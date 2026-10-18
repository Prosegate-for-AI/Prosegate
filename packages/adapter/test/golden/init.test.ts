import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { pg, tmpDir } from "../helpers.js";
import { layoutPkg, releasePkg, SHIM_SOURCE, type Pkg } from "./driver.js";

// `prosegate init --harness claude-code` and `prosegate uninit`: they merge into an existing settings file
// without touching anything else, back it up first, are idempotent, and refuse a file they cannot read. Every
// test sets PROSEGATE_CLAUDE_HOME (or runs in a temp project), so the real ~/.claude is never reached.

let pkg: Pkg;
beforeAll(async () => {
  pkg = await releasePkg();
}, 120_000);

const fwd = (p: string): string => p.replace(/\\/g, "/");
const cmd = (p: Pkg, event: string, extra = ""): string => `node "${fwd(p.shim)}" ${event}${extra}`;

interface Env {
  claude: string;
  home: string;
  settings: string;
}
function env(): Env {
  const claude = join(tmpDir("pg-claude-"), ".claude");
  return { claude, home: join(tmpDir("pg-home-"), ".prosegate"), settings: join(claude, "settings.json") };
}
function init(e: Env, args: string[] = ["--local"], over: { cwd?: string; env?: Record<string, string> } = {}, p: Pkg = pkg) {
  return pg(p.bundle, ["init", "--harness", "claude-code", ...args], { home: e.home, cwd: over.cwd ?? tmpDir(), env: { PROSEGATE_CLAUDE_HOME: e.claude, ...over.env } });
}
function uninit(e: Env, args: string[] = [], over: { cwd?: string } = {}) {
  return pg(pkg.bundle, ["uninit", ...args], { home: e.home, cwd: over.cwd ?? tmpDir(), env: { PROSEGATE_CLAUDE_HOME: e.claude } });
}
const read = (p: string): Record<string, unknown> => JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>;
const backups = (dir: string): string[] => readdirSync(dir).filter((f) => f.includes(".prosegate-backup-"));

function ours(p: Pkg, over: { stopTimeout?: number } = {}): Record<string, unknown> {
  const group = (event: string, timeout: number) => [{ hooks: [{ type: "command", command: cmd(p, event), timeout }] }];
  return { SessionStart: group("SessionStart", 10), UserPromptSubmit: group("UserPromptSubmit", 10), Stop: group("Stop", over.stopTimeout ?? 10) };
}

// A settings file with things init must not touch: other keys, other hooks in the same events, a matcher group.
const EXISTING = {
  $schema: "https://json.schemastore.org/claude-code-settings.json",
  model: "opus",
  permissions: { allow: ["Bash(git status)"], deny: ["Read(./.env)"] },
  env: { FOO: "bar" },
  hooks: {
    PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo pre" }] }],
    Stop: [{ hooks: [{ type: "command", command: "node ~/my-stop-hook.js", timeout: 5 }] }],
    SessionStart: [{ matcher: "startup", hooks: [{ type: "command", command: "echo hello" }] }],
  },
  statusLine: { type: "command", command: "echo status" },
};

describe("init", () => {
  it("installs the three hooks in the user settings and checks the round trip", () => {
    const e = env();
    const r = init(e, ["--local"]);
    expect(r.code).toBe(0);
    expect(r.stderr).toBe("");
    expect(read(e.settings)).toEqual({ hooks: ours(pkg) });
    expect(existsSync(join(e.home, "sessions", "prosegate-init-check"))).toBe(false);
  });

  it("registers `node \"<abs path to shim>\" <event>` in the quoted shell form, with a 10 s timeout on Stop", () => {
    const e = env();
    init(e);
    const hooks = read(e.settings)["hooks"] as Record<string, Array<{ hooks: Array<{ type: string; command: string; timeout: number }> }>>;
    expect(hooks["Stop"]?.[0]?.hooks[0]).toEqual({ type: "command", command: cmd(pkg, "Stop"), timeout: 10 });
    expect(hooks["SessionStart"]?.[0]?.hooks[0]?.command).toBe(cmd(pkg, "SessionStart"));
    expect(hooks["UserPromptSubmit"]?.[0]?.hooks[0]?.command).toBe(cmd(pkg, "UserPromptSubmit"));
  });

  it("prints at most six plain lines: what was installed and where, workspace trust, the override, how to uninstall", () => {
    const e = env();
    const r = init(e, []);
    const lines = r.stdout.trimEnd().split("\n");
    expect(lines.length).toBeLessThanOrEqual(6);
    expect(lines).toEqual([
      `Prosegate hooks installed for Claude Code in ${e.settings}, and a test session ran cleanly.`,
      "Sign-in is not available in this build yet; installed in local mode.",
      "Claude Code starts the hooks only after you accept its workspace-trust prompt for a folder, so open a new session there.",
      "To pause revisions in a session, run prosegate advisory in a separate terminal. To remove the hooks, run prosegate uninit.",
    ]);
    // No emoji, no colour codes.
    expect(r.stdout).toMatch(/^[\x20-\x7e\n]*$/);
  });

  it("--local leaves out the sign-in line", () => {
    expect(init(env(), ["--local"]).stdout).not.toContain("Sign-in");
  });

  it("merges into an existing file: every other key and hook is left alone, ours are added after the user's", () => {
    const e = env();
    mkdirSync(e.claude, { recursive: true });
    writeFileSync(e.settings, `${JSON.stringify(EXISTING, null, 2)}\n`);
    const r = init(e);
    expect(r.code).toBe(0);
    const after = read(e.settings);
    const { hooks: before, ...rest } = EXISTING;
    const { hooks: afterHooks, ...afterRest } = after as { hooks: Record<string, unknown[]> } & Record<string, unknown>;
    expect(afterRest).toEqual(rest);
    expect(Object.keys(after)).toEqual(Object.keys(EXISTING));
    expect(afterHooks["PreToolUse"]).toEqual(before.PreToolUse);
    expect(afterHooks["Stop"]).toEqual([...before.Stop, ...(ours(pkg)["Stop"] as unknown[])]);
    expect(afterHooks["SessionStart"]).toEqual([...before.SessionStart, ...(ours(pkg)["SessionStart"] as unknown[])]);
    expect(afterHooks["UserPromptSubmit"]).toEqual(ours(pkg)["UserPromptSubmit"]);
  });

  it("writes a timestamped backup of the old file first, and says so", () => {
    const e = env();
    mkdirSync(e.claude, { recursive: true });
    const original = `${JSON.stringify(EXISTING, null, 2)}\n`;
    writeFileSync(e.settings, original);
    const r = init(e);
    const [backup] = backups(e.claude);
    expect(backups(e.claude)).toHaveLength(1);
    expect(backup).toMatch(/^settings\.json\.prosegate-backup-\d{8}T\d{6}Z$/);
    expect(readFileSync(join(e.claude, backup as string), "utf8")).toBe(original);
    expect(r.stdout).toContain(`Your previous settings were saved as ${backup as string}.`);
    expect(r.stdout.trimEnd().split("\n").length).toBeLessThanOrEqual(6);
  });

  it("run through npx, it says the hooks point into npx's cache and how to get a permanent install, within the six lines", () => {
    const e = env();
    const npx = layoutPkg(pkg.bundle, join("_npx", "9f0e02e6eb294270", "node_modules", "prosegate"));
    mkdirSync(e.claude, { recursive: true });
    writeFileSync(e.settings, JSON.stringify({ model: "opus" }));
    const r = init(e, [], {}, npx);
    const lines = r.stdout.trimEnd().split("\n");
    expect(lines).toHaveLength(6);
    expect(lines.at(-1)).toBe("You ran this through npx. For a permanent install, and for the commands above, run npm install -g prosegate and then this again.");
    expect(init(env(), ["--local"]).stdout).not.toContain("npx");
  });

  it("keeps the file's indentation and line endings", () => {
    const e = env();
    mkdirSync(e.claude, { recursive: true });
    writeFileSync(e.settings, '{\r\n\t"model": "opus"\r\n}\r\n');
    init(e);
    const text = readFileSync(e.settings, "utf8");
    expect(text).toContain('\r\n\t"model": "opus"');
    expect(text.replace(/\r\n/g, "")).not.toContain("\n");
  });

  it("is idempotent: a second run changes nothing, writes no backup, and says so", () => {
    const e = env();
    mkdirSync(e.claude, { recursive: true });
    writeFileSync(e.settings, JSON.stringify(EXISTING, null, 2));
    init(e);
    const once = readFileSync(e.settings, "utf8");
    const backupsAfterFirst = backups(e.claude);
    const again = init(e);
    expect(again.code).toBe(0);
    expect(readFileSync(e.settings, "utf8")).toBe(once);
    expect(backups(e.claude)).toEqual(backupsAfterFirst);
    expect(again.stdout.split("\n")[0]).toBe(`Prosegate hooks were already installed in ${e.settings}; nothing changed, and a test session ran cleanly.`);
  });

  it("moves its own entries when the package moved (an upgrade), leaving the user's hooks in place", () => {
    const e = env();
    const old = layoutPkg(null, "old-prosegate");
    mkdirSync(e.claude, { recursive: true });
    const stale = (event: string): unknown => ({ hooks: [{ type: "command", command: `node "${fwd(old.shim)}" ${event}`, timeout: 10 }] });
    writeFileSync(
      e.settings,
      JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "echo mine" }] }, stale("Stop")], SessionStart: [stale("SessionStart")], UserPromptSubmit: [stale("UserPromptSubmit")] } }, null, 2),
    );
    expect(init(e).code).toBe(0);
    const stop = (read(e.settings)["hooks"] as { Stop: unknown[] }).Stop;
    expect(stop).toEqual([{ hooks: [{ type: "command", command: "echo mine" }] }, ...(ours(pkg)["Stop"] as unknown[])]);
    expect(JSON.stringify(read(e.settings))).not.toContain("old-prosegate");
  });

  it("--scope project writes .claude/settings.json in the working directory and leaves the user settings alone", () => {
    const e = env();
    const project = tmpDir("pg-project-");
    const r = init(e, ["--scope", "project", "--local"], { cwd: project });
    expect(r.code).toBe(0);
    expect(read(join(project, ".claude", "settings.json"))).toEqual({ hooks: ours(pkg) });
    expect(existsSync(e.settings)).toBe(false);
    expect(r.stdout.split("\n")[0]).toBe("Prosegate hooks installed for Claude Code in .claude/settings.json (this project only), and a test session ran cleanly.");
  });

  it("--headless registers the flag the shim reads", () => {
    const e = env();
    init(e, ["--local", "--headless"]);
    const hooks = read(e.settings)["hooks"] as { Stop: Array<{ hooks: Array<{ command: string }> }> };
    expect(hooks.Stop[0]?.hooks[0]?.command).toBe(cmd(pkg, "Stop", " --headless"));
  });

  it("the user scope honours CLAUDE_CONFIG_DIR, and PROSEGATE_CLAUDE_HOME wins over it", () => {
    const e = env();
    const other = join(tmpDir("pg-config-"), "cfg");
    const r = pg(pkg.bundle, ["init", "--harness", "claude-code", "--local"], { home: e.home, cwd: tmpDir(), env: { CLAUDE_CONFIG_DIR: other } });
    expect(r.code).toBe(0);
    expect(existsSync(join(other, "settings.json"))).toBe(true);
    const winner = pg(pkg.bundle, ["init", "--harness", "claude-code", "--local"], { home: e.home, cwd: tmpDir(), env: { CLAUDE_CONFIG_DIR: other, PROSEGATE_CLAUDE_HOME: e.claude } });
    expect(winner.code).toBe(0);
    expect(existsSync(e.settings)).toBe(true);
  });

  it("the check runs the registered command through a shell and reports a shim that does not answer", () => {
    const e = env();
    const broken = layoutPkg(null, "broken");
    writeFileSync(broken.shim, 'process.stdout.write("Welcome back!\\n");\n');
    writeFileSync(broken.bundle, readFileSync(pkg.bundle));
    const r = init(e, ["--local"], {}, broken);
    expect(r.code).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toMatch(/^Prosegate: the hooks are in .+settings\.json, but the check failed: it printed text where JSON was expected \(does your shell profile print something\?\)\. Claude Code will ignore Prosegate until this is fixed\. Details: .+\.log\n$/);
  });

  describe("refusals change nothing", () => {
    const refuse = (content: string, expected: RegExp): void => {
      const e = env();
      mkdirSync(e.claude, { recursive: true });
      writeFileSync(e.settings, content);
      const r = init(e);
      expect({ code: r.code, stdout: r.stdout }).toEqual({ code: 1, stdout: "" });
      expect(r.stderr).toMatch(expected);
      expect(readFileSync(e.settings, "utf8")).toBe(content);
      expect(backups(e.claude)).toEqual([]);
      expect(existsSync(join(e.home, "sessions"))).toBe(false);
    };

    it("malformed JSON: says where, never quotes the file, and writes nothing", () => {
      refuse('{\n  "env": { "SECRET_TOKEN": "abc123" },\n  "hooks": {,\n}\n', /^Prosegate: .+settings\.json is not valid JSON at line 3, column \d+, so nothing was changed\. Fix or move that file, then run this again\.\n$/);
    });

    it("never prints file content in the refusal", () => {
      const e = env();
      mkdirSync(e.claude, { recursive: true });
      writeFileSync(e.settings, '{"env":{"SECRET_TOKEN":"abc123"},,}');
      const r = init(e);
      expect(r.stderr).not.toContain("abc123");
      expect(r.stderr).not.toContain("SECRET");
    });

    it("JSON that is not an object", () => {
      refuse("[1, 2]", /is not a JSON object, so nothing was changed\./);
    });

    it("hooks that are not an object, or an event that is not a list", () => {
      refuse('{"hooks": []}', /"hooks" in .+settings\.json is not an object, so nothing was changed\./);
      refuse('{"hooks": {"Stop": {"hooks": []}}}', /hooks\.Stop in .+settings\.json is not a list, so nothing was changed\./);
    });
  });

  it("init without --harness, with an unknown harness or an unknown option, installs nothing", () => {
    const e = env();
    for (const args of [[], ["--harness", "cursor"], ["--harness", "claude-code", "--scope", "everywhere"], ["--harness", "claude-code", "--frobnicate"]]) {
      const r = pg(pkg.bundle, ["init", ...args], { home: e.home, cwd: tmpDir(), env: { PROSEGATE_CLAUDE_HOME: e.claude } });
      expect(r.code).toBe(1);
      expect(r.stdout).toBe("");
      expect(r.stderr).toMatch(/^Prosegate: /);
    }
    expect(existsSync(e.settings)).toBe(false);
  });

  it("does not register an MCP server (Phase 5)", () => {
    const e = env();
    init(e);
    expect(JSON.stringify(read(e.settings))).not.toMatch(/mcp/i);
    expect(existsSync(join(e.claude, ".mcp.json"))).toBe(false);
  });

  it("the shim it registers is the file in the package", () => {
    expect(readFileSync(pkg.shim, "utf8")).toBe(readFileSync(SHIM_SOURCE, "utf8"));
  });
});

describe("uninit", () => {
  it("removes exactly what init added: the file is back to its original JSON, key order included", () => {
    const e = env();
    mkdirSync(e.claude, { recursive: true });
    writeFileSync(e.settings, `${JSON.stringify(EXISTING, null, 2)}\n`);
    init(e);
    const r = uninit(e);
    expect(r.code).toBe(0);
    expect(r.stdout.split("\n")[0]).toBe(`Prosegate hooks removed from ${e.settings}.`);
    expect(readFileSync(e.settings, "utf8")).toBe(`${JSON.stringify(EXISTING, null, 2)}\n`);
  });

  it("leaves an empty settings object, not an empty hooks key, when the file had only our hooks", () => {
    const e = env();
    init(e);
    expect(uninit(e).code).toBe(0);
    expect(read(e.settings)).toEqual({});
  });

  it("keeps an empty hook group the user wrote", () => {
    const e = env();
    mkdirSync(e.claude, { recursive: true });
    const mine = { hooks: { Stop: [{ hooks: [] }] } };
    writeFileSync(e.settings, JSON.stringify(mine));
    init(e);
    uninit(e);
    expect(read(e.settings)).toEqual(mine);
  });

  it("with nothing to remove, says so and writes nothing", () => {
    const e = env();
    mkdirSync(e.claude, { recursive: true });
    writeFileSync(e.settings, JSON.stringify(EXISTING));
    const r = uninit(e);
    expect(r.stdout).toBe(`No Prosegate hooks found in ${e.settings}; nothing changed.\n`);
    expect(backups(e.claude)).toEqual([]);
    expect(uninit(env()).code).toBe(0);
  });

  it("refuses a file that is not valid JSON, untouched", () => {
    const e = env();
    mkdirSync(e.claude, { recursive: true });
    writeFileSync(e.settings, "{ not json");
    const r = uninit(e);
    expect(r.code).toBe(1);
    expect(readFileSync(e.settings, "utf8")).toBe("{ not json");
  });

  it("--scope project removes from the project file only", () => {
    const e = env();
    const project = tmpDir("pg-project-");
    init(e, ["--local"]);
    init(e, ["--scope", "project", "--local"], { cwd: project });
    expect(uninit(e, ["--scope", "project"], { cwd: project }).code).toBe(0);
    expect(read(join(project, ".claude", "settings.json"))).toEqual({});
    expect(read(e.settings)).toEqual({ hooks: ours(pkg) });
  });
});
