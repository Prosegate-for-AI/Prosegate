# Configuration service

Phase 7's Hono API runs on Cloudflare Workers with D1, a telemetry Queue and a
15-minute scheduled handler. It distributes configuration and collects allowlisted
counts; it cannot execute prose checks. `pnpm --filter @prosegate/config build`
bundles the Worker and rejects engine, reviewer, adapter, segmenter, RE2 and external
runtime imports in the complete build graph.

## Local verification

From the repository root:

```sh
pnpm --filter @prosegate/config build
pnpm exec vitest run services/config/test/service.test.mjs eval/runners/publish-pack.test.ts
pnpm --filter @prosegate/config typecheck
```

Tests build the actual Worker, run it in Miniflare/workerd against D1, generate
ephemeral signing/OIDC keys, and use a fake administrative provider binding. They
make no paid calls or changes to installed Claude settings. The repository test
setup isolates every home directory. Node 22+ is required for the Wrangler
development CLI; the API itself uses standard Worker APIs.

For local development, apply the D1 migration with
`pnpm --filter @prosegate/config migrate:local`, set local secrets in
`services/config/.dev.vars`, then run `pnpm --filter @prosegate/config dev`.
Do not commit `.dev.vars`. Use an ephemeral local Ed25519 private JWK for
`SIGNING_KEY`; do not reuse a deployment key.

## Provisioning an installation

This change does not deploy anything or choose the still-undecided managed
authentication provider.

1. Create a D1 database, telemetry Queue and dead-letter Queue. Set the real
   database id in Wrangler configuration; apply `migrations/0001_config.sql`.
2. Set `DASHBOARD_ORIGIN` to the exact dashboard origin. Configure `OIDC_ISSUER`,
   `OIDC_AUDIENCE`, and an HTTPS `OIDC_JWKS_URL`. Tokens must have `sub`, `iat`,
   `exp` and `amr` containing `mfa`; supported signatures are ES256 and RS256.
   `OIDC_JWKS` may pin a public JWKS for isolated installations/tests. There is no
   unauthenticated account creation or production test-auth bypass.
3. An operator provisions a unique namespace and account with the provider's
   verified `auth_subject`. Org creation similarly reserves a namespace and
   inserts an org, account membership and its first admin in one transaction.
   Namespaces use lowercase letters/digits/hyphens, at most 31 characters;
   `local`, `core` and `prosegate` are reserved. Account/org ids are visible ASCII
   tokens of at most 64 characters. Keep `accounts.org_id` and `org_members`
   consistent. An account may belong to one org.
4. Set `SIGNING_KEY` using the Worker secret store. Signatures are Ed25519 over
   exactly the returned UTF-8 YAML/prompt text; policy signatures cover canonical
   JSON **including org identity**. Ship its public key in the adapter's trusted
   key set before enabling network sync. Rotation requires the documented
   90-day overlap. Production adapter sync/auth enrollment is not wired by this
   service-only change.
5. Set a random `PUBLISH_TOKEN` as a Worker secret and protected CI environment
   secret. Give publisher status only to vetted accounts. The manual
   `publish-pack` workflow uses `config-publisher`, `PROSEGATE_CONFIG_URL` (HTTPS
   origin) and `PROSEGATE_PUBLISH_TOKEN`. It claims **one** pending job and runs
   the engine's actual examples and 200 ms p95 gate in the separate eval process.
   The API signs only after matching content hash, lease and example totals.
   A crashed job can be reclaimed after ten minutes; published or rejected
   versions cannot be overwritten. No model is called by this job. Its latency
   and example result does not establish Phase 6 corpus quality.
6. Populate immutable reviewer prompts through the internal publishing route.
   Prompt text signatures do not authenticate the separate supported-model
   metadata; clients must retain their own model allowlist.

All mutating API requests require an `Idempotency-Key` (8–128 alphanumeric,
underscore or hyphen characters). Send JSON with its matching content type.
Successful responses are replayable for 24 hours, except responses containing
one-time credentials: only a tombstone is saved, and replay returns
`409 secret_already_delivered`. Losing such a response requires a fresh flow;
provider reservations remain discoverable and revocable. `409 state_changed_retry`
means a concurrent change won; retry with the same key. Do not retry financial
provider operations independently of their durable operation id.

## Reviewer administration boundary — disabled by default

S2 has **not** been accepted. No live provider adapter, admin secret, spend
measurement, email transport or billing integration is installed here. Hosted
vending is not production-ready. BYOK preview remains the available reviewer path.

The service implements reservations, one-time delivery, plan/org checks, three
vends per account per UTC day, one non-revoked key per device, usage polling,
anomaly flagging, revocation retries and a notification outbox. Its provider
boundary is a **service binding**, never an arbitrary outbound URL or inference
client. Enabling it requires both `REVIEWER_ADMIN` and the explicit
`VENDING_EXPOSURE_ACCEPTED=accepted-s2` deployment setting, after the owner accepts
the actual S2 report in writing. That string alone is not evidence of acceptance.
Anthropic vending remains unavailable.

Failed provisioning reservations also consume the daily quota because their
external outcome may be unknown. Cron jobs run independently, so a telemetry
outage cannot prevent financial controls. Provider work uses bounded batches of
five concurrent requests, with at most 100 keys considered per maintenance pass.

The separately deployed administrative bridge must implement:

| Request | Required behavior |
| --- | --- |
| `PUT /v1/keys/{operation_id}` | Accept `{account_id,device_id,provider,cap_cents,expires_at,model}`. Reuse one project and calendar-month **account** budget across devices and rotations. Set provider-side hard spend limit, measured rate limits, allowed model and expiry before returning `{key,project_id}` once. The operation id must survive partial creation and be idempotent. |
| `GET /v1/keys/{operation_id}/usage` | Return `{usage_cents,daily_cents,trailing_daily_cents}` for the account/project. Costs are nonnegative cents; daily average excludes today. Use measured billing/usage lag from S2, not assumptions about freshness. |
| `DELETE /v1/keys/{operation_id}` | Idempotently remove the service account/key, including partially completed creates. Return success only once it cannot be used; repeated calls must succeed. |

The default requested budget is $5 per account per calendar month, key lifetime
30 days. Never interpret a fresh device/rotation as a fresh budget. Administrative
responses must not be logged. D1 has no reviewer secret column, and idempotency
responses never contain provider secrets. A failed or interrupted provisioning
attempt is retained for cleanup; cron revokes reservations older than 15 minutes.

The poller revokes on expiry, full cap, daily burn above 3× a positive trailing
seven-day average, or over 80% of cap before UTC day 20. Burn anomalies revoke all
the account's keys, flag the account and enqueue a notification. A zero historical
average does not trigger the ratio rule. Dashboard confirmation clears the flag,
but does not reset the provider budget or daily vend quota.

Revocation requests stop being advertised as active immediately; the background
handler attempts deletion and cron retries failures. A response to a revoke
request is not proof that the provider already deleted the key. Only status
`revoked` means the administrative bridge confirmed deletion. Missing polls for
two hours produce `suspended` status and the adapter must stop using the key;
this status alone **does not disable a stolen key at the provider**. Hard caps,
rate limits, expiry and the S2 exposure measurement remain necessary.

`NOTIFICATIONS` is an optional delivery service binding. It receives
`POST /v1/send` with `{id,account_id,code,target}` and `Idempotency-Key: id`.
It must resolve the verified account email and deduplicate by id. Failed delivery
is retried; no notification is marked delivered without a successful response.

## Data and operations

- Normal writes use an optimistic global revision checked inside a D1 batch
  transaction, including quotas, profile graph validation, audit and idempotency.
  This trades write throughput for simple v0 correctness. Retry 409 conflicts;
  partition this revision before scaling beyond a small installation.
- Telemetry intake strictly validates the shared schema, bounds timestamps to
  ±1 day, stamps account/device ids and records a transactional outbox. Queue
  messages contain only outbox ids. The consumer revalidates and atomically
  inserts events and removes the outbox row. Duplicate delivery cannot double
  count. Cron retries delivery and recomputes recent/dirty aggregate days.
- The same cron performs aggregation and retention every 15 minutes (more often
  than the original nightly plan): raw events/outbox 180 days, samples 90 days,
  idempotency 24 hours. Historical aggregate counts are retained. Inspect the
  dead-letter Queue and pending outbox on operational failures.
- Sample sharing is off per profile. Org policy can forbid it. Only block
  findings, at most 600 UTF-16 units per excerpt/span, and 20 per device/day are
  accepted. Email addresses, URLs, long numbers and key-shaped tokens are
  redacted again on the server, including finding text. This is heuristic,
  not a guarantee that all sensitive information is removed.
- No request/response body logging is enabled. Errors use stable codes without
  SQL, provider responses or submitted text. Configure operational alerts for
  cron failures, old outbox entries, stale polls, undelivered notifications and
  revocations that remain pending before a production rollout.
- Lists have v0 bounds: 200 devices/keys/samples, 500 profiles per visible
  namespace set/affected descendants, 5,000 published pack versions. Pagination
  and higher-throughput writes are follow-up work.

See [the API contract](../../docs/06%20Config%20service%20API.md) and ADR-38.
Phase 8's Pages dashboard is implemented against these routes. See
[dashboard setup](../../apps/dashboard/README.md) for the public OIDC client,
exact callback/origin configuration, in-memory sessions and browser tests.
The Worker audience must match that client's ID token audience. Unsaved profile
previews are authenticated read-only operations and bypass idempotency persistence;
profile creation/editing/deletion and policy edits support conditional writes
as documented in [the API contract](../../docs/06%20Config%20service%20API.md).
