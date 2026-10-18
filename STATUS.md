# STATUS

Snapshot, rewritten at each change. Last updated 2026-10-18.

**Phase:** 3 — Adapter and Claude Code shim. Phases 0–2 exited (ledger).

## In flight

| Item | Owner (agent / model) | State |
| --- | --- | --- |
| W3.1 adapter core | sonnet (implementer); top tier (re-verify) | cycle 1 merged provisionally (aa9c772): 3,178 tests, all gates green. Top-tier re-verify of security and cross-process behaviour running |
| W3.2 Claude Code shim, `init`, 09 goldens, live revise | implementer / sonnet, worktree | started |

## Phase 3 exit needs (plan §4)

- `npx prosegate init` works on the author's machine. My test is project scope in a scratch project; the user-scope install is Murray's to run.
- A pass-1 revise seen live.
- Override commands work.
- A headless report is written.
- The three 09 mock transcripts reproduce byte for byte in the fake-harness test (plan §10).

## Waiting on Murray

- `pnpm test:perf` on a quiet machine: the Phase 2 caveat.
- HQ-7: corpus licensing.
- HQ-6: private remote / CI.
- HQ-1: vending.
- HQ-2, HQ-3, HQ-4, HQ-8.

## Next three actions

1. Act on the W3.1 re-verify (cycle 2 if needed).
2. Review W3.2: conformance, UX, tests, and a top-tier check of the shim's fail-open and its live behaviour.
3. Phase 3 exit, then a status message. Then brief Phase 4 (reviewer: key store per ADR-14, BYOK, prompt builder, provider clients).
