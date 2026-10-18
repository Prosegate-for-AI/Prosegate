# STATUS

Snapshot, rewritten at each change. Last updated 2026-10-18.

**Phase:** 2 closing (engine final cycle), Phase 3 started in parallel.

## In flight

| Item | Owner (agent / model) | State |
| --- | --- | --- |
| W2.2 `@prosegate/engine` | implementer / sonnet | cycle 2 of 3 (final): ADR-26 id-key normalisation, label bold, filler.003 sentence-start, wider filler lists, allow_terms. Re-verify verdict on cycle 1b: fit for Phase 3 dogfood |
| W3.1 adapter core (`prosegate` CLI) | implementer / sonnet, worktree | started |

## Done in Phase 2

W2.1 rule-example docs; W2.3 `eval:rules` harness (exited); engine cycles 1 and 1b merged to master (a96a738). All gates green: 2,732 tests and 88 perf tests.

## Phase 2 exit needs

Engine cycle 2 merged and green; `pnpm test:perf` green; 23/23 rules hit/miss; `eval:rules` runs (PARTIAL until corpora exist).

## Phase 3 plan

- W3.1: adapter core (entry points, session store, pass cap, modes, commands with ADR-27, telemetry spool, the D-17 bundle fix).
- W3.2: Claude Code shim, `init --harness claude-code` (project or user scope), fake-harness byte-for-byte goldens from 09, headless summary, and a live revise in a scratch project via the terminal.

## Waiting on Murray

HQ-1, HQ-2, HQ-3, HQ-4, HQ-6, HQ-7, HQ-8. A user-scope `init` on Murray's machine edits `~/.claude/settings.json`; I will test project-scope only and leave the user-scope install to Murray.

## Next three actions

1. Merge engine cycle 2; Phase 2 exit; status message.
2. Review W3.1 (all six dimensions: it is the turn path).
3. Brief W3.2.
