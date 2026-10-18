import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { PackVersionError } from "@prosegate/engine";

// The adapter's side of the engine contract: what it passes the engine (the request, the mode, the cap
// check, the budget, the prose limit), and what it does with the engine's failure signals. The engine is
// wrapped so that every call is recorded and a test can make it trip, throw or take time (B1, B3, B4, X2, X4).

const spy = vi.hoisted(() => ({
  mode: "real" as "real" | "budget" | "version" | "truncated" | "slow",
  calls: [] as Array<Record<string, unknown>>,
  /** Called by the "slow" mode inside the review, to move the fake clock past the cap. */
  tick: (): void => undefined,
}));

vi.mock("@prosegate/engine", async (importOriginal) => {
  const real = await importOriginal<typeof import("@prosegate/engine")>();
  return {
    ...real,
    reviewRulesDetailed: (input: Parameters<typeof real.reviewRulesDetailed>[0]) => {
      spy.calls.push({
        request: input.request,
        enforce: input.enforce,
        capCheck: input.capCheck,
        budgetMs: input.budgetMs,
        maxProseChars: input.maxProseChars,
        packs: input.packs.map((p) => p.id),
      });
      if (spy.mode === "version") throw new real.PackVersionError("core", "0.1.0", "0.2.0");
      const detailed = real.reviewRulesDetailed(input);
      if (spy.mode === "budget") return { ...detailed, diagnostics: { ...detailed.diagnostics, budget_exceeded: true, rules_unfinished: ["core.filler.001"] } };
      if (spy.mode === "truncated") return { ...detailed, diagnostics: { ...detailed.diagnostics, truncated: true } };
      if (spy.mode === "slow") spy.tick();
      return detailed;
    },
  };
});

const { turnEnd, turnStart, sessionStart } = await import("../src/hooks.js");
const { runCommand } = await import("../src/commands.js");
const { TIC_TEXT, CLEAN_TEXT, SESSION, testCtx, tmpDir } = await import("./helpers.js");

function setup(over: Parameters<typeof testCtx>[1] = {}) {
  spy.mode = "real";
  spy.calls.length = 0;
  spy.tick = () => undefined;
  const home = tmpDir();
  const ctx = testCtx(home, over);
  sessionStart({ harness: "claude-code", session_id: SESSION, cwd: "/work/project", mode: "interactive" }, ctx);
  return { home, ctx };
}
const end = (ctx: ReturnType<typeof testCtx>, id: string, over: Record<string, unknown> = {}, text = TIC_TEXT) =>
  turnEnd({ session_id: SESSION, turn_id: id, assistant_text: text, user_message: "", tool_calls: [], continuation: false, ...over } as never, ctx).output;
const spool = (home: string) => readFileSync(join(home, "telemetry", "spool.jsonl"), "utf8");
const log = (home: string) => readFileSync(join(home, "logs", `${new Date().toISOString().slice(0, 10)}.log`), "utf8");
const lastCall = () => spy.calls.at(-1) as { request: Record<string, unknown> & { context: { mode: string; user_message: string }; prior_findings: string[]; pass: number; stages: string[] }; enforce: boolean; capCheck: boolean | undefined; budgetMs: number; maxProseChars: number; packs: string[] };

describe("what the adapter hands the engine (X2, X4)", () => {
  it("the request: profile, pass, stages, the live user message, interactive mode; enforce on; prose limit 100 KB; the full budget", () => {
    const { ctx } = setup();
    turnStart({ session_id: SESSION, user_message: "STORED MESSAGE", tool_calls_so_far: [] }, ctx);
    end(ctx, "t1");
    const call = lastCall();
    expect(call.request).toMatchObject({ schema: "prosegate.review/1", profile_id: "local/base", pass: 1, stages: ["rules"], session_id: SESSION, turn_id: "t1", prior_findings: [] });
    expect(call.request.context).toEqual({ user_message: "STORED MESSAGE", style_constraints: "", mode: "interactive" });
    expect(call.enforce).toBe(true);
    expect(call.capCheck).toBe(false);
    expect(call.maxProseChars).toBe(100 * 1024);
    expect(call.budgetMs).toBe(2000);
    expect(call.packs).toEqual(["core"]);
  });

  it("the live user message wins over the stored one, and is cut to 2,000 characters", () => {
    const { ctx } = setup();
    turnStart({ session_id: SESSION, user_message: "STORED MESSAGE", tool_calls_so_far: [] }, ctx);
    end(ctx, "t1", { user_message: "LIVE ".repeat(1000) });
    const message = lastCall().request.context.user_message;
    expect(message.startsWith("LIVE LIVE")).toBe(true);
    expect(message).toHaveLength(2000);
  });

  it("headless (CI) is passed through as the review mode", () => {
    const { ctx } = setup();
    end({ ...ctx, env: { CI: "true" } }, "t1");
    expect(lastCall().request.context.mode).toBe("headless");
  });

  it("advisory reviews without enforcing; quiet enforces", () => {
    const { ctx } = setup();
    runCommand(["advisory"], { ...ctx, env: { PROSEGATE_SESSION: SESSION } });
    end(ctx, "t1");
    expect(lastCall().enforce).toBe(false);
    runCommand(["quiet"], { ...ctx, env: { PROSEGATE_SESSION: SESSION } });
    end(ctx, "t2");
    expect(lastCall().enforce).toBe(true);
  });

  it("pass 2 carries the pass-1 ids; the call after the cap sets capCheck", () => {
    const { ctx } = setup();
    const a = end(ctx, "t1");
    end(ctx, "t1", { continuation: true });
    expect(lastCall().request.pass).toBe(2);
    expect(lastCall().request.prior_findings).toEqual(a.result.findings.map((f) => f.id));
    expect(lastCall().capCheck).toBe(false);
    end(ctx, "t1", { continuation: true });
    expect(lastCall().capCheck).toBe(true);
  });

  it("no engine call when enforcement is off", () => {
    const { ctx } = setup();
    runCommand(["off"], { ...ctx, env: { PROSEGATE_SESSION: SESSION } });
    end(ctx, "t1");
    expect(spy.calls).toHaveLength(0);
  });
});

describe("the engine budget and the review cap (ADR-29, B1, B3, B4)", () => {
  function atMs(ms: number) {
    let now = ms;
    const { home, ctx } = setup({ elapsedMs: () => now });
    return { home, ctx, set: (v: number) => (now = v) };
  }

  it("the engine gets the time left under the 6 s cap, at most 2 s, at least 100 ms", () => {
    for (const [elapsed, expected] of [[0, 2000], [3999, 2000], [4000, 2000], [4001, 1999], [5000, 1000], [5900, 100], [5950, 100], [6000, 100]] as const) {
      const { ctx } = atMs(elapsed);
      end(ctx, `t-${elapsed}`);
      expect(lastCall().budgetMs, `elapsed ${elapsed}`).toBe(expected);
    }
  });

  it("past the cap before the review starts: not reviewed, and the engine is never called", () => {
    const { home, ctx } = atMs(6001);
    const out = end(ctx, "t1");
    expect(spy.calls).toHaveLength(0);
    expect(out.decision).toBe("allow");
    expect(out.result.skipped_reason).toBe("reviewer_unavailable");
    expect(log(home)).toContain("the 6 s cap was spent before the review started");
    expect(spool(home)).toContain('"code":"turn_budget_exceeded"');
  });

  it("exactly at the cap it still reviews", () => {
    const { ctx } = atMs(6000);
    expect(end(ctx, "t1").result.verdict).toBe("revise");
  });

  it("a review that finishes after the cap is discarded: allow, skipped, logged (B3)", () => {
    const { home, ctx, set } = atMs(100);
    spy.mode = "slow";
    spy.tick = () => set(6001);
    const out = end(ctx, "t1");
    expect(out.decision).toBe("allow");
    expect(out.result.skipped_reason).toBe("reviewer_unavailable");
    expect(out.result.findings).toEqual([]);
    expect(log(home)).toContain("the review finished after the 6 s cap");
    // And a review that ends exactly on the cap is kept.
    const again = atMs(100);
    spy.mode = "slow";
    spy.tick = () => again.set(6000);
    expect(end(again.ctx, "t2").decision).toBe("continue");
  });
});

describe("the engine's failure signals", () => {
  it("a tripped engine budget: allow, no partial findings to the model, logged, in telemetry, remembered for status", () => {
    const { home, ctx } = setup();
    spy.mode = "budget";
    const out = end(ctx, "b");
    expect(out.decision).toBe("allow");
    expect(out.feedback_text).toBe("");
    expect(out.notice).toBeNull();
    expect(out.result.verdict).toBe("skipped");
    expect(out.result.skipped_reason).toBe("reviewer_unavailable");
    expect(out.result.findings).toEqual([]);
    expect(spool(home)).toContain('"code":"turn_budget_exceeded"');
    expect(log(home)).toContain("the engine budget ran out during the review");
    expect(runCommand(["status"], { ...ctx, env: { PROSEGATE_SESSION: SESSION } }).out).toContain("Last turn: not reviewed (the review ran out of time)");
    // Nothing was recorded as a continuation: the next call is still pass 1.
    spy.mode = "real";
    expect(end(ctx, "b").result.pass).toBe(1);
  });

  it("a PackVersionError: allow, pack_rejected", () => {
    const { home, ctx } = setup();
    spy.mode = "version";
    const out = end(ctx, "c");
    expect(out.decision).toBe("allow");
    expect(out.result.skipped_reason).toBe("reviewer_unavailable");
    expect(spool(home)).toContain('"code":"pack_rejected"');
    expect(new PackVersionError("core", "1", "2").packId).toBe("core");
  });

  it("a truncated review still counts: the model is continued, turn_truncated is recorded, status says so", () => {
    const { home, ctx } = setup();
    spy.mode = "truncated";
    const out = end(ctx, "d");
    expect(out.decision).toBe("continue");
    expect(spool(home)).toContain('"code":"turn_truncated"');
    expect(spool(home)).not.toContain("turn_budget_exceeded");
    expect(runCommand(["status"], { ...ctx, env: { PROSEGATE_SESSION: SESSION } }).out).toContain("Last turn: only the first 100 KB of prose was reviewed");
  });

  it("sanity: the real engine continues on this text and passes a clean one", () => {
    const { ctx } = setup();
    expect(end(ctx, "a").decision).toBe("continue");
    expect(end(ctx, "b", {}, CLEAN_TEXT).decision).toBe("allow");
  });
});
