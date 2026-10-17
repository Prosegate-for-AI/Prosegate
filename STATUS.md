# STATUS

Snapshot, rewritten at each change. Last updated 2026-10-17.

**Phase:** 1 — Contracts. Phase 0 exited (ledger, HEAD 798787d).

## In flight

| Item | Owner (agent / model) | State |
| --- | --- | --- |
| W1.1 `schema` | implementer / sonnet, worktree `agent-ae9aecbb…` | 3 of 4 reviews in (conformance, UX, privacy); tests review pending → then cycle 1 |
| W1.2 `segmenter` | implementer / sonnet, worktree `agent-aea51b47…` | implementing |
| W1.3 `profiles` + `core` 0.1.0 YAML | implementer / sonnet, worktree `agent-a6b58ffe…` | review cycle 1 of 3 in progress (4 reviews: conformance, correctness, tests, security/top-tier) |

## Spec changes this phase

ADR-15 (core corrections, `any` match kind), ADR-16 (feedback_text is user copy), ADR-17 (contract clarifications), ADR-18 (org policy binds the session; severity precedence), ADR-19 (allowlisted injected text, signed policy, pack caps, YAML hardening), 04 range semantics.

## Blocked / waiting on Murray

HQ-1 (S2 run), HQ-2 (auth), HQ-3 (licences), HQ-4 (name), HQ-6 (private remote), HQ-7 (corpus licensing), HQ-8 (paid eval work). None blocks Phase 1 or 2.

## Next three actions

1. Send the W1.1 cycle 1 once its tests review lands; review W1.2 when it reports (top-tier verify on offsets).
2. Merge W1.1–W1.3 into master once each exits; run the Phase 1 proving command.
3. Brief Phase 2: engine on S4's pipeline against the real `core.yaml`, corpus-ref example files, and `eval:rules`.
