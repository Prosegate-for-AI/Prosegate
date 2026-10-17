# 11 — Implementation plan v0

Oct 17, 2026 · drafted from docs 01–10 · Status: Draft

## How to read this

The plan turns the eleven design docs into a build order. It assumes one engineer full-time (the author) plus one part-time contributor, and targets the 30-day dogfood in 01 starting in week 11. Every milestone names the doc it satisfies and the test that proves it. Nothing in here changes a decision in 02; where a verified fact contradicts a doc, the contradiction is listed in §2 and the doc owner decides.

Order of work follows the dependency graph, not the doc numbers: contracts (03, 04) → engine and pack (08) → adapter and Claude Code shim (05, 09) → reviewer (08) → eval (10) → config service (06, 07) → dashboard → dogfood.

## 1. Verified facts that shape the plan

Checked against current documentation on 2026-10-17.

| Fact | Source | Effect on the design |
| --- | --- | --- |
| Claude Code's `Stop` hook receives `last_assistant_message` on stdin, and the docs say not to read `transcript_path` for the final text because the file may lag at Stop time. | code.claude.com/docs/en/hooks | 05 says "parse the transcript JSONL for the last assistant message". Use `last_assistant_message` as the text; read the transcript only for tool-use names, best-effort, tolerating lag. |
| `Stop` output supports `decision: "block"` + `reason` (fed to the model), `hookSpecificOutput.additionalContext`, and a universal `systemMessage` field shown to the user as a terminal notification on most events. Whether `Stop` renders `systemMessage` is not stated explicitly. | same | Resolves 09's "to be verified" on a user-visible channel. Spike S1 tests `systemMessage` on `Stop`; if it renders, the notice goes there and `notice_via_model` becomes the fallback only. |
| Claude Code caps consecutive stop-hook continuations at 8 (`CLAUDE_CODE_STOP_HOOK_BLOCK_CAP`) and resets the count on any tool call. `Stop` default timeout is 600 s; `UserPromptSubmit` is 30 s. | same | Pass cap of 2 fits inside it. Register the Stop hook with an explicit 10 s timeout so the adapter's 6 s cap is the binding one. |
| Hooks can be `type: "mcp_tool"` as well as `command`. | same | Keep `command` hooks for v0 (one process per event, no server-lifetime issues). Note `mcp_tool` as a later latency optimisation. |
| OpenAI's Administration API creates projects, service accounts (key returned once), project rate limits, and exposes `/v1/organization/costs`. It has no endpoint that sets a hard project spend cap, and the dashboard's monthly budget is documented as not a hard cap. | platform.openai.com admin reference (overview page); community thread 1087771, last reply 2025-08-01. **Superseded 2026-10-17 by S2:** the official OpenAPI spec defines a per-project hard spend limit (`/organization/projects/{id}/spend_limit`); see ADR-8 and docs/spikes/S2.md | ADR-3 and 07 assume "a hard spend limit". The enforceable controls are per-project rate limits plus cost polling and revoke. Spike S2 re-reads the current reference (the detailed pages returned 403/404 to automated fetch); the vending design in §6.7 is written against what the API can do. |
| `re2js` is a pure-JavaScript RE2 port with linear-time matching; `re2` (node-re2) is a native addon. | npm | Use `re2js` so the adapter ships as one file per platform with no node-gyp. Benchmark on the pack in Phase 2 against the 50 ms budget. |

## 2. Doc corrections to raise with the owner

1. **05, Claude Code mapping:** replace "parse the transcript JSONL for the last assistant message's text blocks" with `last_assistant_message`; keep transcript parsing for tool names only.
2. **02 ADR-3 and 07 key handling:** "hard spend limit" is not available by API. Proposed wording: "a per-project token and request rate limit set at vend time, cost polling every 15 minutes, and revoke by deleting the service account; worst-case exposure per key is the rate limit times the polling interval." Needs a new ADR entry if accepted.
3. **09, notice channel:** likely resolvable to `systemMessage` after S1; the `notice_via_model` route stays as the fallback for harnesses without a channel.
4. **05, capability matrix:** Claude Code row "Last assistant text available to the hook" becomes "yes, via `last_assistant_message`".

## 3. Repository and toolchain

One monorepo, `prosegate/`, pnpm workspaces, TypeScript strict, ESM.

```
packages/
  schema/        03: types, zod validators, JSON Schema build, finding ids, feedback_text renderer
  segmenter/     markdown → Segment[]; sentence splitter; word counts; UTF-16 offsets
  engine/        04 match kinds + metrics, pack loader/validator, overlap resolution, pass semantics
  profiles/      04 YAML schemas, inheritance resolver, snapshot hash, selection heuristics; bundled core pack + starter profiles
  reviewer/      08 prompt builder, provider clients (OpenAI, Anthropic), output enforcement, span re-find
  adapter/       05 `prosegate` CLI: entry points, session store, keychain, config client, telemetry, MCP server, shims/
services/
  config/        06 Cloudflare Worker: Hono router, D1 migrations, Queue consumer, Cron poller, signing, vending
apps/
  dashboard/     06 Pages app: device approval, profile editor, keys, samples, usage
eval/
  corpora/       10 AI corpus, human control, adversarial, rubric set + gold JSON
  runners/       eval:rules, eval:reviewer, eval:e2e; baseline.json; reports/
  annotate/      annotation CLI; GUIDELINES.md
```

| Concern | Choice | Why |
| --- | --- | --- |
| Validation | `zod` with `.strict()`; `zod-to-json-schema` at build | One source for the 03, 04 and 07 schemas; strict mode rejects unknown fields as 06 and 07 require |
| Regex | `re2js` | RE2 semantics as 04 requires; no native build |
| YAML | `yaml` | Round-trips comments for `profile diff` |
| Bundling | `tsup` (esbuild) to one file per platform; `@napi-rs/keyring` as an optional platform dependency | 05 packaging; keyring is the one native dependency and has a 0600-file fallback |
| MCP | `@modelcontextprotocol/sdk` stdio server | Standard |
| Reviewer HTTP | raw `fetch` + zod, no provider SDKs | Keeps the bundle small; two endpoints only |
| Service | Hono on Workers, D1 through bindings with a thin repository layer, `wrangler` | 06 names the stack |
| Signing | WebCrypto Ed25519 on Workers; `@noble/ed25519` in the adapter | No native code on either side |
| Tests | `vitest`; fixture-driven golden tests for the engine | Rules are data; tests are tables |
| CI | GitHub Actions: lint, typecheck, unit, `eval:rules`, bundle size, dependency-graph check | 06: the engine must not appear in the Worker's graph |

## 4. Phases and milestones

| Week | Phase | Milestone | Proves |
| --- | --- | --- | --- |
| 1 | 0 Spikes and scaffold | S1–S4 answered; monorepo builds; CI green on an empty engine | §5 |
| 1–2 | 1 Contracts | `schema`, `segmenter`, `profiles` resolver pass their suites; JSON Schema emitted | 03, 04 |
| 2–3 | 2 Engine and `core` 0.1.0 | All 21 rules pass hit/miss; pack under 50 ms on 2,000 words; `eval:rules` runs | 08; 10 rules row |
| 3–4 | 3 Adapter and Claude Code shim | `npx prosegate init` works on the author's machine; a pass-1 revise seen live; override commands work; headless report written | 05, 09 |
| 4–5 | 4 Reviewer | BYOK path returns reviewer findings inside 4 s; fork text enforced; span re-find ≥ 95% on a 30-draft smoke set | 08 rubric |
| 5 | 5 MCP and selection | `select_profile`, `list_profiles`, `review_prose` served; hysteresis state machine passes scenario tests | 04, 05 |
| 4–8 (parallel) | 6 Eval corpus and reports | Human control ≥ 300 per profile for three profiles; rubric set of 150; first full eval report | 10 |
| 6–9 | 7 Config service | Device auth, signed profile and pack sync, telemetry ingest, vending with poller, org policy | 06, 07 |
| 8–10 | 8 Dashboard | Device approval, profile editor with server-side resolve, keys, samples, usage | 06 |
| 10 | 9 Release candidate | Signed npm publish with provenance; privacy page wording; admin doc | 07; 02 ADR-7 and ADR-8 |
| 11–15 | 10 Dogfood | 30 days on the author's team; weekly review of `advisory` sessions and dominant rule ids | 01 success criteria |

The free tier (local YAML, deterministic only) is usable at the end of Phase 3. The reviewer with BYOK is usable at the end of Phase 4. Nothing in Phases 7–8 is on the turn path, so the team can start using BYOK keys at week 6 if the service slips; the 30-day clock in 01 starts when the service is in.

## 5. Phase 0 — spikes (week 1)

Each spike is a throwaway script plus a one-paragraph note in `docs/spikes/`.

- **S1 Stop hook surface.** Register a Stop hook that returns `{"decision":"block","reason":"…","systemMessage":"…"}`. Record: whether `systemMessage` is shown; what the user sees for `reason`; whether `last_assistant_message` carries markdown verbatim; what the transcript holds at Stop time for `tool_use` names; behaviour with `stop_hook_active` on the second continuation. Also test exit 2 with stderr as the alternative. Decides the §6.5 render path.
- **S2 OpenAI vending.** With an admin key on a sandbox org: create a project, create a service account and capture the one-time key, set rate limits, call `/v1/organization/costs` filtered by `project_ids`, delete the service account, confirm the key dies. Measure cost-reporting lag. Decides §6.7 and the ADR-3 wording.
- **S3 Keychain.** `@napi-rs/keyring` set/get/delete on Windows, macOS, Linux, and a container with no secret service, inside a tsup single-file bundle. Decides packaging of the native dependency and the 0600 fallback trigger.
- **S4 re2js budget.** Compile all `core` regexes with `re2js`, run on 2,000 words × 100 iterations. If the pack exceeds 50 ms p95, decide between precompiled-program caching and native `re2` for the CLI only.

Scaffold in parallel: pnpm workspace, base tsconfig, vitest, eslint, tsup configs, GitHub Actions with the dependency-graph check stubbed.

## 6. Work breakdown by package

### 6.1 `schema` (Phase 1)

- Types from 03 verbatim; zod schemas with `.strict()`; `pnpm build:schema` emits `prosegate.review.1.json` and `prosegate.findings.1.json`.
- `findingId(category, ruleId, spanText, segmentId)` = first 10 hex of SHA-256 over the pipe-joined fields.
- `renderFeedbackText(result)` per the 03 template: `info` excluded, 80-char trim, `warn` only on pass 1, ends with the override line. Golden tests against the 09 mock transcripts.
- `renderNotice(result, mode)` for the 09 notice line and finding lines: 60-char trim, at most six lines.
- The versioning rule encoded as a test: adding an `Action` or a `skipped_reason` does not change the schema id; a consumer helper renders unknown actions with `instruction.text` alone.

### 6.2 `segmenter` (Phase 1)

- Input: the full turn string. Output: `Segment[]` with UTF-16 offsets and kinds `prose | code | table | tool_output | quote`.
- Rules: fenced and indented code → `code`; pipe tables → `table`; blockquotes and quoted runs the model attributes to the user or a named source → `quote`; `tool_output` only from harness-provided markers (none in Claude Code v0; kind reserved). Everything else is `prose`, split at blank lines; headings and list items stay inside prose segments but are tagged for the structure metrics.
- Sentence splitter handles abbreviations, decimals, version strings, file paths and URLs; list items count as sentences for `bullet_ratio`; headings do not.
- Word counter shared by the floors (03 thresholds) and the telemetry bucket (07).
- Language gate: a cheap stop-word ratio test; non-English → no prose segments → `skipped`, `no_prose` (10 known gaps).
- Tests: a fixture corpus of 40 markdown turns with expected segment tables; an offset round-trip property test (`text.slice(start, end) === span.text`).

### 6.3 `engine` (Phase 2)

- Pack loader: parse YAML, validate against the 04 rule-pack schema, reject unknown metrics and unsupported `findings_schema`, compile each `phrase` list to one `re2js` alternation with word boundaries and case folding, syntax-check `regex` rules as RE2 at load. Load once per session; cache compiled packs in memory keyed by `id@version`.
- Matchers per 04: `phrase` (`position: any | sentence_start | closing`, `max_doc_words`), `regex` (group 1 or whole match), `sentence_metric` (`word_count`, `starts_with`, `comma_count`, `similarity_to_prior`), `document_metric` (`bullet_ratio`, `headers_per_100_words`, `sentence_length_cv`, `closing_similarity`, `bold_per_100_words`).
- `allow_terms` applied to `vocab` matches before emission.
- Overlap resolution exactly as 03: severity, then rule over reviewer, then earlier start; the containment rule for a reviewer finding over a rule finding with a different category.
- Pass semantics: `review(request, priorFindings)`; pass 2 filters to `block` ids present in `prior_findings`, demotes new findings to `info`, computes `cleared`.
- Thresholds from the resolved profile; `below_floor` and the reviewer floor returned as `stages`.
- Budget guard: wall-clock per rule and per pack; a pack over 200 ms on the fixture set fails `eval:rules`.
- Tests: every `core` rule's hit and miss as a table test generated from the pack YAML; overlap scenarios; the pass-2 strict-subset property; determinism (same input → same ids).

### 6.4 `profiles` (Phase 1; selection in Phase 5)

- Schemas for `prosegate.profile/1` and `prosegate.rulepack/1`.
- Resolver: walk `extends` leaf to root, depth ≤ 3, cycle detection, merge root-first per the 04 table (union by id for packs with semver range intersection via `semver`; deep merge for categories, rules and thresholds; union for `allow_terms`; whole-object replace for `reviewer.register`; replace for `reviewer.*`, `enforcement.*`, `trigger.*`). Pack range resolution picks the highest cached version. Errors name the offending pair.
- Snapshot: `{ id, version: "<leaf>+<sha8>", resolved_from, …resolved }`, written to `~/.prosegate/sessions/<id>/profile.json` with mode 0600.
- Local overlay: a local profile with a synced id becomes a child of the synced one; a local pack with a synced id is a rejected conflict naming both.
- Bundled: `core` 0.1.0 and the five starter profiles from 08 (`base`, `pr-description`, `design-doc`, `email`, `chat-reply`) under the `local` namespace for the free tier; `<namespace>/base` always resolvable offline.
- Selection (Phase 5): scorer over `patterns` and `harness_hints`; state machine with `active`, `previous`, `candidate`, `candidate_streak`; the confident-versus-two-turn-candidate rule; sticky reversion after the review completes; `profile <id>` clears candidate state. Scenario tests cover the six steps in 04.

### 6.5 `adapter` (Phase 3; MCP in Phase 5)

CLI `prosegate` with subcommands. Hook entry points read one JSON object on stdin and write one on stdout; exit codes 0/1/2 per 05.

- **Session store** `~/.prosegate/sessions/<session_id>/`: `profile.json`, `state.json` (mode, active/previous/candidate profile, pass counts by `turn_id`, the `review_prose` cache), `turn.json` (current user message and `turn_id`), `report.json` in headless mode. Older session directories are deleted at the next `session-start`.
- `session-start`: resolve the profile (last used for this cwd → account default → base), write the snapshot, emit `inject` (profile name, register constraints, the two tool names) and the `offline` flag, and the 09 version-changed line when the synced profile version moved.
- `turn-start`: store the user message; derive `turn_id` as sha256(session_id + user_message) when the harness supplies none; run the selector; emit the selection-request line or null.
- `turn-end`: build the `ReviewRequest` (user message from `turn.json`; style constraints from CLAUDE.md lines when the shim can supply them, else empty), run the engine then the reviewer under a 6 s overall budget, apply the mode (`enforce | advisory | quiet | off`, plus `PROSEGATE_MODE`), increment the pass count for `turn_id`, render `feedback_text` and the notice, enqueue telemetry, return the decision.
- **Override commands** `advisory | enforce | quiet | off | profile <id> | reload | profile diff | key set | init` write `state.json` for the session named by `PROSEGATE_SESSION`, else the most recent session for the cwd; `advisory` and `off` refuse when org policy is `required`.
- **Keychain**: device key and reviewer key through `@napi-rs/keyring`; 0600 file fallback with a one-time notice.
- **Config client**: device-code flow for `init`; `GET /profiles`, `GET /profiles/{id}` with `If-None-Match`, `GET /rule-packs/{id}/{version}`, `GET /reviewer-prompts/{version}`; Ed25519 verification against the bundled public keys (two trusted for 90 days after a rotation); never called on the turn path.
- **Telemetry**: the 07 allowlisted events built by typed constructors only; batched per minute to `POST /telemetry`; dropped silently offline. A test serialises every outbound payload type, greps for key prefixes (`sk-`, `sk-ant-`, the device-key prefix) and fails the build on a match.
- **Logging**: stderr to `~/.prosegate/logs/<date>.log`; `--debug` writes the turn text locally with a warning.
- **MCP server** (`prosegate mcp`): `list_profiles`, `select_profile`, `review_prose` per 05; `review_prose` rate-limited to one call per turn with a cached result; always pass 1 and never `revise`.
- **Shim: Claude Code** (`shims/claude-code/`): three hook scripts, under 150 lines total, registered by `init` in `~/.claude/settings.json` for `SessionStart`, `UserPromptSubmit` and `Stop` (10 s timeout on Stop); the MCP server registered at user scope. Stop handler: pass `last_assistant_message` as `assistant_text` and `stop_hook_active` as `continuation`; read `tool_use` names from the transcript since the last user message, best-effort. Output per S1: `decision: block` with `reason: feedback_text`, plus `systemMessage` for the notice if S1 confirms it renders; otherwise exit 2 with `feedback_text` on stderr. Mode detection: `CI`, `PROSEGATE_MODE`, else interactive.
- **`init --harness claude-code`**: writes the registrations, runs device-code auth (skippable with `--local` for the free tier), runs `session-start` once, prints the first-session override line.
- Tests: hook entry points as subprocess tests with fixture stdin; a fake harness driver that replays the three 09 mock transcripts end to end and asserts the exact notice and `feedback_text` strings; pass-cap tests across process boundaries (a fresh process per hook call).

### 6.6 `reviewer` (Phase 4)

- Prompt builder: four blocks (user message, constraints, register spec, draft with code blocks replaced by `[code block omitted]`); prompt text and version loaded from the signed `reviewer_prompt/1` artefact, bundled for offline use.
- Provider clients: OpenAI (structured outputs with the 08 JSON schema) and Anthropic (tool use forced to the schema). One interface: `review(prompt, draft, { model, key, timeoutMs }) → RawFindings`.
- Enforcement after parse: category allowlist; `unsupported_claim` text rewritten to the fork; `vague_claim` action forced to `specify`; `register` capped at `warn`; instruction ≤ 160 chars with URL, code and tool-name filters (07 threat 4); confidence ≥ 0.6; at most six findings.
- Span re-find: exact substring in the original draft within prose segments only; attach to the first occurrence; misses counted in `stats` and in telemetry `span_misses`.
- Timeout 4 s, one retry on a network error, none on a model error; a schema failure gets one validated retry; on failure `stats.reviewer` is null and the rules result stands.
- Key source: vended or BYOK from the keychain, one code path; a missing key removes `reviewer` from `stages` with a once-per-session notice.
- Tests: recorded provider responses as fixtures; enforcement table tests; a span re-find property test over the segmenter corpus.

### 6.7 `services/config` (Phase 7)

- Hono router under `/v1`; every body validated with strict zod; `application/problem+json` errors with stable codes; `Idempotency-Key` on mutating routes, stored in a D1 table for 24 h.
- Auth: device bearer keys stored as SHA-256; dashboard sessions from the managed provider (still an open decision; the plan assumes an OIDC provider with MFA and keeps the adapter unaware of it).
- Device flow: `POST /device-codes`; `POST /devices/claim` polled every 5 s, 410 on expiry; `DELETE /devices/{id}` revokes the device and its vended keys.
- Profiles and packs: `GET`, `PUT`, `DELETE` per 06 with server-side resolution reusing `packages/profiles` (allowed in the Worker; the engine is not), ETags, signatures, 409 on delete-while-extended. Pack publish runs hit/miss examples and the 200 ms budget through `packages/engine` in a separate publish Worker or a CI job, never in the API Worker, so 06's "no engine in the bundle" stays true. Decide which in week 1 of Phase 7.
- Signing: Ed25519 private key in a Worker secret; canonical bytes are the stored YAML; signature returned alongside.
- Telemetry: `POST /telemetry` validates against the 07 allowlist (generated from the same zod schema the adapter uses), enqueues to a Queue; the consumer writes `telemetry_events`; a nightly cron aggregates to `telemetry_daily` and deletes raw rows after 180 days.
- Samples: `POST /samples` gated per profile server-side, 600-char cap, 20 per device per day, 90-day deletion cron.
- **Vending**, written against S2 results: the first paid vend creates the per-user project and service account, sets project rate limits sized to the plan (the enforceable ceiling), returns the key once, and stores only `project_id` and `key_id`. The poller runs every 15 minutes, reads `/v1/organization/costs` by `project_ids`, writes `usage_cents`, and applies 07's revoke rules (3× trailing daily average; 80% of cap before day 20) by deleting the service account, emailing the user and flagging the account; two hours without a successful poll suspends the key. Worst-case exposure per key equals the rate limit times the polling interval and is stated in the admin doc.
- Orgs and policy: members and roles; policy merged into org profiles at resolution; `byok_required` disables vending.
- Audit log on profile edits, key events and policy changes.
- Tests: Miniflare or `wrangler dev` integration tests per endpoint; a build step that fails if `packages/engine` or `re2js` appears in the Worker bundle's import graph; a fuzz test that posts unknown fields to every route and expects 422.

### 6.8 `apps/dashboard` (Phase 8, minimal)

Pages app behind the managed auth provider. Screens: device approval (enter `user_code`), profile list and YAML editor with the `/resolved` preview and validation errors, rule-pack list, reviewer keys (status and usage only), samples list with delete, usage charts from `/dashboard/usage`, org members and policy. No design-system work in v0.

### 6.9 `eval/` (Phase 6, parallel from week 4)

- Corpus layout per 10 with gold JSON beside each file; licence recorded per human-control item; the team's own writing in a private sibling repo with the same layout.
- Generation scripts for the AI corpus (four models, two generations, real-style prompts stored beside outputs) with a cost cap per run.
- Annotation CLI: one document at a time, span marks by category, two annotators, an adjudication pass, Cohen's κ per category in the report.
- Runners: `eval:rules` (example pass, false-positive rate, precision, latency versus `baseline.json`; fails on a budget breach or a five-point precision loss); `eval:reviewer --model` (manual, cost-capped); `eval:e2e --model` (clearance, introduced findings, meaning-preserved judge with a 10% human sample, length change, fabrication check). Reports to `eval/reports/<date>-<sha>.json`.
- Gate wiring: `eval:rules` on every PR; `eval:reviewer` and `eval:e2e` on pack and prompt releases; `core.triad.001` ships `warn` only if its control-set false-positive rate holds, else `info`.

## 7. Cross-cutting work

- **Security tests in CI**: key-prefix grep over outbound payload types; engine-absent-from-Worker graph check; RE2-only check at pack load; instruction-text constraints (≤ 200 chars, no URLs, no backticks).
- **Packaging**: tsup single-file builds for Windows, macOS and Linux on x64 and arm64; npm publish with provenance; reproducible-build hash in the release notes; pinned lockfile.
- **Docs**: README per package; admin doc for `enforcement_default: required` that says plainly it costs adoption; privacy page with the 07 wording and nothing stronger.
- **Telemetry review**: adding a field to the allowlist is one PR touching both the shared schema and 07.

## 8. Critical path and parallelism

Critical path: S1 → `schema` and `segmenter` → `engine` and `core` → `adapter` and shim → first live revise on the author's machine at the end of week 4. Everything else hangs off that.

Parallel tracks once Phase 2 starts: eval corpus collection and annotation (needs no code beyond the segmenter); the config service from week 6 (needs only the schemas); the dashboard from week 8 (needs the service).

Sequencing rules: the reviewer is not wired into `turn-end` until the rules path has run for a week on the author's machine, so rule false positives are seen without reviewer noise; vending is not enabled for anyone until S2's exposure number has been accepted in writing.

## 9. Risks

| Risk | Likelihood | Mitigation |
| --- | --- | --- |
| No hard spend cap on vended keys (§1) | Certain per the checked sources | Rate limits plus polling and revoke; stated exposure; `byok_required` for orgs that refuse it; re-check the reference in S2 |
| `systemMessage` not rendered on `Stop` | Possible | The `notice_via_model` fallback is already designed in 09; telemetry measures its failure rate |
| Transcript lag hides tool names at Stop | Likely at times | Hints are advisory; the selector also runs at `turn-start` from the user message |
| `core.triad.001` or a `structure` rule over its false-positive budget on markdown-heavy control docs | Likely for at least one rule | The rule is pulled, not softened (10); the control set includes markdown-heavy docs on purpose |
| Human-control corpus licensing and dating | Moderate | Licence per item; pre-2022 where possible; private corpus for team writing |
| 6 s turn-end cap exceeded on long drafts with the reviewer | Moderate | Reviewer floor and 4 s timeout; rules-only fallback; p95 tracked through telemetry buckets |
| Keyring native dependency breaks single-file packaging | Low after S3 | The 0600 fallback is already the CI path |
| Managed auth provider undecided | Open | Service work starts with device keys only; dashboard auth is the last piece of Phase 7 |

## 10. Definition of done for v0

- `npx prosegate init --harness claude-code` installs in under a minute on all three platforms.
- All 21 `core` rules pass hit/miss; `eval:rules` is green against baseline; the pack runs under 50 ms on 2,000 words.
- The three 09 mock transcripts reproduce byte for byte in the fake-harness test and visually in a live Claude Code session.
- The reviewer eval passes for one small OpenAI model and one small Anthropic model, named with version strings in the report.
- The config service passes the unknown-field fuzz, the engine-absent graph check and the key-prefix grep.
- The 30-day dogfood meets the 01 criteria: under 5% of sessions dropped to advisory, false positives under budget, pass-2 clearance at or above 80%, median added latency under 2 s, three profiles in daily use.
