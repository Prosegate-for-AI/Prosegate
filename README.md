# Prosegate

Status: pre-release. Local rules, Claude Code hooks, MCP tools and automatic profile suggestions are implemented. An explicit BYOK reviewer preview is available; automatic reviewer hooks remain gated on one week of rules-only dogfood.

A prose linter for AI-agent output. It runs locally as a CLI and enforces at turn end through Claude Code's Stop hook. Its MCP tools list and select profiles and check drafts; turn-start heuristics prompt the model to choose a suitable profile. Design docs are in `docs/`; the build order is `docs/11 Implementation plan.md`.

For the manual AI-review preview, provider data flow, key commands and request format, see [the reviewer README](packages/reviewer/README.md). No provider calls run during normal hooks in this build.

For MCP setup, automatic profile suggestions, one-shot profiles and session binding, see [the adapter guide](packages/adapter/README.md). Re-run `prosegate init --harness claude-code --local` from the newly built package to add MCP to an existing hook installation, then start a new Claude session. See `STATUS.md` for registry availability; use a prepared tarball before publication, or `prosegate@next` for a published preview.

Phase 6's corpus, annotation, budgeted generation and quality-reporting tools are implemented. See
[the evaluation guide](eval/README.md). Corpus collection, independent human labels and live model
qualification remain pending; empty corpora produce PARTIAL reports.

Phase 7's configuration API, device authorization, signed configuration, org policy,
telemetry and opt-in samples are implemented. See [the service operations guide](services/config/README.md).
Hosted deployment/auth onboarding and the S2-gated live vending bridge remain
integration work. Phase 8's Pages dashboard is implemented, with managed sign-in,
device approval, profile editing, key status, samples, usage and organization settings.
See [the dashboard setup guide](apps/dashboard/README.md) for configuration and browser tests.

- `packages/` - the open engine: `schema`, `segmenter`, `engine`, `profiles`, `reviewer`, `adapter` (the `prosegate` CLI, bundled to one file). The bundled `core` pack and starter profiles will live in `packages/profiles`.
- `eval/` - the runners and annotation tooling are open. Corpora carry per-item licences; private material (the team's own writing) lives outside this repo.
- `services/config/` - the config service (Cloudflare Worker): sync, key vending, org policy.
- `apps/dashboard/` - the web dashboard for the config service.
- `scripts/` - repo guard checks (`check:deps`, `check:secrets`, `check:bundle`).

Open-core line: `packages/` + `eval/` + the bundled pack and profiles are the free, open surface. `services/` + `apps/` are the paid service.

No code under `packages/` may depend on `services/` or `apps/`, and `services/config` must never pull in the engine, reviewer, adapter, segmenter or `re2js`. `pnpm check:deps` enforces both against the installed dependency tree and the source imports, and CI runs it.

Common commands: `pnpm install`, `pnpm build`, `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm check:deps`, `pnpm check:secrets`, `pnpm check:bundle`, `pnpm eval:rules`. Dependencies are pinned to exact versions.

Local tools, packs, profiles and evaluation tooling are Apache-2.0. The service and
dashboard use FSL-1.1-ALv2, with each version converting to Apache-2.0 after two years.
See [licensing](LICENSE.md), [privacy](PRIVACY.md), [administrator guide](docs/ADMIN.md)
and [release procedure](RELEASING.md). The current package version is `0.1.0-alpha.3`;
release-candidate qualification and actual npm publication remain separate gates.
