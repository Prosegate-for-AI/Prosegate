import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { runCommand } from "../src/commands.js";
import type { Ctx } from "../src/ctx.js";
import { sessionStart, turnEnd, turnStart, type TurnEndOutput } from "../src/hooks.js";
import { SessionStore, turnKey } from "../src/store.js";
import { readSpool } from "../src/telemetry.js";
import { CLEAN_TEXT, SESSION, TIC_TEXT, buildBundle, json, pg, sessionStartInput, testCtx, tmpDir, turnEndInput } from "./helpers.js";

// Turn and session semantics across hook processes (ADR-30, ADR-31): the profile's pass cap, floors on
// pass 1 only, turn binding, the profile fixed for the turn, the shipped notice once per turn, session sources.

vi.setConfig({ testTimeout: 120_000 });

let bundle = "";
beforeAll(async () => {
  bundle = await buildBundle();
}, 120_000);

const CWD = "/work/project";

function started(over: Partial<Ctx> = {}): { home: string; ctx: Ctx } {
  const home = tmpDir();
  const ctx = testCtx(home, { cwd: CWD, ...over });
  sessionStart({ harness: "claude-code", session_id: SESSION, cwd: CWD, mode: "interactive" }, ctx);
  return { home, ctx };
}

function end(ctx: Ctx, text: string, over: Record<string, unknown> = {}): TurnEndOutput {
  return turnEnd({ session_id: SESSION, turn_id: "turn-1", assistant_text: text, user_message: "", tool_calls: [], continuation: false, ...over } as never, ctx).output;
}

function state(home: string, id = SESSION): { turns: Record<string, { count: number; pass1: unknown[]; profile_id: string; shipped_shown: boolean }>; active_profile: string; mode: string | null; turn_ordinal: number } {
  return JSON.parse(readFileSync(join(home, "sessions", id, "state.json"), "utf8")) as ReturnType<typeof state>;
}

function put(home: string, rel: string, text: string): void {
  const file = join(home, rel);
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, text);
}

// The correctness review's texts: BAD has two block findings and 62 words; the half-fixed revision drops
// one of them and falls to 57 words, under the 60-word floor.
const BAD =
  "This change could potentially break the build on older runners. It is worth noting that the cache is keyed per tenant, " +
  "so two tenants never share an entry. The reads go through the catalog service, and the writes go straight to the store. " +
  "We measured the latency on the staging dataset and it dropped from 410 ms to 95 ms at p95.";
const BAD_HALF_FIXED =
  "This change could potentially break the build on older runners. The cache is keyed per tenant, " +
  "so two tenants never share an entry. The reads go through the catalog service, and the writes go straight to the store. " +
  "We measured the latency on the staging dataset and it dropped from 410 ms to 95 ms at p95.";

describe("the profile's pass cap (ADR-31)", () => {
  const ONE = 'schema: prosegate.profile/1\nid: local/one\nversion: 1\nname: One pass\nextends: local/base\nenforcement:\n  mode: enforce\n  pass_cap: 1\n  render: diff\n';

  it("pass_cap 1 continues exactly once, says `pass 1 of 1`, and ships on the next call", () => {
    const { home, ctx } = started();
    put(home, "profiles/one.yaml", ONE);
    expect(runCommand(["profile", "local/one"], { ...ctx, env: { PROSEGATE_SESSION: SESSION } }).code).toBe(0);
    const a = end(ctx, BAD);
    expect(a.decision).toBe("continue");
    expect(a.result.profile.id).toBe("local/one");
    expect(a.feedback_text).toContain("(pass 1 of 1)");
    expect(a.feedback_text).not.toContain("of 2");
    expect(a.notice).toMatch(/revising, pass 1 of 1/);
    const b = end(ctx, BAD, { continuation: true });
    expect(b.decision).toBe("allow");
    expect(b.result.skipped_reason).toBe("pass_cap");
    expect(b.notice).toMatch(/^Prosegate · 2 findings remain after 1 pass · shipped as is/);
    expect(end(ctx, BAD, { continuation: true }).decision).toBe("allow");
  });

  it("pass_cap 2 (the default) still continues twice and says `of 2`", () => {
    const { ctx } = started();
    const a = end(ctx, BAD);
    expect(a.feedback_text).toContain("(pass 1 of 2)");
    expect(end(ctx, BAD, { continuation: true }).decision).toBe("continue");
    expect(end(ctx, BAD, { continuation: true }).decision).toBe("allow");
  });
});

describe("floors apply on pass 1 only (ADR-31)", () => {
  it("a pass-2 revision under the word floor that keeps a block finding is continued, not shipped silently", () => {
    const { ctx } = started();
    const a = end(ctx, BAD);
    expect(a.decision).toBe("continue");
    const b = end(ctx, BAD_HALF_FIXED, { continuation: true });
    expect(b.decision).toBe("continue");
    expect(b.result.skipped_reason).toBeUndefined();
    expect(b.result.findings.map((f) => f.rule_id)).toEqual(["core.hedge.004"]);
    expect(b.notice).toBe("Prosegate · 1 of 2 findings remain · revising, pass 2 of 2");
    const c = end(ctx, BAD_HALF_FIXED, { continuation: true });
    expect(c.decision).toBe("allow");
    expect(c.notice).toMatch(/^Prosegate · 1 finding remains after 2 passes · shipped as is/);
  });

  it("a short first reply is still skipped on pass 1", () => {
    const { ctx } = started();
    expect(end(ctx, "It's worth noting that this is short.").result.skipped_reason).toBe("below_floor");
  });
});

describe("turn binding (ADR-30, ADR-31)", () => {
  it("continuation:false with a pass count and no shim turn id is a new turn: pass 1 again, logged", () => {
    const { home, ctx } = started();
    const input = { turn_id: "", user_message: "" };
    expect(end(ctx, TIC_TEXT, input).result.pass).toBe(1);
    expect(end(ctx, TIC_TEXT, { ...input, continuation: true }).result.pass).toBe(2);
    const again = end(ctx, TIC_TEXT, { ...input, continuation: false });
    expect(again.result.pass).toBe(1);
    expect(again.decision).toBe("continue");
    expect(readFileSync(join(home, "logs", `${new Date(ctx.now()).toISOString().slice(0, 10)}.log`), "utf8")).toContain("turn_reset");
  });

  it("with a shim turn id the count wins over continuation:false (and the mismatch is logged)", () => {
    const { home, ctx } = started();
    expect(end(ctx, TIC_TEXT).result.pass).toBe(1);
    const second = end(ctx, TIC_TEXT, { continuation: false });
    expect(second.result.pass).toBe(2);
    expect(readFileSync(join(home, "logs", `${new Date(ctx.now()).toISOString().slice(0, 10)}.log`), "utf8")).toContain("continuation_mismatch");
  });

  it("continuation:true on the first call is still pass 1 (another hook's continuation does not skip a pass)", () => {
    const { ctx } = started();
    const a = end(ctx, TIC_TEXT, { continuation: true });
    expect(a.result.pass).toBe(1);
    expect(a.decision).toBe("continue");
    expect(a.feedback_text).toContain("(pass 1 of 2)");
    expect(end(ctx, TIC_TEXT, { continuation: true }).result.pass).toBe(2);
  });

  it("a turn-end for a turn id never seen at turn-start gets its own record and cannot consume another turn's passes", () => {
    const { home, ctx } = started();
    turnStart({ session_id: SESSION, user_message: "write it", tool_calls_so_far: [] }, ctx);
    expect(end(ctx, TIC_TEXT, { turn_id: "real" }).decision).toBe("continue");
    for (const id of ["junk-1", "junk-2", "junk-3"]) expect(end(ctx, TIC_TEXT, { turn_id: id, continuation: true }).result.pass).toBe(1);
    const turns = state(home).turns;
    expect(turns[turnKey("real")]?.count).toBe(1);
    expect(end(ctx, TIC_TEXT, { turn_id: "real", continuation: true }).result.pass).toBe(2);
  });

  it("t17: spoofed turn-ends with no turn id, then the real Stop: the real Stop still continues", () => {
    // Each spoof sequence is the continuation flags of the agent's junk calls; none of them ends in an allow
    // that would delete turn.json and hide the problem.
    const sequences: boolean[][] = [[false, false], [false, true], [true, true], [false]];
    for (const shimId of [false, true]) {
      for (const flags of sequences) {
        const label = `shim id: ${shimId}, spoofs: ${flags.join(",")}`;
        const home = tmpDir();
        pg(bundle, ["session-start"], { home, input: sessionStartInput() });
        pg(bundle, ["turn-start"], { home, input: { session_id: SESSION, user_message: "write me a summary", tool_calls_so_far: [] } });
        const agentEnv = { CLAUDECODE: "1" };
        const spoof = (continuation: boolean) => json<{ decision: string }>(pg(bundle, ["turn-end"], { home, env: agentEnv, input: { session_id: SESSION, assistant_text: TIC_TEXT, tool_calls: [], continuation } }));
        for (const f of flags) expect(spoof(f).decision, label).toBe("continue");
        const real = json<{ decision: string; result: { pass: number } }>(
          pg(bundle, ["turn-end"], { home, input: turnEndInput(TIC_TEXT, shimId ? { turn_id: "prompt-abc" } : { turn_id: "" }) }),
        );
        expect(real.decision, label).toBe("continue");
        expect(real.result.pass, label).toBe(1);
      }
    }
  });

  it("live hook input outranks a stale turn.json: its user message and its turn id", () => {
    const { home, ctx } = started();
    const store = new SessionStore(ctx, SESSION);
    store.writeTurn({ turn_id: "stale-turn", user_message: "STALE MESSAGE", ts: 1 });
    const out = end(ctx, TIC_TEXT, { turn_id: "", user_message: "the live message" });
    expect(out.decision).toBe("continue");
    // The record is keyed by the id derived from the live message, not by the stale file's id.
    expect(Object.keys(state(home).turns)).not.toContain(turnKey("stale-turn"));
  });
});

describe("the profile is fixed for the turn (ADR-31)", () => {
  it("a profile change between pass 1 and pass 2 applies from the next turn", () => {
    const { home, ctx } = started();
    const a = end(ctx, TIC_TEXT, { turn_id: "t1" });
    expect(a.result.profile.id).toBe("local/base");
    expect(runCommand(["profile", "local/chat-reply"], { ...ctx, env: { PROSEGATE_SESSION: SESSION } }).code).toBe(0);
    const b = end(ctx, TIC_TEXT, { turn_id: "t1", continuation: true });
    expect(b.result.profile.id).toBe("local/base");
    expect(b.feedback_text).toContain('against profile "local/base"');
    expect(state(home).turns[turnKey("t1")]?.profile_id).toBe("local/base");
    const next = end(ctx, TIC_TEXT, { turn_id: "t2" });
    expect(next.result.profile.id).toBe("local/chat-reply");
  });
});

describe("the shipped notice is shown once per turn (ADR-31)", () => {
  it("repeated Stops after the cap (other hooks continuing the model) do not repeat it", () => {
    const { ctx } = started();
    end(ctx, TIC_TEXT);
    end(ctx, TIC_TEXT, { continuation: true });
    const first = end(ctx, TIC_TEXT, { continuation: true });
    expect(first.notice).toMatch(/shipped as is/);
    for (let i = 0; i < 3; i++) {
      const again = end(ctx, TIC_TEXT, { continuation: true });
      expect(again.decision).toBe("allow");
      expect(again.notice).toBeNull();
    }
    // A new turn can ship its own.
    end(ctx, TIC_TEXT, { turn_id: "t2" });
    end(ctx, TIC_TEXT, { turn_id: "t2", continuation: true });
    expect(end(ctx, TIC_TEXT, { turn_id: "t2", continuation: true }).notice).toMatch(/shipped as is/);
  });
});

describe("what the pass-2 and cap-check calls leave in the record (P7)", () => {
  it("pass 2 never overwrites the pass-1 findings, so the cap check clears against the right set", () => {
    const { home, ctx } = started();
    const a = end(ctx, TIC_TEXT);
    const pass1 = state(home).turns[turnKey("turn-1")]?.pass1 ?? [];
    expect(pass1.length).toBeGreaterThanOrEqual(3);
    // Pass 2 fixes the filler only.
    const revised = TIC_TEXT.replace("Great question! ", "");
    const b = end(ctx, revised, { continuation: true });
    expect(b.decision).toBe("continue");
    expect(state(home).turns[turnKey("turn-1")]?.pass1).toEqual(pass1);
    // The cap check on a clean text clears everything pass 1 reported, not just what pass 2 still held.
    const c = end(ctx, CLEAN_TEXT, { continuation: true });
    expect(c.result.skipped_reason).toBe("pass_cap");
    expect(c.result.cleared).toHaveLength(pass1.length);
    expect(a.result.findings.length).toBe(pass1.length);
  });
});

describe("telemetry end to end (T1, T2, TL7)", () => {
  const ids = (n: number) => Array.from({ length: n }, (_, i) => i);
  const SENTENCE = "The cache keeps one entry per tenant and expires it after sixty seconds. ";
  const LONG_CLEAN = ids(18).map(() => SENTENCE).join("").trim(); // 234 words of prose

  it("a revised-then-clean turn spools cleared and cleared_categories; the prose length is bucketed to 100 words", () => {
    const { ctx } = started();
    end(ctx, TIC_TEXT);
    end(ctx, LONG_CLEAN, { continuation: true });
    const events = readSpool(ctx).flatMap((l) => (JSON.parse(l) as { events: Array<Record<string, unknown>> }).events);
    const reviews = events.filter((e) => e["t"] === "review");
    expect(reviews).toHaveLength(2);
    const second = reviews.find((e) => e["pass"] === 2) as Record<string, unknown>;
    expect(second["cleared"]).toBeGreaterThanOrEqual(3);
    expect([...(second["cleared_categories"] as string[])].sort()).toEqual(["filler", "hedge", "vocab"]);
    expect(second["prose_words_bucket"]).toBe(200);
    const first = reviews.find((e) => e["pass"] === 1) as Record<string, unknown>;
    expect(first["prose_words_bucket"]).toBe(100);
    for (const e of events.filter((x) => x["t"] === "enforcement")) expect(e["notice_via_model"]).toBe(false);
  });

  it("override_used is false when nothing is lowered and true on a per-turn advisory (PROSEGATE_MODE=advisory)", () => {
    const { ctx } = started();
    end(ctx, TIC_TEXT, { turn_id: "a" });
    end(ctx, TIC_TEXT, { turn_id: "b" });
    const last = (c: Ctx) =>
      readSpool(c)
        .flatMap((l) => (JSON.parse(l) as { events: Array<Record<string, unknown>> }).events)
        .filter((e) => e["t"] === "enforcement")
        .at(-1) as Record<string, unknown>;
    expect(last(ctx)["override_used"]).toBe(false);
    end({ ...ctx, env: { PROSEGATE_MODE: "advisory" } }, TIC_TEXT, { turn_id: "c" });
    expect(last(ctx)["override_used"]).toBe(true);
    expect(last(ctx)["decision"]).toBe("allow");
  });
});

describe("a harness that cannot continue the model (ADR-29)", () => {
  it("continue_supported:false allows, shows the findings as a notice, and records enforcement_unavailable", () => {
    const { home, ctx } = started();
    const out = end(ctx, TIC_TEXT, { continue_supported: false });
    expect(out.decision).toBe("allow");
    expect(out.feedback_text).toBe("");
    expect(out.notice).toMatch(/^Prosegate · profile base · \d+ findings .* · revising, pass 1 of 2/);
    const last = readSpool(ctx)
      .flatMap((l) => (JSON.parse(l) as { events: Array<Record<string, unknown>> }).events)
      .filter((e) => e["t"] === "enforcement")
      .at(-1) as Record<string, unknown>;
    expect(last["enforcement_unavailable"]).toBe(true);
    expect(last["decision"]).toBe("allow");
    // And no pass was spent: a harness that can continue later still starts at pass 1.
    expect(state(home).turns[turnKey("turn-1")]?.count ?? 0).toBe(0);
    expect(end(ctx, TIC_TEXT).result.pass).toBe(1);
  });
});

describe("session source (ADR-31)", () => {
  const start = (ctx: Ctx, source?: string) => sessionStart({ harness: "claude-code", session_id: SESSION, cwd: CWD, mode: "interactive", ...(source === undefined ? {} : { source }) } as never, ctx);

  it("compact never touches pass counts; startup and clear reset them", () => {
    const { home, ctx } = started();
    expect(end(ctx, TIC_TEXT).decision).toBe("continue");
    expect(state(home).turns[turnKey("turn-1")]?.count).toBe(1);
    start(ctx, "compact");
    expect(state(home).turns[turnKey("turn-1")]?.count).toBe(1);
    expect(end(ctx, TIC_TEXT, { continuation: true }).result.pass).toBe(2);
    for (const source of ["resume", "fork"]) {
      start(ctx, source);
      expect(state(home).turns[turnKey("turn-1")]?.count, source).toBe(2);
    }
    start(ctx, "clear");
    expect(state(home).turns).toEqual({});
  });

  it("modes reset on startup and clear, and are kept by resume, compact and fork; an absent source means startup", () => {
    const { home, ctx } = started();
    for (const [source, kept] of [["resume", true], ["compact", true], ["fork", true], ["clear", false], ["startup", false], [undefined, false]] as const) {
      runCommand(["advisory"], { ...ctx, env: { PROSEGATE_SESSION: SESSION } });
      expect(state(home).mode).toBe("advisory");
      start(ctx, source);
      expect(state(home).mode, String(source)).toBe(kept ? "advisory" : null);
    }
  });

  it("the integrity record is not renewed by compact, which fires mid-session", () => {
    const { home, ctx } = started();
    const before = JSON.parse(readFileSync(join(home, "sessions", SESSION, "state.json"), "utf8")) as { local_hashes: Record<string, string> };
    put(home, "profiles/new.yaml", "schema: prosegate.profile/1\nid: local/new\nversion: 1\nname: New\n");
    start(ctx, "compact");
    expect(JSON.parse(readFileSync(join(home, "sessions", SESSION, "state.json"), "utf8")).local_hashes).toEqual(before.local_hashes);
    start(ctx, "resume");
    expect(Object.keys(JSON.parse(readFileSync(join(home, "sessions", SESSION, "state.json"), "utf8")).local_hashes as object)).toEqual(["profiles/new.yaml"]);
  });
});

describe("once-per-session lines are hidden where they should be (X9-X11)", () => {
  const BROKEN = "schema: prosegate.profile/1\nid: local/x\n  version: [1\n";

  function sessionWithBrokenFile(): { home: string; ctx: Ctx } {
    const home = tmpDir();
    const ctx = testCtx(home, { cwd: CWD });
    put(home, "profiles/broken.yaml", BROKEN);
    // Session start would show the line; mark it as not yet shown so the turn-end path is what is tested.
    sessionStart({ harness: "claude-code", session_id: SESSION, cwd: CWD, mode: "interactive" }, ctx);
    const file = join(home, "sessions", SESSION, "state.json");
    writeFileSync(file, JSON.stringify({ ...(JSON.parse(readFileSync(file, "utf8")) as object), resolution_notice_shown: false }));
    return { home, ctx };
  }

  it("shown on a quiet-free enforce turn without findings", () => {
    const { ctx } = sessionWithBrokenFile();
    expect(end(ctx, CLEAN_TEXT).notice).toMatch(/^Prosegate · ignoring .*broken\.yaml \(invalid YAML(, line \d+)?\) · fix it, then run prosegate reload$/);
  });

  it("not shown in quiet", () => {
    const { ctx } = sessionWithBrokenFile();
    runCommand(["quiet"], { ...ctx, env: { PROSEGATE_SESSION: SESSION } });
    expect(end(ctx, CLEAN_TEXT).notice).toBeNull();
  });

  it("not shown in headless", () => {
    const { ctx } = sessionWithBrokenFile();
    expect(end({ ...ctx, env: { CI: "true" } }, CLEAN_TEXT).notice).toBeNull();
  });

  it("not shown with enforcement off (only the lowered-enforcement line is)", () => {
    const { ctx } = sessionWithBrokenFile();
    runCommand(["off"], { ...ctx, env: { PROSEGATE_SESSION: SESSION } });
    expect(end(ctx, CLEAN_TEXT).notice).toBe("Prosegate · enforcement is lowered in this session (off) · prosegate status");
  });
});
