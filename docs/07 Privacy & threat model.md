# 07 — Privacy and threat model

## The claim, and why it holds

Prosegate's service has no endpoint that accepts prose. The draft, the user's message and the style constraints go from the user's machine directly to the reviewer provider, under a key the user holds; Prosegate's servers receive configuration and counts. The claim is structural, not a retention promise: the published source of both the adapter and the config service shows no code path that could receive a prompt, and the config service's request validator rejects any payload field it does not know.

What the claim does not cover: the reviewer provider sees the draft under that provider's own data terms, and the adapter reads the harness transcript on the user's machine. Both are stated in the public wording at the end.

## Data flows

| Data | From → to | When | Stored where | Retention |
| --- | --- | --- | --- | --- |
| Draft, user message, style constraints | Machine → reviewer provider (direct HTTPS) | Reviewer stage runs (over floor, key present, profile enables it) | Not stored by Prosegate; provider terms apply | Provider's |
| Harness transcript (last turn only) | Harness file → adapter process memory | `turn-end` | Never written by Prosegate; `--debug` writes a local copy with a warning | Process lifetime |
| Resolved profile snapshot | Adapter → `~/.prosegate/sessions/<id>/` | Session start | Local disk, 0600 | Deleted at next session start |
| Profiles, rule packs, reviewer prompts | Config service → machine | Session start, `reload` | D1 (server), local cache | Until user deletes |
| Device key | Config service → machine (once) | `prosegate init` | OS keychain; file 0600 fallback | Until revoked |
| Reviewer key (vended) | Config service → machine | Session start if absent or rotated | OS keychain; never in config files, env dumps or logs | Until revoked or rotated (30 days) |
| Reviewer key (BYOK) | User → machine | `prosegate key set` | OS keychain | Until user removes |
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
| 1 | Config service compromise | Profiles, telemetry, key ids | No prose to lose; D1 encrypted at rest; device keys hashed; key values not stored; incident = revoke all vended keys and rotate device keys | Attacker learns which rules users hit and their profile names |
| 2 | Vended key stolen from a user's machine | Prosegate's provider bill | Per-user project and cap; 15-minute usage polling; anomaly revoke; keychain storage | Up to one cap per stolen key before revoke |
| 3 | Malicious or buggy rule pack or profile from sync | User's model receives harmful instructions; regex DoS | Packs and profiles signed by the service (Ed25519), adapter verifies; RE2 only; 200 ms pack budget; instruction text ≤ 200 chars, no URLs, no backticks; action enum fixed | An org admin can still write a bad instruction for their own org |
| 4 | Prompt injection through the draft (content from a tool result steers the reviewer) | User's model acts on an injected instruction | Reviewer output is constrained: fixed fork text for two categories; `register` instruction ≤ 160 chars, filtered for URLs, code and tool names; actions are an enum; `feedback_text` is rendered by the adapter from fields, never from free text | A short malicious `register` instruction that passes filters; mitigated by `warn` cap on that category |
| 5 | Telemetry used to reconstruct prose | User's text | No span text, offsets or lengths per finding; counts only; prose length bucketed to 100 words; server rejects unknown fields and strings over 64 chars | Rule ids imply short phrases appeared; accepted and disclosed |
| 6 | Adapter reads the whole transcript | Everything in the session | Parser reads from the last user message onward only; nothing persisted; `--debug` is explicit and local | A compromised adapter binary could read more (see 8) |
| 7 | Account takeover on the config service | Profiles changed to inject instructions into the user's models | Managed auth with MFA; profile version shown at session start with a diff when changed since last session; signed profiles; email on profile edits from a new device | Social engineering of the user |
| 8 | Supply chain: tampered npm package | Everything | Published with npm provenance; reproducible build with the hash in the release; pinned dependencies; open source | Users who skip verification |
| 9 | Reviewer provider logs the draft | User's text | Provider terms; BYOK lets an org use its own contract; disclosed in wording | Provider's practices |

## Telemetry allowlist

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
      reviewer?: { model: string; latency_bucket_ms: 500 | 1000 | 2000 | 4000 | 8000; findings: number; span_misses: number };
      cleared: number;               // pass 2 only
      cleared_categories: Category[] }
  | { t: 'enforcement'; decision: 'allow' | 'continue'; enforcement_unavailable: boolean; override_used: boolean; notice_via_model: boolean }
  | { t: 'profile_select'; from: string; to: string; by: 'model' | 'heuristic' | 'user' }
  | { t: 'error'; code: string };   // code from a fixed list; no messages
```

Every event carries `account_id`, `device_id`, `ts`. No event carries a session or turn id; sequences cannot be reassembled across events.

## Opt-in samples

Off by default, set per profile, shown in the dashboard as a list the user can delete from. When on, the adapter sends for each `block` finding: the span text plus one sentence either side, the finding fields, and the pass. Before sending it strips email addresses, URLs, numbers of five or more digits, and any token matching a secret pattern; it caps at 20 samples per day per device. The redaction is heuristic and the toggle's own text says so. Samples are used for rule tuning only and are deleted after 90 days.

## Public wording

The privacy page says this and no more:

> Your text never reaches Prosegate. The deterministic checks run on your machine. The judgement checks send your draft and your last message directly from your machine to the AI provider you chose, under a key you hold; that provider's data terms apply, and with your own key you can use your own contract. Prosegate's servers store your account, your profiles, your rule packs, and counts of which rules fired. They have no endpoint that can receive your text, and both the adapter and the server are open source so you can check. If you turn on sample sharing for a profile, short redacted excerpts around flagged spans are sent and listed in your dashboard, where you can delete them.

Anything stronger than that, in marketing or in a sales call, is false.
