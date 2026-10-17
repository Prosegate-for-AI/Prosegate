# 02 — Decision log

Seven decisions constrain everything else. Each is a paragraph, dated, with the alternatives it beat. Reopen one only with a new entry that supersedes it; never edit history.

## ADR-1 · The originating model is the only writer

2026-10-17. Prosegate detects and instructs; the model that wrote the text revises it, with its own context. Rejected: a second model rewriting the output (loses the user's intent, the codebase's terms of art, and the reason a hedge was there); a one-shot paraphraser (commodity, lossy). Consequence: the findings schema (03) is an instruction format, not a diff format, and quality depends on how actionable each instruction is.

## ADR-2 · Prose never reaches Prosegate's servers

2026-10-17. Deterministic rules run in the local adapter; the reviewer is called from the local adapter directly; the config service has no text endpoint. Rejected: a hosted review API on Workers (simplest to build, but the privacy claim becomes a retention promise that cannot be verified); a hosted relay inside confidential compute (verifiable, roughly $50–150/month in infrastructure, two to four weeks of engineering for attestation and reproducible builds, and a long-running VM beside a Workers stack). Consequence: the Workers service is a config server; the adapter carries almost all the engineering; the privacy page can say "no code path" and be true.

## ADR-3 · Reviewer keys are vended or user-supplied, one code path

2026-10-17. The adapter calls the reviewer provider with whatever key it holds; the key comes from Prosegate's vending endpoint (an OpenAI project per user with a hard spend cap) or from the user's keychain. Rejected: BYOK only (an onboarding cliff for subscription-only users who have never created an API key); hosted-only (reintroduces a text path); a self-review mode where the harness's own model does the judgement pass (spends the expensive model's context on the engine's work). Consequence: Prosegate is the billing party for vended inference and needs usage polling and auto-revoke from day one (07).

## ADR-4 · The reviewer model is interchangeable

2026-10-17. Any cheap model that supports structured output and passes the rubric eval (10) is supported; the first supported pair is one small OpenAI model and one small Anthropic model. Rejected: Haiku specifically. Reason: the Anthropic Admin API cannot create API keys, so vending requires a provider whose admin API can; tying the reviewer to one provider would force the hosted path back to a relay. Consequence: the reviewer prompt is written against a schema, not a model, and is re-evaluated per model per release.

## ADR-5 · Enforcement by hook, on by default, with a session override

2026-10-17. The harness's turn-end hook continues the model with the findings when any `block` finding exists; a single command drops the session to advisory. Rejected: advisory by default with enforcement as a team feature (the author's own team is the first customer and wants enforcement; advisory findings get ignored); enforcement with no override (gets uninstalled at the first false positive). Consequence: the false-positive budget in 10 is a hard gate on every rule, and the override is visible in telemetry so rule quality is measurable.

## ADR-6 · Agent-agnostic contract, Claude Code adapter first

2026-10-17. The shim interface (05) is defined independent of any harness; only the Claude Code shim ships in v0. Rejected: three adapters at launch (stalls the project before the findings format has met real output); Claude Code-specific hook JSON baked into the contract (would have to be unpicked for the second harness). Consequence: the capability matrix carries "to verify" entries for Cursor and Codex until someone checks their current hook surfaces.

## ADR-7 · Open-core

2026-10-17. Adapter, rules engine, bundled `core` pack and starter profiles are open source; the config service's sync, vending, org features and dashboards are the paid product. Rejected: closed adapter (contradicts ADR-2, since "audit the code that touches your text" is the proof); fully open including the service (nothing to sell). Consequence: a solo user can run the deterministic tier forever from a local YAML, and that is intended.

## Open, not yet decided

- Product name. "Prosegate" is a working codename.
- Managed auth provider for the config service.
- Whether `register` findings should ever be `block`. Currently capped at `warn` (08).

## ADR-8 · Vended keys: provider hard spend limit, plus rate limits, polling and revoke

2026-10-17. Refines ADR-3; its decision (vended or user-supplied, one code path) stands. Plan 11 §1 recorded that OpenAI's Administration API had no hard per-project spend cap. That fact is out of date: the official OpenAPI spec (openai/openai-openapi, 2026-07-23 onward) defines `/v1/organization/projects/{id}/spend_limit` as a "hard spend limit" (`threshold_amount` in cents, monthly), with requests over it failing 429 `project_spend_limit_exceeded`; OpenAI's guide says enforcement is not instantaneous and spend can slightly exceed the limit. Each vend therefore sets, on the user's project: the hard spend limit at the plan budget ($5/month default), per-model rate limits sized to the plan, a model allowlist restricted to the supported reviewer model, and an expiry on the service account; the 15-minute poller and the 07 anomaly revoke stay as the second line. Worst-case exposure per key = spend limit + rate-limited spend per minute × measured enforcement lag; S2 measures the lag and the admin doc states the number. Rejected: rate limits and polling alone (the plan's draft; weaker now that the provider enforces a limit); trusting the provider limit alone (enforcement lag is undocumented and a stolen key can burn until it lands). Consequence: 07 key handling describes both lines; vending stays off for every user until the product owner accepts the S2 exposure number in writing (plan 11 §8).

## ADR-9 · Claude Code Stop hook mapping: `last_assistant_message`, `prompt_id`, `systemMessage`

2026-10-17. Adopts plan 11 §2 corrections 1, 3 and 4. The Stop shim takes the turn text from `last_assistant_message` (the docs warn the transcript may lag at Stop time) and reads the transcript only for tool-use names, best-effort. `turn_id` is the harness's `prompt_id` when present, else sha256(session_id + user message) as 05 already allows. The shim continues the model with `{"decision":"block","reason":feedback_text}` and carries the user notice in the same object's `systemMessage`, which the docs describe as shown to the user on every event that does not discard it, and Stop does not. The `notice_via_model` route in 09 remains behind an adapter switch (`render_channel: system_message | via_model`) for harnesses without a channel and in case the live S1 run contradicts the docs. Rejected: transcript parsing for the text (lags; reads more of the user's session than needed, against 07 threat 6); exit 2 as the primary path (stderr loses the `systemMessage` channel). Consequence: 05's capability matrix and mapping change; 09's "to be verified" becomes "`systemMessage`, with the model-carried notice as fallback". Evidence: `docs/spikes/S1.md`; the live observation is pending (HQ-5) and can only flip the switch's default.

## ADR-10 · Rule latency is measured warm; the cold hook process has its own budget

2026-10-17. Spike S4 measured the `core` pack on re2js. Run as one `\b…\b` `(?i)` alternation per rule over the whole document, it takes 59 ms p95 on 2,000 words, over 05's 50 ms. Run on an ASCII-lowercased copy, per paragraph, with word boundaries checked in JS (offsets unchanged, Unicode-correct), it takes 7.7 ms p95 warm. Every Claude Code hook is a fresh process (05, plan 11 §1), so each `turn-end` also pays pack compilation and the first run cold, about 54 ms p50 / 86 ms p95, plus about 17 ms of module load. Decision: 05's "rules under 50 ms for 2,000 words" means rule execution on a loaded pack, which is what `stats.rules_latency_ms` reports and the eval budget gates. A second budget covers the whole cold path: `prosegate turn-end` with the reviewer stage off, spawn to exit, at most 400 ms p95 on the 2,000-word fixture on the CI runner, enforced by a test. Rejected: a long-lived daemon for warm matching (a second resident process, IPC and lifetime bugs, for under 100 ms against a 6 s cap and a 2 s median target); native `re2` for the CLI (node-gyp breaks the single-file build that S4 shows is unnecessary); counting cold compile against the 50 ms rule budget (makes the gate measure Node startup, not rules). Consequence: the engine adopts S4's matching pipeline and the 1:1 typographic normalisation; `mcp_tool` hooks stay the later optimisation noted in plan 11 §1.

## ADR-11 · Stop continuation uses `additionalContext`, not `decision: "block"`

2026-10-17. Supersedes ADR-9's continuation mechanism; the rest of ADR-9 stands. The live S1 run on Claude Code 2.1.278 showed that `{"decision":"block","reason":…}` and exit 2 both continue the model, and both make Claude Code raise a user notification reading "Stop hook error occurred · ctrl+o to see". `{"hookSpecificOutput":{"hookEventName":"Stop","additionalContext":feedback_text}}` continues the model identically: two passes, `stop_hook_active` false → true → true, `prompt_id` constant. It raises no error notification. `systemMessage` in the same object reaches the user as an informational line prefixed by the harness with "Stop says: ". Decision: the shim continues with `additionalContext` and carries the notice in `systemMessage`; exit 2 remains the fallback only if JSON output fails. Rejected: `decision: "block"` (labels every Prosegate revision an error, which reads as a broken install to the first user and fails 09's "always able to act on it"). Consequence: 05's Stop mapping row changes; the "Stop says: " prefix is outside Prosegate's control and is recorded in 09 so the golden tests compare the `systemMessage` string, not the terminal line.

## ADR-12 · Notice and feedback_text rendering details

2026-10-17. 03 and 09 fix the strings but leave these choices open; the 09 mock transcripts constrain them, and they are now fixed so the golden tests are deterministic.
- Notice finding lines and the per-category counts in the notice line are in 03 `Category` order, then document order within a category. The first mock lists hedge, vocab, triad, although "robust" precedes the hedge in the text. `feedback_text` stays in document order (03).
- Finding line: two spaces; category label (underscore → space) padded to max(8, longest label shown + 2); then, only if any shown finding has a rule id, a rule-id column padded to the longest id + 2, blank for reviewer findings; then the span in double quotes.
- Trimming (60 chars in the notice, 80 in `feedback_text`) counts Unicode code points; a longer span becomes its first N−1 code points plus "…".
- "finding(s)" in the 03 template is a placeholder: render "1 finding" / "n findings" in both strings.
- The notice names the profile by its slug (`pr-description`); `feedback_text` uses the full id (03).
- `info` findings never appear in the notice or its counts.
- At most six finding lines; further findings are counted in the notice line, not listed. The first notice of a session shows at most five, then `  Session override: prosegate advisory` (09 requires the first notice to name the override; the seven-line budget holds).
- Pass 2 summary "k of n findings remain": n is the pass-1 `block` count, and noun and verb agree with n ("1 of 1 finding remains").
- Pass-cap check: the `turn-end` call after pass 2 reviews the final text filtered to surviving pass-1 `block` ids, returns `verdict: 'pass'` with `skipped_reason: 'pass_cap'` (03 rule 3), and the notice "k finding(s) remain(s) after 2 passes · shipped as is" appears only when k > 0. This is how 09's mock can know a claim was "still present".
- `render_channel: via_model` (ADR-9) inserts `Begin your revised response with this line, verbatim: <notice line>` as the second-to-last line of `feedback_text`; the override line stays last (03).

Rejected: document order in the notice (contradicts the mock); a seventh line for the override (breaks the 09 budget). Consequence: `@prosegate/schema` renderers implement exactly this, with golden tests from 09 plus a first-notice variant.
