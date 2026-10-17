# Prosegate — Design Docs v0

Oct 17, 2026 · @Murray le Roux

## What this is

Prosegate is a prose linter for AI-agent output. The originating model writes and revises; the engine only detects and instructs. It runs on the user's machine as a harness adapter and local MCP server, enforces at turn end through the harness's stop hook, and never sends prose to Prosegate's own service.

The shape, decided 2026-10-17:

- Local adapter (TypeScript, open source): deterministic rule engine, reviewer client, profile selector, telemetry, one hook shim per harness. Serves `select_profile` and `review_prose` as MCP tools.
- Config service (Cloudflare Workers, D1, Pages): accounts, profiles, versioned rule packs and reviewer prompts, device keys, vended reviewer keys, metadata telemetry. No endpoint accepts prose, except the opt-in samples endpoint, which is off by default and capped at 600 characters per excerpt.
- Reviewer: any cheap competent model, called directly from the adapter. Key is either vended (one OpenAI project per user with a hard spend cap) or the user's own. One code path, two key sources.
- Enforcement on by default; one command drops a session to advisory. Pass cap of two.
- First customer: engineering teams running agentic harnesses, starting with the author's own team. Claude Code adapter ships first.

Prosegate is a working codename, not a decision. Package names in 05 and endpoint names in 06 assume it and change with it.

## At a glance

&#91;embedded content: components and what calls what · 5 parts, 2 prose-free links\]

The harness calls the adapter through hooks and MCP tools and gets findings back; the adapter talks to the config service without prose and to the reviewer provider with it; the config service reaches the provider's admin API only to vend, poll and revoke keys.

## Tabs and reading order

Read 03, 04 and 05 first; they are the contracts everything else consumes. Then 08 and 07, then the rest.

| # | Tab | Holds | Status |
| --- | --- | --- | --- |
| 03 | 03 Findings schema | The JSON contract between rule engine, reviewer, hook and UI | Draft |
| 04 | 04 Profile & rule-pack schema | YAML for profiles and rule packs, inheritance, selection, versioning | Draft |
| 05 | 05 Harness adapter contract | What every harness shim implements; Claude Code as reference | Draft |
| 08 | 08 Rule catalogue & rubric | Every v0 rule with examples; the reviewer prompt and output | Draft |
| 07 | 07 Privacy & threat model | Data flows, key handling, vended-key abuse model, telemetry allowlist | Draft |
| 01 | 01 Scope brief | Problem, customer, non-goals | Draft |
| 02 | 02 Decision log | ADRs with rejected alternatives | Draft |
| 06 | 06 Config service API | Config service endpoints | Draft |
| 09 | 09 Enforcement UX | What the user sees at turn end; override; mock transcripts | Draft |
| 10 | 10 Eval plan | Corpus, control set, false-positive budget, regression harness | Draft |
