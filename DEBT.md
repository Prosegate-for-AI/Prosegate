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
| D-17 | Adapter bundle crashes at runtime once it imports `yaml` ("Dynamic require of process"): add a `createRequire` banner in `packages/adapter/tsup.config.ts`, and make `check:bundle` also *execute* the bundle on a real resolve, not just scan specifiers | W1.3 cycle 1 | 3 | open |
| D-18 | Adapter obligations checklist (`docs/notes/adapter-obligations.md`): every item is a Phase 3 test | W1.3 re-verify | 3 | open |
| D-19 | Segmenter accepted gaps: `U.S.`/`Inc.`/`Dr.` never break at a sentence end; lowercase sentence starts merge; no quote detection in headings; `<pre>`, `<details>`, `$$`, unfenced shell transcripts and diffs stay prose; single-quote and post-quote attributions missed. Revisit with eval false-positive data | W1.2 reviews | 6 | open |
| D-20 | Segmenter re-verify accepted residuals: `Ctrl+C.`/`Column B.`/`Appendix B.`/`Grade: B.` merge sentences; `Smith et al. The` merges; `San Francisco, CA.` merges; `- - ```` fence parity; a closing line glued to the last list item (CommonMark); one block_id across adjacent bullet and ordered lists; flags and ★ don't start sentences; post-cue and single-quote attributions | W1.2 re-verify | 6 | open |
