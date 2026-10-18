// `prosegate init --harness claude-code` and `prosegate uninit` (05 "Packaging", W3.2). Init registers the
// three hooks in a Claude Code settings.json by merging into it: every other key and hook is left alone, a
// timestamped backup is written first, a second run changes nothing, and a file that is not valid JSON is
// refused untouched. Uninit removes exactly the entries init added. MCP registration is Phase 5 (TODO below).

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { Ctx } from "./ctx.js";
import { SESSIONS_DIR } from "./ctx.js";
import { removeTree, writeFileAtomic } from "./fs-secure.js";

export interface InitResult {
  code: 0 | 1;
  out: string;
  err: string;
}

const EVENTS = ["SessionStart", "UserPromptSubmit", "Stop"] as const;
type HookEvent = (typeof EVENTS)[number];
/** Matches a command init wrote, whatever directory the package lived in then (so an upgrade or a move replaces it). */
const OURS = /claude-code[\\/]hook\.mjs"?\s+(SessionStart|UserPromptSubmit|Stop)(\s|$)/;
/** The adapter's log for today (the same path run.ts reports). */
function logPathFor(ctx: Ctx): string {
  return join(ctx.home, "logs", `${new Date(ctx.now()).toISOString().slice(0, 10)}.log`);
}

const SYNTHETIC_SESSION = "prosegate-init-check";
const HOOK_TIMEOUT_S = 10;

export const INIT_USAGE = "usage: prosegate init --harness claude-code [--scope project|user] [--local]";

interface Options {
  scope: "project" | "user";
  local: boolean;
  headless: boolean;
}

function parseArgs(args: readonly string[], needHarness: boolean): Options | string {
  const o: Options = { scope: "user", local: false, headless: false };
  // No default harness: a bare `prosegate init` must not edit anyone's settings by accident.
  if (needHarness && !args.some((a) => a === "--harness" || a.startsWith("--harness="))) return `Prosegate: init needs a harness. ${INIT_USAGE}`;
  for (let i = 0; i < args.length; i++) {
    const [flag, inline] = (args[i] ?? "").split(/=(.*)/s, 2) as [string, string | undefined];
    const value = (): string | undefined => inline ?? args[++i];
    if (flag === "--local") o.local = true;
    else if (flag === "--headless") o.headless = true;
    else if (flag === "--harness") {
      const h = value();
      if (h !== "claude-code") return `Prosegate: harness ${JSON.stringify((h ?? "").slice(0, 30))} is not supported yet. Supported: claude-code.`;
    } else if (flag === "--scope") {
      const s = value();
      if (s !== "project" && s !== "user") return `Prosegate: --scope must be project or user. ${INIT_USAGE}`;
      o.scope = s;
    } else return `Prosegate: unknown option ${JSON.stringify(flag.slice(0, 30))}. ${INIT_USAGE}`;
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
  const norm = (p: string): string => (platform === "win32" ? resolve(p).toLowerCase() : resolve(p));
  const base = norm(dir);
  return norm(path).startsWith(base.endsWith(sep) ? base : base + sep);
}

/**
 * The settings file for a scope, or the refusal. In a test build or when run from source (never in the release
 * bundle: `__PROSEGATE_TEST__` is false there and the branch folds away), a user-scope path that was not given
 * explicitly and is not under the OS temp directory is refused: it would be somebody's real ~/.claude.
 */
export function settingsTarget(ctx: Ctx, scope: "project" | "user"): { path: string; claudeDir: string | null } | string {
  const home = claudeHome(ctx.env, ctx.platform);
  if (scope === "project") return { path: join(ctx.cwd, ".claude", "settings.json"), claudeDir: home?.dir ?? null };
  if (home === null) return "Prosegate: cannot tell where your Claude settings are (no home directory in the environment), so nothing was changed. Set CLAUDE_CONFIG_DIR, then run this again.";
  const path = join(home.dir, "settings.json");
  if (typeof __PROSEGATE_TEST__ !== "boolean" && !home.given && !isUnder(path, tmpdir(), ctx.platform)) return testBuildRefusal(path);
  return { path, claudeDir: home.dir };
}

/** Only referenced from the folded branch above, so the release bundle does not carry its text. */
function testBuildRefusal(path: string): string {
  return `Prosegate: refusing to write ${path} from a test build: it is outside the temp directory and no test home was given (set PROSEGATE_CLAUDE_HOME). Nothing was changed.`;
}

/** The shim ships inside the package, beside dist/ (and beside src/ when run from source). */
export function shimPath(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "shims", "claude-code", "hook.mjs");
}

/** Forward slashes work in Git Bash, PowerShell and node alike; backslashes inside double quotes do not in a POSIX shell. */
export function commandFor(event: HookEvent, shim: string, headless: boolean): string {
  return `node "${shim.replace(/\\/g, "/")}" ${event}${headless ? " --headless" : ""}`;
}

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);

/** Where JSON.parse gave up, without quoting the file (it can hold secrets). */
function whereBroken(error: unknown): string {
  const m = error instanceof Error ? /line (\d+) column (\d+)/.exec(error.message) : null;
  return m === null ? "" : ` at line ${m[1] ?? "?"}, column ${m[2] ?? "?"}`;
}

interface Loaded {
  settings: Json;
  raw: string | null;
}

function load(path: string): Loaded | string {
  if (!existsSync(path)) return { settings: {}, raw: null };
  const raw = readFileSync(path, "utf8").replace(/^\uFEFF/, "");
  if (raw.trim() === "") return { settings: {}, raw };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return `Prosegate: ${path} is not valid JSON${whereBroken(error)}, so nothing was changed. Fix or move that file, then run this again.`;
  }
  if (!isObject(parsed)) return `Prosegate: ${path} is not a JSON object, so nothing was changed. Fix or move that file, then run this again.`;
  return { settings: parsed, raw };
}

/** The hooks object and the array for an event, or a refusal when the file has them in a shape Claude Code would not read either. */
function hooksOf(settings: Json, path: string): Json | string {
  const h = settings["hooks"];
  if (h === undefined) return {};
  return isObject(h) ? h : `Prosegate: "hooks" in ${path} is not an object, so nothing was changed.`;
}

function isOurs(hook: unknown): boolean {
  return isObject(hook) && typeof hook["command"] === "string" && OURS.test(hook["command"]);
}

/** Adds (or updates in place) or removes our three entries. Returns the new settings and whether anything changed. */
function merge(settings: Json, path: string, commands: Record<HookEvent, string> | null): { settings: Json; changed: boolean } | string {
  const hooks = hooksOf(settings, path);
  if (typeof hooks === "string") return hooks;
  const next: Json = { ...hooks };
  const dropped = new Set<string>();
  let changed = false;
  for (const event of EVENTS) {
    const current = next[event];
    if (current !== undefined && !Array.isArray(current)) return `Prosegate: hooks.${event} in ${path} is not a list, so nothing was changed.`;
    const groups: unknown[] = Array.isArray(current) ? current.map((g) => (isObject(g) && Array.isArray(g["hooks"]) ? { ...g, hooks: [...(g["hooks"] as unknown[])] } : g)) : [];
    const want = commands === null ? null : { type: "command", command: commands[event], timeout: HOOK_TIMEOUT_S };
    let found = false;
    const emptied = new Set<unknown>();
    for (let gi = 0; gi < groups.length; gi++) {
      const g = groups[gi];
      if (!isObject(g) || !Array.isArray(g["hooks"])) continue;
      const list = g["hooks"] as unknown[];
      for (let hi = list.length - 1; hi >= 0; hi--) {
        if (!isOurs(list[hi])) continue;
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

function serialise(settings: Json, raw: string | null): string {
  const indent = raw === null ? "  " : (/^([ \t]+)"/m.exec(raw)?.[1] ?? "  ");
  const text = `${JSON.stringify(settings, null, indent)}\n`;
  return raw?.includes("\r\n") === true ? text.replace(/\n/g, "\r\n") : text;
}

function backupName(path: string, now: number): string {
  return `${path}.prosegate-backup-${new Date(now).toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z")}`;
}

/** Writes the merged settings, with a backup of the old file first. Returns the backup path, if one was made. */
function save(path: string, loaded: Loaded, settings: Json, ctx: Ctx): string | null {
  mkdirSync(dirname(path), { recursive: true });
  let backup: string | null = null;
  if (loaded.raw !== null && loaded.raw.trim() !== "") {
    backup = backupName(path, ctx.now());
    writeFileAtomic(backup, loaded.raw);
  }
  writeFileAtomic(path, serialise(settings, loaded.raw));
  return backup;
}

// TODO(Phase 5): register `prosegate mcp` as a stdio server with `claude mcp add --scope user` (S1); nothing is registered now.

/** Runs the registered SessionStart command the way Claude Code does (through a shell) and checks that it answers. */
/** The check uses the homes init was given: the Prosegate home it cleans up afterwards is the one the hook writes to (incident 2026-10-18). */
export function roundTripEnv(ctx: Ctx, claudeDir: string | null, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const given = Object.fromEntries(Object.entries(ctx.env).filter((e): e is [string, string] => e[1] !== undefined));
  return { ...base, ...given, PROSEGATE_HOME: ctx.home, ...(claudeDir === null ? {} : { PROSEGATE_CLAUDE_HOME: claudeDir }) };
}

function roundTrip(command: string, ctx: Ctx, claudeDir: string | null): string | null {
  const r = spawnSync(command, {
    shell: true,
    input: JSON.stringify({ session_id: SYNTHETIC_SESSION, cwd: ctx.cwd, hook_event_name: "SessionStart", source: "startup" }),
    encoding: "utf8",
    timeout: 20_000,
    windowsHide: true,
    env: roundTripEnv(ctx, claudeDir),
  });
  try {
    removeTree(join(ctx.home, SESSIONS_DIR, SYNTHETIC_SESSION));
  } catch {
    // The synthetic session is swept with the others after a week.
  }
  if (r.error !== undefined) return `the command did not run (${(r.error as NodeJS.ErrnoException).code ?? "error"})`;
  if (r.status !== 0) return `the command exited with ${String(r.status)}`;
  try {
    // The whole of stdout, not its last line: Claude Code reads JSON only when stdout starts with it.
    const out = JSON.parse(r.stdout.trim()) as { hookSpecificOutput?: { additionalContext?: unknown } };
    return typeof out.hookSpecificOutput?.additionalContext === "string" ? null : "it ran but gave no answer; see the log";
  } catch {
    return r.stdout.trim() === "" ? "it ran but printed nothing; see the log" : "it printed text where JSON was expected (does your shell profile print something?)";
  }
}

const done = (out: string[]): InitResult => ({ code: 0, out: `${out.join("\n")}\n`, err: "" });
const refuse = (err: string): InitResult => ({ code: 1, out: "", err: `${err}\n` });

export function runInit(args: readonly string[], ctx: Ctx): InitResult {
  const o = parseArgs(args, true);
  if (typeof o === "string") return refuse(o);
  const target = settingsTarget(ctx, o.scope);
  if (typeof target === "string") return refuse(target);
  const { path } = target;
  const loaded = load(path);
  if (typeof loaded === "string") return refuse(loaded);
  const shim = shimPath();
  if (!existsSync(shim)) return refuse(`Prosegate: the hook script is missing from this install (${shim}). Reinstall the package, then run this again.`);
  const commands = Object.fromEntries(EVENTS.map((e) => [e, commandFor(e, shim, o.headless)])) as Record<HookEvent, string>;
  const merged = merge(loaded.settings, path, commands);
  if (typeof merged === "string") return refuse(merged);
  const backup = merged.changed ? save(path, loaded, merged.settings, ctx) : null;

  const problem = roundTrip(commands.SessionStart, ctx, target.claudeDir);
  if (problem !== null) {
    return refuse(`Prosegate: the hooks are in ${path}, but the check failed: ${problem}. Claude Code will ignore Prosegate until this is fixed. Details: ${logPathFor(ctx)}`);
  }
  const where = o.scope === "project" ? ".claude/settings.json (this project only)" : path;
  const lines = [
    merged.changed ? `Prosegate hooks installed for Claude Code in ${where}, and a test session ran cleanly.` : `Prosegate hooks were already installed in ${where}; nothing changed, and a test session ran cleanly.`,
  ];
  if (!o.local) lines.push("Sign-in is not available in this build yet; installed in local mode.");
  lines.push("Claude Code starts the hooks only after you accept its workspace-trust prompt for a folder, so open a new session there.");
  lines.push("To pause revisions in a session, run prosegate advisory in a separate terminal. To remove the hooks, run prosegate uninit.");
  if (backup !== null) lines.push(`Your previous settings were saved as ${basename(backup)}.`);
  // npm may clear npx's cache, which would leave the hooks pointing at nothing (they then fail open, silently), and the commands above need a PATH entry.
  if (shim.includes(`${sep}_npx${sep}`)) lines.push("You ran this through npx. For a permanent install, and for the commands above, run npm install -g prosegate and then this again.");
  return done(lines);
}

export function runUninit(args: readonly string[], ctx: Ctx): InitResult {
  const o = parseArgs(args, false);
  if (typeof o === "string") return refuse(o.replace(INIT_USAGE, "usage: prosegate uninit [--scope project|user]"));
  const target = settingsTarget(ctx, o.scope);
  if (typeof target === "string") return refuse(target);
  const { path } = target;
  const loaded = load(path);
  if (typeof loaded === "string") return refuse(loaded);
  const merged = merge(loaded.settings, path, null);
  if (typeof merged === "string") return refuse(merged);
  if (!merged.changed) return done([`No Prosegate hooks found in ${path}; nothing changed.`]);
  const backup = save(path, loaded, merged.settings, ctx);
  return done([`Prosegate hooks removed from ${path}.`, ...(backup === null ? [] : [`Your previous settings were saved as ${basename(backup)}.`])]);
}
