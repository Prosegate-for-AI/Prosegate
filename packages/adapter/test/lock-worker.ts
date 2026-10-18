// A worker process for locks.test.ts: `node --import tsx lock-worker.ts <home> <session> <count>`.
// It does <count> read-modify-write increments of a counter in state.json through the real
// SessionStore.updateState, then prints `done`. Two of these racing must not lose an increment.

import { createCtx } from "../src/ctx.js";
import { SessionStore, defaultState } from "../src/store.js";

const [home, sessionId, countText] = process.argv.slice(2) as [string, string, string];
const ctx = createCtx({ env: {}, home, cwd: "/work/project", elapsedMs: () => 0 });
const store = new SessionStore(ctx, sessionId);
const fallback = () => defaultState(ctx, { session_id: sessionId, harness: "claude-code", cwd: "/work/project", context_mode: "interactive", active_profile: "local/base" });
for (let i = 0; i < Number(countText); i++) {
  store.updateState(fallback, (s) => ({ ...s, candidate_streak: s.candidate_streak + 1 }));
}
process.stdout.write("done\n");
