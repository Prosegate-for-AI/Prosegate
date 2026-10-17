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
