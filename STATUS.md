# STATUS

Snapshot, rewritten at each change. Last updated 2026-10-18.

**Phase:** 3 — Adapter and Claude Code shim. Phases 0–2 exited (ledger).

## In flight

| Item | Owner (agent / model) | State |
| --- | --- | --- |
| W3.1 adapter core | — | **Exited.** Merged a6d4491 after 3 cycles plus one orchestrator fix; all gates green (3,222 tests); debt D-30 to D-33 |
| W3.2 Claude Code shim, `init`, 09 goldens, live revise | implementer / sonnet, branch `w32-cycle1` in a scratch worktree | Cycle 1 of 3 running: test isolation (incident), ADR-32/33 (stable launcher, `settings.local.json`, one registration, rollback), shim fail-open hardening, one notice per turn |

## Phase 3 exit needs (plan §4)

- `npx prosegate init` works on the author's machine. The verifier said not yet; it waits on W3.2 cycle 1. My test is project scope in a scratch project; the user-scope install is Murray's to run.
- A pass-1 revise seen live. Done by the W3.2 verifier: continue, pass 2, shipped as is, and the advisory notice were all seen in Claude Code 2.1.302.
- Override commands work. W3.1 covers these.
- A headless report is written. W3.1 covers this.
- The 09 mock transcripts reproduce byte for byte. This needs a re-run after ADR-33 changed 09.

## Waiting on Murray

- **Urgent:** restore `~/.claude/settings.json` from `settings.json.prosegate-backup-20261018T072200Z`. It still holds the stray hooks, and every session runs the W3.2 worktree's shim. Then, optionally, `rm -rf ~/.prosegate`, which holds 82+ stray session directories, all local.
- `pnpm test:perf` on a quiet machine: the Phase 2 caveat (HQ-6).
- HQ-7: corpus licensing.
- HQ-1: vending.
- HQ-2, HQ-3, HQ-4, HQ-8.

## Next three actions

1. Review W3.2 cycle 1: conformance and a top-tier adversarial pass. Merge, run the gates, re-run the 09 goldens.
2. Phase 3 exit, then a status message. Murray runs `npx prosegate init` (user scope) once the restore is done.
3. **Stop.** Murray asked to stop after Phase 3 (2026-10-18). No Phase 4 work starts until he says so.
