import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { PackLoadError, clearParseCaches, loadLocal, loadPacks, parseStats, resolveAndLoad, resolveSession } from "../src/profiles.js";
import { sessionStart, turnEnd } from "../src/hooks.js";
import { runCommand } from "../src/commands.js";
import { CLEAN_TEXT, SESSION, TIC_TEXT, testCtx, tmpDir } from "./helpers.js";

// Resolution at every session-start and turn-end (ADR-19, obligations 2, 6, 7, 9, 10, 12, 15, 19).

beforeEach(() => clearParseCaches());

function put(home: string, rel: string, text: string): void {
  const file = join(home, rel);
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, text);
}

const MINE = (extra = "") =>
  `schema: prosegate.profile/1\nid: local/mine\nversion: 1\nname: Mine\nextends: local/base\n${extra}`;

const PACK = (over: { id?: string; version?: string; hit?: string; miss?: string; phrase?: string } = {}) => `schema: prosegate.rulepack/1
id: ${over.id ?? "mypack"}
version: ${over.version ?? "1.0.0"}
findings_schema: 1
rules:
  - id: ${over.id ?? "mypack"}.filler.001
    category: filler
    severity: block
    match: { kind: phrase, phrases: ["${over.phrase ?? "frobnicate the widget"}"], boundary: word, case_insensitive: true }
    instruction: { action: remove, text: "Remove it." }
    examples: { hit: ["${over.hit ?? "Please frobnicate the widget now."}"], miss: ["${over.miss ?? "Leave the widget alone."}"] }
`;

function endTurn(ctx: ReturnType<typeof testCtx>, text: string, id: string) {
  return turnEnd({ session_id: SESSION, turn_id: id, assistant_text: text, user_message: "", tool_calls: [], continuation: false }, ctx).output;
}

describe("sources", () => {
  it("bundled content is marked bundled and local files local; nothing is marked synced (obligation 2)", () => {
    const home = tmpDir();
    put(home, "profiles/mine.yaml", MINE());
    const r = resolveSession(testCtx(home), "local/mine");
    expect(r.resolved.sources.map((s) => [s.id, s.origin])).toEqual([
      ["local/base", "bundled"],
      ["local/mine", "local"],
    ]);
    expect(r.resolved.packs).toMatchObject([{ id: "core", origin: "bundled", signed: false }]);
    expect(r.issues).toEqual([]);
  });

  it("the bundled packs are always in the sources, local packs alongside them (obligation 7)", () => {
    const home = tmpDir();
    put(home, "packs/mypack.yaml", PACK());
    put(home, "profiles/mine.yaml", MINE("rule_packs:\n  - { id: mypack, version: \">=1.0.0 <2.0.0\" }\n"));
    const r = resolveAndLoad(testCtx(home), "local/mine");
    expect(r.resolved.packs.map((p) => [p.id, p.version, p.origin])).toEqual([
      ["core", "0.1.0", "bundled"],
      ["mypack", "1.0.0", "local"],
    ]);
    expect(r.packs.map((p) => p.id)).toEqual(["core", "mypack"]);
  });

  it("only the packs the snapshot pins are loaded (obligation 15)", () => {
    const home = tmpDir();
    put(home, "packs/mypack.yaml", PACK());
    const r = resolveAndLoad(testCtx(home), "local/base");
    expect(r.packs.map((p) => p.id)).toEqual(["core"]);
  });

  it("a local profile can overlay a bundled one with the same id", () => {
    const home = tmpDir();
    put(home, "profiles/base.yaml", 'schema: prosegate.profile/1\nid: local/base\nversion: 1\nname: Base\noverrides:\n  allow_terms: ["robust"]\n');
    const r = resolveSession(testCtx(home), "local/base");
    expect(r.resolved.allow_terms).toEqual(["robust"]);
    expect(r.resolved.sources.map((s) => s.origin)).toEqual(["bundled", "local"]);
  });
});

describe("a resolution error falls back to local/base and names the file", () => {
  it("a local file that does not parse is skipped and reported; the rest resolve", () => {
    const home = tmpDir();
    put(home, "profiles/broken.yaml", "schema: nope\n");
    put(home, "profiles/mine.yaml", MINE());
    const r = resolveSession(testCtx(home), "local/mine");
    expect(r.fellBack).toBe(false);
    expect(r.issues).toHaveLength(1);
    expect(r.issues[0]).toMatch(/^profiles\/broken\.yaml: /);
  });

  it("an active profile that cannot resolve falls back, and the issue names its file", () => {
    const home = tmpDir();
    put(home, "profiles/mine.yaml", MINE("rule_packs:\n  - { id: core, version: \">=2.0.0 <3.0.0\" }\n"));
    const r = resolveSession(testCtx(home), "local/mine");
    expect(r.fellBack).toBe(true);
    expect(r.resolved.id).toBe("local/base");
    expect(r.issues.at(-1)).toMatch(/^profiles\/mine\.yaml: .*using local\/base instead$/);
  });

  it("a profile that no longer exists falls back too", () => {
    const r = resolveSession(testCtx(tmpDir()), "local/gone");
    expect(r.fellBack).toBe(true);
    expect(r.issues[0]).toContain("local/gone");
  });

  it("a local pack that reuses the bundled pack id falls back to the starters alone", () => {
    const home = tmpDir();
    put(home, "packs/evil.yaml", PACK({ id: "core", version: "9.0.0" }));
    const r = resolveSession(testCtx(home), "local/base");
    expect(r.fellBack).toBe(true);
    expect(r.resolved.packs[0]).toMatchObject({ id: "core", version: "0.1.0", origin: "bundled" });
    expect(r.issues.join("\n")).toContain("packs/evil.yaml");
  });

  it("the session keeps working: turn-end reviews under local/base and shows the line once, on a turn without its own notice", () => {
    const home = tmpDir();
    const ctx = testCtx(home);
    put(home, "profiles/mine.yaml", MINE("rule_packs:\n  - { id: core, version: \">=2.0.0 <3.0.0\" }\n"));
    sessionStart({ harness: "claude-code", session_id: SESSION, cwd: "/work/project", mode: "interactive" }, ctx);
    runCommand(["profile", "local/mine"], { ...ctx, env: { PROSEGATE_SESSION: SESSION } }); // refuses: cannot resolve
    // Put the broken profile in the state by hand, as a remembered profile would be.
    const store = JSON.parse(readFileSync(join(home, "sessions", SESSION, "state.json"), "utf8")) as Record<string, unknown>;
    writeFileSync(join(home, "sessions", SESSION, "state.json"), JSON.stringify({ ...store, active_profile: "local/mine" }));

    const withFindings = endTurn(ctx, TIC_TEXT, "t1");
    expect(withFindings.decision).toBe("continue");
    expect(withFindings.result.profile.id).toBe("local/base");
    const clean = endTurn(ctx, CLEAN_TEXT, "t2");
    expect(clean.notice).toMatch(/^Prosegate · profiles\/mine\.yaml: .*using local\/base instead$/);
    expect(endTurn(ctx, CLEAN_TEXT, "t3").notice).toBeNull();
  });
});

describe("local packs (obligations 9, 10, 19)", () => {
  it("a pack whose miss example fires its own rule is rejected, its file is named, and the profile falls back", () => {
    const home = tmpDir();
    put(home, "packs/bad.yaml", PACK({ miss: "Please frobnicate the widget now." }));
    put(home, "profiles/mine.yaml", MINE("rule_packs:\n  - { id: mypack, version: \">=1.0.0 <2.0.0\" }\n"));
    const r = resolveAndLoad(testCtx(home), "local/mine");
    expect(r.fellBack).toBe(true);
    expect(r.issues.join("\n")).toMatch(/packs\/bad\.yaml: pack mypack: rule mypack\.filler\.001 fires on its own miss example; file ignored/);
    expect(r.packs.map((p) => p.id)).toEqual(["core"]);
  });

  it("a pack whose hit example does not fire its rule is rejected", () => {
    const home = tmpDir();
    put(home, "packs/bad.yaml", PACK({ hit: "Nothing to see here at all." }));
    put(home, "profiles/mine.yaml", MINE("rule_packs:\n  - { id: mypack, version: \">=1.0.0 <2.0.0\" }\n"));
    const r = resolveAndLoad(testCtx(home), "local/mine");
    expect(r.issues.join("\n")).toContain("does not fire on its own hit example");
  });

  it("a pack that does not compile or validate is ignored with its file named", () => {
    const home = tmpDir();
    put(home, "packs/junk.yaml", "schema: prosegate.rulepack/1\nid: junk\n");
    const r = resolveAndLoad(testCtx(home), "local/base");
    expect(r.issues[0]).toMatch(/^packs\/junk\.yaml: /);
  });

  it("corpus-ref examples cannot be resolved here and are skipped, not failed", () => {
    const home = tmpDir();
    const body = PACK().replace('hit: ["Please frobnicate the widget now."]', 'hit: ["<eval corpus ref: mypack/filler-001-hit-01>", "Please frobnicate the widget now."]');
    put(home, "packs/mypack.yaml", body);
    put(home, "profiles/mine.yaml", MINE("rule_packs:\n  - { id: mypack, version: \">=1.0.0 <2.0.0\" }\n"));
    expect(resolveAndLoad(testCtx(home), "local/mine").fellBack).toBe(false);
  });

  it("loads the body by the exact id and version the snapshot pinned, and refuses a body that says otherwise (obligation 9)", () => {
    const home = tmpDir();
    put(home, "packs/mypack.yaml", PACK());
    put(home, "profiles/mine.yaml", MINE("rule_packs:\n  - { id: mypack, version: \">=1.0.0 <2.0.0\" }\n"));
    const ctx = testCtx(home);
    const r = resolveSession(ctx, "local/mine");
    const local = loadLocal(ctx);
    // The file on disk is replaced by a different version after resolution.
    const swapped = { ...local, packs: { mypack: [{ file: "packs/mypack.yaml", version: "1.0.0", yaml: PACK({ version: "1.0.1" }) }] } };
    expect(() => loadPacks(r.resolved, swapped)).toThrow(PackLoadError);
    expect(() => loadPacks(r.resolved, swapped)).toThrow(/pack body says mypack 1\.0\.1, but the profile pinned mypack 1\.0\.0/);
    const missing = { ...local, packs: {} };
    expect(() => loadPacks(r.resolved, missing)).toThrow(/has no body on this machine/);
  });

  it("validates an unchanged pack once per process, however many resolutions follow (obligation 19)", () => {
    const home = tmpDir();
    put(home, "packs/mypack.yaml", PACK());
    put(home, "profiles/mine.yaml", MINE("rule_packs:\n  - { id: mypack, version: \">=1.0.0 <2.0.0\" }\n"));
    const ctx = testCtx(home);
    for (let i = 0; i < 6; i++) resolveAndLoad(ctx, "local/mine");
    expect(parseStats.packParses).toBe(2); // mypack and the bundled core, once each
    expect(parseStats.profileParses).toBe(1); // the one local profile file
    put(home, "packs/mypack.yaml", PACK({ phrase: "frobnicate the gadget", hit: "Please frobnicate the gadget now." }));
    resolveAndLoad(ctx, "local/mine");
    expect(parseStats.packParses).toBe(3); // changed text is validated again
  });

  it("a local pack's rules review the turn like any other", () => {
    const home = tmpDir();
    put(home, "packs/mypack.yaml", PACK());
    put(home, "profiles/mine.yaml", MINE("rule_packs:\n  - { id: mypack, version: \">=1.0.0 <2.0.0\" }\n"));
    const ctx = testCtx(home);
    sessionStart({ harness: "claude-code", session_id: SESSION, cwd: "/work/project", mode: "interactive" }, ctx);
    expect(runCommand(["profile", "local/mine"], { ...ctx, env: { PROSEGATE_SESSION: SESSION } }).code).toBe(0);
    const out = endTurn(ctx, `${CLEAN_TEXT} Please frobnicate the widget before the release.`, "t1");
    expect(out.decision).toBe("continue");
    expect(out.feedback_text).toContain("mypack.filler.001");
  });
});
