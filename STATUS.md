# STATUS

Snapshot, rewritten at each change. Last updated 2026-10-17.

**Phase:** 2 — Engine and `core` 0.1.0. Phase 1 exited (ledger, HEAD ed1e414).

## In flight

| Item | Owner (agent / model) | State |
| --- | --- | --- |
| W2.2 `@prosegate/engine` | implementer / sonnet, worktree `agent-a9a52c09…` | cycle 1 of 3: ADR-23 ids, ADR-24 (document scope, pr-description, structure.004, wraps/hyphens, recall variants, bounded work), `\b` alternatives, 33 witness tests, realistic regression fixtures |
| W2.3 `eval:rules` harness | implementer / sonnet, worktree `agent-ac1dd4c3…` | cycle 1 of 3: strictest-severity gating, unfinished-rule FP, pre-overlap candidates, baseline and partial headline, 18 mutation survivors |

Both are merged provisionally to master; neither has exited.

## Phase 2 exit needs (plan §4)

All core rules pass hit/miss (23/23 now); the pack runs under 50 ms on 2,000 words (`pnpm test:perf` on a quiet machine); `eval:rules` runs and the gates are proven by planted breaches. The realistic false-positive evidence from ADR-24 is a quality gate I am adding myself: zero block findings on the 90 natural clean replies.

## Waiting on Murray

HQ-1, HQ-2, HQ-3, HQ-4, HQ-6, HQ-7, HQ-8. HQ-7 (corpus licensing) is needed by week 4 — the eval FP gate has no data until then.

## Next three actions

1. Verify W2.2 cycle 1 with a top-tier re-run of the realistic FP and pass-2 harnesses; verify W2.3 cycle 1.
2. Phase 2 exit check, then a status message.
3. Brief Phase 3: adapter and Claude Code shim, against `docs/notes/adapter-obligations.md` and the 09 goldens.
