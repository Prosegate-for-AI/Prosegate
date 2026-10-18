import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { OrgPolicyInput, ResolutionSources } from "@prosegate/profiles";
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

function stateOf(home: string): { mode: string | null; active_profile: string; previous_profile: string | null } {
  return JSON.parse(readFileSync(join(home, "sessions", SESSION, "state.json"), "utf8")) as ReturnType<typeof stateOf>;
}

function profileFiles(home: string): string[] {
  const dir = join(home, "profiles");
  return existsSync(dir) ? readdirSync(dir).sort() : [];
}

describe("mode commands", () => {
  it.each([
    ["advisory", "Prosegate: advisory for this session. Findings will be shown, not enforced. Run prosegate enforce to restore."],
    ["quiet", "Prosegate: quiet for this session. Findings are still enforced; notices are hidden. Run prosegate enforce to restore."],
    ["off", "Prosegate: off for this session. Nothing will be reviewed. Run prosegate enforce to restore."],
    ["enforce", "Prosegate: enforcement restored for this session."],
  ])("%s sets the mode and prints its line", (name, line) => {
    const { home, ctx } = started();
    const r = cmd(ctx, name);
    expect(r).toEqual({ code: 0, out: `${line}\n`, err: "" });
    expect(stateOf(home).mode).toBe(name);
  });

  it("a lowering command emits override_used; enforce does not", () => {
    const { ctx } = started();
    const before = readSpool(ctx).length;
    cmd(ctx, "enforce");
    expect(readSpool(ctx)).toHaveLength(before);
    cmd(ctx, "advisory");
    const added = readSpool(ctx).slice(before);
    expect(added).toHaveLength(1);
    expect(added[0]).toContain('"override_used":true');
  });

  it("with no session for the directory, says so and exits 1", () => {
    const home = tmpDir();
    const r = cmd(testCtx(home, { cwd: "/somewhere/else" }), "advisory");
    expect(r.code).toBe(1);
    expect(r.err).toBe("Prosegate: no session found for this directory. Start your agent here first, or set PROSEGATE_SESSION.\n");
  });

  it("without PROSEGATE_SESSION it picks the most recently active session whose cwd matches", () => {
    const home = tmpDir();
    const ctx = testCtx(home, { cwd: CWD });
    sessionStart({ harness: "claude-code", session_id: "old-one", cwd: CWD, mode: "interactive" }, ctx);
    sessionStart({ harness: "claude-code", session_id: "other-dir", cwd: "/elsewhere", mode: "interactive" }, ctx);
    sessionStart({ harness: "claude-code", session_id: "new-one", cwd: CWD, mode: "interactive" }, ctx);
    expect(cmd(ctx, "quiet").code).toBe(0);
    const read = (id: string) => JSON.parse(readFileSync(join(home, "sessions", id, "state.json"), "utf8")) as { mode: string | null };
    expect(read("new-one").mode).toBe("quiet");
    expect(read("old-one").mode).toBeNull();
    expect(read("other-dir").mode).toBeNull();
  });

  it("rejects extra arguments and unknown commands", () => {
    const { ctx } = started();
    expect(cmd(ctx, "advisory", "now").err).toBe("usage: prosegate advisory\n");
    expect(cmd(ctx, "frobnicate").err).toBe('prosegate: unknown command "frobnicate". Run prosegate --help.\n');
  });
});

describe("profile <id>", () => {
  it("sets the active profile, keeps the previous one, clears the candidate and remembers it for the directory", () => {
    const { home, ctx } = started();
    const r = cmd(ctx, "profile", "local/pr-description");
    expect(r).toEqual({ code: 0, out: "Prosegate: profile set to local/pr-description; it applies from the next turn.\n", err: "" });
    const s = stateOf(home);
    expect(s).toMatchObject({ active_profile: "local/pr-description", previous_profile: "local/base" });
    const map = JSON.parse(readFileSync(join(home, "cwd-profiles.json"), "utf8")) as Record<string, { profile: string }>;
    expect(Object.values(map).map((v) => v.profile)).toEqual(["local/pr-description"]);
  });

  it("the next session in the same directory starts on that profile", () => {
    const { home, ctx } = started();
    cmd(ctx, "profile", "local/email");
    const out = sessionStart({ harness: "claude-code", session_id: "next", cwd: CWD, mode: "interactive" }, testCtx(home, { cwd: CWD })).output;
    expect(out.active_profile).toBe("local/email");
    expect(out.inject).toContain("Active profile: Email (local/email).");
  });

  it("on an unknown id prints the valid ids and exits 1", () => {
    const { ctx } = started();
    const r = cmd(ctx, "profile", "local/nope");
    expect(r.code).toBe(1);
    expect(r.err).toBe('Prosegate: unknown profile "local/nope". Valid profiles: local/base, local/chat-reply, local/design-doc, local/email, local/pr-description.\n');
  });

  it("lists local profiles among the valid ids", () => {
    const { home, ctx } = started();
    mkdirSync(join(home, "profiles"), { recursive: true });
    writeFileSync(
      join(home, "profiles", "mine.yaml"),
      'schema: prosegate.profile/1\nid: local/mine\nversion: 1\nname: Mine\nextends: local/base\n',
    );
    expect(cmd(ctx, "profile", "local/nope").err).toContain("local/mine");
    expect(cmd(ctx, "profile", "local/mine").code).toBe(0);
  });

  it("needs exactly one argument", () => {
    const { ctx } = started();
    expect(cmd(ctx, "profile").err).toBe("usage: prosegate profile <id>\n");
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
  it("prints mode, profile and version, the locally disabled rules, in at most four lines", () => {
    const { ctx } = started();
    cmd(ctx, "rule", "off", "core.hedge.001");
    cmd(ctx, "advisory");
    const r = cmd(ctx, "status");
    const lines = r.out.trimEnd().split("\n");
    expect(r.code).toBe(0);
    expect(lines.length).toBeLessThanOrEqual(4);
    expect(lines[0]).toBe("Prosegate: advisory");
    expect(lines[1]).toMatch(/^Profile: local\/base \(v1\+[0-9a-f]{8}\)$/);
    expect(lines[2]).toBe("Rules off locally: core.hedge.001");
    expect(lines[3]).toBe(`Session: ${SESSION}`);
  });
});

describe("reload", () => {
  it("re-resolves, rewrites the cache and reports the version", () => {
    const { home, ctx } = started();
    cmd(ctx, "rule", "off", "core.hedge.001");
    const r = cmd(ctx, "reload");
    expect(r.code).toBe(0);
    expect(r.out).toBe("Prosegate: reloaded profile local/base (v1).\n");
    const cache = JSON.parse(readFileSync(join(home, "sessions", SESSION, "profile.json"), "utf8")) as { rules: Record<string, unknown> };
    expect(Object.keys(cache.rules)).toContain("core.hedge.001");
  });

  it("names a broken local file", () => {
    const { home, ctx } = started();
    mkdirSync(join(home, "profiles"), { recursive: true });
    writeFileSync(join(home, "profiles", "broken.yaml"), "schema: nope\n");
    const r = cmd(ctx, "reload");
    expect(r.code).toBe(0);
    expect(r.out).toContain("profiles/broken.yaml");
  });
});

describe("rule off / on / list", () => {
  it("rule off writes a managed overlay, takes effect at the next turn-end, and rule on removes it", () => {
    const { home, ctx } = started();
    const text = TIC_TEXT;
    const hedgeIn = (c: Ctx): boolean =>
      turnEnd({ session_id: SESSION, turn_id: `t-${Math.random()}`, assistant_text: text, user_message: "", tool_calls: [], continuation: false }, c).output.result.findings.some((f) => f.rule_id === "core.hedge.001");
    expect(hedgeIn(ctx)).toBe(true);

    const off = cmd(ctx, "rule", "off", "core.hedge.001");
    expect(off).toEqual({
      code: 0,
      out: "Prosegate: rule core.hedge.001 is off for profile local/base. Run prosegate rule on core.hedge.001 to restore.\n",
      err: "",
    });
    expect(profileFiles(home)).toEqual(["local--base.overlay.yaml"]);
    const file = readFileSync(join(home, "profiles", "local--base.overlay.yaml"), "utf8");
    expect(file).toContain("core.hedge.001: { enabled: false }");
    expect(file).toMatch(/^# Managed by/);
    expect(hedgeIn(ctx)).toBe(false);

    expect(cmd(ctx, "rule", "list").out).toBe("core.hedge.001  profiles/local--base.overlay.yaml (local/base)\n");
    expect(cmd(ctx, "rule", "off", "core.hedge.001").out).toBe("Prosegate: rule core.hedge.001 is already off for profile local/base.\n");

    expect(cmd(ctx, "rule", "on", "core.hedge.001").out).toBe("Prosegate: rule core.hedge.001 is on again for profile local/base.\n");
    expect(profileFiles(home)).toEqual([]);
    expect(cmd(ctx, "rule", "list").out).toBe("Prosegate: no rules are switched off locally.\n");
    expect(hedgeIn(ctx)).toBe(true);
  });

  it("several rules share the one overlay; turning one on keeps the others", () => {
    const { home, ctx } = started();
    cmd(ctx, "rule", "off", "core.hedge.001");
    cmd(ctx, "rule", "off", "core.filler.001");
    const file = readFileSync(join(home, "profiles", "local--base.overlay.yaml"), "utf8");
    expect(file.match(/enabled: false/g)).toHaveLength(2);
    cmd(ctx, "rule", "on", "core.hedge.001");
    expect(readFileSync(join(home, "profiles", "local--base.overlay.yaml"), "utf8")).not.toContain("core.hedge.001");
    expect(cmd(ctx, "rule", "list").out).toBe("core.filler.001  profiles/local--base.overlay.yaml (local/base)\n");
  });

  it("an overlay of a profile that extends another keeps the extends", () => {
    const { home, ctx } = started();
    cmd(ctx, "profile", "local/chat-reply");
    expect(cmd(ctx, "rule", "off", "core.hedge.001").code).toBe(0);
    const file = readFileSync(join(home, "profiles", "local--chat-reply.overlay.yaml"), "utf8");
    expect(file).toContain("extends: local/base");
    expect(file).toContain('name: "Chat reply"');
  });

  it("rejects ids that are not rules of the active profile", () => {
    const { ctx } = started();
    expect(cmd(ctx, "rule", "off", "core.hedge.999").err).toBe("Prosegate: profile local/base has no rule core.hedge.999.\n");
    expect(cmd(ctx, "rule", "off", "nonsense").err).toBe('Prosegate: "nonsense" is not a rule id such as core.hedge.001.\n');
    expect(cmd(ctx, "rule", "on", "core.hedge.001").out).toBe("Prosegate: rule core.hedge.001 is not switched off locally.\n");
    expect(cmd(ctx, "rule").err).toContain("usage: prosegate rule off <id>");
  });

  it("will not rewrite a file it did not write", () => {
    const { home, ctx } = started();
    mkdirSync(join(home, "profiles"), { recursive: true });
    const theirs = 'schema: prosegate.profile/1\nid: local/base\nversion: 1\nname: Base\n# my notes\noverrides:\n  allow_terms: ["robust"]\n';
    writeFileSync(join(home, "profiles", "base.yaml"), theirs);
    const r = cmd(ctx, "rule", "off", "core.hedge.001");
    expect(r.code).toBe(1);
    expect(r.err).toContain("customised in a file this command does not manage");
    expect(readFileSync(join(home, "profiles", "base.yaml"), "utf8")).toBe(theirs);
  });

  it("rule list shows rules switched off in files the user wrote too", () => {
    const { home, ctx } = started();
    mkdirSync(join(home, "profiles"), { recursive: true });
    writeFileSync(join(home, "profiles", "base.yaml"), 'schema: prosegate.profile/1\nid: local/base\nversion: 1\nname: Base\noverrides:\n  rules:\n    core.vocab.003: { enabled: false }\n');
    expect(cmd(ctx, "rule", "list").out).toBe("core.vocab.003  profiles/base.yaml (local/base)\n");
    expect(cmd(ctx, "rule", "on", "core.vocab.003").err).toContain("profiles/base.yaml switches core.vocab.003 off and is not managed by this command");
  });
});

// ---- the agent-context refusal (ADR-27) -----------------------------------------------------------------

describe("the agent-context refusal", () => {
  const agent = (ctx: Ctx, tty = false): Ctx => ({ ...ctx, env: { ...ctx.env, CLAUDECODE: "1" }, stdinIsTTY: tty });

  it.each([
    ["advisory", ["advisory"]],
    ["off", ["off"]],
    ["quiet", ["quiet"]],
    ["rule off", ["rule", "off", "core.hedge.001"]],
  ])("%s refuses with the ADR-27 text, exit 1, and changes nothing", (name, argv) => {
    const { home, ctx } = started();
    const before = stateOf(home).mode;
    const r = cmd(agent(ctx), ...argv);
    expect(r).toEqual({ code: 1, out: "", err: `prosegate ${name} must be run by you in a terminal, not by the agent.\n` });
    expect(stateOf(home).mode).toBe(before);
    expect(profileFiles(home)).toEqual([]);
  });

  it("commands that raise enforcement still work from an agent", () => {
    const { home, ctx } = started();
    cmd(ctx, "advisory");
    expect(cmd(agent(ctx), "enforce").code).toBe(0);
    expect(stateOf(home).mode).toBe("enforce");
    expect(cmd(agent(ctx), "rule", "on", "core.hedge.001").code).toBe(0);
    expect(cmd(agent(ctx), "status").code).toBe(0);
  });

  it("a terminal (TTY stdin) or no agent marker is allowed", () => {
    const { ctx } = started();
    expect(cmd(agent(ctx, true), "quiet").code).toBe(0);
    expect(cmd({ ...ctx, stdinIsTTY: false }, "quiet").code).toBe(0);
  });
});

// ---- org policy `required` (09, ADR-18) ------------------------------------------------------------------

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
const REFUSAL = "Enforcement is required by Acme; ask an admin, or uninstall.\n";

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
  ])("%s refuses with the 09 text", (_name, argv) => {
    const { home, ctx } = required();
    const r = cmd(ctx, ...argv);
    expect(r).toEqual({ code: 1, out: "", err: REFUSAL });
    expect(stateOf(home).mode).toBeNull();
  });

  it("quiet and enforce stay allowed (they do not lower enforcement)", () => {
    const { ctx } = required();
    expect(cmd(ctx, "quiet").code).toBe(0);
    expect(cmd(ctx, "enforce").code).toBe(0);
  });

  it("profile <id> accepts only the org's own profiles", () => {
    const { ctx } = required();
    const r = cmd(ctx, "profile", "local/email");
    expect(r.code).toBe(1);
    expect(r.err).toBe('Prosegate: unknown profile "local/email". Valid profiles: acme/base.\n');
    expect(cmd(ctx, "profile", "acme/base").code).toBe(0);
  });

  it("turn-end enforces even if state.json was edited to off or advisory", () => {
    const { home, ctx } = required();
    const file = join(home, "sessions", SESSION, "state.json");
    const s = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    writeFileSync(file, JSON.stringify({ ...s, mode: "off" }));
    const out = turnEnd({ session_id: SESSION, turn_id: "t", assistant_text: TIC_TEXT, user_message: "", tool_calls: [], continuation: false }, { ...ctx, env: { PROSEGATE_MODE: "off" } }).output;
    expect(out.decision).toBe("continue");
  });

  it("local profile files are ignored, and the session says so once", () => {
    const home = tmpDir();
    mkdirSync(join(home, "profiles"), { recursive: true });
    writeFileSync(join(home, "profiles", "mine.yaml"), 'schema: prosegate.profile/1\nid: local/mine\nversion: 1\nname: Mine\n');
    const ctx = testCtx(home, { cwd: CWD, policy: POLICY, synced: SYNCED });
    const out = sessionStart({ harness: "claude-code", session_id: SESSION, cwd: CWD, mode: "interactive" }, ctx).output;
    expect(out.inject).toContain("Prosegate · local profiles and rule overlays are ignored in this session · enforcement is required by Acme");
    const again = sessionStart({ harness: "claude-code", session_id: SESSION, cwd: CWD, mode: "interactive" }, ctx).output;
    expect(again.inject).not.toContain("ignored in this session");
    // And turn-end does not repeat it either.
    const t = turnEnd({ session_id: SESSION, turn_id: "t", assistant_text: CLEAN_TEXT, user_message: "", tool_calls: [], continuation: false }, ctx).output;
    expect(t.notice).toBeNull();
  });
});
