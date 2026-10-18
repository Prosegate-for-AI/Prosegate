// A worker process for locks.test.ts: `node --import tsx lockrace-worker.ts <dir> <rounds> <holdMs> <stepMs>`.
// For each round r it waits for START_AT + r * stepMs (a shared epoch, so every worker contends in the
// same instant), takes `<dir>/l<r>.lock` with the real withLock and logs `enter` and `exit` times to
// `<dir>/l<r>.log`. Overlapping enter..exit intervals in one round mean the lock failed to be exclusive.

import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { sleepSync, withLock } from "../src/fs-secure.js";

const [dir, rounds, holdMs, stepMs] = process.argv.slice(2) as [string, string, string, string];
const start = Number(process.env["START_AT"]);
const stamp = (): number => performance.timeOrigin + performance.now();
/** Sleeps until `at`, then spins the last few milliseconds: every worker leaves within about a millisecond of the others, without burning CPU while it waits. */
function waitUntil(at: number): void {
  for (;;) {
    const left = at - Date.now();
    if (left <= 0) return;
    if (left > 4) sleepSync(left - 3);
  }
}
for (let r = 0; r < Number(rounds); r++) {
  waitUntil(start + r * Number(stepMs));
  const log = join(dir, `l${r}.log`);
  try {
    withLock(
      join(dir, `l${r}.lock`),
      () => {
        appendFileSync(log, `enter ${process.pid} ${stamp()}\n`);
        sleepSync(Number(holdMs));
        appendFileSync(log, `exit ${process.pid} ${stamp()}\n`);
      },
      { timeoutMs: 8000 },
    );
  } catch (error) {
    appendFileSync(log, `fail ${process.pid} ${(error as Error).name}\n`);
  }
}
