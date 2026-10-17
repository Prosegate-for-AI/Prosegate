# 06 — Config service API

## Shape

Cloudflare Workers behind `api.<domain>/v1`, D1 for state, a Queue for telemetry ingest, a 15-minute Cron Trigger for key usage polling, Pages for the dashboard. Two callers: the adapter, with a device bearer key, and the dashboard, with a session from the managed auth provider. Every request body is validated against a generated schema that rejects unknown fields; the only endpoint that accepts free text is `/samples`, which is off per account until the user turns it on and caps each excerpt at 600 characters.

Errors are `application/problem+json` with a stable `code`. All mutating endpoints accept an `Idempotency-Key` header; `/reviewer-keys/vend` requires one.

## Endpoints

| Method and path | Caller | Body (fields accepted) | Returns | Notes |
| --- | --- | --- | --- | --- |
| `POST /device-codes` | adapter (no auth) | `name`, `platform`, `adapter_version` | `device_code`, `user_code`, `verification_url`, `expires_in` | Device-authorisation flow; `prosegate init` prints the URL |
| `POST /devices/claim` | adapter (no auth) | `device_code` | `device_key`, `account_id`, `device_id` | Polled every 5 s until the user approves in the dashboard; 410 after expiry |
| `GET /me` | adapter, dashboard | — | account, plan, org, `default_profile`, `vending_enabled` |  |
| `DELETE /devices/{id}` | dashboard | — | 204 | Revokes the device key; vended keys on that device are revoked too |
| `GET /profiles` | adapter, dashboard | query `namespace` | list of `{id, name, version, etag, updated_at}` | Includes org profiles the account can read |
| `GET /profiles/{id}` | adapter, dashboard | — | `yaml`, `version`, `signature`, `etag` | `If-None-Match` honoured; 304 on match |
| `PUT /profiles/{id}` | dashboard | `yaml` (≤ 64 KB) | `version`, `signature`, `resolution` | Validates against 04, resolves the chain server-side, rejects cycles and unmet pack ranges with the offending ids; bumps the integer version; signs |
| `DELETE /profiles/{id}` | dashboard | — | 204 | Refused with 409 while another profile `extends` it |
| `GET /profiles/{id}/resolved` | dashboard | — | resolved snapshot per 04 | UI preview; never cached by the adapter |
| `GET /rule-packs` | adapter, dashboard | — | list of `{id, versions[], publisher}` |  |
| `GET /rule-packs/{id}/{version}` | adapter, dashboard | — | `yaml`, `signature` | Immutable once published |
| `PUT /rule-packs/{id}/{version}` | dashboard (publisher) | `yaml` (≤ 256 KB) | `signature`, `eval_report` | Runs every rule's `hit`/`miss` examples and the 200 ms budget server-side; 422 with the failing rule ids |
| `GET /reviewer-prompts/{version}` | adapter | — | `text`, `signature`, `supported_models[]` |  |
| `POST /reviewer-keys/vend` | adapter | `provider` | `key`, `key_id`, `cap_cents`, `expires_at` | Creates the per-user provider project on first call; one active key per device; 402 on free plan; 429 above 3 vends per day |
| `GET /reviewer-keys` | adapter, dashboard | — | list of `{key_id, provider, status, usage_pct, expires_at}` | Never returns key values |
| `POST /reviewer-keys/{key_id}/revoke` | adapter, dashboard | — | 204 | Also called by the usage poller |
| `POST /telemetry` | adapter | `events[]` per the 07 allowlist, ≤ 50 | 202 | Unknown field anywhere → 422, whole batch dropped |
| `POST /samples` | adapter | `profile_id`, `pass`, `finding` (03 fields minus `span.start/end`), `excerpt` (≤ 600 chars) | 202 | 403 unless the profile's sharing toggle is on server-side; 20 per device per day |
| `GET /samples`, `DELETE /samples/{id}` | dashboard | — | list / 204 |  |
| `GET /dashboard/usage` | dashboard | query `from`, `to` | aggregates by day, profile, category | Computed from telemetry; no raw events exposed |
| `GET /orgs/{id}/members`, `PUT /orgs/{id}/members/{user}` | dashboard (org admin) | `role` |  | `admin` or `member` |
| `GET /orgs/{id}/policy`, `PUT /orgs/{id}/policy` | dashboard (org admin) | `enforcement_default`, `allowed_providers[]`, `byok_required`, `sharing_allowed` |  | Policy is merged into every org profile at resolution; `byok_required` disables vending for the org |

## Signing

The service holds one Ed25519 signing key; its public key ships inside the adapter and is rotated by shipping a new adapter version that trusts both for 90 days. Every profile, rule pack and reviewer prompt the adapter uses carries a signature over its canonical bytes; the adapter refuses unsigned or mis-signed content from the network and marks local YAML as unsigned-but-trusted in the session snapshot.

## Data model (D1)

| Table | Key columns | Notes |
| --- | --- | --- |
| `accounts` | `id`, `auth_subject`, `plan`, `org_id` | `auth_subject` from the managed provider |
| `orgs`, `org_members` | `id`, `name`, `policy_json` / `org_id`, `account_id`, `role` |  |
| `devices` | `id`, `account_id`, `name`, `key_hash`, `last_seen`, `revoked_at` | Key stored as SHA-256 only |
| `profiles` | `id`, `namespace`, `version`, `yaml`, `signature`, `sharing_enabled`, `updated_at` | One row per version; current = max version |
| `rule_packs` | `id`, `version`, `publisher_id`, `yaml`, `signature`, `eval_report_json` | Immutable rows |
| `reviewer_prompts` | `version`, `text`, `signature`, `supported_models_json` |  |
| `reviewer_keys` | `key_id`, `account_id`, `device_id`, `provider`, `project_id`, `status`, `cap_cents`, `usage_cents`, `polled_at`, `expires_at` | No key value column exists |
| `telemetry_events` | `account_id`, `device_id`, `ts`, `event_json` | Written from the Queue consumer; aggregated nightly into `telemetry_daily`; raw rows deleted after 180 days |
| `samples` | `id`, `account_id`, `profile_id`, `excerpt`, `finding_json`, `created_at` | Deleted after 90 days by cron |
| `audit_log` | `account_id`, `actor`, `action`, `target`, `ts` | Profile edits, key events, policy changes |

## Usage poller

Every 15 minutes the Cron Trigger lists active vended keys, queries the provider's usage endpoint per project, writes `usage_cents`, and applies the revoke rules from 07. A provider outage leaves `polled_at` stale; a key not polled for 2 hours is suspended (not revoked) until the next successful poll, and the adapter treats a suspended key as absent.

## What this service cannot do, by construction

- Receive a draft, a user message or style constraints: no schema has a field for them, and the validator rejects unknown fields.
- Return a reviewer key value after vending: the column does not exist.
- Run a review: there is no rule engine or provider client in the Workers bundle; a CI check fails the build if the engine package appears in its dependency graph.
