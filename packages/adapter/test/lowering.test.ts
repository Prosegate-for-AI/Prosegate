import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { runCommand } from "../src/commands.js";
import type { Ctx } from "../src/ctx.js";
import { sessionStart, turnEnd, type TurnEndOutput } from "../src/hooks.js";
import { computeLowering, loweredNoticeLine } from "../src/lowering.js";
import { parseRulePackYaml } from "@prosegate/profiles";
import { loadLocal, resolveSession } from "../src/profiles.js";
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

  it("a lowering made mid-session shows on the allow that ends the turn, not on a continuation the shim never shows", () => {
    const { home, ctx } = started();
    put(home, "profiles/base.yaml", overlay("overrides:\n  rules:\n    core.hedge.001: { enabled: false }\n"));
    const p1 = end(ctx, TIC_TEXT, { turn_id: "t1" });
    expect(p1.decision).toBe("continue");
    expect(p1.notice ?? "").not.toContain("lowered");
    const p2 = end(ctx, TIC_TEXT, { turn_id: "t1", continuation: true });
    expect(p2.decision).toBe("continue");
    expect(p2.notice ?? "").not.toContain("lowered");
    const cap = end(ctx, TIC_TEXT, { turn_id: "t1", continuation: true });
    expect(cap.decision).toBe("allow");
    expect(cap.notice).toContain("enforcement is lowered in this session (1 rule switched off");
    expect(cap.notice).toContain("shipped as is");
    expect(end(ctx, CLEAN_TEXT, { turn_id: "t2" }).notice).toBeNull();
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
    const out = end(ctx, CLEAN_TEXT);
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
    // The record of what was shown starts over at every session start (N2): the next resume shows it again.
    const again = sessionStart({ harness: "claude-code", session_id: SESSION, cwd: CWD, mode: "interactive", source: "resume" }, ctx).output;
    expect(again.notice).toBe(LOWERED("advisory"));
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
  const eff = { mode: "enforce" as const, source: "profile" as const, headless: false, required: false };
  const same = { profile: resolved, substituted: false };
  const call = (over: Partial<Parameters<typeof computeLowering>[0]> = {}) =>
    computeLowering({ eff, resolved, baseline: same, bodies: [], recordedHashes: {}, currentHashes: {}, ...over });

  it("an unchanged profile is not lowered, and the hash record adds a reason but never removes one", () => {
    expect(call().what).toBe("");
    expect(loweredNoticeLine("x")).toBe(LOWERED("x"));
    expect(call({ recordedHashes: { "profiles/a.yaml": "1" }, currentHashes: { "profiles/a.yaml": "2" } }).filesChanged).toBe(true);
    expect(call({ recordedHashes: { "profiles/a.yaml": "1" } }).filesChanged).toBe(true);
    expect(call({ recordedHashes: { "profiles/a.yaml": "1" }, currentHashes: { "profiles/a.yaml": "1" } }).filesChanged).toBe(false);
  });

  it("finds every way a profile can be weaker than its baseline, with the hash record empty or rewritten", () => {
    const weaker = (patch: object) => ({ ...resolved, ...patch }) as typeof resolved;
    const against = (profile: typeof resolved) => call({ resolved: profile, baseline: same });
    const floor = against(weaker({ thresholds: { ...resolved.thresholds, token_floor_words: resolved.thresholds.token_floor_words + 1 } }));
    expect(floor.what).toBe("review thresholds raised");
    expect(against(weaker({ thresholds: { ...resolved.thresholds, reviewer_floor_words: resolved.thresholds.reviewer_floor_words + 5 } })).what).toBe("review thresholds raised");
    expect(against(weaker({ allow_terms: ["robust", "seamless"] })).what).toBe("2 allowed terms added");
    expect(against(weaker({ allow_terms: ["robust"] })).what).toBe("1 allowed term added");
    expect(against(weaker({ enforcement: { ...resolved.enforcement, pass_cap: 1 } })).what).toBe("revision passes reduced");
    expect(against(weaker({ enforcement: { ...resolved.enforcement, render: "none" } })).what).toBe("notices turned off by the profile");
    // More strict is not lowered.
    expect(against(weaker({ thresholds: { ...resolved.thresholds, token_floor_words: 0 } })).what).toBe("");
    expect(against(weaker({ enforcement: { ...resolved.enforcement, pass_cap: 2 } })).what).toBe("");
  });

  it("the reviewer being off, or having fewer categories, is a lowering", () => {
    const reviewing = { ...resolved, reviewer: { ...resolved.reviewer, enabled: true, categories: ["tone", "register"] } } as unknown as typeof resolved;
    const base = { profile: reviewing, substituted: false };
    const off = { ...reviewing, reviewer: { ...reviewing.reviewer, enabled: false } } as typeof resolved;
    expect(call({ resolved: off, baseline: base }).what).toBe("reviewer switched off");
    const fewer = { ...reviewing, reviewer: { ...reviewing.reviewer, categories: ["tone"] } } as unknown as typeof resolved;
    expect(call({ resolved: fewer, baseline: base }).what).toBe("reviewer categories removed");
    expect(call({ resolved: reviewing, baseline: base }).what).toBe("");
  });

  it("a profile that exists only in the user's files is named, whatever the cause of its weakness", () => {
    const weak = { ...resolved, id: "local/weak", enforcement: { ...resolved.enforcement, mode: "advisory" as const } } as typeof resolved;
    const advisory = { mode: "advisory" as const, source: "profile" as const, headless: false, required: false };
    const out = call({ resolved: weak, eff: advisory, baseline: { profile: resolved, substituted: true } });
    expect(out.what).toBe("local profile local/weak");
    expect(out.weakProfile).toBe("local/weak");
    // The user's own command on top adds the mode, and keeps the name.
    const off = { mode: "off" as const, source: "command" as const, headless: false, required: false };
    expect(call({ resolved: weak, eff: off, baseline: { profile: resolved, substituted: true } }).what).toBe("off, local profile local/weak");
    // A user-file-only profile that is no weaker than its baseline is not reported.
    expect(call({ resolved: { ...resolved, id: "local/same" }, baseline: { profile: resolved, substituted: true } }).what).toBe("");
  });

  it("rules gone from the packs in effect count as switched off (a pack that carries fewer rules than the baseline's)", () => {
    const few = parseRulePackYaml(
      [
        "schema: prosegate.rulepack/1",
        "id: core",
        "version: 0.9.0",
        "findings_schema: 1",
        "rules:",
        "  - id: core.vocab.001",
        "    category: vocab",
        "    severity: block",
        "    match: { kind: phrase, phrases: [synergy, synergies] }",
        '    instruction: { action: replace, text: "Say what actually combines." }',
        '    examples: { hit: ["We expect synergy from the merger."], miss: ["We expect savings from the merger."] }',
        "",
      ].join("\n"),
    );
    if (!few.ok) throw new Error("fixture pack does not parse");
    const pin = resolved.packs[0] as (typeof resolved.packs)[number];
    const swapped = { ...resolved, packs: [{ ...pin, version: "0.9.0", origin: "local" as const }] } as typeof resolved;
    const out = call({ resolved: swapped, bodies: [few.value] });
    expect(out.what).toMatch(/^\d+ rules switched off$/);
    expect(out.rulesOff).not.toContain("core.vocab.001");
    expect(out.rulesOff.length).toBeGreaterThan(5);
  });

  it("quiet is not a lowering, and required policy cannot be lowered", () => {
    expect(call({ eff: { ...eff, mode: "quiet", source: "command" } }).what).toBe("");
    expect(call({ eff: { ...eff, required: true }, resolved: { ...resolved, thresholds: { ...resolved.thresholds, token_floor_words: 9e6 } } as typeof resolved }).what).toBe("");
  });
});

// ---- N1, N2: a full comparison every turn, independent of anything the agent can edit --------------------------

describe("the full comparison, made at every session-start and turn-end (N1, N2)", () => {
  const WEAK = "schema: prosegate.profile/1\nid: local/weak\nversion: 1\nname: Weak\nextends: local/base\noverrides:\n  thresholds:\n    token_floor_words: 1000000\n";
  const stateFile = (home: string) => join(home, "sessions", SESSION, "state.json");
  const readState = (home: string) => JSON.parse(readFileSync(stateFile(home), "utf8")) as Record<string, unknown>;
  const editState = (home: string, patch: Record<string, unknown>) => writeFileSync(stateFile(home), JSON.stringify({ ...readState(home), ...patch }));
  const rewriteHashes = (home: string, ctx: Ctx) => {
    // What an agent would do: set the integrity record to match the files as they are now.
    const now = loadLocal(ctx).hashes;
    editState(home, { local_hashes: now });
  };
  const fresh = (): { home: string; ctx: Ctx } => started();

  it("an overlay raising token_floor_words to 1,000,000 is reported though the hash record was rewritten to match", () => {
    const { home, ctx } = fresh();
    put(home, "profiles/base.yaml", overlay("overrides:\n  thresholds:\n    token_floor_words: 1000000\n"));
    rewriteHashes(home, ctx);
    const out = end(ctx, CLEAN_TEXT);
    expect(out.notice).toBe(LOWERED("review thresholds raised"));
    expect(lastEnforcement(ctx)["override_used"]).toBe(true);
  });

  it("allow_terms added, pass_cap 1 and render none are each reported, hash record rewritten", () => {
    const cases: Array<[string, string, string]> = [
      ["allow_terms", "overrides:\n  allow_terms: [robust, seamless, holistic]\n", "3 allowed terms added"],
      ["pass_cap", "enforcement:\n  pass_cap: 1\n", "revision passes reduced"],
      ["render", "enforcement:\n  render: none\n", "notices turned off by the profile"],
    ];
    for (const [, body, what] of cases) {
      const { home, ctx } = fresh();
      put(home, "profiles/base.yaml", overlay(body));
      rewriteHashes(home, ctx);
      expect(end(ctx, CLEAN_TEXT).notice, what).toBe(LOWERED(what));
    }
  });

  it("a local pack cannot stand in for the bundled core: the resolver refuses it, the bundled rules stay, and the issue is reported", () => {
    const { home, ctx } = fresh();
    const pack = [
      "schema: prosegate.rulepack/1",
      "id: core",
      "version: 0.9.0",
      "findings_schema: 1",
      "rules:",
      "  - id: core.vocab.001",
      "    category: vocab",
      "    severity: block",
      "    match: { kind: phrase, phrases: [synergy, synergies] }",
      '    instruction: { action: replace, text: "Say what actually combines." }',
      '    examples: { hit: ["We expect synergy from the merger."], miss: ["We expect savings from the merger."] }',
      "",
    ].join("\n");
    put(home, "packs/core.yaml", pack);
    put(home, "profiles/base.yaml", overlay('rule_packs:\n  - { id: core, version: "0.9.0" }\n'));
    rewriteHashes(home, ctx);
    const resolved = resolveSession(ctx, "local/base");
    expect(resolved.fellBack).toBe(true);
    expect(resolved.resolved.packs.find((p) => p.id === "core")?.origin).toBe("bundled");
    expect(end(ctx, TIC_TEXT).decision).toBe("continue");
  });

  it("a local-only profile weaker than its base is reported by name, and named again at the next session start", () => {
    const { home, ctx } = fresh();
    put(home, "profiles/weak.yaml", WEAK);
    editState(home, { active_profile: "local/weak" });
    rewriteHashes(home, ctx);
    const out = end(ctx, CLEAN_TEXT);
    expect(out.notice).toBe(LOWERED("local profile local/weak"));
    expect(readState(home)["lowered_shown"]).toBe("local profile local/weak");
    expect(end(ctx, CLEAN_TEXT, { turn_id: "t2" }).notice).toBeNull();
    const resumed = sessionStart({ harness: "claude-code", session_id: SESSION, cwd: CWD, mode: "interactive", source: "resume" }, ctx).output;
    expect(resumed.notice).toBe(LOWERED("local profile local/weak"));
  });

  it("a local-only profile that extends a bundled one is compared with that one, not with base", () => {
    const { home, ctx } = fresh();
    put(home, "profiles/mine.yaml", "schema: prosegate.profile/1\nid: local/mine\nversion: 1\nname: Mine\nextends: local/design-doc\n");
    editState(home, { active_profile: "local/mine" });
    rewriteHashes(home, ctx);
    // design-doc allows "comprehensive", which base does not; that is the bundled profile's own definition.
    expect(end(ctx, CLEAN_TEXT).notice).toBeNull();
  });

  it("edits to state.json cannot hide a lowering from the next session start", () => {
    const { home, ctx } = fresh();
    put(home, "profiles/base.yaml", overlay("overrides:\n  thresholds:\n    token_floor_words: 1000000\n"));
    // lowered_shown is set ahead of time to exactly what the line would say: this session's repeat is suppressed...
    editState(home, { lowered_shown: "review thresholds raised, local profile files changed since the session started" });
    rewriteHashes(home, ctx);
    editState(home, { lowered_shown: "review thresholds raised" });
    expect(end(ctx, CLEAN_TEXT).notice).toBeNull();
    // ...and the next session start shows it, whatever the file says.
    const next = sessionStart({ harness: "claude-code", session_id: SESSION, cwd: CWD, mode: "interactive", source: "resume" }, ctx).output;
    expect(next.notice).toBe(LOWERED("review thresholds raised"));
  });

  it("state.json deleted or corrupted inside the turn does not hide it", () => {
    for (const damage of ["delete", "corrupt"]) {
      const { home, ctx } = fresh();
      put(home, "profiles/base.yaml", overlay("overrides:\n  thresholds:\n    token_floor_words: 1000000\n"));
      if (damage === "delete") rmSync(stateFile(home));
      else writeFileSync(stateFile(home), "{");
      const out = end(ctx, CLEAN_TEXT);
      expect(out.notice, damage).toBe(LOWERED("review thresholds raised"));
      expect(lastEnforcement(ctx)["override_used"], damage).toBe(true);
    }
  });

  it("mode set to off in state.json with lowered_shown pre-set shows at the next session start", () => {
    const { home, ctx } = fresh();
    editState(home, { mode: "off", lowered_shown: "off" });
    expect(end(ctx, CLEAN_TEXT).notice).toBeNull();
    expect(sessionStart({ harness: "claude-code", session_id: SESSION, cwd: CWD, mode: "interactive", source: "resume" }, ctx).output.notice).toBe(LOWERED("off"));
  });
});
