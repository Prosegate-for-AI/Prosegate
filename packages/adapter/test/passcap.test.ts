import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { CLEAN_TEXT, SESSION, TIC_TEXT, WARN_TEXT, buildBundle, json, pg, sessionStartInput, tmpDir, turnEndInput } from "./helpers.js";

// The pass cap across process boundaries (09 "Pass cap", ADR-12): every call below is a fresh
// process, so the count survives only if the session store holds it.

// Each test spawns real processes; the root run executes dozens of test files in parallel.
vi.setConfig({ testTimeout: 120_000 });

let bundle = "";
beforeAll(async () => {
  bundle = await buildBundle();
}, 120_000);

interface Out {
  decision: "allow" | "continue";
  feedback_text: string;
  render: string;
  notice: string | null;
  result: { verdict: string; skipped_reason?: string; pass: number; cleared: string[]; findings: Array<{ rule_id: string; severity: string }> };
}

function fresh(): string {
  const home = tmpDir();
  expect(pg(bundle, ["session-start"], { home, input: sessionStartInput() }).code).toBe(0);
  return home;
}
function end(home: string, text: string, over: Record<string, unknown> = {}, env: Record<string, string> = {}): Out {
  const r = pg(bundle, ["turn-end"], { home, input: turnEndInput(text, over), env });
  expect(r.code).toBe(0);
  return json<Out>(r);
}
function command(home: string, ...argv: string[]) {
  return pg(bundle, argv, { home, env: { PROSEGATE_SESSION: SESSION } });
}
function state(home: string): { turns: Record<string, { count: number }>; mode: string | null; first_notice_shown: boolean } {
  return JSON.parse(readFileSync(join(home, "sessions", SESSION, "state.json"), "utf8")) as ReturnType<typeof state>;
}
function spool(home: string): string[] {
  return readFileSync(join(home, "telemetry", "spool.jsonl"), "utf8").split("\n").filter(Boolean);
}

describe("enforce: revise, revise, cap", () => {
  it("pass 1 continues, pass 2 continues with the summary notice, the next call allows with the shipped notice", () => {
    const home = fresh();

    const a = end(home, TIC_TEXT);
    expect(a.decision).toBe("continue");
    expect(a.result).toMatchObject({ verdict: "revise", pass: 1 });
    expect(a.render).toBe("diff");
    expect(a.notice).toMatch(/revising, pass 1 of 2/);
    expect(state(home).turns).toBeDefined();
    expect(Object.values(state(home).turns).map((t) => t.count)).toEqual([1]);

    const b = end(home, TIC_TEXT, { continuation: true });
    expect(b.decision).toBe("continue");
    expect(b.result).toMatchObject({ verdict: "revise", pass: 2 });
    expect(b.render).toBe("summary");
    expect(b.feedback_text).toMatch(/^\[Prosegate\] 2 findings remain after your revision, against profile "local\/base" \(pass 2 of 2\)\./);
    expect(b.notice).toBe("Prosegate · 2 findings remain · revising, pass 2 of 2");
    expect(Object.values(state(home).turns).map((t) => t.count)).toEqual([2]);

    const c = end(home, TIC_TEXT, { continuation: true });
    expect(c.decision).toBe("allow");
    expect(c.feedback_text).toBe("");
    expect(c.result).toMatchObject({ verdict: "pass", skipped_reason: "pass_cap" });
    expect(c.render).toBe("diff");
    expect(c.notice).toMatch(/^Prosegate · 2 findings remain after 2 passes · shipped as is\n {2}filler {2}core\.filler\.001 {2}"Great question"\n {2}hedge {3}core\.hedge\.001 {3}"It's worth noting that"$/);

    // The cap stays: another call for the same turn still allows.
    expect(end(home, TIC_TEXT, { continuation: true }).decision).toBe("allow");
  });

  it("the cap check does not demote findings that were only on pass 1 into a notice", () => {
    const home = fresh();
    end(home, TIC_TEXT);
    // The model removes the hedge and keeps the filler.
    const revised = TIC_TEXT.replace("It's worth noting that the cache", "The cache");
    const b = end(home, revised, { continuation: true });
    expect(b.decision).toBe("continue");
    expect(b.notice).toBe("Prosegate · 1 of 2 findings remain · revising, pass 2 of 2");
    const c = end(home, revised, { continuation: true });
    expect(c.notice).toMatch(/^Prosegate · 1 finding remains after 2 passes · shipped as is\n {2}filler/);
  });
});

describe("enforce: revise then clean", () => {
  it("pass 2 with nothing left allows silently and reports what it cleared", () => {
    const home = fresh();
    expect(end(home, TIC_TEXT).decision).toBe("continue");
    const b = end(home, CLEAN_TEXT, { continuation: true });
    expect(b.decision).toBe("allow");
    expect(b.feedback_text).toBe("");
    expect(b.notice).toBeNull();
    expect(b.render).toBe("none");
    expect(b.result.verdict).toBe("pass");
    expect(b.result.cleared.length).toBeGreaterThanOrEqual(2);
    const review2 = spool(home).find((l) => l.includes('"pass":2')) ?? "";
    expect(review2).toContain('"cleared_categories"');
    expect(review2).not.toContain('"cleared":0');
  });

  it("the next turn starts again at pass 1 (turn-start clears earlier counts; a new prompt id is a new turn)", () => {
    const home = fresh();
    end(home, TIC_TEXT);
    end(home, TIC_TEXT, { continuation: true });
    const next = end(home, TIC_TEXT, { turn_id: "turn-2" });
    expect(next.result.pass).toBe(1);
    expect(next.decision).toBe("continue");
    // A repeated user message with a derived id: turn-start resets the count.
    pg(bundle, ["turn-start"], { home, input: { session_id: SESSION, user_message: "go on", tool_calls_so_far: [] } });
    const again = end(home, TIC_TEXT, { turn_id: "", user_message: "go on" });
    expect(again.result.pass).toBe(1);
  });
});

describe("enforce: a warn-only turn", () => {
  it("allows silently, even though findings exist", () => {
    const home = fresh();
    const a = end(home, WARN_TEXT);
    expect(a).toMatchObject({ decision: "allow", feedback_text: "", notice: null, render: "none" });
    expect(a.result.findings.length).toBeGreaterThan(0);
    expect(a.result.findings.every((f) => f.severity === "warn")).toBe(true);
  });
});

describe("the first notice of a session names the override once", () => {
  it("is on the first pass-1 notice and not on the second turn's", () => {
    const home = fresh();
    const a = end(home, TIC_TEXT, { turn_id: "turn-1" });
    expect(a.notice).toContain("To pause for this session, run: prosegate advisory");
    expect(state(home).first_notice_shown).toBe(true);
    const b = end(home, TIC_TEXT, { turn_id: "turn-2" });
    expect(b.notice).toMatch(/revising, pass 1 of 2/);
    expect(b.notice).not.toContain("To pause for this session");
  });
});

describe("advisory", () => {
  it("never continues the model and shows the advisory notice", () => {
    const home = fresh();
    const set = command(home, "advisory");
    expect(set.code).toBe(0);
    expect(set.stdout).toBe("Prosegate: advisory for this session. Findings will be shown, not enforced. Run prosegate enforce to restore.\n");
    const a = end(home, TIC_TEXT);
    expect(a.decision).toBe("allow");
    expect(a.feedback_text).toBe("");
    expect(a.result.verdict).toBe("pass");
    expect(a.notice).toMatch(/^Prosegate · profile base · \d+ findings \(.*\) · advisory, not enforced\n {2}filler/);
    // Still advisory on the next call for the same turn.
    expect(end(home, TIC_TEXT, { continuation: true }).decision).toBe("allow");
    expect(Object.values(state(home).turns).every((t) => t.count === 0)).toBe(true);
  });

  it("enforce restores it", () => {
    const home = fresh();
    command(home, "advisory");
    const r = command(home, "enforce");
    expect(r.stdout).toBe("Prosegate: enforcement restored for this session.\n");
    expect(end(home, TIC_TEXT).decision).toBe("continue");
  });
});

describe("quiet", () => {
  it("continues the model with no notice", () => {
    const home = fresh();
    expect(command(home, "quiet").code).toBe(0);
    const a = end(home, TIC_TEXT);
    expect(a.decision).toBe("continue");
    expect(a.feedback_text).toContain("[Prosegate]");
    expect(a.notice).toBeNull();
    expect(a.render).toBe("none");
    const c = end(home, TIC_TEXT, { continuation: true });
    expect(c.notice).toBeNull();
    const shipped = end(home, TIC_TEXT, { continuation: true });
    expect(shipped.decision).toBe("allow");
    expect(shipped.notice).toBeNull();
  });
});

describe("off", () => {
  it("reviews nothing, shows nothing, and the only telemetry is override_used", () => {
    const home = fresh();
    command(home, "off");
    const before = spool(home).length;
    const a = end(home, TIC_TEXT);
    expect(a).toMatchObject({ decision: "allow", feedback_text: "", notice: null, render: "none" });
    expect(a.result.verdict).toBe("skipped");
    expect(a.result.findings).toEqual([]);
    const added = spool(home).slice(before);
    expect(added).toHaveLength(1);
    expect(added[0]).toContain('"t":"enforcement"');
    expect(added[0]).toContain('"override_used":true');
    expect(added[0]).not.toContain('"t":"review"');
  });
});

describe("PROSEGATE_MODE", () => {
  it("advisory in the environment behaves like the command, for this process only", () => {
    const home = fresh();
    const a = end(home, TIC_TEXT, {}, { PROSEGATE_MODE: "advisory" });
    expect(a.decision).toBe("allow");
    expect(a.notice).toMatch(/advisory, not enforced/);
    expect(end(home, TIC_TEXT, { turn_id: "turn-9" }).decision).toBe("continue");
  });
  it("off in the environment reviews nothing", () => {
    const home = fresh();
    const a = end(home, TIC_TEXT, {}, { PROSEGATE_MODE: "off" });
    expect(a).toMatchObject({ decision: "allow", notice: null });
    expect(a.result.verdict).toBe("skipped");
  });
});
