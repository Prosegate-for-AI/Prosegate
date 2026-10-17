# STATUS

Snapshot, rewritten at each change. Last updated 2026-10-17 (after session restart).

**Phase:** 1 — Contracts (Phase 2 corpus work started in parallel).

## Done this phase

- W1.1 `@prosegate/schema`: merged to master (a69e1d6); 523 package tests, all gates green.

## In flight

| Item | Owner (agent / model) | State |
| --- | --- | --- |
| W1.2 `segmenter` | implementer / sonnet, worktree `agent-aea51b47…` | conformance and adversarial reviews in; tests review resumed after restart; then cycle 1 |
| W1.3 `profiles` + real `core` 0.1.0 | implementer / sonnet, worktree `agent-a6b58ffe…` | cycle 2 of 3 resumed after restart (partial edits were uncommitted) |
| W2.1 corpus-ref example documents (12) | implementer / sonnet, worktree | running |

## Queued

- W1.4 (after W1.3 merges): move the injected-text filter to `schema` (ADR-20); fix its bypasses (accent folding, confusables skeleton, spaced/leet product names, command flags, injection phrasing) and false positives (`Data:`, `#123`, `$20`, CJK punctuation); wire into `findingProblems`; denylist-only pass on ids; final top-tier privacy verify of schema + filter.
- Phase 2 engine brief: S4 pipeline against the real `core.yaml` and the W2.1 documents.

## Waiting on Murray

HQ-1, HQ-2, HQ-3, HQ-4, HQ-6, HQ-7, HQ-8. None blocks Phases 1–2.

## Next three actions

1. Run W1.2's fix cycle once its tests review lands.
2. Accept W1.3 after cycle 2, merge it, and launch W1.4.
3. Brief and launch the Phase 2 engine.
