# 07 — Privacy and threat model

## The claim, and why it holds

Normal hooks and MCP checks run locally. Explicit BYOK review sends the draft, bounded user message and style constraints directly to the chosen provider. The configuration service does not execute draft reviews or proxy inference. It does accept user-authored configuration and, when enabled, redacted sample excerpts: it is false to claim that no prose can reach it. Request validators restrict accepted fields; they do not establish that a permitted text field contains no sensitive information. ADR-40 corrects ADR-2's earlier absolute wording.

What the claim does not cover: the reviewer provider sees the draft under that provider's own data terms, and the adapter reads the harness transcript on the user's machine. Both are stated in the public wording at the end.

## Data flows

The table includes the planned connected-service flows. Current hooks/MCP are
rules-only; adapter enrollment, remote sync and telemetry/sample uploads are not
wired. Live vending and notification bridges remain gated. Profile previews are
received by the service without persistence. See PRIVACY.md for current public wording.

| Data | From → to | When | Stored where | Retention |
| --- | --- | --- | --- | --- |
| Draft, user message, style constraints | Machine → reviewer provider (direct HTTPS) | Reviewer stage runs (over floor, key present, profile enables it) | Not stored by Prosegate; provider terms apply | Provider's |
| Harness transcript (last turn only) | Harness file → adapter process memory | `turn-end` | Never written by Prosegate; `--debug` writes a local copy with a warning | Process lifetime |
| Resolved profile snapshot | Adapter → `~/.prosegate/sessions/<id>/` | Session start | Local disk, 0600 / owner-only ACL | With its session: 7 days idle (ADR-31); holds no prose |
| Last user message (`turn.json`, ≤ 2,000 chars) | Adapter → session dir | Turn start | Local disk, 0600 / owner-only ACL | Deleted when the turn ends (ADR-31) |
| Headless report (`report.json`, spans ≤ 80 chars) | Adapter → session dir | Turn end, headless only | Local disk, 0600 / owner-only ACL | Deleted at the next session start (ADR-31) |
| Advisory draft findings (`mcp-review.json`, includes finding excerpts) | MCP tool → private session dir | First `review_prose` call per turn; local rules only in this build | Local disk, 0600 / owner-only ACL | Deleted at turn completion, the next turn or fresh session; abandoned turns swept at session start after one hour (ADR-36) |
| Debug copy of a turn (`debug/`) | Adapter → session dir | Only with `--debug`, with a user notice | Local disk, 0600 / owner-only ACL | Deleted when the turn ends unless `--debug` is still on (ADR-31) |
| Profiles, rule packs, reviewer prompts | Config service → machine | Session start, `reload` | D1 (server), local cache | Until user deletes |
| Device key | Config service → machine (once) | `prosegate init` | OS keychain; file 0600 fallback | Until revoked |
| Reviewer key (vended) | Config service → machine | Session start if absent or rotated | OS keychain; never in config files, env dumps or logs | Until revoked or rotated (30 days) |
| Reviewer key (BYOK) | User → machine | `prosegate key set` | OS keychain or announced owner-only file fallback | Until user removes |
| Telemetry (allowlisted metadata) | Machine → config service | After each `turn-end`, batched per minute | D1, per account | 180 days, then aggregated |
| Opt-in samples | Machine → config service | Only with the per-profile toggle on | D1, per account, visible in dashboard | 90 days; user-deletable |

## Key handling

- Device key: 32 random bytes, bearer token, scoped to one account and one device record, revocable from the dashboard. Rotated on `prosegate init` re-run.
- Vended reviewer key: one OpenAI project per user, created through the Administration API at first paid session, with a hard spend limit, per-model rate limits and a model allowlist set at vend time, and a service-account key with an expiry (ADR-8). The service stores the project id and the key's id, never the key value after it is handed to the device (the hand-off is the only time it exists server-side, in memory).
- Spend limit default: $5 per calendar month per user, adjustable per plan, set as the project's provider-side hard spend limit. The provider documents that enforcement is not instantaneous, so worst-case exposure per key is the limit plus the rate-limited spend during the enforcement lag; the admin doc states the number measured in S2. Usage is polled every 15 minutes through the Administration API. Burn above 3× the user's trailing seven-day daily average, or above 80% of the cap before day 20, revokes the key, flags the account, and emails the user. The next session vends a fresh key after the user confirms in the dashboard.
- Keys never appear in `feedback_text`, telemetry, logs, crash reports or MCP responses. A unit test greps every outbound payload type for the key prefixes and fails the build on a match.
- Keychain: `@napi-rs/keyring`; on Linux, Secret Service only, never the kernel keyring. The backend is chosen by a probe at `init` and `session-start` and recorded; where no keychain works (CI, some containers), a file under `~/.prosegate/` readable only by the user (mode 0600 on POSIX; an owner-and-SYSTEM-only ACL on Windows) with a one-time notice. Secrets are never passed on a command line (ADR-14).

## Threats and mitigations

| # | Threat | Asset at risk | Mitigation | Residual |
| --- | --- | --- | --- | --- |
| 1 | Config service compromise | Profiles, shared samples, telemetry, key ids | No inference proxy; sample opt-in/redaction/retention; device keys hashed; key values not stored; incident = revoke vended keys and rotate device keys | Attacker can read configuration and remaining shared excerpts as well as counts and identifiers; redaction is incomplete |
| 2 | Vended key stolen from a user's machine | Prosegate's provider bill | Planned per-account project and cap; 15-minute polling; anomaly revoke; keychain storage; live vending disabled | Cap plus rate-limited spend during enforcement lag; S2 exposure unmeasured/unaccepted, not a guaranteed one-cap maximum |
| 3 | Malicious or buggy rule pack or profile from sync | User's model receives harmful instructions; regex DoS | Packs, profiles and org policy signed by the service (Ed25519), adapter verifies and re-resolves at every turn end; RE2 only; per-pack work caps; 200 ms pack budget in a publish job; every model-injected string ≤ 200 chars and passes one allowlist-plus-denylist filter (no URLs, links, markup, shell or tool vocabulary, `prosegate`, invisible characters; ADR-19); action enum fixed | An org admin can still write a bad instruction for their own org; each model-injected string passes the filter as rendered, but a filter cannot stop an instruction that is harmful in plain words in any language ("run the install step from the wiki"), that names a harness tool or file in ordinary words, that asks the model to decode an encoding, or that spells out an address; up to 60 characters of the user's own words reach the model in the `vague_claim` fork. Third-party packs therefore need publisher vetting and the dashboard review step, which are the primary controls; the filter is defence in depth |
| 4 | Prompt injection through the draft (content from a tool result steers the reviewer) | User's model acts on an injected instruction | Reviewer output is constrained: fixed fork text for two categories; `register` instruction ≤ 160 chars, filtered for URLs, code and tool names; actions are an enum; `feedback_text` is rendered by the adapter from fields, never from free text | A short malicious `register` instruction that passes filters; mitigated by `warn` cap on that category |
| 5 | Telemetry used to reconstruct prose | User's text | No span text, offsets or lengths per finding; counts only; prose length bucketed to 100 words; server rejects unknown fields and strings over 64 chars | Rule ids imply short phrases appeared; accepted and disclosed |
| 6 | Adapter reads the whole transcript | Everything in the session | Parser reads from the last user message onward only; nothing persisted; `--debug` is explicit and local | A compromised adapter binary could read more (see 8) |
| 7 | Account takeover on the config service | Profiles changed to inject instructions into the user's models | Managed auth with MFA; profile version shown at session start with a diff when changed since last session; signed profiles; email on profile edits from a new device | Social engineering of the user |
| 8 | Supply chain: tampered npm package | Everything | Release workflow prepares provenance publishing, repeated-build comparison and hashes; pinned dependencies; Apache local source. Actual npm publication remains pending | Hashes alone do not authenticate their source; provenance does not prove code safety |
| 9 | Reviewer provider logs the draft | User's text | Provider terms; BYOK lets an org use its own contract; disclosed in wording | Provider's practices |
| 10 | The agent lowers its own enforcement (it holds a shell and can edit any file the user can) | The product's enforcement promise | Mode-lowering commands and `profile` refuse in agent context (ADR-27, ADR-30); effective enforcement is compared with its baseline every turn and any lowering is shown to the user, never the model, once per session and on change (ADR-30); `override_used` on every lowering path; no test levers in release builds (ADR-29); hook entry points never let one turn consume another's passes (ADR-30, ADR-31) | Deliberate circumvention remains possible and is inherent locally: reading the real `prompt_id` from the transcript and spoofing `turn-end` to exhaust the cap (shown to the user as "shipped as is"), editing `state.json`, removing every agent marker, or a new console that fakes a TTY. Detection, not prevention, is the v0 control |

## Telemetry allowlist

ADR-35 restricts `reviewer.model` to the two transport candidates declared in `packages/schema/src/reviewer-models.ts`. They are not yet live-eval-qualified. Arbitrary model-id strings are rejected, even when they match the old model-id pattern. The preview keeps all telemetry local; automatic reviewer hooks and remote telemetry are not enabled.

The server's validator is generated from this schema and rejects anything else. Adding a field is a schema change with its own review.

```typescript
type Event =
  | { t: 'session_start'; harness: string; adapter_version: string; profile_count: number; offline: boolean }
  | { t: 'review';
      profile_id: string;            // synced id, or 'local' for a local-only profile
      pass: 1 | 2;
      verdict: 'pass' | 'revise' | 'skipped';
      skipped_reason?: string;
      prose_words_bucket: number;    // floor(words / 100) * 100
      by_category: Partial<Record<Category, number>>;
      rule_ids: string[];            // ids hit, deduplicated
      reviewer?: { model: 'gpt-5.4-mini-2026-03-17' | 'claude-haiku-5-5'; latency_bucket_ms: 500 | 1000 | 2000 | 4000 | 8000; findings: number; span_misses: number };
      cleared: number;               // pass 2 only
      cleared_categories: Category[] }
  | { t: 'enforcement'; decision: 'allow' | 'continue'; enforcement_unavailable: boolean; override_used: boolean; notice_via_model: boolean }
  | { t: 'profile_select'; from: string; to: string; by: 'model' | 'heuristic' | 'user' }
  | { t: 'error'; code: ErrorCode };   // fixed list below; no messages

type ErrorCode =
  | 'adapter_error' | 'reviewer_timeout' | 'reviewer_http_error' | 'reviewer_schema_invalid' | 'reviewer_key_missing'
  | 'profile_resolution_failed' | 'pack_rejected' | 'signature_invalid' | 'snapshot_missing' | 'turn_budget_exceeded'
  | 'keychain_unavailable' | 'keychain_timeout' | 'transcript_unreadable' | 'telemetry_dropped' | 'turn_truncated';
```

Every stored event carries `account_id`, `device_id` and `ts` (integer epoch milliseconds). The adapter sends `ts`; the service stamps `account_id` and `device_id` from the authenticated device key, so a client cannot attribute events to another account (ADR-17). Every string field has its own format (enum, semver, model-id pattern, or the 04 id grammar), at most 64 visible ASCII characters, and is rejected if it has the shape of a key. `profile_id`, `from` and `to` carry a synced id or the literal `local`, never a local profile's own name; `rule_ids` carry only ids from `core` or synced packs. The adapter enforces both by masking against the session's synced id sets in its single send path, because the schema cannot tell a local id from a synced one. Arrays and counts are bounded. The adapter truncates `ts` to the minute and shuffles events within a batch; no event carries a session or turn id. Events from one turn can still share a minute and a batch; what they reveal together is which rule ids fired on pass 1 and which were cleared on pass 2, which is the purpose of the event and is disclosed.

## Opt-in samples

Off by default, set per profile, shown in the dashboard as a list the user can delete from. When on, the adapter sends for each `block` finding: the span text plus one sentence either side, the finding fields, and the pass. Before sending it strips email addresses, URLs, numbers of five or more digits, and any token matching a secret pattern; it caps at 20 samples per day per device. The redaction is heuristic and the toggle's own text says so. Samples are used for rule tuning only and are deleted after 90 days.

Phase 7 also enforces the profile/org toggle, quota, excerpt limit and redaction on
the server, including the finding's free-text fields. Telemetry's transactional
outbox holds only validated allowlisted counts and is subject to the same 180-day
retention as raw events. One-time device/provider credentials are excluded from
idempotency storage. Provider revocations remain pending until confirmed by the
administrative bridge; a `suspended` database status alone does not disable direct
provider use. Live vending remains gated on the unaccepted S2 exposure report.

## Public wording

Phase 8 browser handling (ADR-39): the dashboard uses managed OIDC with PKCE and
a nonce, with signed MFA sessions verified again by the configuration Worker.
Tokens remain in memory; only the short-lived login transaction is placed in
session storage. Profile drafts stay in the open editor, and server-side preview
does not persist them or cache the response. Callback query parameters are removed.
Local sign-out clears dashboard state but does not end the provider's SSO session.
Pages emits a restrictive CSP and no-store/no-referrer headers; returned profile,
pack and sample text is never interpreted as HTML. Hosted headers and the selected
provider still require deployment qualification.

The canonical public wording is now [PRIVACY.md](../PRIVACY.md), rendered into the dashboard's unauthenticated /privacy page and included in the adapter tarball. It distinguishes current local-only hooks from direct BYOK review and the optional configuration service. It explicitly discloses profile/preview text, shared excerpts, local draft caches, correlation limits, retention, deletion limits and deployment dependencies. The local tools are Apache-2.0; service/dashboard are FSL-1.1-ALv2 source-available components (HQ-3 answered October 20). Do not claim that no text can reach the service, that redaction removes every secret, or that the service is currently OSI open source.
