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
