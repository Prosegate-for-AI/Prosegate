// A worker process for spool.test.ts: `node --import tsx spool-worker.ts <home> <count>` records <count>
// events through the real recordEvents. Two of these racing must not lose an event.

import { createCtx } from "../src/ctx.js";
import { enforcementEvent, recordEvents } from "../src/telemetry.js";

const [home, countText] = process.argv.slice(2) as [string, string];
const ctx = createCtx({ env: {}, home, cwd: "/work/project", elapsedMs: () => 0 });
for (let i = 0; i < Number(countText); i++) recordEvents(ctx, [enforcementEvent({ decision: "allow", overrideUsed: false })]);
