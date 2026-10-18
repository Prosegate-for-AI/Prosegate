# DEBT

Accepted should-fix findings, known gaps and parked ideas. Each has the phase that owns closing it.

| # | Item | Source | Owner phase | Status |
| --- | --- | --- | --- | --- |
| D-1 | Adapter publish metadata: `publishConfig` (access, provenance), `license`, `repository`, `description`; reserve the npm name `prosegate` (publishing = HQ-4) | W0.1 review | 9 | open |
| D-2 | Per-directory LICENSE files (free tree vs `services/`+`apps/`) | W0.1 review; HQ-3 | 9 | blocked on HQ-3 |
| D-3 | Built-Worker-bundle import-graph check (engine, reviewer, re2js absent from the bundle, not just the dependency graph) | plan §6.7 | 7 | open |
| D-4 | vitest `projects` split so Worker integration tests (Miniflare/wrangler) can run beside node tests | W0.1 review | 7 | open |
| D-5 | Dashboard tsconfig: Bundler resolution + DOM lib | W0.1 review | 8 | open |
| D-6 | Device-key format and prefix (`pgd_` assumed by check:secrets) to be fixed in an ADR when the device flow is built | W0.1 review | 7 | open |
| D-7 | Idea: ship the Claude Code integration as a plugin (bundled `hooks/hooks.json` + `.mcp.json`) instead of editing settings; needs a marketplace | S1 docs | post-v0 | idea |
| D-8 | S1 live observation (systemMessage on Stop, prompt_id stability, last_assistant_message fidelity) | S1; HQ-5 | 3 | closed 2026-10-17 |
| D-9 | S2 live run (hard-cap enforcement lag, cost lag, revoke latency → exposure number) | S2; HQ-1 | 7 | blocked on HQ-1 |
| D-10 | Usage poller should read `usage/completions` at 1m/1h buckets for intra-day burn; `/costs` is daily-only (06 "Usage poller" to be updated with S2 data) | S2 | 7 | open |
| D-11 | GitHub Actions workflow never executed (no remote); run it once a private remote exists | Phase 0 exit; HQ-6 | 3 | blocked on HQ-6 |
| D-12 | macOS untested for keyring (ad-hoc signed binaries, upstream #149; keychain ACL tied to node binary) | S3 | 9 | open |
| D-13 | Feedback block is user-visible in Claude Code (ADR-13): every `feedback_text` line needs UX review as user copy | S1 TUI | 3 | open |
| D-14 | (decided ADR-27) A per-rule escape hatch for the first false positive (e.g. `prosegate allow <rule_id>` writing a local overlay with `enabled: false`). Free tier, one-sentence explainable; decide in Phase 3 | W1.1 UX review | 3 | idea |
| D-15 | (decided ADR-27) The model can run `prosegate advisory`/`off` from its own shell tool. Commands must detect an agent-tool context (e.g. `CLAUDECODE` env, no TTY) and refuse or require the user. ADR-16 tells the model not to; that is not enforcement | ADR-16 | 3 | open |
| D-16 | Telemetry `reviewer.model` accepts lowercase whitespace-free text matching the model-id pattern; replace with an allowlist of supported reviewer model ids when Phase 4 fixes the supported pair | W1.1 cycle 1 | 4 | open |
| D-17 | (closed by W3.1, 845d40f) Adapter bundle crashes at runtime once it imports `yaml` ("Dynamic require of process"): add a `createRequire` banner in `packages/adapter/tsup.config.ts`, and make `check:bundle` also *execute* the bundle on a real resolve, not just scan specifiers | W1.3 cycle 1 | 3 | open |
| D-18 | Adapter obligations checklist (`docs/notes/adapter-obligations.md`): every item is a Phase 3 test | W1.3 re-verify | 3 | open |
| D-19 | Segmenter accepted gaps: `U.S.`/`Inc.`/`Dr.` never break at a sentence end; lowercase sentence starts merge; no quote detection in headings; `<pre>`, `<details>`, `$$`, unfenced shell transcripts and diffs stay prose; single-quote and post-quote attributions missed. Revisit with eval false-positive data | W1.2 reviews | 6 | open |
| D-20 | Segmenter re-verify accepted residuals: `Ctrl+C.`/`Column B.`/`Appendix B.`/`Grade: B.` merge sentences; `Smith et al. The` merges; `San Francisco, CA.` merges; `- - ```` fence parity; a closing line glued to the last list item (CommonMark); one block_id across adjacent bullet and ordered lists; flags and ★ don't start sentences; post-cue and single-quote attributions | W1.2 re-verify | 6 | open |
| D-21 | Filler recall 53% on fresh tic text vs 10's 70% target; deterministic lists capped at ADR-26; Phase 4 reviewer and Phase 6 corpus measure and decide | W2.2 cycle 2 | 6 | open |
| D-22 | `prosegate profile diff` (what changed between the last-seen and current profile), removed from the 09 notice until built | ADR-28 | 5 | open |
| D-23 | A reply written entirely as a blockquote, as indented paragraphs or in an unclosed fence is never reviewed (no_prose). Blockquotes are excluded by design (03: users' words); measure how often models do this in the eval corpus | W3.1 security F15 | 6 | open |
| D-24 | 'Fail closed' when re-resolution fails under an org `required` policy has no defined behaviour (hook fails open today). Decide with the config client | W3.1 conformance S5 | 7 | open |
| D-25 | `@prosegate/profiles` should export pre-parsed bundled content at `gen:bundled` time; the adapter re-parses the bundled pack and profile YAML on every hook (~58 ms of the cold path) | W3.1 cycle 1 | 5 | open |
| D-26 | "pass k of <cap>" belongs in the schema renderers; the adapter rewrites "of 2" for cap 1 | W3.1 cycle 1 | 4 | open |
| D-27 | A quoted mention of a flagged phrase without an attribution cue is linted (seen live: a Stop-hook revision request on a reply that quoted the hedge it was describing). Consider treating short quoted spans that exactly equal a rule phrase as mentions, not uses | live incident 2026-10-18 | 6 | open |
| D-28 | `feedback_text`'s last line and the notices say `prosegate <command>`, which fails until the user adds `~/.prosegate/bin` to PATH after an npx install (ADR-33 prints the line but cannot make it so). Measure at dogfood; consider printing the `npx` form when `prosegate` does not resolve | W3.2 UX review | 5 | open |
| D-29 | The shim cannot stop an import-time write to fd 1 by a dependency, or a synchronous engine loop that outlives the watchdog; both end in Claude Code's own kill (fail-open, no visible line) | W3.2 UX review | 3 | open |
| D-30 | The active profile choice is not compared with a baseline: the agent can write `cwd-profiles.json` (or a `local/x` that only `extends: local/design-doc`) and run under a weaker profile across sessions with no lowered line; the notice still names the profile. Fix with Phase 5 selection (selection by the agent is a separate, visible event there) | W3.1 final verify F2 | 8 | open |
| D-31 | Lowered-line dedupe keys on the summary text, and `rule on` is allowed in agent context, so swapping which rule is off (or further weakening under "review thresholds raised", "N allowed terms added", "local profile <id>") is not re-shown in the session or later sessions; only `status` shows it. Key the dedupe on a hash of the effective weakening, not its text | W3.1 final verify F3 | 7 | open |
| D-32 | Lock: a holder stalled > 1 s between `open(wx)` and writing its owner is broken (two holders, lost increments in an injected 1.3 s stall); the `.brk` mutex is unlinked without an ownership check after 2 s. Write the owner to a temp file and `link` it into place | W3.1 final verify F4 | 5 | open |
| D-33 | Untested: stale `.lock.stale.*` sweep, the re-judge under the mutex, the link-back restore (mutants survive). `turn.json` survives a malformed turn-end input and a turn-start throw until the 1 h sweep. Telemetry for a prose-less pass 2 reads `verdict:"pass", cleared:0` with no remaining count | W3.1 final verify F5, F6 | 4 | open |
