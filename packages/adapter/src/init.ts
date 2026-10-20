// `prosegate init --harness claude-code` and `prosegate uninit` (05 "Packaging", ADR-32, ADR-33).
// Init copies the package to ~/.prosegate/app/<version>/, registers three hooks in a Claude Code settings file against the launcher
// ~/.prosegate/app/hook.mjs, checks the result through the shell Claude Code uses, and only then points app/current at the new
// version. It merges into the settings (every other key and hook stays), writes a backup under ~/.prosegate/backups first, is a
// no-op the second time, refuses a file it cannot read, and rolls everything back if the self-check fails. Uninit removes exactly the
// entries init added. MCP uses the same stable launcher, with a private registration in Claude's config.

import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { SESSIONS_DIR, type Ctx } from "./ctx.js";
import { ensureDirIn, removeTree, writeFileAtomic } from "./fs-secure.js";
import {
  appDir,
  binDir,
  currentVersion,
  InstallBusyError,
  installVersion,
  launcherPath,
  onPath,
  packageProblem,
  previousVersion,
  pruneVersions,
  purge,
  restoreCurrent,
  setCurrent,
  withInstallLock,
  writeBin,
} from "./app-install.js";
import { detectShell, hookCommand, quoteProblem, runInShell, type HookShell } from "./hook-shell.js";
import { INIT_CHECK_SESSION } from "./init-check.js";

export interface InitResult {
  code: 0 | 1;
  out: string;
  err: string;
}

const EVENTS = ["SessionStart", "UserPromptSubmit", "Stop"] as const;
type HookEvent = (typeof EVENTS)[number];
const HOOK_TIMEOUT_S = 10;
const BACKUPS_KEPT = 5;
/** `<script>.mjs <Event>`: the script argument (single-quoted, double-quoted or bare) that ends in hook.mjs, then an event. */
const SCRIPT = /(?:'([^']*hook\.mjs)'|"([^"]*hook\.mjs)"|([^\s'"]*hook\.mjs))\s+(?:SessionStart|UserPromptSubmit|Stop)(?:\s|$)/;
/** `<...>/.prosegate/app/hook.mjs` or `<...>/prosegate/app/hook.mjs`: the launcher in a Prosegate home. */
const LAUNCHER_PATH = /(^|\/)\.?prosegate\/app\/hook\.mjs$/i;
/** `<...>/prosegate/<...>/shims/claude-code/hook.mjs`: the package's own shim, as the first W3.2 build registered it. */
const PACKAGE_SHIM = /(^|\/)prosegate\/(.*\/)?shims\/claude-code\/hook\.mjs$/i;

export const INIT_USAGE = "usage: prosegate init --harness claude-code [--scope project|user] [--local]";
export const UNINIT_USAGE = "usage: prosegate uninit [--scope project|user] [--purge]";
const BARE_INIT = "Prosegate: say which tool to set up, for example: prosegate init --harness claude-code";

/** The adapter's log for today (the same path run.ts reports). */
function logPathFor(ctx: Ctx): string {
  return join(ctx.home, "logs", `${new Date(ctx.now()).toISOString().slice(0, 10)}.log`);
}

interface Options {
  scope: "project" | "user";
  local: boolean;
  purge: boolean;
}

function parseArgs(args: readonly string[], init: boolean): Options | string {
  const o: Options = { scope: "user", local: false, purge: false };
  const usage = init ? INIT_USAGE : UNINIT_USAGE;
  // No default harness: a bare `prosegate init` must not edit anyone's settings by accident.
  if (init && !args.some((a) => a === "--harness" || a.startsWith("--harness="))) return BARE_INIT;
  for (let i = 0; i < args.length; i++) {
    const [flag, inline] = (args[i] ?? "").split(/=(.*)/s, 2) as [string, string | undefined];
    const value = (): string | undefined => inline ?? args[++i];
    if (init && flag === "--local") o.local = true;
    else if (!init && flag === "--purge") o.purge = true;
    else if (init && flag === "--harness") {
      const h = value();
      if (h !== "claude-code") return `Prosegate: harness ${JSON.stringify((h ?? "").slice(0, 30))} is not supported yet. Supported: claude-code.`;
    } else if (flag === "--scope") {
      const s = value();
      if (s !== "project" && s !== "user") return `Prosegate: --scope must be project or user. ${usage}`;
      o.scope = s;
    } else return `Prosegate: unknown option ${JSON.stringify(flag.slice(0, 30))}. ${usage}`;
  }
  return o;
}

/** Replaced by tsup (`define`): `false` in the release bundle, a string in the test build, undefined when run from source. See ctx.ts. */
declare const __PROSEGATE_TEST__: boolean | string | undefined;

/**
 * Where Claude Code keeps user settings: PROSEGATE_CLAUDE_HOME, else CLAUDE_CONFIG_DIR (both "given"), else `.claude` under
 * the home directory the ENVIRONMENT names (USERPROFILE on Windows, HOME elsewhere), never os.homedir(): a caller that
 * isolates its environment is then isolated (incident 2026-10-18). Null when the environment names no home.
 */
function claudeHome(env: Ctx["env"], platform: NodeJS.Platform): { dir: string; given: boolean } | null {
  const pick = (k: string): string | undefined => (env[k] !== undefined && env[k] !== "" ? env[k] : undefined);
  const given = pick("PROSEGATE_CLAUDE_HOME") ?? pick("CLAUDE_CONFIG_DIR");
  if (given !== undefined) return { dir: given, given: true };
  const home = platform === "win32" ? (pick("USERPROFILE") ?? pick("HOME")) : (pick("HOME") ?? pick("USERPROFILE"));
  return home === undefined ? null : { dir: join(home, ".claude"), given: false };
}

function isUnder(path: string, dir: string, platform: NodeJS.Platform): boolean {
  const norm = (p: string): string => {
    let existing = resolve(p);
    const missing: string[] = [];
    while (!existsSync(existing) && dirname(existing) !== existing) {
      missing.unshift(basename(existing));
      existing = dirname(existing);
    }
    const real = join(realpathSync(existing), ...missing);
    return platform === "win32" ? real.toLowerCase() : real;
  };
  try {
    const base = norm(dir);
    return norm(path).startsWith(base.endsWith(sep) ? base : base + sep);
  } catch { return false; }
}

export interface Target {
  scope: "project" | "user";
  /** The settings file this scope writes: `settings.json` under the Claude home, or the project's `settings.local.json`. */
  path: string;
  /** The project's `settings.json`, where the first W3.2 build wrote; its entries are removed (project scope) or refused (user scope). */
  legacy: string | null;
  /** The other scope's file(s): Prosegate is registered in one scope at a time. */
  other: Array<{ path: string; scope: "project" | "user" }>;
  claudeDir: string | null;
}

/**
 * The settings files for a scope, or the refusal. In a test build or when run from source (never in the release bundle:
 * `__PROSEGATE_TEST__` is false there and the branch folds away), a user-scope path that was not given explicitly and is not
 * under the OS temp directory is refused: it would be somebody's real ~/.claude.
 */
export function settingsTarget(ctx: Ctx, scope: "project" | "user"): Target | string {
  const home = claudeHome(ctx.env, ctx.platform);
  const userFile = home === null ? null : join(home.dir, "settings.json");
  const local = join(ctx.cwd, ".claude", "settings.local.json");
  const legacy = join(ctx.cwd, ".claude", "settings.json");
  if (scope === "project") {
    return { scope, path: local, legacy, other: userFile === null ? [] : [{ path: userFile, scope: "user" }], claudeDir: home?.dir ?? null };
  }
  if (home === null || userFile === null) return "Prosegate: cannot tell where your Claude settings are (no home directory in the environment), so nothing was changed. Set CLAUDE_CONFIG_DIR, then run this again.";
  if (typeof __PROSEGATE_TEST__ !== "boolean" && !home.given && !isUnder(userFile, tmpdir(), ctx.platform)) return testBuildRefusal(userFile);
  return { scope, path: userFile, legacy: null, other: [{ path: local, scope: "project" }, { path: legacy, scope: "project" }], claudeDir: home.dir };
}

/** Only referenced from the folded branch above, so the release bundle does not carry its text. */
function testBuildRefusal(path: string): string {
  return `Prosegate: refusing to write ${path} from a test build: it is outside the temp directory and no test home was given (set PROSEGATE_CLAUDE_HOME). Nothing was changed.`;
}

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);
const BOM = String.fromCharCode(0xfeff);

/** Where JSON.parse gave up, without quoting the file (it can hold secrets). */
function whereBroken(error: unknown, body: string): string {
  const m = error instanceof Error ? /line (\d+) column (\d+)/.exec(error.message) : null;
  if (m !== null) return ` at line ${m[1] ?? "?"}, column ${m[2] ?? "?"}`;
  // Node 20 can report only an offset. Derive coordinates without exposing text.
  const offset = error instanceof Error ? /position (\d+)/.exec(error.message) : null;
  if (offset === null) return "";
  const before = body.slice(0, Number(offset[1]));
  return ` at line ${before.split("\n").length}, column ${before.length - before.lastIndexOf("\n")}`;
}

interface Loaded {
  settings: Json;
  /** The file's text as read, byte for byte (BOM included), or null when there is no file. */
  text: string | null;
}

function load(path: string): Loaded | string {
  if (!existsSync(path)) return { settings: {}, text: null };
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    return `Prosegate: cannot read ${path} (${(error as NodeJS.ErrnoException).code ?? "error"}), so nothing was changed. Fix or move that file, then run this again.`;
  }
  const body = text.startsWith(BOM) ? text.slice(1) : text;
  if (body.trim() === "") return { settings: {}, text };
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch (error) {
    return `Prosegate: ${path} is not valid JSON${whereBroken(error, body)}, so nothing was changed. Fix or move that file, then run this again.`;
  }
  if (!isObject(parsed)) return `Prosegate: ${path} is not a JSON object, so nothing was changed. Fix or move that file, then run this again.`;
  return { settings: parsed, text };
}

/** The hook script a command runs: the quoted or bare argument that ends in hook.mjs and is followed by an event. */
function scriptOf(command: string): string | null {
  const m = SCRIPT.exec(command);
  const script = m?.[1] ?? m?.[2] ?? m?.[3];
  return script === undefined ? null : script.replace(/\\/g, "/");
}

/**
 * Ours, judged from the script argument alone (never the Node path or anything else in the command): this home's launcher, a
 * launcher in a `.prosegate` or `prosegate` home, or the package's own shim in a directory named `prosegate` (the first W3.2
 * build registered `.../prosegate/shims/claude-code/hook.mjs`). A third party's `.../claude-code/hook.mjs` is not.
 */
function isOurs(hook: unknown, known: ReadonlySet<string>): boolean {
  if (!isObject(hook) || typeof hook["command"] !== "string") return false;
  const script = scriptOf(hook["command"]);
  if (script === null) return false;
  const lower = script.toLowerCase();
  return [...known].some((launcher) => launcher.toLowerCase() === lower) || LAUNCHER_PATH.test(script) || PACKAGE_SHIM.test(script);
}

/** True when any hook in the settings is one of ours. */
function hasOurs(settings: Json, known: ReadonlySet<string>): boolean {
  const hooks = settings["hooks"];
  if (!isObject(hooks)) return false;
  return Object.values(hooks).some((groups) => Array.isArray(groups) && groups.some((g) => isObject(g) && Array.isArray(g["hooks"]) && (g["hooks"] as unknown[]).some((h) => isOurs(h, known))));
}

/** Adds (or updates in place) or removes our three entries. Returns the new settings and whether anything changed. */
function merge(settings: Json, path: string, commands: Record<HookEvent, string> | null, known: ReadonlySet<string>): { settings: Json; changed: boolean } | string {
  const hooks = settings["hooks"] === undefined ? {} : settings["hooks"];
  if (!isObject(hooks)) return `Prosegate: "hooks" in ${path} is not an object, so nothing was changed. Fix or move that file, then run this again.`;
  const next: Json = { ...hooks };
  const dropped = new Set<string>();
  let changed = false;
  for (const event of EVENTS) {
    const current = next[event];
    if (current !== undefined && !Array.isArray(current)) return `Prosegate: hooks.${event} in ${path} is not a list, so nothing was changed. Fix or move that file, then run this again.`;
    const groups: unknown[] = Array.isArray(current) ? current.map((g) => (isObject(g) && Array.isArray(g["hooks"]) ? { ...g, hooks: [...(g["hooks"] as unknown[])] } : g)) : [];
    const want = commands === null ? null : { type: "command", command: commands[event], timeout: HOOK_TIMEOUT_S };
    let found = false;
    const emptied = new Set<unknown>();
    for (const g of groups) {
      if (!isObject(g) || !Array.isArray(g["hooks"])) continue;
      const list = g["hooks"] as unknown[];
      for (let hi = list.length - 1; hi >= 0; hi--) {
        if (!isOurs(list[hi], known)) continue;
        if (want === null || found) {
          list.splice(hi, 1);
          if (list.length === 0) emptied.add(g);
          changed = true;
        } else {
          found = true;
          if (JSON.stringify(list[hi]) !== JSON.stringify(want)) {
            list[hi] = want;
            changed = true;
          }
        }
      }
    }
    const kept = groups.filter((g) => !emptied.has(g));
    if (want !== null && !found) {
      kept.push({ hooks: [want] });
      changed = true;
    }
    // An event we emptied is dropped; an empty list the user wrote before we came is theirs and stays.
    if (kept.length > 0 || (Array.isArray(current) && current.length === 0)) next[event] = kept;
    else dropped.add(event);
  }
  const hooksOut = Object.fromEntries(Object.entries(next).filter(([k]) => !dropped.has(k)));
  const out: Json = { ...settings };
  if (Object.keys(hooksOut).length > 0) out["hooks"] = hooksOut;
  else delete out["hooks"];
  return { settings: out, changed };
}

/** The text to write: the file's own indent, line endings and BOM are kept. */
function serialise(settings: Json, old: string | null): string {
  const indent = old === null ? "  " : (/^([ \t]+)"/m.exec(old)?.[1] ?? "  ");
  const text = `${JSON.stringify(settings, null, indent)}\n`;
  const eol = old?.includes("\r\n") === true ? text.replace(/\n/g, "\r\n") : text;
  return old?.startsWith(BOM) === true ? BOM + eol : eol;
}

/** Copies the old settings to ~/.prosegate/backups/ (never beside the file: a local settings file often holds secrets and its backup would escape the ignore rule). */
function backup(ctx: Ctx, path: string, text: string): string {
  const dir = join(ctx.home, "backups");
  ensureDirIn(ctx.home, dir, ctx.platform);
  const stamp = new Date(ctx.now()).toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  for (let n = 0; ; n++) {
    const file = join(dir, `${basename(path)}.${stamp}${n === 0 ? "" : `-${n}`}`);
    try {
      writeFileSync(file, text, { flag: "wx", mode: 0o600 });
      return file;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
}

function pruneBackups(ctx: Ctx): void {
  const dir = join(ctx.home, "backups");
  try {
    const files = readdirSync(dir).map((name) => ({ name, at: statSync(join(dir, name)).mtimeMs }));
    for (const f of files.sort((a, b) => b.at - a.at || (a.name < b.name ? 1 : -1)).slice(BACKUPS_KEPT)) rmSync(join(dir, f.name), { force: true });
  } catch {
    // pruning is housekeeping
  }
}

interface Saved {
  backup: string | null;
}

/** Writes the settings atomically (through a symlink to its target), after a backup of the old file. Returns the refusal when it cannot. */
function save(ctx: Ctx, path: string, old: Loaded, settings: Json): Saved | string {
  const real = existsSync(path) ? realpathSync(path) : path;
  let made: string | null = null;
  try {
    mkdirSync(dirname(real), { recursive: true });
    const mode = old.text === null ? null : statSync(real).mode & 0o777;
    if (old.text !== null && old.text.trim() !== "") made = backup(ctx, path, old.text);
    writeFileAtomic(real, serialise(settings, old.text));
    if (mode !== null && ctx.platform !== "win32") chmodSync(real, mode);
  } catch (error) {
    if (made !== null) rmSync(made, { force: true });
    return `Prosegate: could not write ${path} (${(error as NodeJS.ErrnoException).code ?? "error"}), so nothing was changed. Make that file writable, then run this again.`;
  }
  pruneBackups(ctx);
  return { backup: made };
}

/** Puts a settings file back exactly as it was (a failed self-check). */
function restore(path: string, old: Loaded): void {
  try {
    const real = existsSync(path) ? realpathSync(path) : path;
    if (old.text === null) rmSync(real, { force: true });
    else writeFileAtomic(real, old.text);
  } catch {
    // the message below still names the file
  }
}

interface McpPlan {
  path: string;
  loaded: Loaded;
  settings: Json;
  changed: boolean;
}

/** Same locations as Claude's user/local MCP scopes. Project installs stay private (ADR-36). */
export function mcpConfigPath(ctx: Ctx): string | null {
  const home = claudeHome(ctx.env, ctx.platform);
  if (home === null) return null;
  return home.given ? join(home.dir, ".claude.json") : join(dirname(home.dir), ".claude.json");
}

function planMcp(ctx: Ctx, scope: "user" | "project", remove = false): McpPlan | string {
  const path = mcpConfigPath(ctx);
  if (path === null) return "Prosegate: cannot locate Claude's MCP configuration. Set CLAUDE_CONFIG_DIR, then run this again.";
  const home = claudeHome(ctx.env, ctx.platform);
  if (typeof __PROSEGATE_TEST__ !== "boolean" && home?.given !== true && !isUnder(path, tmpdir(), ctx.platform)) return testBuildRefusal(path);
  const loaded = load(path);
  if (typeof loaded === "string") return loaded;
  const settings: Json = structuredClone(loaded.settings);
  const project = resolve(ctx.cwd).replace(/\\/g, "/");
  const projects = settings["projects"] ?? {};
  if (!isObject(projects)) return `Prosegate: projects in ${path} must be an object; nothing was changed.`;
  const local = projects[project] ?? {};
  if (!isObject(local)) return `Prosegate: the project's MCP settings in ${path} must be an object; nothing was changed.`;
  const section = scope === "user" ? settings : local;
  const servers = section["mcpServers"] ?? {};
  if (!isObject(servers)) return `Prosegate: mcpServers in ${path} must be an object; nothing was changed.`;
  const ours = (entry: unknown): boolean => isObject(entry) && Array.isArray(entry["args"])
    && entry["args"].length === 2 && entry["args"][0] === launcherPath(ctx) && entry["args"][1] === "mcp";
  const existing = servers["prosegate"];
  if (existing !== undefined && !ours(existing)) {
    if (remove) return { path, loaded, settings, changed: false };
    return `Prosegate: an unrelated MCP server already uses the name prosegate in ${path}; nothing was changed.`;
  }
  if (!remove) {
    const other = (scope === "user" ? local : settings)["mcpServers"];
    const shared = load(join(ctx.cwd, ".mcp.json"));
    if (typeof shared === "string") return shared;
    const sharedServers = shared.settings["mcpServers"];
    if ((isObject(other) && other["prosegate"] !== undefined) || (isObject(sharedServers) && sharedServers["prosegate"] !== undefined)) {
      return "Prosegate: another scope already registers an MCP server named prosegate. Remove that registration before changing scope; nothing was changed.";
    }
    servers["prosegate"] = { type: "stdio", command: process.execPath, args: [launcherPath(ctx), "mcp"] };
  } else {
    delete servers["prosegate"];
  }
  if (existing === undefined && remove) return { path, loaded, settings, changed: false };
  section["mcpServers"] = servers;
  if (scope === "project") {
    projects[project] = section;
    settings["projects"] = projects;
  }
  return { path, loaded, settings, changed: JSON.stringify(settings) !== JSON.stringify(loaded.settings) };
}

/** The adapter's environment for the self-check: the homes init was given, over whatever the process has. */
export function roundTripEnv(ctx: Ctx, claudeDir: string | null, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const given = Object.fromEntries(Object.entries(ctx.env).filter((e): e is [string, string] => e[1] !== undefined));
  return { ...base, ...given, PROSEGATE_HOME: ctx.home, ...(claudeDir === null ? {} : { PROSEGATE_CLAUDE_HOME: claudeDir }) };
}

/** Problems are fragments ("the hook printed nothing"), so the one failure sentence reads whole. */
const SHELL_TEXT = "your shell startup prints text, and Claude Code cannot read hook output while it does; print only in interactive shells";

/** Runs a registered command the way Claude Code does (through its shell) with a SessionStart for a synthetic session; null when it answered. */
function selfCheck(ctx: Ctx, shell: HookShell, command: string, claudeDir: string | null): string | null {
  const input = JSON.stringify({ session_id: INIT_CHECK_SESSION, cwd: ctx.cwd, hook_event_name: "SessionStart", source: "startup" });
  const r = runInShell(shell, command, input, roundTripEnv(ctx, claudeDir), ctx.cwd);
  try {
    removeTree(join(ctx.home, SESSIONS_DIR, INIT_CHECK_SESSION));
  } catch {
    // swept with the other sessions after a week
  }
  if (r.error !== undefined) return `the command did not run (${r.error.code ?? "error"})`;
  if (r.status !== 0) return `the command exited with ${String(r.status)}`;
  let out: { hookSpecificOutput?: { additionalContext?: unknown }; systemMessage?: unknown };
  try {
    // The whole of stdout, not its last line: Claude Code reads JSON only when stdout starts with it.
    out = JSON.parse(r.stdout.trim()) as typeof out;
  } catch {
    return r.stdout.trim() === "" ? "the hook printed nothing" : SHELL_TEXT;
  }
  if (typeof out.hookSpecificOutput?.additionalContext === "string") return null;
  // The launcher's own fail-open line: "Prosegate · this session may not be reviewed (<why>) · details: <log>".
  const why = typeof out.systemMessage === "string" ? /\((.+)\) · details:/.exec(out.systemMessage)?.[1] : undefined;
  return why === undefined ? "the hook gave no answer" : `the hook could not run: ${why}`;
}

/** Exercise MCP negotiation and discovery without a model, account or network. */
function mcpSelfCheck(ctx: Ctx, claudeDir: string | null): string | null {
  const messages = [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "prosegate-init-check", version: "1" } } },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
  ];
  const r = spawnSync(process.execPath, [launcherPath(ctx), "mcp"], {
    cwd: ctx.cwd, env: roundTripEnv(ctx, claudeDir), input: messages.map((m) => JSON.stringify(m)).join("\n") + "\n",
    encoding: "utf8", windowsHide: true, timeout: 5000, maxBuffer: 128 * 1024,
  });
  if (r.status !== 0 || r.error !== undefined) return "the MCP server did not start";
  try {
    const replies = r.stdout.trim().split("\n").map((line) => JSON.parse(line) as { id?: number; result?: { protocolVersion?: string; tools?: Array<{ name: string }> } });
    const names = replies.find((reply) => reply.id === 2)?.result?.tools?.map((t) => t.name).sort();
    return replies.some((reply) => reply.id === 1 && typeof reply.result?.protocolVersion === "string")
      && JSON.stringify(names) === JSON.stringify(["list_profiles", "review_prose", "select_profile"]) ? null : "the MCP server did not expose its three tools";
  } catch { return "the MCP server printed an invalid reply"; }
}

const done = (out: string[]): InitResult => ({ code: 0, out: `${out.join("\n")}\n`, err: "" });
const refuse = (err: string): InitResult => ({ code: 1, out: "", err: `${err}\n` });
const scopeFlag = (s: "project" | "user"): string => (s === "project" ? " --scope project" : "");
const uninitCommand = (s: "project" | "user"): string => `"prosegate uninit${scopeFlag(s)}"`;
const BUSY = "Prosegate: another prosegate init is running; try again when it finishes.";

/** The first file of the other scope that holds entries of ours, else null. */
function otherScopeEntry(target: Target, known: ReadonlySet<string>): { path: string; scope: "project" | "user" } | null {
  for (const o of target.other) {
    const loaded = load(o.path);
    if (typeof loaded !== "string" && hasOurs(loaded.settings, known)) return o;
  }
  return null;
}

/** git check-ignore: 1 means the file is not ignored. Anything else (not a repository, no git) says nothing. */
function notIgnored(cwd: string, file: string): boolean {
  const r = spawnSync("git", ["check-ignore", "-q", file], { cwd, windowsHide: true, timeout: 5000 });
  return r.status === 1;
}

function disableAllHooksIn(files: readonly string[]): string | null {
  for (const f of files) {
    const loaded = load(f);
    if (typeof loaded !== "string" && loaded.settings["disableAllHooks"] === true) return f;
  }
  return null;
}

interface InitPlan {
  o: Options;
  target: Target;
  nodePath: string;
  shell: HookShell;
  commands: Record<HookEvent, string>;
  known: ReadonlySet<string>;
  loaded: Loaded;
  legacy: Loaded | null;
  merged: { settings: Json; changed: boolean };
  mcp: McpPlan;
}

/** Everything init can check without writing: the arguments, the settings files, the refusals. A string is the refusal. */
function planInit(args: readonly string[], ctx: Ctx): InitPlan | string {
  const o = parseArgs(args, true);
  if (typeof o === "string") return o;
  const target = settingsTarget(ctx, o.scope);
  if (typeof target === "string") return target;
  const nodePath = process.execPath;
  const launcher = launcherPath(ctx);
  const quote = quoteProblem(nodePath, launcher);
  if (quote !== null) return quote;
  const incomplete = packageProblem();
  if (incomplete !== null) return incomplete;
  const shell = detectShell(ctx);
  const commands = Object.fromEntries(EVENTS.map((e) => [e, hookCommand(shell, nodePath, launcher, e)])) as Record<HookEvent, string>;
  const known = new Set([launcher.replace(/\\/g, "/")]);
  const other = otherScopeEntry(target, known);
  if (other !== null) {
    return `Prosegate: it is already set up in ${other.path} (${other.scope} scope), and one registration is enough. Run ${uninitCommand(other.scope)} first, then run this again.`;
  }
  const loaded = load(target.path);
  if (typeof loaded === "string") return loaded;
  const legacy = target.legacy === null ? null : load(target.legacy);
  if (typeof legacy === "string") return legacy;
  const merged = merge(loaded.settings, target.path, commands, known);
  if (typeof merged === "string") return merged;
  const mcp = planMcp(ctx, o.scope);
  if (typeof mcp === "string") return mcp;
  return { o, target, nodePath, shell, commands, known, loaded, legacy, merged, mcp };
}

export function runInit(args: readonly string[], ctx: Ctx): InitResult {
  const first = planInit(args, ctx);
  if (typeof first === "string") return refuse(first);
  try {
    // Re-planned under the lock: another init may have finished since the first look.
    return withInstallLock(ctx, () => {
      const plan = planInit(args, ctx);
      return typeof plan === "string" ? refuse(plan) : applyInit(plan, ctx);
    });
  } catch (error) {
    if (error instanceof InstallBusyError) return refuse(BUSY);
    throw error;
  }
}

function applyInit(plan: InitPlan, ctx: Ctx): InitResult {
  const { o, target, nodePath, shell, commands, known, loaded, legacy, merged, mcp } = plan;

  // 1. The program files, then a check of the NEW version (the launcher can be pinned to one with --use) before anything points at it.
  const oldLauncher = existsSync(launcherPath(ctx)) ? readFileSync(launcherPath(ctx), "utf8") : null;
  const installed = installVersion(ctx);
  if (typeof installed === "string") return refuse(installed);
  const before = { current: currentVersion(ctx), previous: previousVersion(ctx) };
  const undo = (): void => {
    restoreCurrent(ctx, before.current, before.previous);
    if (oldLauncher === null) rmSync(launcherPath(ctx), { force: true });
    else writeFileAtomic(launcherPath(ctx), oldLauncher);
    if (installed.created) rmSync(installed.dir, { recursive: true, force: true });
  };
  const fail = (problem: string): InitResult => {
    undo();
    return refuse(`Prosegate: the self-check failed (${problem}), so the hooks were rolled back and your settings are unchanged. Details: ${logPathFor(ctx)}`);
  };
  const pinned = selfCheck(ctx, shell, `${commands.SessionStart} --use=${installed.version}`, target.claudeDir);
  if (pinned !== null) return fail(pinned);

  // 2. The registration (with a backup), then the pointer, then the check through the registered command itself.
  let saved: Saved | null = null;
  if (merged.changed) {
    const r = save(ctx, target.path, loaded, merged.settings);
    if (typeof r === "string") {
      undo();
      return refuse(r);
    }
    saved = r;
  }
  setCurrent(ctx, installed.version);
  const problem = selfCheck(ctx, shell, commands.SessionStart, target.claudeDir) ?? mcpSelfCheck(ctx, target.claudeDir);
  if (problem !== null) {
    if (merged.changed) restore(target.path, loaded);
    return fail(problem);
  }
  if (mcp.changed) {
    // Refuse a concurrent Claude/config writer instead of replacing its newer settings.
    const latest = load(mcp.path);
    if (typeof latest === "string" || latest.text !== mcp.loaded.text) {
      if (merged.changed) restore(target.path, loaded);
      return fail("Claude's MCP configuration changed during installation; try again");
    }
    const mcpSaved = save(ctx, mcp.path, mcp.loaded, mcp.settings);
    if (typeof mcpSaved === "string") {
      if (merged.changed) restore(target.path, loaded);
      return fail("the MCP registration could not be written");
    }
  }

  // 3. The earlier W3.2 build wrote project entries to .claude/settings.json: take them out (project scope), and say if that failed.
  const notes: string[] = [];
  let legacyBackup: string | null = null;
  if (legacy !== null && target.legacy !== null && hasOurs(legacy.settings, known)) {
    const cleaned = merge(legacy.settings, target.legacy, null, known);
    const r = typeof cleaned === "string" ? cleaned : save(ctx, target.legacy, legacy, cleaned.settings);
    if (typeof r === "string") {
      const code = /\((E[A-Z]+)\)/.exec(r)?.[1] ?? "error";
      notes.push(`Warning: Prosegate's earlier entries are still in .claude/settings.json because it could not be written (${code}). Make it writable, then run "prosegate uninit --scope project".`);
    } else {
      legacyBackup = r.backup;
      notes.push("Removed Prosegate's earlier entries from .claude/settings.json.");
    }
  }
  pruneVersions(ctx);
  const bin = writeBin(ctx, nodePath);
  const backupPath = saved?.backup ?? legacyBackup;

  const where = o.scope === "project" ? `${target.path} (this folder only; not committed)` : target.path;
  const remove = `To remove it, run ${uninitCommand(o.scope)}.${backupPath === null ? "" : ` Your previous settings are saved in ${backupPath}.`}`;
  const out = [
    merged.changed ? `Prosegate is installed for Claude Code: hooks added to ${where}. The self-check passed.` : `Prosegate was already installed for Claude Code in ${where}; nothing changed. The self-check passed.`,
    `MCP tools registered in ${mcp.path}${o.scope === "project" ? " for this folder only (Claude local scope)" : " for all folders"}.`,
    o.local ? "Local mode for now: no sign-in is needed yet." : "Sign-in is not available in this build yet; installed in local mode.",
    "Start a new Claude Code session. If it asks whether to trust the folder, say yes; hooks do not run until you do.",
    // The PATH line comes before the lines that tell the user to type `prosegate`.
    ...(typeof bin === "string" ? [bin] : onPath(ctx) ? [] : [`To use "prosegate" directly, add ${binDir(ctx)} to your PATH; until then, "npx prosegate <command>" works.`]),
    'Prosegate stays silent when your prose is clean. To pause it for a session, run "prosegate advisory" in a terminal outside Claude Code.',
    remove,
    ...notes,
  ];
  if (o.scope === "project" && notIgnored(ctx.cwd, target.path)) out.push(`Warning: git does not ignore ${target.path}; add it to .gitignore so a machine-specific path is not committed.`);
  const off = disableAllHooksIn([target.path, ...target.other.map((x) => x.path)]);
  if (off !== null) out.push(`Warning: "disableAllHooks" is true in ${off}, so Claude Code will run no hook at all, Prosegate's included. Remove that setting, or set it to false, then start a new session.`);
  return done(out);
}

export function runUninit(args: readonly string[], ctx: Ctx): InitResult {
  const o = parseArgs(args, false);
  if (typeof o === "string") return refuse(o);
  const target = settingsTarget(ctx, o.scope);
  if (typeof target === "string") return refuse(target);
  try {
    const changed = existsSync(appDir(ctx)) ? withInstallLock(ctx, () => uninitSettings(target, ctx)) : uninitSettings(target, ctx);
    return typeof changed === "string" ? refuse(changed) : finishUninit(o, changed, ctx);
  } catch (error) {
    if (error instanceof InstallBusyError) return refuse(BUSY.replace("init", "command"));
    throw error;
  }
}

interface Removal {
  files: string[];
  removed: string[];
  backups: string[];
  /** Entries of ours in the other scope, which this command did not touch. */
  other: { path: string; scope: "project" | "user" } | null;
  mcpRemoved?: string;
}

function uninitSettings(target: Target, ctx: Ctx): Removal | string {
  const mcp = planMcp(ctx, target.scope, true);
  if (typeof mcp === "string") return mcp;
  // A third party's hook that merely looks like ours is never touched: ours are judged by their script path.
  const known = new Set([launcherPath(ctx).replace(/\\/g, "/")]);
  const files = [target.path, ...(target.legacy === null ? [] : [target.legacy])];
  const removal: Removal = { files, removed: [], backups: [], other: null };
  const plans: Array<{ path: string; loaded: Loaded; settings: Json }> = [];
  for (const file of files) {
    const loaded = load(file);
    if (typeof loaded === "string") return loaded;
    const merged = merge(loaded.settings, file, null, known);
    if (typeof merged === "string") return merged;
    if (!merged.changed) continue;
    plans.push({ path: file, loaded, settings: merged.settings });
  }
  if (mcp.changed) plans.push(mcp);
  const written: typeof plans = [];
  const undo = (): void => { for (const plan of written.reverse()) restore(plan.path, plan.loaded); };
  for (const plan of plans) {
    const latest = load(plan.path);
    if (typeof latest === "string" || latest.text !== plan.loaded.text) {
      undo();
      return "Prosegate: configuration changed during removal; restored the files already changed. Try again.";
    }
    const r = save(ctx, plan.path, plan.loaded, plan.settings);
    if (typeof r === "string") { undo(); return r; }
    written.push(plan);
    if (plan.path === mcp.path) removal.mcpRemoved = plan.path;
    else removal.removed.push(plan.path);
    if (r.backup !== null) removal.backups.push(r.backup);
  }
  removal.other = otherScopeEntry(target, known);
  return removal;
}

function finishUninit(o: Options, r: Removal, ctx: Ctx): InitResult {
  const out: string[] = [];
  if (r.removed.length > 0) out.push(`Prosegate hooks removed from ${r.removed.join(" and ")}.`);
  else {
    const here = `No Prosegate hooks found in ${r.files.join(" or ")}; nothing changed.`;
    out.push(r.other === null ? here : `${here} Prosegate is set up in ${r.other.path}: run ${uninitCommand(r.other.scope)}.`);
  }
  if (r.mcpRemoved !== undefined) out.push(`Prosegate MCP registration removed from ${r.mcpRemoved}.`);
  if (r.backups.length > 0) out.push(`Your previous settings are saved in ${r.backups.join(" and ")}.`);
  if (o.purge) {
    try {
      purge(ctx);
      out.push(`Removed Prosegate's program files from ${appDir(ctx)} and ${binDir(ctx)}. A project that is still set up shows a "files are missing" line until you run "npx prosegate uninit --scope project" in it.`);
    } catch (error) {
      out.push(`Could not remove ${appDir(ctx)} (${(error as NodeJS.ErrnoException).code ?? "error"}); delete it by hand.`);
    }
  } else if (existsSync(appDir(ctx))) {
    out.push(`Prosegate's program files are still in ${appDir(ctx)}, because other projects may use them. To remove them too, run "prosegate uninit --purge".`);
  }
  return done(out);
}
