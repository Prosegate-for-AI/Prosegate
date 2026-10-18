import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { callHook } from "../src/hook-bridge.js";
import { tmpDir } from "./helpers.js";

// The in-process call of the adapter's hook commands, through the real adapter in a temp Prosegate home.

let saved: string | undefined;
let home: string;
beforeEach(() => {
  saved = process.env["PROSEGATE_HOME"];
  home = tmpDir("pg-bridge-");
  process.env["PROSEGATE_HOME"] = home;
});
afterEach(() => {
  if (saved === undefined) Reflect.deleteProperty(process.env, "PROSEGATE_HOME");
  else process.env["PROSEGATE_HOME"] = saved;
});

describe("callHook", () => {
  it("returns the command's JSON and its stderr", async () => {
    const r = await callHook("session-start", { harness: "claude-code", session_id: "s-1", cwd: home, mode: "interactive" });
    expect("out" in r).toBe(true);
    if ("out" in r) {
      expect(r.out["active_profile"]).toBe("local/base");
      expect(typeof r.out["inject"]).toBe("string");
    }
  });

  it("a command that fails is a problem with the reason and log path from the adapter's own stderr line, never an exception", async () => {
    const r = await callHook("turn-end", { session_id: "s-1", nonsense: true });
    expect("problem" in r).toBe(true);
    if ("problem" in r) {
      expect(r.problem.why).toBe("invalid hook input");
      expect(r.problem.where).toMatch(/\.log$/);
      expect(r.problem.detail).toMatch(/^turn-end: exit 1: /);
    }
  });
});
