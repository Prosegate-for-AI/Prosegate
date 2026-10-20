import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { createCtx } from "../../src/ctx.js";
import { detectShell, hookCommand } from "../../src/hook-shell.js";
import { runUninit } from "../../src/init.js";
import { pg, pgAsync, tmpDir } from "../helpers.js";
import { layoutPkg, releasePkg, type Pkg } from "./driver.js";

// `prosegate init --harness claude-code` and `prosegate uninit` (ADR-32, ADR-33): they copy the package to ~/.prosegate/app, register the
// launcher, merge into an existing settings file without touching anything else, back it up first (under ~/.prosegate/backups), are a
// no-op the second time, refuse a file or a scope they should not touch, and roll back when the self-check fails. Every test sets
// PROSEGATE_CLAUDE_HOME (or runs in a temp project), so the real ~/.claude is never reached (incident 2026-10-18).

let pkg: Pkg;
beforeAll(async () => {
  pkg = await releasePkg();
}, 120_000);

const fwd = (p: string): string => p.replace(/\\/g, "/");
const BASH = detectShell(createCtx({ env: {}, home: "x", cwd: "x" })).kind === "bash";
/** A skipped git test shows as skipped in the report instead of passing without having run. */
const HAS_GIT = spawnSync("git", ["--version"], { windowsHide: true }).status === 0;

/** PATH without any directory that holds a `prosegate` command, so "is it on PATH?" is the test's to decide. */
function cleanPath(extra: string[] = []): string {
  const dirs = (process.env["PATH"] ?? process.env["Path"] ?? "").split(delimiter).filter((d) => d !== "" && !["prosegate", "prosegate.cmd", "prosegate.exe"].some((n) => existsSync(join(d, n))));
  return [...extra, ...dirs].join(delimiter);
}

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
  return pg(p.bundle, ["init", "--harness", "claude-code", ...args], { home: e.home, cwd: over.cwd ?? tmpDir(), env: { PROSEGATE_CLAUDE_HOME: e.claude, PATH: cleanPath(), ...over.env } });
}
function uninit(e: Env, args: string[] = [], over: { cwd?: string; env?: Record<string, string> } = {}) {
  return pg(pkg.bundle, ["uninit", ...args], { home: e.home, cwd: over.cwd ?? tmpDir(), env: { PROSEGATE_CLAUDE_HOME: e.claude, PATH: cleanPath(), ...over.env } });
}
const read = (p: string): Record<string, unknown> => JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>;
const backupsOf = (e: Env): string[] => (existsSync(join(e.home, "backups")) ? readdirSync(join(e.home, "backups")) : []);
const writeSettings = (e: Env, text: string, file = e.settings): void => {
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, text);
};

/** The command init registers for this machine's hook shell, written out by hand (single-quoted paths, this Node, the launcher). */
function command(e: Env, event: string): string {
  const call = `'${fwd(process.execPath)}' '${fwd(join(e.home, "app", "hook.mjs"))}' ${event}`;
  return BASH ? call : `& ${call}`;
}
function ours(e: Env): Record<string, unknown> {
  const group = (event: string) => [{ hooks: [{ type: "command", command: command(e, event), timeout: 10 }] }];
  return { SessionStart: group("SessionStart"), UserPromptSubmit: group("UserPromptSubmit"), Stop: group("Stop") };
}

// A settings file with things init must not touch: other keys, other hooks in the same events, a matcher group, and a THIRD-PARTY hook
// whose layout is the same as the first W3.2 build's (.../claude-code/hook.mjs) but which is not Prosegate's.
const THIRD_PARTY = "node /opt/acme/claude-code/hook.mjs Stop";
const EXISTING = {
  $schema: "https://json.schemastore.org/claude-code-settings.json",
  model: "opus",
  permissions: { allow: ["Bash(git status)"], deny: ["Read(./.env)"] },
  env: { FOO: "bar" },
  hooks: {
    PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo pre" }] }],
    Stop: [{ hooks: [{ type: "command", command: "node ~/my-stop-hook.js", timeout: 5 }] }, { hooks: [{ type: "command", command: THIRD_PARTY }] }],
    SessionStart: [{ matcher: "startup", hooks: [{ type: "command", command: "echo hello" }] }],
  },
  statusLine: { type: "command", command: "echo status" },
};
const EXISTING_TEXT = `${JSON.stringify(EXISTING, null, 2)}\n`;

describe("init, user scope", () => {
  it("copies the package to ~/.prosegate/app, registers the launcher, writes the command, and the self-check passes", () => {
    const e = env();
    const r = init(e);
    expect(r.stderr).toBe("");
    expect(r.code).toBe(0);
    expect(read(e.settings)).toEqual({ hooks: ours(e) });
    expect(readFileSync(join(e.home, "app", "current"), "utf8").trim()).toBe("1.0.0");
    for (const f of ["hook.mjs", join("1.0.0", "dist", "prosegate.mjs"), join("1.0.0", "shims", "claude-code", "hook.mjs"), join("1.0.0", "package.json")]) expect(existsSync(join(e.home, "app", f)), f).toBe(true);
    expect(readFileSync(join(e.home, "app", "hook.mjs"), "utf8")).toBe(readFileSync(pkg.launcher, "utf8"));
    expect(existsSync(join(e.home, "bin", "prosegate"))).toBe(true);
    if (process.platform === "win32") expect(existsSync(join(e.home, "bin", "prosegate.cmd"))).toBe(true);
    expect(existsSync(join(e.home, "sessions", "prosegate-init-check"))).toBe(false);
  });

  it("registers single-quoted paths, this Node (not a bare `node`) and the launcher, with a 10 s timeout on every hook", () => {
    const e = env();
    init(e);
    const hooks = read(e.settings)["hooks"] as Record<string, Array<{ hooks: Array<{ type: string; command: string; timeout: number }> }>>;
    for (const event of ["SessionStart", "UserPromptSubmit", "Stop"]) {
      const hook = hooks[event]?.[0]?.hooks[0];
      expect(hook, event).toEqual({ type: "command", command: command(e, event), timeout: 10 });
      expect(hook?.command).toContain(`'${fwd(process.execPath)}'`);
      expect(hook?.command).not.toMatch(/^node /);
    }
  });

  it("prints the copy of ADR-33, in at most seven plain lines (backup and PATH lines included)", () => {
    const e = env();
    writeSettings(e, EXISTING_TEXT);
    const r = init(e, []);
    const lines = r.stdout.trimEnd().split("\n");
    expect(lines.length).toBeLessThanOrEqual(7);
    const [backup] = backupsOf(e);
    expect(lines).toEqual([
      `Prosegate is installed for Claude Code: hooks added to ${e.settings}. The self-check passed.`,
      `MCP tools registered in ${join(e.claude, ".claude.json")} for all folders.`,
      "Sign-in is not available in this build yet; installed in local mode.",
      "Start a new Claude Code session. If it asks whether to trust the folder, say yes; hooks do not run until you do.",
      // The PATH line comes before the lines that tell the user to type `prosegate`.
      `To use "prosegate" directly, add ${join(e.home, "bin")} to your PATH; until then, "npx prosegate <command>" works.`,
      'Prosegate stays silent when your prose is clean. To pause it for a session, run "prosegate advisory" in a terminal outside Claude Code.',
      `To remove it, run "prosegate uninit". Your previous settings are saved in ${join(e.home, "backups", backup as string)}.`,
    ]);
    expect(r.stdout).toMatch(/^[\x20-\x7e\n]*$/); // no emoji, no colour
  });

  it("--local says local mode in its own words, and a first install with no settings file has no backup line", () => {
    const e = env();
    const lines = init(e, ["--local"]).stdout.trimEnd().split("\n");
    expect(lines[2]).toBe("Local mode for now: no sign-in is needed yet.");
    expect(lines[6]).toBe('To remove it, run "prosegate uninit".');
    expect(backupsOf(e)).toEqual([]);
  });

  it("no PATH line when `prosegate` already resolves on PATH", () => {
    const e = env();
    const r = init(e, ["--local"], { env: { PATH: cleanPath([join(e.home, "bin")]) } });
    // The first run creates the scripts after the PATH is read, so run twice: the second finds them.
    const second = init(e, ["--local"], { env: { PATH: cleanPath([join(e.home, "bin")]) } });
    expect(r.code).toBe(0);
    expect(second.stdout).not.toContain("add ");
  });

  it("a `prosegate` that exists only in the PATH entries npx and pnpm exec add for their own child does not count as on PATH", () => {
    const e = env();
    const npxBin = join(tmpDir("pg-npx-"), "_npx", "ab12cd", "node_modules", ".bin");
    mkdirSync(npxBin, { recursive: true });
    writeFileSync(join(npxBin, process.platform === "win32" ? "prosegate.cmd" : "prosegate"), "");
    const r = init(e, ["--local"], { env: { PATH: [npxBin, cleanPath()].join(delimiter) } });
    expect(r.stdout).toContain(`To use "prosegate" directly, add ${join(e.home, "bin")} to your PATH`);
  });

  it("the `prosegate` command it writes runs the current version", () => {
    const e = env();
    expect(init(e).code).toBe(0);
    const script = process.platform === "win32" ? join(e.home, "bin", "prosegate.cmd") : join(e.home, "bin", "prosegate");
    if (process.platform !== "win32") {
      chmodSync(script, 0o600);
      expect(init(e).code).toBe(0); // Re-init repairs an existing non-executable script.
    }
    const r = spawnSync(script, ["--version"], { encoding: "utf8", shell: process.platform === "win32" });
    expect(r.status, r.error?.message ?? r.stderr).toBe(0);
    expect(r.stdout).toMatch(/^\S+\n$/);
    const sh = BASH && process.platform === "win32" ? spawnSync(detectShell(createCtx({ env: {}, home: "x", cwd: "x" })).file, ["-c", `'${fwd(join(e.home, "bin", "prosegate"))}' --version`], { encoding: "utf8" }) : null;
    if (sh !== null) expect(sh.stdout).toBe(r.stdout);
  });

  it("merges into an existing file: every other key and hook is left alone, ours are added after the user's", () => {
    const e = env();
    writeSettings(e, EXISTING_TEXT);
    expect(init(e).code).toBe(0);
    const after = read(e.settings);
    const { hooks: before, ...rest } = EXISTING;
    const { hooks: afterHooks, ...afterRest } = after as { hooks: Record<string, unknown[]> } & Record<string, unknown>;
    expect(afterRest).toEqual(rest);
    expect(Object.keys(after)).toEqual(Object.keys(EXISTING));
    expect(afterHooks["PreToolUse"]).toEqual(before.PreToolUse);
    expect(afterHooks["Stop"]).toEqual([...before.Stop, ...(ours(e)["Stop"] as unknown[])]);
    expect(afterHooks["SessionStart"]).toEqual([...before.SessionStart, ...(ours(e)["SessionStart"] as unknown[])]);
    expect(afterHooks["UserPromptSubmit"]).toEqual(ours(e)["UserPromptSubmit"]);
  });

  it("backs the old file up under ~/.prosegate/backups (not beside it), exactly, and keeps the newest five", () => {
    const e = env();
    writeSettings(e, EXISTING_TEXT);
    init(e);
    expect(readdirSync(join(e.settings, "..")).sort()).toEqual([".claude.json", "settings.json"]);
    const [name] = backupsOf(e);
    expect(name).toMatch(/^settings\.json\.\d{8}T\d{6}Z(-\d+)?$/);
    expect(readFileSync(join(e.home, "backups", name as string), "utf8")).toBe(EXISTING_TEXT);
  });

  it("is a no-op the second time: no write, no new backup, the same `current`, and it says so", () => {
    const e = env();
    writeSettings(e, EXISTING_TEXT);
    init(e);
    const once = readFileSync(e.settings, "utf8");
    const backups = backupsOf(e);
    const again = init(e);
    expect(again.code).toBe(0);
    expect(readFileSync(e.settings, "utf8")).toBe(once);
    expect(backupsOf(e)).toEqual(backups);
    expect(readdirSync(join(e.home, "app")).sort()).toEqual(["1.0.0", "current", "hook.mjs"]);
    expect(again.stdout.split("\n")[0]).toBe(`Prosegate was already installed for Claude Code in ${e.settings}; nothing changed. The self-check passed.`);
    expect(again.stdout).not.toContain("previous settings");
  });

  it("keeps the file's indentation, line endings and byte order mark", () => {
    const e = env();
    writeSettings(e, `${String.fromCharCode(0xfeff)}{\r\n\t"model": "opus"\r\n}\r\n`);
    init(e);
    const text = readFileSync(e.settings, "utf8");
    expect(text.startsWith(String.fromCharCode(0xfeff))).toBe(true);
    expect(text).toContain('\r\n\t"model": "opus"');
    expect(text.replace(/\r\n/g, "")).not.toContain("\n");
  });

  it("writes through a symlinked settings file instead of replacing the link", () => {
    const e = env();
    const target = join(tmpDir("pg-dotfiles-"), "claude-settings.json");
    writeFileSync(target, EXISTING_TEXT);
    mkdirSync(e.claude, { recursive: true });
    try {
      symlinkSync(target, e.settings, "file");
    } catch {
      return; // creating symlinks needs a privilege on some Windows setups
    }
    expect(init(e).code).toBe(0);
    expect(read(target)["hooks"]).toBeDefined();
    expect(readFileSync(e.settings, "utf8")).toBe(readFileSync(target, "utf8"));
  });

  it("warns when disableAllHooks is true", () => {
    const e = env();
    writeSettings(e, JSON.stringify({ disableAllHooks: true }));
    expect(init(e).stdout).toContain(
      `Warning: "disableAllHooks" is true in ${e.settings}, so Claude Code will run no hook at all, Prosegate's included. Remove that setting, or set it to false, then start a new session.`,
    );
  });

  it("a settings file that cannot be written gets a real message and leaves no backup", () => {
    if (process.platform !== "win32") return; // POSIX lets a rename replace a read-only file; the Windows rule is the one that bites
    const e = env();
    writeSettings(e, EXISTING_TEXT);
    chmodSync(e.settings, 0o444);
    const r = init(e);
    chmodSync(e.settings, 0o666);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(new RegExp(`^Prosegate: could not write .+settings\\.json \\((EPERM|EACCES)\\), so nothing was changed\\. Make that file writable, then run this again\\.\\n$`));
    expect(backupsOf(e)).toEqual([]);
    expect(readFileSync(e.settings, "utf8")).toBe(EXISTING_TEXT);
  });

  it("writes no telemetry for its own check session (a check is not a session)", () => {
    const e = env();
    init(e);
    const spool = join(e.home, "telemetry", "spool.jsonl");
    expect(!existsSync(spool) || !readFileSync(spool, "utf8").includes("session_start")).toBe(true);
    // The control: a real session start does spool one, so the assertion above can fail.
    pg(pkg.bundle, ["session-start"], { home: e.home, input: { harness: "claude-code", session_id: "a-real-session", cwd: tmpDir(), mode: "interactive" } });
    expect(readFileSync(spool, "utf8")).toContain("session_start");
  });
});

describe("init, versions and the launcher", () => {
  it("a newer version installs beside the old one, current moves, the previous is kept and older ones are pruned", () => {
    const e = env();
    const v = (version: string): Pkg => layoutPkg(pkg.bundle, `prosegate-${version}`, undefined, version);
    expect(init(e, ["--local"], {}, v("1.0.0")).code).toBe(0);
    expect(init(e, ["--local"], {}, v("2.0.0")).code).toBe(0);
    expect(readFileSync(join(e.home, "app", "current"), "utf8").trim()).toBe("2.0.0");
    expect(readFileSync(join(e.home, "app", "previous"), "utf8").trim()).toBe("1.0.0");
    expect(readdirSync(join(e.home, "app")).sort()).toEqual(["1.0.0", "2.0.0", "current", "hook.mjs", "previous"]);
    expect(init(e, ["--local"], {}, v("3.0.0")).code).toBe(0);
    expect(readdirSync(join(e.home, "app")).sort()).toEqual(["2.0.0", "3.0.0", "current", "hook.mjs", "previous"]);
    // The registration never changed: one launcher.
    expect(read(e.settings)).toEqual({ hooks: ours(e) });
  });

  it("the same version number with different content gets its own directory (a running hook keeps its files)", () => {
    const e = env();
    init(e);
    const other = layoutPkg(pkg.bundle, "prosegate-rebuilt", undefined, "1.0.0");
    writeFileSync(other.bundle, `${readFileSync(pkg.bundle, "utf8")}\n// rebuilt\n`);
    expect(init(e, ["--local"], {}, other).code).toBe(0);
    const dirs = readdirSync(join(e.home, "app")).filter((n) => n.startsWith("1.0.0"));
    expect(dirs).toHaveLength(2);
    expect(readFileSync(join(e.home, "app", "current"), "utf8").trim()).toMatch(/^1\.0\.0-[0-9a-f]{8}$/);
  });
});

describe("init, a damaged install and two inits at once", () => {
  const sessionStartOk = (e: Env): boolean => {
    const r = spawnSync(process.execPath, [join(e.home, "app", "hook.mjs"), "SessionStart"], {
      input: JSON.stringify({ session_id: "s-recover", cwd: tmpDir(), hook_event_name: "SessionStart", source: "startup" }),
      encoding: "utf8",
      env: { ...process.env, PROSEGATE_HOME: e.home },
    });
    return typeof (JSON.parse(r.stdout) as { hookSpecificOutput?: { additionalContext?: unknown } }).hookSpecificOutput?.additionalContext === "string";
  };

  it("a version directory with a deleted file is rebuilt by the next init, and the hooks work again (V F-A)", () => {
    const e = env();
    expect(init(e).code).toBe(0);
    rmSync(join(e.home, "app", "1.0.0", "dist", "prosegate.mjs"));
    expect(sessionStartOk(e)).toBe(false);
    const again = init(e);
    expect(again.code).toBe(0);
    expect(existsSync(join(e.home, "app", "1.0.0", "dist", "prosegate.mjs"))).toBe(true);
    expect(sessionStartOk(e)).toBe(true);
    expect(readdirSync(join(e.home, "app")).sort()).toEqual(["1.0.0", "current", "hook.mjs"]);
  });

  it("a version directory with an edited or emptied file is rebuilt too, not trusted because its marker file is intact", () => {
    for (const rel of [join("dist", "prosegate.mjs"), join("shims", "claude-code", "hook.mjs"), join("shims", "claude-code", "launcher.mjs")]) {
      const e = env();
      init(e);
      writeFileSync(join(e.home, "app", "1.0.0", rel), "// damaged\n");
      expect(init(e).code, rel).toBe(0);
      expect(readFileSync(join(e.home, "app", "1.0.0", rel), "utf8"), rel).not.toBe("// damaged\n");
      expect(sessionStartOk(e), rel).toBe(true);
    }
  });

  it("four inits at once: one installs, the others wait and find it done; one registration, no leftovers", async () => {
    const e = env();
    const runs = await Promise.all(
      Array.from({ length: 4 }, () => pgAsync(pkg.bundle, ["init", "--harness", "claude-code", "--local"], { home: e.home, cwd: tmpDir(), env: { PROSEGATE_CLAUDE_HOME: e.claude, PATH: cleanPath() } })),
    );
    // Normally all four succeed. On a machine so loaded that an init waits out its 30 s, the only other outcome allowed is the
    // lock's own refusal, in full; anything else (a half-written pointer, a crash) fails.
    const ok = runs.filter((r) => r.code === 0);
    for (const r of runs.filter((x) => x.code !== 0)) expect(r.stderr).toBe("Prosegate: another prosegate init is running; try again when it finishes.\n");
    expect(ok.length).toBeGreaterThanOrEqual(2);
    expect(ok.filter((r) => r.stdout.startsWith("Prosegate is installed for Claude Code")).length).toBe(1);
    expect(ok.filter((r) => r.stdout.startsWith("Prosegate was already installed for Claude Code")).length).toBe(ok.length - 1);
    expect(read(e.settings)).toEqual({ hooks: ours(e) });
    expect(readdirSync(join(e.home, "app")).sort()).toEqual(["1.0.0", "current", "hook.mjs"]);
    expect(sessionStartOk(e)).toBe(true);
  }, 120_000);

  it("an init that cannot get the install lock within about 30 s refuses, and changes nothing", () => {
    const e = env();
    mkdirSync(join(e.home, "app"), { recursive: true });
    // A lock held by a live process (this one), fresh: not stale, so the init waits for it.
    writeFileSync(join(e.home, "app", ".install.lock"), JSON.stringify({ pid: process.pid, token: "held-by-the-test", at: Date.now() }));
    const t0 = performance.now();
    const r = init(e);
    const waited = performance.now() - t0;
    expect(r.code).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toBe("Prosegate: another prosegate init is running; try again when it finishes.\n");
    expect(waited).toBeGreaterThanOrEqual(29_000);
    expect(existsSync(e.settings)).toBe(false);
    expect(existsSync(join(e.home, "app", "current"))).toBe(false);
  }, 120_000);
});

describe("init, project scope", () => {
  it("writes .claude/settings.local.json in the working directory and leaves the user settings alone", () => {
    const e = env();
    const project = tmpDir("pg-project-");
    const r = init(e, ["--scope", "project", "--local"], { cwd: project });
    expect(r.code).toBe(0);
    expect(read(join(project, ".claude", "settings.local.json"))).toEqual({ hooks: ours(e) });
    expect(existsSync(join(project, ".claude", "settings.json"))).toBe(false);
    expect(existsSync(e.settings)).toBe(false);
    expect(r.stdout.split("\n")[0]).toBe(`Prosegate is installed for Claude Code: hooks added to ${join(project, ".claude", "settings.local.json")} (this folder only; not committed). The self-check passed.`);
  });

  it("removes the earlier build's entries from .claude/settings.json (and only those) and says so", () => {
    const e = env();
    const project = tmpDir("pg-project-");
    const legacy = {
      permissions: { allow: ["Bash(ls)"] },
      hooks: { Stop: [{ hooks: [{ type: "command", command: "node ~/mine.js" }] }, { hooks: [{ type: "command", command: 'node "C:/Users/x/AppData/npm-cache/_npx/ab12/node_modules/prosegate/shims/claude-code/hook.mjs" Stop', timeout: 10 }] }, { hooks: [{ type: "command", command: THIRD_PARTY }] }] },
    };
    writeSettings(e, JSON.stringify(legacy, null, 2), join(project, ".claude", "settings.json"));
    const r = init(e, ["--scope", "project", "--local"], { cwd: project });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Removed Prosegate's earlier entries from .claude/settings.json.");
    expect(read(join(project, ".claude", "settings.json"))).toEqual({
      permissions: legacy.permissions,
      hooks: { Stop: [legacy.hooks.Stop[0], legacy.hooks.Stop[2]] },
    });
  });

  it("project scope says how to remove it: `prosegate uninit --scope project`, in full", () => {
    const e = env();
    const lines = init(e, ["--scope", "project", "--local"], { cwd: tmpDir("pg-project-") }).stdout.trimEnd().split("\n");
    expect(lines.at(-1)).toBe('To remove it, run "prosegate uninit --scope project".');
    expect(lines.join("\n")).not.toContain('run "prosegate uninit".');
  });

  it("a failed clean-up of the earlier .claude/settings.json is reported, not swallowed", () => {
    if (process.platform !== "win32") return; // a read-only file blocks the atomic replace on Windows only
    const e = env();
    const project = tmpDir("pg-project-");
    const legacyFile = join(project, ".claude", "settings.json");
    const entry = { hooks: { Stop: [{ hooks: [{ type: "command", command: 'node "C:/x/node_modules/prosegate/shims/claude-code/hook.mjs" Stop' }] }] } };
    writeSettings(e, JSON.stringify(entry), legacyFile);
    chmodSync(legacyFile, 0o444);
    const r = init(e, ["--scope", "project", "--local"], { cwd: project });
    chmodSync(legacyFile, 0o666);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(
      "Warning: Prosegate's earlier entries are still in .claude/settings.json because it could not be written (EPERM). Make it writable, then run \"prosegate uninit --scope project\".",
    );
    expect(read(legacyFile)).toEqual(entry);
  });

  it.skipIf(!HAS_GIT)("warns, once, when git does not ignore the local file, and not when it does", () => {
    const e = env();
    const project = tmpDir("pg-project-");
    expect(spawnSync("git", ["init", "-q"], { cwd: project }).status).toBe(0);
    const file = join(project, ".claude", "settings.local.json");
    const open = init(e, ["--scope", "project", "--local"], { cwd: project });
    expect(open.stdout).toContain(`Warning: git does not ignore ${file}; add it to .gitignore so a machine-specific path is not committed.`);
    writeFileSync(join(project, ".gitignore"), ".claude/settings.local.json\n");
    expect(init(e, ["--scope", "project", "--local"], { cwd: project }).stdout).not.toContain("Warning: git");
  });
});

describe("one registration", () => {
  it("project init refuses when the user scope has our entries, and the other way round, naming the file and the uninit command", () => {
    const e = env();
    const project = tmpDir("pg-project-");
    expect(init(e).code).toBe(0);
    const user = readFileSync(e.settings, "utf8");
    const r = init(e, ["--scope", "project", "--local"], { cwd: project });
    expect(r.code).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toBe(`Prosegate: it is already set up in ${e.settings} (user scope), and one registration is enough. Run "prosegate uninit" first, then run this again.\n`);
    expect(existsSync(join(project, ".claude"))).toBe(false);
    expect(readFileSync(e.settings, "utf8")).toBe(user);

    const f = env();
    expect(init(f, ["--scope", "project", "--local"], { cwd: project }).code).toBe(0);
    const back = init(f, ["--local"], { cwd: project });
    expect(back.code).toBe(1);
    expect(back.stderr).toBe(`Prosegate: it is already set up in ${join(project, ".claude", "settings.local.json")} (project scope), and one registration is enough. Run "prosegate uninit --scope project" first, then run this again.\n`);
    expect(existsSync(f.settings)).toBe(false);
  });
});

describe("a third party's hook with the same layout is never touched", () => {
  it("not by init, not by uninit, and uninit without init does not say it removed anything", () => {
    const e = env();
    // Each of these names "Prosegate" somewhere (the Node path, a parent directory) but none is Prosegate's script (C S1).
    const lookalikes = [
      THIRD_PARTY,
      `'C:/Prosegate/tools/node.exe' '/opt/acme/claude-code/hook.mjs' Stop`,
      `node /opt/Prosegate/acme/claude-code/hook.mjs Stop`,
      `node /opt/Prosegate/vendor/app/hook.mjs Stop`,
      `"/home/me/.prosegate-tools/bin/node" "/srv/other/shims/claude-code/hook.mjs" Stop`,
    ];
    const only = { hooks: { Stop: lookalikes.map((command) => ({ hooks: [{ type: "command", command }] })) } };
    const text = `${JSON.stringify(only, null, 2)}\n`;
    writeSettings(e, text);
    const nothing = uninit(e);
    expect(nothing.code).toBe(0);
    expect(nothing.stdout).toBe(`No Prosegate hooks found in ${e.settings}; nothing changed.\n`);
    expect(nothing.stdout).not.toContain("removed");
    expect(readFileSync(e.settings, "utf8")).toBe(text);
    expect(backupsOf(e)).toEqual([]);
    expect(init(e).code).toBe(0);
    expect(((read(e.settings)["hooks"] as { Stop: unknown[] }).Stop).slice(0, lookalikes.length)).toEqual(only.hooks.Stop);
    expect(uninit(e).code).toBe(0);
    expect(readFileSync(e.settings, "utf8")).toBe(text);
  });
});

describe("uninit", () => {
  it("init then uninit leaves the settings byte-identical, and says where the program files are", () => {
    const e = env();
    writeSettings(e, EXISTING_TEXT);
    init(e);
    const r = uninit(e);
    expect(r.code).toBe(0);
    expect(readFileSync(e.settings, "utf8")).toBe(EXISTING_TEXT);
    const lines = r.stdout.trimEnd().split("\n");
    expect(lines[0]).toBe(`Prosegate hooks removed from ${e.settings}.`);
    expect(lines.at(-1)).toBe(`Prosegate's program files are still in ${join(e.home, "app")}, because other projects may use them. To remove them too, run "prosegate uninit --purge".`);
    expect(existsSync(join(e.home, "app", "hook.mjs"))).toBe(true);
  });

  it("--purge removes the versions, current, previous and bin, but keeps the launcher so other projects show the readable line (V F-B)", () => {
    const e = env();
    init(e);
    const r = uninit(e, ["--purge"]);
    expect(r.code).toBe(0);
    expect(readdirSync(join(e.home, "app"))).toEqual(["hook.mjs"]);
    expect(existsSync(join(e.home, "bin"))).toBe(false);
    expect(r.stdout.trimEnd().split("\n").at(-1)).toBe(
      `Removed Prosegate's program files from ${join(e.home, "app")} and ${join(e.home, "bin")}. A project that is still set up shows a "files are missing" line until you run "npx prosegate uninit --scope project" in it.`,
    );
    expect(read(e.settings)).toEqual({});
  });

  it("after a purge, a project that is still set up shows the launcher's files-are-missing line, not an error", () => {
    const e = env();
    init(e);
    uninit(e, ["--purge"]);
    const stop = spawnSync(process.execPath, [join(e.home, "app", "hook.mjs"), "Stop"], {
      input: JSON.stringify({ session_id: "s-1", prompt_id: "p", last_assistant_message: "text" }),
      encoding: "utf8",
      env: { ...process.env, PROSEGATE_HOME: e.home },
    });
    expect(stop.status).toBe(0);
    expect((JSON.parse(stop.stdout) as { systemMessage: string }).systemMessage).toContain('its files are missing; run "npx prosegate init" again');
  });

  it("the no-op line names the other scope when our entries are there, both ways round (C M1, V F-D)", () => {
    const e = env();
    const project = tmpDir("pg-project-");
    const projectFile = join(project, ".claude", "settings.local.json");
    expect(init(e, ["--scope", "project", "--local"], { cwd: project }).code).toBe(0);
    const fromUser = uninit(e, [], { cwd: project });
    expect(fromUser.stdout.split("\n")[0]).toBe(`No Prosegate hooks found in ${e.settings}; nothing changed. Prosegate is set up in ${projectFile}: run "prosegate uninit --scope project".`);
    const gone = uninit(e, ["--scope", "project"], { cwd: project });
    expect(gone.stdout.split("\n")[0]).toBe(`Prosegate hooks removed from ${projectFile}.`);

    const f = env();
    expect(init(f, ["--local"], { cwd: project }).code).toBe(0);
    const fromProject = uninit(f, ["--scope", "project"], { cwd: project });
    const files = `${projectFile} or ${join(project, ".claude", "settings.json")}`;
    expect(fromProject.stdout.split("\n")[0]).toBe(`No Prosegate hooks found in ${files}; nothing changed. Prosegate is set up in ${f.settings}: run "prosegate uninit".`);
  });

  it("project-scope uninit also cleans the earlier build's .claude/settings.json (I36)", () => {
    const e = env();
    const project = tmpDir("pg-project-");
    const old = { permissions: { allow: ["Bash(ls)"] }, hooks: { Stop: [{ hooks: [{ type: "command", command: 'node "C:/x/node_modules/prosegate/shims/claude-code/hook.mjs" Stop' }] }] } };
    writeSettings(e, JSON.stringify(old, null, 2), join(project, ".claude", "settings.json"));
    const r = uninit(e, ["--scope", "project"], { cwd: project });
    expect(r.stdout.split("\n")[0]).toBe(`Prosegate hooks removed from ${join(project, ".claude", "settings.json")}.`);
    expect(read(join(project, ".claude", "settings.json"))).toEqual({ permissions: old.permissions });
  });

  it("leaves an empty settings object, not an empty hooks key, when the file had only our hooks", () => {
    const e = env();
    init(e);
    expect(uninit(e).code).toBe(0);
    expect(read(e.settings)).toEqual({});
  });

  it("keeps an empty hook group the user wrote", () => {
    const e = env();
    const mine = { hooks: { Stop: [{ hooks: [] }] } };
    writeSettings(e, JSON.stringify(mine));
    init(e);
    uninit(e);
    expect(read(e.settings)).toEqual(mine);
  });

  it("uninit keeps an empty event list the user wrote, and drops only the event it emptied (I6)", () => {
    const e = env();
    const group = [{ hooks: [{ type: "command", command: command(e, "SessionStart"), timeout: 10 }] }];
    writeSettings(e, JSON.stringify({ hooks: { Stop: [], UserPromptSubmit: [], SessionStart: group } }, null, 2));
    expect(uninit(e).code).toBe(0);
    expect(read(e.settings)).toEqual({ hooks: { Stop: [], UserPromptSubmit: [] } });
  });

  it("moves its own stale entries in place (I9): the first W3.2 build's npx-cache command and an old timeout are replaced, the user's hooks keep their places", () => {
    const e = env();
    const stale = (event: string, timeout: number): unknown => ({ hooks: [{ type: "command", command: `node "C:/Users/x/AppData/npm-cache/_npx/ab12/node_modules/prosegate/shims/claude-code/hook.mjs" ${event}`, timeout }] });
    const mine = { hooks: [{ type: "command", command: "echo mine" }] };
    writeSettings(e, JSON.stringify({ hooks: { SessionStart: [stale("SessionStart", 10)], UserPromptSubmit: [stale("UserPromptSubmit", 600)], Stop: [mine, stale("Stop", 10), mine] } }, null, 2));
    expect(init(e).code).toBe(0);
    const hooks = read(e.settings)["hooks"] as Record<string, Array<{ hooks: Array<{ command: string; timeout: number }> }>>;
    expect(hooks["Stop"]?.map((g) => g.hooks[0]?.command)).toEqual(["echo mine", command(e, "Stop"), "echo mine"]);
    expect(hooks["UserPromptSubmit"]?.[0]?.hooks[0]).toEqual({ type: "command", command: command(e, "UserPromptSubmit"), timeout: 10 });
    expect(hooks["SessionStart"]).toEqual((ours(e) as Record<string, unknown>)["SessionStart"]);
    expect(JSON.stringify(hooks)).not.toContain("_npx");
  });

  it("collapses duplicates of ours to one entry (I8)", () => {
    const e = env();
    const dupe = { type: "command", command: command(e, "Stop"), timeout: 10 };
    writeSettings(e, JSON.stringify({ hooks: { Stop: [{ hooks: [dupe, dupe] }, { hooks: [dupe] }] } }, null, 2));
    expect(init(e).code).toBe(0);
    const stop = (read(e.settings)["hooks"] as { Stop: Array<{ hooks: unknown[] }> }).Stop;
    expect(stop.flatMap((g) => g.hooks)).toEqual([dupe]);
  });

  it("with nothing to remove, says so and writes nothing", () => {
    const e = env();
    writeSettings(e, JSON.stringify(EXISTING));
    const r = uninit(e);
    expect(r.stdout).toBe(`No Prosegate hooks found in ${e.settings}; nothing changed.\n`);
    expect(backupsOf(e)).toEqual([]);
    expect(uninit(env()).code).toBe(0);
  });

  it("refuses a file that is not valid JSON, untouched", () => {
    const e = env();
    writeSettings(e, "{ not json");
    const r = uninit(e);
    expect(r.code).toBe(1);
    expect(readFileSync(e.settings, "utf8")).toBe("{ not json");
  });

  it("--scope project removes from the project files only (settings.local.json and the earlier settings.json)", () => {
    const e = env();
    const project = tmpDir("pg-project-");
    init(e, ["--scope", "project", "--local"], { cwd: project });
    const r = uninit(e, ["--scope", "project"], { cwd: project });
    expect(r.code).toBe(0);
    expect(read(join(project, ".claude", "settings.local.json"))).toEqual({});
  });

  it("backups never collide (a counter suffix) and only the newest five are kept (F13)", () => {
    const e = env();
    const ctxAt = (t: () => number) => createCtx({ env: { PROSEGATE_CLAUDE_HOME: e.claude, HOME: e.claude, USERPROFILE: e.claude }, home: e.home, cwd: tmpDir(), now: t });
    const withOurs = (): void => writeSettings(e, JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: command(e, "Stop") }] }] } }));
    // The same millisecond, three times: three different backup files.
    for (let i = 0; i < 3; i++) {
      withOurs();
      expect(runUninit([], ctxAt(() => 1_800_000_000_000)).code).toBe(0);
    }
    expect(backupsOf(e)).toHaveLength(3);
    expect(new Set(backupsOf(e)).size).toBe(3);
    for (let i = 0; i < 5; i++) {
      withOurs();
      expect(runUninit([], ctxAt(() => 1_800_000_100_000 + i * 1000)).code).toBe(0);
    }
    expect(backupsOf(e)).toHaveLength(5);
  });
});

describe("refusals change nothing", () => {
  const refuse = (content: string, expected: RegExp): void => {
    const e = env();
    writeSettings(e, content);
    const r = init(e);
    expect({ code: r.code, stdout: r.stdout }).toEqual({ code: 1, stdout: "" });
    expect(r.stderr).toMatch(expected);
    expect(readFileSync(e.settings, "utf8")).toBe(content);
    expect(backupsOf(e)).toEqual([]);
    expect(existsSync(join(e.home, "app"))).toBe(false);
  };

  it("malformed JSON: says where, never quotes the file, and writes nothing", () => {
    refuse('{\n  "env": { "SECRET_TOKEN": "abc123" },\n  "hooks": {,\n}\n', /^Prosegate: .+settings\.json is not valid JSON at line 3, column \d+, so nothing was changed\. Fix or move that file, then run this again\.\n$/);
    const e = env();
    writeSettings(e, '{"env":{"SECRET_TOKEN":"abc123"},,}');
    const r = init(e);
    expect(r.stderr).not.toContain("abc123");
    expect(r.stderr).not.toContain("SECRET");
  });

  it("JSON that is not an object, hooks that are not an object, an event that is not a list: all end with 'Fix or move that file, then run this again.'", () => {
    refuse("[1, 2]", /is not a JSON object, so nothing was changed\. Fix or move that file, then run this again\./);
    refuse('{"hooks": []}', /"hooks" in .+settings\.json is not an object, so nothing was changed\. Fix or move that file, then run this again\./);
    refuse('{"hooks": {"Stop": {"hooks": []}}}', /hooks\.Stop in .+settings\.json is not a list, so nothing was changed\. Fix or move that file, then run this again\./);
  });

  it("init with no harness, an unknown harness or option, or an old --headless installs nothing", () => {
    const e = env();
    const run = (args: string[]) => pg(pkg.bundle, ["init", ...args], { home: e.home, cwd: tmpDir(), env: { PROSEGATE_CLAUDE_HOME: e.claude } });
    expect(run([]).stderr).toBe("Prosegate: say which tool to set up, for example: prosegate init --harness claude-code\n");
    for (const args of [["--harness", "cursor"], ["--harness", "claude-code", "--scope", "everywhere"], ["--harness", "claude-code", "--frobnicate"], ["--harness", "claude-code", "--headless"]]) {
      const r = run(args);
      expect(r.code).toBe(1);
      expect(r.stdout).toBe("");
      expect(r.stderr).toMatch(/^Prosegate: /);
    }
    expect(existsSync(e.settings)).toBe(false);
    expect(existsSync(join(e.home, "app"))).toBe(false);
  });

  it("a package with a file missing is reported, not half-installed", () => {
    const e = env();
    const gone = layoutPkg(pkg.bundle, "gone");
    rmSync(gone.launcher);
    const r = init(e, ["--local"], {}, gone);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/^Prosegate: the package is incomplete \(.+launcher\.mjs is missing\)\. Reinstall it, then run this again\.\n$/);
    expect(existsSync(e.settings)).toBe(false);
    expect(existsSync(join(e.home, "app"))).toBe(false);
  });

  it("registers the MCP server alongside hooks in Claude's separate config", () => {
    const e = env();
    init(e);
    expect(JSON.stringify(read(e.settings))).not.toMatch(/mcp/i);
    expect(existsSync(join(e.claude, ".mcp.json"))).toBe(false);
    expect(read(join(e.claude, ".claude.json"))["mcpServers"]).toEqual({
      prosegate: { type: "stdio", command: process.execPath, args: [join(e.home, "app", "hook.mjs"), "mcp"] },
    });
  });
});

describe("MCP installation and removal", () => {
  it("preserves unrelated MCP servers and account settings, backs up the config, and is idempotent", () => {
    const e = env();
    const file = join(e.claude, ".claude.json");
    const original = { theme: "dark", mcpServers: { existing: { command: "other", args: ["--stdio"] } } };
    const text = JSON.stringify(original, null, 2) + "\n";
    writeSettings(e, text, file);
    expect(init(e).code).toBe(0);
    expect(read(file)).toMatchObject(original);
    expect(backupsOf(e).some((name) => readFileSync(join(e.home, "backups", name), "utf8") === text)).toBe(true);
    const installed = readFileSync(file, "utf8");
    const backups = backupsOf(e);
    expect(init(e).code).toBe(0);
    expect(readFileSync(file, "utf8")).toBe(installed);
    expect(backupsOf(e)).toEqual(backups);
    expect(uninit(e).code).toBe(0);
    expect(read(file)).toEqual(original);
  });
  it("registers project scope privately and uninstalls only that project's entry", () => {
    const e = env(); const project = tmpDir();
    const file = join(e.claude, ".claude.json");
    const unrelated = { mcpServers: { other: { command: "other" } } };
    writeSettings(e, JSON.stringify({ projects: { "/another/project": unrelated } }), file);
    expect(init(e, ["--scope", "project"], { cwd: project }).code).toBe(0);
    expect(existsSync(join(project, ".mcp.json"))).toBe(false);
    const projects = read(file)["projects"] as Record<string, { mcpServers: Record<string, unknown> }>;
    expect(projects[project.replace(/\\/g, "/")]?.mcpServers["prosegate"]).toBeDefined();
    expect(uninit(e, ["--scope", "project"], { cwd: project }).code).toBe(0);
    expect((read(file)["projects"] as Record<string, unknown>)["/another/project"]).toEqual(unrelated);
  });
  it.each(["malformed", "conflict", "invalid servers"])("refuses %s MCP config before changing hooks", (kind) => {
    const e = env(); const file = join(e.claude, ".claude.json");
    const text = kind === "malformed" ? '{"private-value":' : JSON.stringify({ mcpServers: kind === "conflict" ? { prosegate: { command: "another-program" } } : [] });
    writeSettings(e, text, file);
    const result = init(e);
    expect(result.code).toBe(1);
    expect(result.stderr).not.toContain("private-value");
    expect(readFileSync(file, "utf8")).toBe(text);
    expect(existsSync(e.settings)).toBe(false);
    expect(existsSync(join(e.home, "app"))).toBe(false);
  });
  it("preserves a replacement MCP registration when uninit removes our hooks", () => {
    const e = env(); expect(init(e).code).toBe(0);
    const file = join(e.claude, ".claude.json");
    const replacement = { mcpServers: { prosegate: { command: "another-program" } } };
    writeSettings(e, JSON.stringify(replacement), file);
    expect(uninit(e).code).toBe(0);
    expect(read(file)).toEqual(replacement);
    expect(read(e.settings)["hooks"]).toBeUndefined();
  });
  it("rolls hooks and version back when the MCP self-check fails", () => {
    const e = env();
    const bad = layoutPkg(pkg.bundle);
    // A broken launcher that still answers hooks but cannot negotiate MCP.
    const launcher = readFileSync(bad.launcher, "utf8").replace('if (event === "mcp") {', 'if (event === "mcp") { process.exit(1);');
    writeFileSync(bad.launcher, launcher);
    writeSettings(e, EXISTING_TEXT);
    const result = init(e, ["--local"], {}, bad);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("MCP server did not start");
    expect(readFileSync(e.settings, "utf8")).toBe(EXISTING_TEXT);
    expect(existsSync(join(e.claude, ".claude.json"))).toBe(false);
    expect(existsSync(join(e.home, "app", "current"))).toBe(false);
  });
});

describe("the self-check, and rolling back when it fails (ADR-33)", () => {
  /** Settings the user had, so a rollback has something to restore. */
  const prepared = (): Env => {
    const e = env();
    writeSettings(e, EXISTING_TEXT);
    return e;
  };
  const untouched = (e: Env): void => {
    expect(readFileSync(e.settings, "utf8")).toBe(EXISTING_TEXT);
    expect(existsSync(join(e.home, "app", "current"))).toBe(false);
    expect(readdirSync(join(e.home, "app")).filter((n) => /^\d/.test(n))).toEqual([]);
  };

  /** A package whose bundle is the real one (it runs init) but whose installed shim answers by `body`. */
  const withShim = (name: string, body: string, version = "1.0.0"): Pkg => {
    const file = join(tmpDir("pg-shim-"), "hook.mjs");
    writeFileSync(file, body);
    return layoutPkg(pkg.bundle, name, file, version);
  };
  const FAILS = `export const writeAtomic = () => {};\nexport async function handle() { return { sid: "s", problem: { why: "internal error", where: null, detail: "x" } }; }\n`;

  it("a version that cannot answer: refused before anything points at it, settings unchanged, program files removed", () => {
    const e = prepared();
    const bad = withShim("bad", FAILS);
    const r = init(e, ["--local"], {}, bad);
    expect(r.code).toBe(1);
    expect(r.stdout).toBe("");
    // One sentence, one "Details:", and the problem is a fragment (C S2).
    expect(r.stderr).toBe(`Prosegate: the self-check failed (the hook could not run: internal error), so the hooks were rolled back and your settings are unchanged. Details: ${join(e.home, "logs", `${new Date().toISOString().slice(0, 10)}.log`)}\n`);
    expect(r.stderr.match(/Details:/g)).toHaveLength(1);
    untouched(e);
    expect(backupsOf(e)).toEqual([]);
  });

  it("a failure after the settings were written restores them byte for byte, puts `current` back, and removes the new version", () => {
    const e = prepared();
    const counter = join(tmpDir("pg-counter-"), "calls");
    // Answers the first call (the pinned check of the new version) and fails every later one (the registered command).
    const once = withShim(
      "once",
      `import { appendFileSync, existsSync } from "node:fs";\nexport const writeAtomic = () => {};\nexport async function handle() {\n  const first = !existsSync(${JSON.stringify(counter)});\n  appendFileSync(${JSON.stringify(counter)}, "x");\n  if (!first) return { sid: "s", problem: { why: "second call", where: null, detail: "x" } };\n  return { sid: "s", json: { hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: "ok" } } };\n}\n`,
    );
    const r = init(e, ["--local"], {}, once);
    expect(r.code).toBe(1);
    expect(r.stderr).toBe(`Prosegate: the self-check failed (the hook could not run: second call), so the hooks were rolled back and your settings are unchanged. Details: ${join(e.home, "logs", `${new Date().toISOString().slice(0, 10)}.log`)}\n`);
    expect(readFileSync(e.settings, "utf8")).toBe(EXISTING_TEXT);
    expect(existsSync(join(e.home, "app", "current"))).toBe(false);
    expect(readdirSync(join(e.home, "app")).filter((n) => /^\d/.test(n))).toEqual([]);
    expect(readFileSync(counter, "utf8").length).toBe(2);
  });

  it("a rollback puts back the version that was current", () => {
    const e = env();
    expect(init(e).code).toBe(0);
    const bad = withShim("bad2", FAILS, "2.0.0");
    const r = init(e, ["--local"], {}, bad);
    expect(r.code).toBe(1);
    expect(readFileSync(join(e.home, "app", "current"), "utf8").trim()).toBe("1.0.0");
    expect(existsSync(join(e.home, "app", "2.0.0"))).toBe(false);
    expect(read(e.settings)).toEqual({ hooks: ours(e) });
  });

  it.skipIf(!BASH)("a shell startup file that prints text is named as the problem, and nothing is installed", () => {
    const e = prepared();
    const home = tmpDir("pg-shellhome-");
    writeFileSync(join(home, ".bash_profile"), "echo 'Welcome back!'\n");
    const r = init(e, ["--local"], { env: { HOME: home, USERPROFILE: home, PROSEGATE_HOOK_SHELL: "bash" } });
    expect(r.code).toBe(1);
    expect(r.stderr).toBe(
      `Prosegate: the self-check failed (your shell startup prints text, and Claude Code cannot read hook output while it does; print only in interactive shells), so the hooks were rolled back and your settings are unchanged. Details: ${join(e.home, "logs", `${new Date().toISOString().slice(0, 10)}.log`)}\n`,
    );
    untouched(e);
  });
});

describe("quoting (F3, F11)", () => {
  const quirky = `a$HOME \`echo hi\` b`;

  // Git Bash on Windows; bash and a plain POSIX sh elsewhere (PROSEGATE_HOOK_SHELL=sh forces the second).
  const shells = process.platform === "win32" ? [undefined] : [undefined, "sh"];
  it.skipIf(process.platform === "win32" && !BASH).each(shells)("a home whose path holds $ and backticks is registered literally and runs through the hook shell (%s)", (forced) => {
    const hookShell = forced === undefined ? {} : { PROSEGATE_HOOK_SHELL: forced };
    const e = env();
    const odd: Env = { claude: e.claude, home: join(tmpDir("pg-odd-"), quirky, ".prosegate"), settings: e.settings };
    const r = init(odd, ["--local"], { env: hookShell });
    expect(r.stderr).toBe("");
    expect(r.code).toBe(0);
    const start = ((read(e.settings)["hooks"] as { SessionStart: Array<{ hooks: Array<{ command: string }> }> }).SessionStart)[0]?.hooks[0]?.command ?? "";
    expect(start).toContain(`'${fwd(join(odd.home, "app", "hook.mjs"))}'`);
    expect(start).toContain("$HOME");
    expect(start).toContain("`echo hi`");
    // Run the registered command again, as Claude Code would.
    const shell = detectShell(createCtx({ env: hookShell, home: "x", cwd: "x" }));
    const run = spawnSync(shell.file, [...shell.args, start], { input: JSON.stringify({ session_id: "s", cwd: tmpDir(), hook_event_name: "SessionStart", source: "startup" }), encoding: "utf8", env: { ...process.env, PROSEGATE_HOME: odd.home } });
    expect(JSON.parse(run.stdout)).toHaveProperty("hookSpecificOutput.additionalContext");
  });

  it("a path with a single quote is refused with a clear message, and nothing is written", () => {
    const e = env();
    const odd: Env = { claude: e.claude, home: join(tmpDir("pg-odd-"), "it's", ".prosegate"), settings: e.settings };
    const r = init(odd);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/^Prosegate: .+ contains a character a hook command cannot hold safely \(a single quote or a line break\)\. Install Node, or set PROSEGATE_HOME, in a path without one, then run this again\.\n$/);
    expect(existsSync(e.settings)).toBe(false);
    expect(existsSync(odd.home)).toBe(false);
  });

  it.skipIf(process.platform !== "win32")("the PowerShell form (`& '...' '...' Stop`) registers and passes its own self-check when PowerShell is the hook shell", () => {
    const e = env();
    const r = init(e, ["--local"], { env: { PROSEGATE_HOOK_SHELL: "powershell" } });
    expect(r.stderr).toBe("");
    expect(r.code).toBe(0);
    const stop = ((read(e.settings)["hooks"] as { Stop: Array<{ hooks: Array<{ command: string }> }> }).Stop)[0]?.hooks[0]?.command ?? "";
    expect(stop).toBe(`& '${fwd(process.execPath)}' '${fwd(join(e.home, "app", "hook.mjs"))}' Stop`);
  });

  it("hookCommand: bash and sh get the bare quoted form, PowerShell gets the call operator, all with forward slashes", () => {
    const node = "C:\\Program Files\\nodejs\\node.exe";
    const launcher = "C:\\Users\\Me\\.prosegate\\app\\hook.mjs";
    expect(hookCommand({ kind: "bash", file: "bash", args: [] }, node, launcher, "Stop")).toBe(`'C:/Program Files/nodejs/node.exe' 'C:/Users/Me/.prosegate/app/hook.mjs' Stop`);
    expect(hookCommand({ kind: "sh", file: "sh", args: [] }, node, launcher, "Stop")).toBe(`'C:/Program Files/nodejs/node.exe' 'C:/Users/Me/.prosegate/app/hook.mjs' Stop`);
    expect(hookCommand({ kind: "powershell", file: "powershell", args: [] }, node, launcher, "Stop")).toBe(`& 'C:/Program Files/nodejs/node.exe' 'C:/Users/Me/.prosegate/app/hook.mjs' Stop`);
  });
});

describe("the CLAUDE_CONFIG_DIR rules", () => {
  it("the user scope honours CLAUDE_CONFIG_DIR, and PROSEGATE_CLAUDE_HOME wins over it (the host's value is never inherited)", () => {
    const e = env();
    const other = join(tmpDir("pg-config-"), "cfg");
    const r = pg(pkg.bundle, ["init", "--harness", "claude-code", "--local"], { home: e.home, cwd: tmpDir(), env: { CLAUDE_CONFIG_DIR: other, PROSEGATE_CLAUDE_HOME: "", PATH: cleanPath() } });
    expect(r.code).toBe(0);
    expect(existsSync(join(other, "settings.json"))).toBe(true);
    const f = env();
    const winner = pg(pkg.bundle, ["init", "--harness", "claude-code", "--local"], { home: f.home, cwd: tmpDir(), env: { CLAUDE_CONFIG_DIR: other, PROSEGATE_CLAUDE_HOME: f.claude, PATH: cleanPath() } });
    expect(winner.code).toBe(0);
    expect(existsSync(f.settings)).toBe(true);
  });
});
