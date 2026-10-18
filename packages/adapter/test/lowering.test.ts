import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { runCommand } from "../src/commands.js";
import type { Ctx } from "../src/ctx.js";
import { sessionStart, turnEnd, type TurnEndOutput } from "../src/hooks.js";
import { computeLowering, loweredNoticeLine } from "../src/lowering.js";
import { resolveBaseline, resolveSession } from "../src/profiles.js";
import { readSpool } from "../src/telemetry.js";
import { CLEAN_TEXT, SESSION, TIC_TEXT, testCtx, tmpDir } from "./helpers.js";

// ADR-30: lowered enforcement is always visible to the user. The agent can write any file the user can,
// so every path that makes enforcement weaker than the profile's own definition must reach the user as one
// line (through `notice`, never the model), once per session and again when the reason changes, and must
// report override_used.

vi.setConfig({ testTimeout: 120_000 });

const CWD = "/work/project";
const LOWERED = (what: string) => `Prosegate · enforcement is lowered in this session (${what}) · prosegate status`;

function started(over: Partial<Ctx> = {}): { home: string; ctx: Ctx } {
  const home = tmpDir();
  const ctx = testCtx(home, { cwd: CWD, ...over });
  sessionStart({ harness: "claude-code", session_id: SESSION, cwd: CWD, mode: "interactive" }, ctx);
  return { home, ctx };
}
function end(ctx: Ctx, text = TIC_TEXT, over: Record<string, unknown> = {}): TurnEndOutput {
  return turnEnd({ session_id: SESSION, turn_id: "turn-1", assistant_text: text, user_message: "", tool_calls: [], continuation: false, ...over } as never, ctx).output;
}
function put(home: string, rel: string, text: string): string {
  const file = join(home, rel);
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, text);
  return file;
}
function lastEnforcement(ctx: Ctx): Record<string, unknown> {
  return readSpool(ctx)
    .flatMap((l) => (JSON.parse(l) as { events: Array<Record<string, unknown>> }).events)
    .filter((e) => e["t"] === "enforcement")
    .at(-1) as Record<string, unknown>;
}
const overlay = (body: string) => `schema: prosegate.profile/1\nid: local/base\nversion: 1\nname: Base\n${body}`;
const ALL_INFO = overlay(
  "overrides:\n  categories:\n" + ["filler", "hedge", "vocab", "triad", "structure", "repetition"].map((c) => `    ${c}: { severity: info }\n`).join(""),
);

describe("every path that lowers enforcement shows the user a line and reports override_used", () => {
  it("an overlay that sets every category to info (the invisible one in the review)", () => {
    const { home, ctx } = started();
    put(home, "profiles/base.yaml", ALL_INFO);
    const out = end(ctx);
    expect(out.decision).toBe("allow"); // nothing left to enforce
    expect(out.result.findings).toEqual([]);
    expect(out.notice).toMatch(/^Prosegate · enforcement is lowered in this session \(severity lowered on \d+ rules?, local profile files changed since the session started\) · prosegate status$/);
    expect(lastEnforcement(ctx)["override_used"]).toBe(true);
  });

  it("an overlay that sets enforcement.mode to advisory", () => {
    const { home, ctx } = started();
    put(home, "profiles/base.yaml", overlay("enforcement:\n  mode: advisory\n"));
    const out = end(ctx);
    expect(out.decision).toBe("allow");
    expect(out.notice).toContain(LOWERED("advisory, local profile files changed since the session started").replace(" · prosegate status", ""));
    expect(lastEnforcement(ctx)["override_used"]).toBe(true);
  });

  it("a mid-session file change alone (a new profile file appears)", () => {
    const { home, ctx } = started();
    expect(end(ctx, CLEAN_TEXT, { turn_id: "t0" }).notice).toBeNull();
    put(home, "profiles/extra.yaml", "schema: prosegate.profile/1\nid: local/extra\nversion: 1\nname: Extra\nextends: local/base\n");
    const out = end(ctx, CLEAN_TEXT, { turn_id: "t1" });
    expect(out.notice).toBe(LOWERED("local profile files changed since the session started"));
    expect(lastEnforcement(ctx)["override_used"]).toBe(true);
  });

  it("enforcement off", () => {
    const { ctx } = started();
    runCommand(["off"], { ...ctx, env: { PROSEGATE_SESSION: SESSION } });
    const out = end(ctx);
    expect(out.notice).toBe(LOWERED("off"));
    expect(lastEnforcement(ctx)).toMatchObject({ override_used: true, decision: "allow" });
  });

  it("advisory from the command, and from PROSEGATE_MODE for one turn", () => {
    const { ctx } = started();
    expect(end({ ...ctx, env: { PROSEGATE_MODE: "advisory" } }, TIC_TEXT, { turn_id: "t1" }).notice).toContain(LOWERED("advisory").replace(" · prosegate status", ""));
    expect(lastEnforcement(ctx)["override_used"]).toBe(true);
  });

  it("rules switched off in a local overlay", () => {
    const { home, ctx } = started();
    put(home, "profiles/base.yaml", overlay("overrides:\n  rules:\n    core.hedge.001: { enabled: false }\n    core.filler.001: { enabled: false }\n"));
    expect(end(ctx).notice).toContain("2 rules switched off");
    expect(lastEnforcement(ctx)["override_used"]).toBe(true);
  });
});

describe("what is not a lowering", () => {
  it("a session with nothing changed shows no line and reports override_used false", () => {
    const { ctx } = started();
    const out = end(ctx, CLEAN_TEXT);
    expect(out.notice).toBeNull();
    expect(lastEnforcement(ctx)["override_used"]).toBe(false);
  });

  it("quiet keeps enforcing: no lowered line, override_used false", () => {
    const { ctx } = started();
    runCommand(["quiet"], { ...ctx, env: { PROSEGATE_SESSION: SESSION } });
    const out = end(ctx);
    expect(out.decision).toBe("continue");
    expect(out.notice).toBeNull();
    expect(lastEnforcement(ctx)["override_used"]).toBe(false);
  });

  it("a profile whose own definition is advisory is not lowered by being advisory", () => {
    const { home, ctx } = started();
    put(home, "profiles/adv.yaml", "schema: prosegate.profile/1\nid: local/adv\nversion: 1\nname: Adv\nextends: local/base\nenforcement:\n  mode: advisory\n");
    runCommand(["profile", "local/adv"], { ...ctx, env: { PROSEGATE_SESSION: SESSION } });
    // The new file appeared mid-session, so that one reason is claimed; the mode is not.
    const out = end(ctx, TIC_TEXT, { turn_id: "t1" });
    expect(out.decision).toBe("allow");
    expect(out.notice).not.toContain("(advisory");
    expect(out.notice).toContain("advisory, not enforced");
  });

  it("the user's own rule off is reported as the rules switched off, not as an outside file change", () => {
    const { ctx } = started();
    runCommand(["rule", "off", "core.hedge.001"], { ...ctx, env: { PROSEGATE_SESSION: SESSION } });
    const out = end(ctx);
    expect(out.notice).toContain(LOWERED("1 rule switched off"));
    expect(out.notice).not.toContain("files changed");
  });

  it("under org policy required nothing local can lower enforcement, and no lowering is claimed", () => {
    const policy = { org_id: "acme-1", org_name: "Acme", namespace: "acme", enforcement_default: "required" as const };
    const synced = { profiles: { "acme/base": { yaml: 'schema: prosegate.profile/1\nid: acme/base\nversion: 3\nname: Acme base\nrule_packs:\n  - { id: core, version: ">=0.1.0 <1.0.0" }\n', signed: true, origin: "synced" as const } }, packs: {} };
    const { home, ctx } = started({ policy, synced });
    put(home, "profiles/base.yaml", ALL_INFO);
    const out = end(ctx);
    expect(out.decision).toBe("continue");
    expect(out.notice ?? "").not.toContain("lowered");
    expect(lastEnforcement(ctx)["override_used"]).toBe(false);
  });
});

describe("once per session, and again when the reason changes", () => {
  it("shows once, repeats nothing, shows again for a new reason, and again after it was cleared and came back", () => {
    const { home, ctx } = started();
    const base = put(home, "profiles/base.yaml", overlay("overrides:\n  rules:\n    core.hedge.001: { enabled: false }\n"));
    const first = end(ctx, CLEAN_TEXT, { turn_id: "t1" });
    expect(first.notice).toContain("1 rule switched off");
    expect(end(ctx, CLEAN_TEXT, { turn_id: "t2" }).notice).toBeNull();
    // A second rule: the reason changed.
    writeFileSync(base, overlay("overrides:\n  rules:\n    core.hedge.001: { enabled: false }\n    core.filler.001: { enabled: false }\n"));
    expect(end(ctx, CLEAN_TEXT, { turn_id: "t3" }).notice).toContain("2 rules switched off");
    expect(end(ctx, CLEAN_TEXT, { turn_id: "t4" }).notice).toBeNull();
    // The file is removed: the files match the session-start record again, so nothing is lowered and nothing is shown.
    rmSync(base);
    expect(end(ctx, CLEAN_TEXT, { turn_id: "t5" }).notice).toBeNull();
    // And when the same lowering comes back it is shown again, because the earlier one had cleared.
    writeFileSync(base, overlay("overrides:\n  rules:\n    core.hedge.001: { enabled: false }\n"));
    expect(end(ctx, CLEAN_TEXT, { turn_id: "t6" }).notice).toContain("1 rule switched off");
    expect(end(ctx, CLEAN_TEXT, { turn_id: "t7" }).notice).toBeNull();
  });

  it("clearing the lowering resets it, so a new lowering shows again", () => {
    const { home, ctx } = started();
    runCommand(["off"], { ...ctx, env: { PROSEGATE_SESSION: SESSION } });
    expect(end(ctx, CLEAN_TEXT, { turn_id: "t1" }).notice).toBe(LOWERED("off"));
    runCommand(["enforce"], { ...ctx, env: { PROSEGATE_SESSION: SESSION } });
    expect(end(ctx, CLEAN_TEXT, { turn_id: "t2" }).notice).toBeNull();
    runCommand(["advisory"], { ...ctx, env: { PROSEGATE_SESSION: SESSION } });
    expect(end(ctx, CLEAN_TEXT, { turn_id: "t3" }).notice).toBe(LOWERED("advisory"));
    expect(home).toBeTruthy();
  });

  it("it is part of the notice next to a review notice, and never in the feedback the model reads", () => {
    const { ctx } = started();
    runCommand(["advisory"], { ...ctx, env: { PROSEGATE_SESSION: SESSION } });
    const out = end(ctx);
    expect(out.notice?.split("\n")[0]).toBe(LOWERED("advisory"));
    expect(out.feedback_text).toBe("");
    const enforced = started();
    put(enforced.home, "profiles/base.yaml", overlay("overrides:\n  rules:\n    core.vocab.003: { enabled: false }\n"));
    const o2 = end(enforced.ctx);
    expect(o2.decision).toBe("continue");
    expect(o2.feedback_text).not.toMatch(/lowered|prosegate status/);
  });

  it("is shown at session start for lowering already in place (resume), through notice and not inject", () => {
    const { home, ctx } = started();
    put(home, "profiles/base.yaml", overlay("enforcement:\n  mode: advisory\n"));
    const out = sessionStart({ harness: "claude-code", session_id: SESSION, cwd: CWD, mode: "interactive", source: "resume" }, ctx).output;
    expect(out.notice).toBe(LOWERED("advisory"));
    expect(out.inject).not.toContain("lowered");
    const again = sessionStart({ harness: "claude-code", session_id: SESSION, cwd: CWD, mode: "interactive", source: "resume" }, ctx).output;
    expect(again.notice).toBeNull();
    expect(lastEnforcement(ctx)["override_used"]).toBe(true);
  });

  it("headless shows no line, but still reports override_used", () => {
    const { home, ctx } = started();
    put(home, "profiles/base.yaml", overlay("enforcement:\n  mode: advisory\n"));
    const out = end({ ...ctx, env: { CI: "true" } });
    expect(out.notice).toBeNull();
    expect(lastEnforcement(ctx)["override_used"]).toBe(true);
  });
});

describe("status lists what was lowered", () => {
  it("the lowered mode, the downgraded categories and the rules switched off", () => {
    const { home, ctx } = started();
    put(home, "profiles/base.yaml", overlay("enforcement:\n  mode: advisory\noverrides:\n  categories:\n    hedge: { severity: info }\n  rules:\n    core.filler.001: { enabled: false }\n"));
    const lines = runCommand(["status"], { ...ctx, env: { PROSEGATE_SESSION: SESSION } }).out.trimEnd().split("\n");
    expect(lines[0]).toMatch(/^Mode: advisory \(the profile's setting\) — lowered: advisory, 1 rule switched off, severity lowered on \d+ rules?, local profile files changed since the session started$/);
    expect(lines[2]).toMatch(/^Rules off: core\.filler\.001; severity lowered on filler, hedge$|^Rules off: core\.filler\.001; severity lowered on hedge$/);
  });
});

describe("computeLowering, pure", () => {
  const ctx = testCtx(tmpDir());
  const resolved = resolveSession(ctx, "local/base").resolved;
  const state = (hashes: Record<string, string>) => ({ ...(JSON.parse("{}") as object), local_hashes: hashes }) as never;

  it("compares against the baseline, ranks severity, and ignores a baseline that does not pin the rule's pack", () => {
    const baseline = resolveBaseline(ctx, "local/base");
    expect(baseline).not.toBeNull();
    const eff = { mode: "enforce" as const, source: "profile" as const, headless: false, required: false };
    const none = computeLowering({ state: state({}), eff, resolved, baseline, packs: [], currentHashes: {} });
    expect(none.what).toBe("");
    expect(loweredNoticeLine("x")).toBe(LOWERED("x"));
    const changed = computeLowering({ state: state({ "profiles/a.yaml": "1" }), eff, resolved, baseline, packs: [], currentHashes: { "profiles/a.yaml": "2" } });
    expect(changed.filesChanged).toBe(true);
    const gone = computeLowering({ state: state({ "profiles/a.yaml": "1" }), eff, resolved, baseline, packs: [], currentHashes: {} });
    expect(gone.filesChanged).toBe(true);
    const same = computeLowering({ state: state({ "profiles/a.yaml": "1" }), eff, resolved, baseline, packs: [], currentHashes: { "profiles/a.yaml": "1" } });
    expect(same.filesChanged).toBe(false);
  });
});

