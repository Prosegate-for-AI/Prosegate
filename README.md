# Prosegate

Status: pre-release. Nothing here is usable yet.

A prose linter for AI-agent output. It runs locally as a CLI and MCP server and enforces at turn end through Claude Code's Stop hook. Design docs are in `docs/`; the build order is `docs/11 Implementation plan.md`.

- `packages/` - the open engine: `schema`, `segmenter`, `engine`, `profiles`, `reviewer`, `adapter` (the `prosegate` CLI, bundled to one file). The bundled `core` pack and starter profiles will live in `packages/profiles`.
- `eval/` - the runners and annotation tooling are open. Corpora carry per-item licences; private material (the team's own writing) lives outside this repo.
- `services/config/` - the config service (Cloudflare Worker): sync, key vending, org policy.
- `apps/dashboard/` - the web dashboard for the config service.
- `scripts/` - repo guard checks (`check:deps`, `check:secrets`, `check:bundle`).

Open-core line: `packages/` + `eval/` + the bundled pack and profiles are the free, open surface. `services/` + `apps/` are the paid service.

No code under `packages/` may depend on `services/` or `apps/`, and `services/config` must never pull in the engine, reviewer, adapter, segmenter or `re2js`. `pnpm check:deps` enforces both against the installed dependency tree and the source imports, and CI runs it.

Common commands: `pnpm install`, `pnpm build`, `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm check:deps`, `pnpm check:secrets`, `pnpm check:bundle`, `pnpm eval:rules`. Dependencies are pinned to exact versions.

Licensing is pending a product-owner decision; no licence applies yet.
