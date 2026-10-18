// A harness shim calls the adapter's hook commands in its own process (the bundle is imported, not spawned: a second Node costs a
// whole process start on every hook). This is that call: the command runs in-process with its stdin and output in memory, and a
// failure comes back as a `problem` the shim's launcher logs and shows, never as an exception or a stack trace (ADR-34).

import { run } from "./run.js";

export interface HookProblem {
  /** Words for the user: "internal error", "input too large", ... taken from the adapter's own stderr line when it has one. */
  why: string;
  /** The log file the adapter named, if it did. */
  where: string | null;
  /** For the log only: may name files and error codes, never prose. */
  detail: string;
}

export type HookCall = { out: Record<string, unknown>; stderr: string } | { problem: HookProblem };

/** `... (turn-end failed: <why>); ...` */
const WHY = /failed: ([^)]+)\)/;
const DETAILS = /Details: (.+?)\s*$/m;

export async function callHook(command: string, payload: unknown): Promise<HookCall> {
  let stdout = "";
  let stderr = "";
  const problem = (detail: string): HookCall => ({
    problem: { why: WHY.exec(stderr)?.[1] ?? "internal error", where: DETAILS.exec(stderr)?.[1] ?? null, detail: `${command}: ${detail}` },
  });
  try {
    const code = await run([command], {
      stdin: () => Promise.resolve(JSON.stringify(payload)),
      stdout: { write: (s) => void (stdout += s) },
      stderr: { write: (s) => void (stderr += s) },
    });
    if (code !== 0) return problem(`exit ${String(code)}: ${stderr}`);
  } catch (error) {
    const e = error as { code?: unknown; message?: unknown };
    return problem(`${typeof e.code === "string" ? e.code : "error"}: ${String(e.message)}`);
  }
  try {
    return { out: JSON.parse(stdout) as Record<string, unknown>, stderr };
  } catch {
    return problem("the adapter's output was not JSON");
  }
}
