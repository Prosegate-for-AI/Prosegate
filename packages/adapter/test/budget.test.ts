import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { PackVersionError } from "@prosegate/engine";

// The adapter's explicit handling of the engine's two failure signals (brief): a tripped budget
// returns a PARTIAL result with `diagnostics.budget_exceeded`, and the adapter must not continue the
// model on it; a PackVersionError means the loaded pack is not the pinned one.

const mode = vi.hoisted(() => ({ value: "real" as "real" | "budget" | "version" }));

vi.mock("@prosegate/engine", async (importOriginal) => {
  const real = await importOriginal<typeof import("@prosegate/engine")>();
  return {
    ...real,
    reviewRulesDetailed: (input: Parameters<typeof real.reviewRulesDetailed>[0]) => {
      const detailed = real.reviewRulesDetailed(input);
      if (mode.value === "budget") return { ...detailed, diagnostics: { ...detailed.diagnostics, budget_exceeded: true, rules_unfinished: ["core.filler.001"] } };
      if (mode.value === "version") throw new real.PackVersionError("core", "0.1.0", "0.2.0");
      return detailed;
    },
  };
});

const { turnEnd } = await import("../src/hooks.js");
const { sessionStart } = await import("../src/hooks.js");
const { TIC_TEXT, SESSION, testCtx, tmpDir } = await import("./helpers.js");

function setup() {
  const home = tmpDir();
  const ctx = testCtx(home);
  sessionStart({ harness: "claude-code", session_id: SESSION, cwd: "/work/project", mode: "interactive" }, ctx);
  return { home, ctx };
}
const end = (ctx: ReturnType<typeof testCtx>, id: string) =>
  turnEnd({ session_id: SESSION, turn_id: id, assistant_text: TIC_TEXT, user_message: "", tool_calls: [], continuation: false }, ctx).output;
const spool = (home: string) => readFileSync(join(home, "telemetry", "spool.jsonl"), "utf8");

describe("engine failure signals", () => {
  it("sanity: the real engine continues on this text", () => {
    mode.value = "real";
    const { ctx } = setup();
    expect(end(ctx, "a").decision).toBe("continue");
  });

  it("a tripped budget: allow, no partial findings sent to the model, reviewer_unavailable, turn_budget_exceeded", () => {
    mode.value = "budget";
    const { home, ctx } = setup();
    const out = end(ctx, "b");
    expect(out.decision).toBe("allow");
    expect(out.feedback_text).toBe("");
    expect(out.notice).toBeNull();
    expect(out.result.verdict).toBe("skipped");
    expect(out.result.skipped_reason).toBe("reviewer_unavailable");
    expect(out.result.findings).toEqual([]);
    expect(spool(home)).toContain('"code":"turn_budget_exceeded"');
    // Nothing was recorded as a continuation: the next call is still pass 1.
    mode.value = "real";
    expect(end(ctx, "b").result.pass).toBe(1);
  });

  it("a PackVersionError: allow, pack_rejected", () => {
    mode.value = "version";
    const { home, ctx } = setup();
    const out = end(ctx, "c");
    expect(out.decision).toBe("allow");
    expect(out.result.skipped_reason).toBe("reviewer_unavailable");
    expect(spool(home)).toContain('"code":"pack_rejected"');
    expect(new PackVersionError("core", "1", "2").packId).toBe("core");
  });
});
