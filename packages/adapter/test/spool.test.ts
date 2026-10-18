import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { trimUserMessage } from "../src/hooks.js";
import { SPOOL_MAX_EVENTS, encodeBatch, enforcementEvent, readSpool, recordEvents } from "../src/telemetry.js";
import { ADAPTER_DIR, TIC_TEXT, buildBundle, json, pg, sessionStartInput, testCtx, testHooks, tmpDir, turnEndInput } from "./helpers.js";

// The telemetry spool (07, ADR-30) and the last-resort handlers: bounds to the event, a spool that cannot
// be written never fails a turn, two processes append without losing events.

vi.setConfig({ testTimeout: 180_000 });

let bundle = "";
let testBundle = "";
beforeAll(async () => {
  bundle = await buildBundle();
  testBundle = await buildBundle("test");
}, 240_000);

const count = (ctx: ReturnType<typeof testCtx>): number => readSpool(ctx).reduce((n, l) => n + (JSON.parse(l) as { events: unknown[] }).events.length, 0);

describe("the spool bound is exactly 1,000 events (TL3, TL4)", () => {
  const seed = (home: string, n: number, t: number): void => {
    mkdirSync(join(home, "telemetry"), { recursive: true });
    const lines = Array.from({ length: n }, (_, i) => encodeBatch([enforcementEvent({ decision: "allow", overrideUsed: i === 0 })], t));
    writeFileSync(join(home, "telemetry", "spool.jsonl"), `${lines.join("\n")}\n`);
  };

  it("the literal is 1000", () => {
    expect(SPOOL_MAX_EVENTS).toBe(1000);
  });

  it("999 events plus one is 1000 and nothing is dropped; one more drops the oldest and stays at 1000", () => {
    const home = tmpDir();
    const t = 1_700_000_000_000;
    const ctx = testCtx(home, { now: () => t });
    seed(home, 999, t);
    recordEvents(ctx, [enforcementEvent({ decision: "continue", overrideUsed: false })]);
    expect(count(ctx)).toBe(1000);
    expect(readSpool(ctx)[0]).toContain('"override_used":true'); // the oldest is still there
    recordEvents(ctx, [enforcementEvent({ decision: "continue", overrideUsed: false })]);
    expect(count(ctx)).toBe(1000);
    expect(readSpool(ctx).join("\n")).not.toContain('"override_used":true'); // now it is gone
  });

  it("a batch that does not fit drops as many whole lines as it needs", () => {
    const home = tmpDir();
    const t = 1_700_000_000_000;
    const ctx = testCtx(home, { now: () => t });
    seed(home, 1000, t);
    recordEvents(ctx, [enforcementEvent({ decision: "allow", overrideUsed: false }), enforcementEvent({ decision: "continue", overrideUsed: false })]);
    expect(count(ctx)).toBe(1000);
    expect(readSpool(ctx).at(-1)).toContain('"decision":"continue"');
  });
});

describe("a spool that cannot be written never fails the turn (TL8)", () => {
  const logs = (home: string): string =>
    readdirSync(join(home, "logs"))
      .map((f) => readFileSync(join(home, "logs", f), "utf8"))
      .join("");

  it("with spool.jsonl a directory, the turn is still reviewed and answered, and the log says why", () => {
    const home = tmpDir();
    pg(bundle, ["session-start"], { home, input: sessionStartInput() });
    const spool = join(home, "telemetry", "spool.jsonl");
    rmSync(spool);
    mkdirSync(spool);
    const r = pg(bundle, ["turn-end"], { home, input: turnEndInput(TIC_TEXT) });
    expect(r.code).toBe(0);
    expect(json<{ decision: string }>(r).decision).toBe("continue");
    expect(logs(home)).toContain("telemetry_dropped");
  });

  it("with the telemetry directory a file, session-start and turn-end still answer", () => {
    const home = tmpDir();
    writeFileSync(join(home, "telemetry"), "i am a file");
    expect(pg(bundle, ["session-start"], { home, input: sessionStartInput() }).code).toBe(0);
    const t = pg(bundle, ["turn-end"], { home, input: turnEndInput(TIC_TEXT) });
    expect(t.code).toBe(0);
    expect(json<{ decision: string }>(t).decision).toBe("continue");
    expect(logs(home)).toContain("telemetry_dropped");
  });
});

describe("concurrent appends lose nothing (TL9)", () => {
  it("two worker processes each record 60 events; all 120 are in the spool", async () => {
    const home = tmpDir();
    const worker = join(ADAPTER_DIR, "test", "spool-worker.ts");
    const run = (): Promise<number | null> =>
      new Promise((resolve) => {
        const c = spawn(process.execPath, ["--import", "tsx", worker, home, "60"], { cwd: ADAPTER_DIR, stdio: "ignore" });
        c.on("close", resolve);
      });
    const codes = await Promise.all([run(), run()]);
    expect(codes).toEqual([0, 0]);
    expect(count(testCtx(home))).toBe(120);
  });
});

describe("the last-resort handlers (E9)", () => {
  it.each(["escape", "reject"])("an exception that escapes the hook's own catch (%s) still ends in exit 1 with one plain line, a log entry and an event", (kind) => {
    const home = tmpDir();
    pg(testBundle, ["session-start"], { home, input: sessionStartInput() });
    const r = pg(testBundle, ["turn-end"], { home, input: turnEndInput(TIC_TEXT), env: testHooks({ crash: `turn-end:${kind}` }) });
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/^prosegate: could not finish \(internal error\); nothing was blocked\. Details: .+\.log\n$/);
    const log = readdirSync(join(home, "logs")).map((f) => readFileSync(join(home, "logs", f), "utf8")).join("");
    expect(log).toMatch(/error adapter_error an exception escaped: (uncaught exception|unhandled rejection)/);
    expect(readFileSync(join(home, "telemetry", "spool.jsonl"), "utf8")).toContain('"code":"adapter_error"');
  });
});

describe("the user message is cut safely (B8)", () => {
  it("never leaves half a surrogate pair at the 2,000-character boundary", () => {
    const text = `${"x".repeat(1999)}\u{1F600}rest`;
    const cut = trimUserMessage(text);
    expect(cut).toBe("x".repeat(1999));
    expect(trimUserMessage("y".repeat(2000))).toHaveLength(2000);
    expect(trimUserMessage("y".repeat(2001))).toHaveLength(2000);
    expect(trimUserMessage("short")).toBe("short");
  });
});
