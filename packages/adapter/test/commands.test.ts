import { existsSync, mkdirSync, readFileSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { OrgPolicyInput, ResolutionSources } from "@prosegate/profiles";
import { AGENT_MARKERS } from "../src/agent-context.js";
import { runCommand, type CommandResult } from "../src/commands.js";
import type { Ctx } from "../src/ctx.js";
import { sessionStart, turnEnd } from "../src/hooks.js";
import { readSpool } from "../src/telemetry.js";
import { CLEAN_TEXT, SESSION, TIC_TEXT, testCtx, tmpDir } from "./helpers.js";

// Every command, in process over a temp home (the subprocess side is in passcap.test.ts and agent.test.ts).

const CWD = "/work/project";

function started(over: Partial<Ctx> = {}): { home: string; ctx: Ctx } {
  const home = tmpDir();
  const ctx = testCtx(home, { cwd: CWD, ...over });
  sessionStart({ harness: "claude-code", session_id: SESSION, cwd: CWD, mode: "interactive" }, ctx);
  return { home, ctx: { ...ctx, env: { ...ctx.env, PROSEGATE_SESSION: SESSION } } };
}

function cmd(ctx: Ctx, ...argv: string[]): CommandResult {
  return runCommand(argv, ctx);
}

function stateOf(home: string, id = SESSION): { mode: string | null; active_profile: string; previous_profile: string | null; candidate: string | null; candidate_streak: number; local_hashes: Record<string, string> } {
  return JSON.parse(readFileSync(join(home, "sessions", id, "state.json"), "utf8")) as ReturnType<typeof stateOf>;
}

function profileFiles(home: string): string[] {
  const dir = join(home, "profiles");
  return existsSync(dir) ? readdirSync(dir).sort() : [];
}

function put(home: string, rel: string, text: string): string {
  const file = join(home, rel);
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, text);
  return file;
}

function age(home: string, id: string, ms: number): void {
  const dir = join(home, "sessions", id);
  const when = new Date(Date.now() - ms);
  for (const name of readdirSync(dir)) utimesSync(join(dir, name), when, when);
}

describe("mode commands", () => {
  it.each([
    ["advisory", "Prosegate: advisory for this session. Findings will be shown, not enforced. Run prosegate enforce to restore."],
    [
      "quiet",
      "Prosegate: quiet for this session. Findings are still enforced; Prosegate's own notices are hidden, though Claude Code still shows each revision request. Run prosegate enforce to restore.",
    ],
    ["off", "Prosegate: off for this session. Nothing will be reviewed. Run prosegate enforce to restore."],
  ])("%s sets the mode and prints its line", (name, line) => {
    const { home, ctx } = started();
    expect(cmd(ctx, name)).toEqual({ code: 0, out: `${line}\n`, err: "" });
    expect(stateOf(home).mode).toBe(name);
  });

  it("enforce restores enforcement, and says so plainly when it is already on", () => {
    const { home, ctx } = started();
    expect(cmd(ctx, "enforce")).toEqual({ code: 0, out: "Prosegate: already enforcing.\n", err: "" });
    expect(stateOf(home).mode).toBeNull();
    cmd(ctx, "advisory");
    expect(cmd(ctx, "enforce")).toEqual({ code: 0, out: "Prosegate: enforcement restored for this session.\n", err: "" });
    expect(stateOf(home).mode).toBe("enforce");
    // quiet counts as not-yet-enforcing in the full sense: enforce clears it.
    cmd(ctx, "quiet");
    expect(cmd(ctx, "enforce").out).toBe("Prosegate: enforcement restored for this session.\n");
  });

  it("a lowering command emits override_used; enforce does not", () => {
    const { ctx } = started();
    cmd(ctx, "advisory");
    const before = readSpool(ctx).length;
    cmd(ctx, "enforce");
    expect(readSpool(ctx)).toHaveLength(before);
    cmd(ctx, "off");
    const added = readSpool(ctx).slice(before);
    expect(added).toHaveLength(1);
    expect(added[0]).toContain('"override_used":true');
    expect(added[0]).toContain('"notice_via_model":false');
  });

  it("rejects extra arguments and unknown commands", () => {
    const { ctx } = started();
    expect(cmd(ctx, "advisory", "now").err).toBe("usage: prosegate advisory\n");
    expect(cmd(ctx, "frobnicate").err).toBe('prosegate: unknown command "frobnicate". Run prosegate --help.\n');
    expect(cmd(ctx, "constructor").err).toBe('prosegate: unknown command "constructor". Run prosegate --help.\n');
  });
});

describe("which session a command acts on (ADR-31)", () => {
  const noSessionText = (cwd: string) =>
    `Prosegate: no session found for ${cwd}. Run this from the directory your agent was started in, or set PROSEGATE_SESSION=<id>. If your agent is already running here, Prosegate's hooks are probably not installed.\n`;

  it("with no session, names the directory and the likely cause", () => {
    const home = tmpDir();
    const r = cmd(testCtx(home, { cwd: "/somewhere/else" }), "advisory");
    expect(r).toEqual({ code: 1, out: "", err: noSessionText("/somewhere/else") });
  });

  it("finds the session of the nearest ancestor directory", () => {
    const { home, ctx } = started();
    const deep = { ...ctx, cwd: `${CWD}/src/deep`, env: {} };
    expect(cmd(deep, "quiet").code).toBe(0);
    expect(stateOf(home).mode).toBe("quiet");
    // A sibling directory is not an ancestor.
    expect(cmd({ ...ctx, cwd: "/work/other", env: {} }, "off").err).toBe(noSessionText("/work/other"));
  });

  it("with two live sessions it refuses to guess, lists them, and accepts --session or PROSEGATE_SESSION", () => {
    const home = tmpDir();
    const ctx = testCtx(home, { cwd: CWD });
    sessionStart({ harness: "claude-code", session_id: "sess-a", cwd: CWD, mode: "interactive" }, ctx);
    sessionStart({ harness: "claude-code", session_id: "sess-b", cwd: CWD, mode: "interactive" }, ctx);
    const r = cmd(ctx, "quiet");
    expect(r.code).toBe(1);
    expect(r.err).toContain(`Prosegate: more than one session is running in ${CWD}. Pass --session <id> or set PROSEGATE_SESSION to one of:`);
    expect(r.err).toMatch(/\n {2}sess-[ab] {2}last active just now/);
    expect(r.err).toContain("sess-a");
    expect(r.err).toContain("sess-b");
    expect(stateOf(home, "sess-a").mode).toBeNull();
    expect(stateOf(home, "sess-b").mode).toBeNull();
    const named = cmd({ ...ctx, env: { PROSEGATE_SESSION: "sess-b" } }, "quiet");
    expect(named.code).toBe(0);
    expect(stateOf(home, "sess-b").mode).toBe("quiet");
    expect(stateOf(home, "sess-a").mode).toBeNull();
  });

  it("a session idle for hours is not live: the live one is chosen, and confirmations name it because others exist", () => {
    const home = tmpDir();
    const ctx = testCtx(home, { cwd: CWD });
    sessionStart({ harness: "claude-code", session_id: "sess-old", cwd: CWD, mode: "interactive" }, ctx);
    age(home, "sess-old", 10 * 3600_000);
    sessionStart({ harness: "claude-code", session_id: "sess-new", cwd: CWD, mode: "interactive" }, ctx);
    const r = cmd(ctx, "advisory");
    expect(r.code).toBe(0);
    expect(r.out).toBe("Prosegate: advisory for this session. Findings will be shown, not enforced. Run prosegate enforce to restore. (session sess-new)\n");
    expect(stateOf(home, "sess-new").mode).toBe("advisory");
    expect(stateOf(home, "sess-old").mode).toBeNull();
  });

  it("a lone session's confirmations do not name it", () => {
    const { ctx } = started();
    expect(cmd(ctx, "quiet").out).not.toContain("(session");
  });
});

describe("profile [<id>]", () => {
  it("sets the active profile, keeps the previous one, clears the candidate and remembers it for the directory", () => {
    const { home, ctx } = started();
    const state = stateOf(home);
    writeFileSync(join(home, "sessions", SESSION, "state.json"), JSON.stringify({ ...state, candidate: "local/email", candidate_streak: 2 }));
    expect(cmd(ctx, "profile", "local/pr-description")).toEqual({ code: 0, out: "Prosegate: profile set to local/pr-description; it applies from the next turn.\n", err: "" });
    expect(stateOf(home)).toMatchObject({ active_profile: "local/pr-description", previous_profile: "local/base", candidate: null, candidate_streak: 0 });
    const map = JSON.parse(readFileSync(join(home, "cwd-profiles.json"), "utf8")) as Record<string, { profile: string }>;
    expect(Object.values(map).map((v) => v.profile)).toEqual(["local/pr-description"]);
  });

  it("accepts the name a notice shows: an unambiguous slug", () => {
    const { home, ctx } = started();
    expect(cmd(ctx, "profile", "pr-description").out).toBe("Prosegate: profile set to local/pr-description; it applies from the next turn.\n");
    expect(stateOf(home).active_profile).toBe("local/pr-description");
    expect(cmd(ctx, "profile", "base").code).toBe(0);
  });

  it("refuses an ambiguous slug and lists the candidates", () => {
    const { home, ctx } = started();
    put(home, "profiles/b.yaml", "schema: prosegate.profile/1\nid: team/base\nversion: 1\nname: Team base\n");
    const r = cmd(ctx, "profile", "base");
    expect(r.code).toBe(1);
    expect(r.err).toBe('Prosegate: "base" matches more than one profile: local/base, team/base. Use the full id.\n');
  });

  it("the next session in the same directory starts on that profile", () => {
    const { home, ctx } = started();
    cmd(ctx, "profile", "local/email");
    const out = sessionStart({ harness: "claude-code", session_id: "next", cwd: CWD, mode: "interactive" }, testCtx(home, { cwd: CWD })).output;
    expect(out.active_profile).toBe("local/email");
    expect(out.inject).toContain("Active profile: Email.");
  });

  it("bare `prosegate profile` lists the profiles and marks the active one", () => {
    const { ctx } = started();
    expect(cmd(ctx, "profile")).toEqual({
      code: 0,
      out: "Prosegate: profiles (active: local/base):\n  local/base\n  local/chat-reply\n  local/design-doc\n  local/email\n  local/pr-description\n  local/writing-review\n",
      err: "",
    });
  });

  it("on an unknown name suggests the nearest id and lists what is available", () => {
    const { ctx } = started();
    expect(cmd(ctx, "profile", "pr-descripton").err).toBe(
      'Prosegate: no profile "pr-descripton". Did you mean local/pr-description? Available: local/base, local/chat-reply, local/design-doc, local/email, local/pr-description, local/writing-review.\n',
    );
    expect(cmd(ctx, "profile", "zzzzzzzz").err).toBe(
      'Prosegate: no profile "zzzzzzzz". Available: local/base, local/chat-reply, local/design-doc, local/email, local/pr-description, local/writing-review.\n',
    );
  });

  it("caps a long list and points at the bare command", () => {
    const { home, ctx } = started();
    for (let i = 0; i < 12; i++) put(home, `profiles/p${i}.yaml`, `schema: prosegate.profile/1\nid: team/p${String(i).padStart(2, "0")}\nversion: 1\nname: P ${i}\n`);
    const err = cmd(ctx, "profile", "qqqqqqqq").err;
    expect(err).toContain("(+8 more; run prosegate profile with no argument)");
    expect(err.split("\n")[0]?.length).toBeLessThan(400);
  });

  it("lists local profiles among the valid ids", () => {
    const { home, ctx } = started();
    put(home, "profiles/mine.yaml", "schema: prosegate.profile/1\nid: local/mine\nversion: 1\nname: Mine\nextends: local/base\n");
    expect(cmd(ctx, "profile", "local/nope").err).toContain("local/mine");
    expect(cmd(ctx, "profile", "local/mine").code).toBe(0);
  });

  it("takes at most one argument", () => {
    const { ctx } = started();
    expect(cmd(ctx, "profile", "a", "b").err).toBe("usage: prosegate profile [<id>]\n");
  });

  it("refuses a profile that cannot resolve, saying why", () => {
    const { home, ctx } = started();
    const file = put(home, "profiles/mine.yaml", "schema: prosegate.profile/1\nid: local/mine\nversion: 1\nname: Mine\nextends: local/base\nrule_packs:\n  - { id: core, version: \">=2.0.0 <3.0.0\" }\n");
    const r = cmd(ctx, "profile", "local/mine");
    expect(r.code).toBe(1);
    expect(r.err).toMatch(new RegExp(`^Prosegate: cannot use profile local/mine \\(${file.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&")}: .+\\)\\.\\n$`));
    expect(stateOf(home).active_profile).toBe("local/base");
  });

  it("emits a profile_select event with the id masked", () => {
    const { ctx } = started();
    cmd(ctx, "profile", "local/email");
    const last = readSpool(ctx).at(-1) ?? "";
    expect(last).toContain('"t":"profile_select"');
    expect(last).toContain('"by":"user"');
    expect(last).not.toContain("local/");
  });
});

describe("status", () => {
  it("prints effective mode, profile, disabled rules, last turn and automatic reviewer setting", () => {
    const { ctx } = started();
    cmd(ctx, "rule", "off", "core.hedge.001");
    const r = cmd(ctx, "status");
    const lines = r.out.trimEnd().split("\n");
    expect(r.code).toBe(0);
    expect(lines).toHaveLength(5);
    expect(lines[4]).toBe("Automatic AI reviewer: off");
    expect(lines[0]).toMatch(/^Mode: enforce \u2014 lowered: 1 rule switched off$/);
    expect(lines[1]).toBe("Profile: base v1");
    expect(lines[2]).toBe("Rules off: core.hedge.001");
    expect(lines[3]).toBe("Last turn: no reviewed turns yet");
  });

  it("shows the mode PROSEGATE_MODE gives, and who set it", () => {
    const { ctx } = started();
    expect(cmd({ ...ctx, env: { ...ctx.env, PROSEGATE_MODE: "advisory" } }, "status").out.split("\n")[0]).toMatch(/^Mode: advisory \(PROSEGATE_MODE\)/);
    cmd(ctx, "advisory");
    expect(cmd(ctx, "status").out.split("\n")[0]).toBe("Mode: advisory (set by you) \u2014 lowered: advisory");
  });

  it("lists the rules that are off for the active profile, not every overlay on disk", () => {
    const { ctx } = started();
    cmd(ctx, "profile", "local/email");
    cmd(ctx, "rule", "off", "core.vocab.003");
    cmd(ctx, "profile", "local/base");
    // The overlay belongs to local/email; base does not extend it.
    expect(cmd(ctx, "status").out.split("\n")[2]).toBe("Rules off: none");
    // An overlay of a parent does apply to its children, and status says so.
    cmd(ctx, "rule", "off", "core.hedge.001");
    cmd(ctx, "profile", "local/chat-reply");
    expect(cmd(ctx, "status").out.split("\n")[2]).toBe("Rules off: core.hedge.001");
    cmd(ctx, "profile", "local/email");
    expect(cmd(ctx, "status").out.split("\n")[2]).toBe("Rules off: core.hedge.001, core.vocab.003");
  });

  it("names the integer version, not the hash, and the org under required", () => {
    const home = tmpDir();
    const ctx = testCtx(home, { cwd: CWD, policy: POLICY, synced: SYNCED, env: { PROSEGATE_SESSION: SESSION } });
    sessionStart({ harness: "claude-code", session_id: SESSION, cwd: CWD, mode: "interactive" }, ctx);
    const lines = cmd(ctx, "status").out.split("\n");
    expect(lines[0]).toBe("Mode: enforce (required by Acme)");
    expect(lines[1]).toBe("Profile: base v3");
  });

  it("reports the last turn in words", () => {
    const { ctx } = started();
    const end = (text: string, over: Record<string, unknown> = {}) =>
      turnEnd({ session_id: SESSION, turn_id: "t", assistant_text: text, user_message: "", tool_calls: [], continuation: false, ...over }, ctx).output;
    end("Short.");
    expect(cmd(ctx, "status").out).toContain("Last turn: not reviewed (too short)");
    end(CLEAN_TEXT, { turn_id: "t2" });
    expect(cmd(ctx, "status").out).toContain("Last turn: clean\n");
    end(TIC_TEXT, { turn_id: "t3" });
    expect(cmd(ctx, "status").out).toMatch(/Last turn: revising, \d+ findings flagged/);
    end(TIC_TEXT, { turn_id: "t3", continuation: true });
    end(TIC_TEXT, { turn_id: "t3", continuation: true });
    expect(cmd(ctx, "status").out).toMatch(/Last turn: 2 remain after 2 revisions, shipped as is/);
    end(CLEAN_TEXT, { turn_id: "t4" });
    cmd(ctx, "advisory");
    end(TIC_TEXT, { turn_id: "t5" });
    expect(cmd(ctx, "status").out).toMatch(/Last turn: \d+ findings shown, not enforced/);
  });

  it("falls back to saying which profile it fell back from", () => {
    const { home, ctx } = started();
    put(home, "profiles/mine.yaml", "schema: prosegate.profile/1\nid: local/mine\nversion: 1\nname: Mine\nextends: local/base\nrule_packs:\n  - { id: core, version: \">=2.0.0 <3.0.0\" }\n");
    const state = stateOf(home);
    writeFileSync(join(home, "sessions", SESSION, "state.json"), JSON.stringify({ ...state, active_profile: "local/mine" }));
    expect(cmd(ctx, "status").out.split("\n")[1]).toBe("Profile: base v1 [fell back from mine; run prosegate reload]");
  });
});

describe("reload", () => {
  it("re-resolves, rewrites the cache and reports the version", () => {
    const { home, ctx } = started();
    cmd(ctx, "rule", "off", "core.hedge.001");
    const r = cmd(ctx, "reload");
    expect(r).toEqual({ code: 0, out: "Prosegate: reloaded profile base v1.\n", err: "" });
    const cache = JSON.parse(readFileSync(join(home, "sessions", SESSION, "profile.json"), "utf8")) as { rules: Record<string, unknown> };
    expect(Object.keys(cache.rules)).toContain("core.hedge.001");
  });

  it("prints every ignored file first, by absolute path, in plain words, then the result", () => {
    const { home, ctx } = started();
    const files = [1, 2, 3].map((i) => put(home, `profiles/bad${i}.yaml`, "schema: prosegate.profile/1\nid: local/x\n  version: [1\n"));
    const r = cmd(ctx, "reload");
    expect(r.code).toBe(0);
    const lines = r.out.trimEnd().split("\n");
    expect(lines).toHaveLength(4);
    files.forEach((file, i) => expect(lines[i]).toMatch(new RegExp(`^Prosegate: ignored ${file.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&")} \\(invalid YAML(, line \\d+)?\\)\\.$`)));
    expect(lines[3]).toBe("Prosegate: reloaded profile base v1.");
  });

  it("does not reset the integrity record (a reload must not forget a file change)", () => {
    const { home, ctx } = started();
    const before = stateOf(home).local_hashes;
    put(home, "profiles/mine.yaml", "schema: prosegate.profile/1\nid: local/mine\nversion: 1\nname: Mine\nextends: local/base\n");
    cmd(ctx, "reload");
    expect(stateOf(home).local_hashes).toEqual(before);
  });
});

describe("rule off / on / list", () => {
  it("rule off writes a managed overlay, takes effect at the next turn-end, and rule on removes it", () => {
    const { home, ctx } = started();
    const hedgeIn = (c: Ctx): boolean =>
      turnEnd({ session_id: SESSION, turn_id: `t-${Math.random()}`, assistant_text: TIC_TEXT, user_message: "", tool_calls: [], continuation: false }, c).output.result.findings.some((f) => f.rule_id === "core.hedge.001");
    expect(hedgeIn(ctx)).toBe(true);

    const off = cmd(ctx, "rule", "off", "core.hedge.001");
    expect(off).toEqual({
      code: 0,
      out: "Prosegate: rule core.hedge.001 is off for profile local/base in every session. Run prosegate rule on core.hedge.001 to restore.\n",
      err: "",
    });
    expect(profileFiles(home)).toEqual(["local--base.overlay.yaml"]);
    const path = join(home, "profiles", "local--base.overlay.yaml");
    const file = readFileSync(path, "utf8");
    expect(file).toContain("core.hedge.001: { enabled: false }");
    expect(file.split("\n")[0]).toBe("# Written by prosegate rule off / on. If you edit this file by hand, those commands stop managing it and you maintain it yourself.");
    expect(hedgeIn(ctx)).toBe(false);

    expect(cmd(ctx, "rule", "list").out).toBe(`core.hedge.001  ${path} (local/base)\n`);
    expect(cmd(ctx, "rule", "off", "core.hedge.001").out).toBe("Prosegate: rule core.hedge.001 is already off for profile local/base.\n");

    expect(cmd(ctx, "rule", "on", "core.hedge.001").out).toBe("Prosegate: rule core.hedge.001 is on again for profile local/base.\n");
    expect(profileFiles(home)).toEqual([]);
    expect(cmd(ctx, "rule", "list").out).toBe("Prosegate: no rules are switched off locally.\n");
    expect(hedgeIn(ctx)).toBe(true);
  });

  it("rule off emits override_used (ADR-27); rule on does not", () => {
    const { ctx } = started();
    const before = readSpool(ctx).length;
    cmd(ctx, "rule", "off", "core.hedge.001");
    const added = readSpool(ctx).slice(before);
    expect(added).toHaveLength(1);
    expect(added[0]).toContain('"override_used":true');
    cmd(ctx, "rule", "on", "core.hedge.001");
    expect(readSpool(ctx)).toHaveLength(before + 1);
  });

  it("records only its own file's hash, so the next turn does not report its own write as an outside change", () => {
    const { home, ctx } = started();
    cmd(ctx, "rule", "off", "core.hedge.001");
    expect(Object.keys(stateOf(home).local_hashes)).toEqual(["profiles/local--base.overlay.yaml"]);
    cmd(ctx, "rule", "on", "core.hedge.001");
    expect(stateOf(home).local_hashes).toEqual({});
  });

  it("several rules share the one overlay; turning one on keeps the others", () => {
    const { home, ctx } = started();
    cmd(ctx, "rule", "off", "core.hedge.001");
    cmd(ctx, "rule", "off", "core.filler.001");
    const path = join(home, "profiles", "local--base.overlay.yaml");
    expect(readFileSync(path, "utf8").match(/enabled: false/g)).toHaveLength(2);
    cmd(ctx, "rule", "on", "core.hedge.001");
    expect(readFileSync(path, "utf8")).not.toContain("core.hedge.001");
    expect(cmd(ctx, "rule", "list").out).toBe(`core.filler.001  ${path} (local/base)\n`);
  });

  it("an overlay of a profile that extends another keeps the extends", () => {
    const { home, ctx } = started();
    cmd(ctx, "profile", "local/chat-reply");
    expect(cmd(ctx, "rule", "off", "core.hedge.001").code).toBe(0);
    const file = readFileSync(join(home, "profiles", "local--chat-reply.overlay.yaml"), "utf8");
    expect(file).toContain("extends: local/base");
    expect(file).toContain('name: "Chat reply"');
  });

  it("rejects ids that are not rules of the active profile, and bad usage", () => {
    const { ctx } = started();
    expect(cmd(ctx, "rule", "off", "core.hedge.999").err).toBe("Prosegate: profile local/base has no rule core.hedge.999.\n");
    expect(cmd(ctx, "rule", "off", "nonsense").err).toBe('Prosegate: "nonsense" is not a rule id. Ids look like core.hedge.001 and appear in each finding.\n');
    expect(cmd(ctx, "rule", "on", "core.hedge.001")).toEqual({ code: 0, out: "Prosegate: rule core.hedge.001 is not switched off locally.\n", err: "" });
    expect(cmd(ctx, "rule").err).toBe("usage: prosegate rule off <id> | on <id> | list\n");
  });

  it("will not rewrite a file it did not write, and says where it is and what to add", () => {
    const { home, ctx } = started();
    const theirs = 'schema: prosegate.profile/1\nid: local/base\nversion: 1\nname: Base\n# my notes\noverrides:\n  allow_terms: ["robust"]\n';
    const path = put(home, "profiles/base.yaml", theirs);
    const r = cmd(ctx, "rule", "off", "core.hedge.001");
    expect(r.code).toBe(1);
    expect(r.err).toBe(
      `Prosegate: cannot switch off core.hedge.001. ${path} has been edited by hand, so prosegate rule leaves it alone. Add this under overrides.rules in that file: core.hedge.001: { enabled: false }\n`,
    );
    expect(readFileSync(path, "utf8")).toBe(theirs);
  });

  it("rule list shows rules switched off in files the user wrote too, and rule on says to edit that file", () => {
    const { home, ctx } = started();
    const path = put(home, "profiles/base.yaml", 'schema: prosegate.profile/1\nid: local/base\nversion: 1\nname: Base\noverrides:\n  rules:\n    core.vocab.003: { enabled: false }\n');
    expect(cmd(ctx, "rule", "list").out).toBe(`core.vocab.003  ${path} (local/base)\n`);
    expect(cmd(ctx, "rule", "on", "core.vocab.003")).toEqual({
      code: 1,
      out: "",
      err: `Prosegate: ${path} was edited by hand and switches core.vocab.003 off. Remove that line from the file to switch the rule on.\n`,
    });
  });
});

// ---- the agent-context refusal (ADR-27, ADR-28, ADR-30) -----------------------------------------------

describe("the agent-context refusal", () => {
  const agent = (ctx: Ctx, marker = "CLAUDECODE", value = "1", tty = false): Ctx => ({ ...ctx, env: { ...ctx.env, [marker]: value }, stdinIsTTY: tty });
  const refusal = (name: string) =>
    `Prosegate: ${name} was refused because it looks like the agent ran it. In Claude Code, a command typed after ! counts as the agent; run it in a separate terminal.\n`;

  const LOWERING: Array<[string, string[]]> = [
    ["advisory", ["advisory"]],
    ["off", ["off"]],
    ["quiet", ["quiet"]],
    ["rule off", ["rule", "off", "core.hedge.001"]],
  ];

  it.each(LOWERING)("%s refuses with the ADR-28 text, exit 1, and changes nothing", (name, argv) => {
    const { home, ctx } = started();
    const before = stateOf(home).mode;
    expect(cmd(agent(ctx), ...argv)).toEqual({ code: 1, out: "", err: refusal(name) });
    expect(stateOf(home).mode).toBe(before);
    expect(profileFiles(home)).toEqual([]);
  });

  it.each(AGENT_MARKERS)("the marker %s alone is enough", (marker) => {
    const { ctx } = started();
    expect(cmd(agent(ctx, marker), "off").err).toBe(refusal("off"));
  });

  it("an empty marker counts as set (CLAUDECODE= is the one-token bypass)", () => {
    const { ctx } = started();
    expect(cmd(agent(ctx, "CLAUDECODE", ""), "off").err).toBe(refusal("off"));
    expect(cmd(agent(ctx, "CLAUDE_CODE_CHILD_SESSION", ""), "rule", "off", "core.hedge.001").err).toBe(refusal("rule off"));
  });

  it("env -u CLAUDECODE does not help while another marker is set", () => {
    const { ctx } = started();
    const withOne: Ctx = { ...ctx, env: { ...ctx.env, CLAUDE_CODE_CHILD_SESSION: "1" }, stdinIsTTY: false };
    expect(cmd(withOne, "advisory").err).toBe(refusal("advisory"));
  });

  it("marker names are matched without regard to case (Windows environments are case-insensitive)", () => {
    const { ctx } = started();
    expect(cmd(agent(ctx, "claudecode"), "off").err).toBe(refusal("off"));
  });

  it("commands that raise enforcement or only read still work from an agent", () => {
    const { home, ctx } = started();
    cmd(ctx, "advisory");
    expect(cmd(agent(ctx), "enforce").code).toBe(0);
    expect(stateOf(home).mode).toBe("enforce");
    expect(cmd(agent(ctx), "rule", "on", "core.hedge.001").code).toBe(0);
    expect(cmd(agent(ctx), "status").code).toBe(0);
    expect(cmd(agent(ctx), "profile").code).toBe(0);
  });

  it("a terminal (TTY stdin) or no agent marker is allowed", () => {
    const { ctx } = started();
    expect(cmd(agent(ctx, "CLAUDECODE", "1", true), "quiet").code).toBe(0);
    expect(cmd({ ...ctx, stdinIsTTY: false }, "quiet").code).toBe(0);
  });
});

// ---- org policy `required` (09, ADR-18, ADR-28) ------------------------------------------------------------

const POLICY: OrgPolicyInput = { org_id: "acme-1", org_name: "Acme", namespace: "acme", enforcement_default: "required" };
const SYNCED: ResolutionSources = {
  profiles: {
    "acme/base": {
      yaml: 'schema: prosegate.profile/1\nid: acme/base\nversion: 3\nname: Acme base\nrule_packs:\n  - { id: core, version: ">=0.1.0 <1.0.0" }\nenforcement: { mode: enforce }\n',
      signed: true,
      origin: "synced",
    },
  },
  packs: {},
};
const REFUSAL = "Prosegate: enforcement is required by Acme, so this cannot be changed here. Ask an admin to change the policy.\n";

describe("org policy required", () => {
  function required(): { home: string; ctx: Ctx } {
    const home = tmpDir();
    const ctx = testCtx(home, { cwd: CWD, policy: POLICY, synced: SYNCED, env: { PROSEGATE_SESSION: SESSION } });
    sessionStart({ harness: "claude-code", session_id: SESSION, cwd: CWD, mode: "interactive" }, ctx);
    return { home, ctx };
  }

  it("starts on the org's own base profile, because local/base is refused", () => {
    const { home } = required();
    expect(stateOf(home).active_profile).toBe("acme/base");
  });

  it.each([
    ["advisory", ["advisory"]],
    ["off", ["off"]],
    ["rule off", ["rule", "off", "core.hedge.001"]],
  ])("%s refuses with the ADR-28 text", (_name, argv) => {
    const { home, ctx } = required();
    expect(cmd(ctx, ...argv)).toEqual({ code: 1, out: "", err: REFUSAL });
    expect(stateOf(home).mode).toBeNull();
  });

  it("quiet and enforce stay allowed (they do not lower enforcement)", () => {
    const { ctx } = required();
    expect(cmd(ctx, "quiet").code).toBe(0);
    expect(cmd(ctx, "enforce").code).toBe(0);
  });

  it("profile <id> accepts only the org's own profiles, and refuses a starter with the required text (not `unknown profile`)", () => {
    const { ctx } = required();
    expect(cmd(ctx, "profile", "local/base")).toEqual({ code: 1, out: "", err: REFUSAL });
    expect(cmd(ctx, "profile", "local/email")).toEqual({ code: 1, out: "", err: REFUSAL });
    expect(cmd(ctx, "profile", "email")).toEqual({ code: 1, out: "", err: REFUSAL });
    expect(cmd(ctx, "profile", "no-such-thing").err).toBe('Prosegate: no profile "no-such-thing". Available: acme/base.\n');
    expect(cmd(ctx, "profile", "acme/base").code).toBe(0);
    expect(cmd(ctx, "profile").out).toBe("Prosegate: profiles (active: acme/base):\n  acme/base\n");
  });

  it("turn-end enforces even if state.json was edited to off or advisory", () => {
    const { home, ctx } = required();
    const file = join(home, "sessions", SESSION, "state.json");
    const s = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    writeFileSync(file, JSON.stringify({ ...s, mode: "off" }));
    const out = turnEnd({ session_id: SESSION, turn_id: "t", assistant_text: TIC_TEXT, user_message: "", tool_calls: [], continuation: false }, { ...ctx, env: { PROSEGATE_MODE: "off" } }).output;
    expect(out.decision).toBe("continue");
  });

  it("local profile files are ignored, and the session says so once, in the notice and not in the inject", () => {
    const home = tmpDir();
    put(home, "profiles/mine.yaml", "schema: prosegate.profile/1\nid: local/mine\nversion: 1\nname: Mine\n");
    const ctx = testCtx(home, { cwd: CWD, policy: POLICY, synced: SYNCED });
    const out = sessionStart({ harness: "claude-code", session_id: SESSION, cwd: CWD, mode: "interactive", source: "resume" }, ctx).output;
    expect(out.notice).toBe("Prosegate · your local profiles and rule changes are not used in this session · Acme requires enforcement");
    expect(out.inject).not.toContain("not used in this session");
    const again = sessionStart({ harness: "claude-code", session_id: SESSION, cwd: CWD, mode: "interactive", source: "resume" }, ctx).output;
    expect(again.notice).toBeNull();
    const t = turnEnd({ session_id: SESSION, turn_id: "t", assistant_text: CLEAN_TEXT, user_message: "", tool_calls: [], continuation: false }, ctx).output;
    expect(t.notice).toBeNull();
  });

  it("a local file changing mid-session lowers nothing under required, and no lowering is claimed", () => {
    const { home, ctx } = required();
    put(home, "profiles/base.yaml", 'schema: prosegate.profile/1\nid: acme/base\nversion: 1\nname: x\noverrides:\n  categories:\n    filler: { severity: info }\n    hedge: { severity: info }\n');
    const out = turnEnd({ session_id: SESSION, turn_id: "t", assistant_text: TIC_TEXT, user_message: "", tool_calls: [], continuation: false }, ctx).output;
    expect(out.decision).toBe("continue");
    expect(out.notice ?? "").not.toContain("lowered");
  });
});
