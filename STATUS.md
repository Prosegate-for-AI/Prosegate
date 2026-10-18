# STATUS

Snapshot, rewritten at each change. Last updated 2026-10-18.

**Phase:** 3 exited (f7de0a7). **Stopped after Phase 3 at Murray's request**: no Phase 4 work starts until he says so.

## Done

Phases 0–3: spikes; schema, segmenter and profiles; the engine and `core` 0.1.0 (23 rules); the adapter core (W3.1) and the Claude Code shim, launcher and `init`/`uninit` (W3.2). All gates green on master with isolated homes: 3,387 tests.

## Waiting on Murray

- **Urgent:** restore `~/.claude/settings.json` from `settings.json.prosegate-backup-20261018T072200Z` (it still has the stray 03:22 hooks), then start a new session. Optionally delete `~/.prosegate` and `C:\prosegate-guard-probe-home`.
- After the restore, for dogfood: install from the packed tarball (`prosegate` is not on npm yet):
  - `cd packages/adapter && pnpm pack --pack-destination <dir>`
  - `npx --package=<dir>/prosegate-0.0.0.tgz prosegate init --harness claude-code --local`
- `pnpm test:perf` on a quiet machine (HQ-6).
- HQ-7 corpus licensing (most urgent), HQ-1, HQ-2, HQ-3, HQ-4, HQ-6, HQ-8.

## Remaining work

The rest of v0 is on the AI Taskboard as 46 tickets in New, under project Prosegate, with 55 dependency links. `[Human]` tickets are yours and block the agent tickets that need them. The ticket generator is in the session scratchpad (`tbcopy/tickets.mjs`).

## When resumed

1. Brief Phase 4, the reviewer: key store (ADR-14), BYOK, prompt builder, provider clients, D-16, D-21, D-26. Per plan §8, it is wired into turn-end only after the rules path has run a week on Murray's machine.
2. Delete the old W3.2 worktree (`.claude/worktrees/agent-a2d1ea5c6f002cba0`) once the settings restore is confirmed.
3. Priority debt: D-30 (profile choice not compared), D-31 (lowered dedupe keyed on text).
