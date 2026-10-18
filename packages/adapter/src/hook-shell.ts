// The shell Claude Code runs hook commands in (S1: Git Bash when present on Windows, else PowerShell; the user's shell on POSIX),
// the quoting that is literal in all of them, and a way to run a command the way Claude Code does. `init` registers a command
// written for this shell and checks it by running it here, so a quoting or shell-startup problem shows at install time.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { basename, delimiter, dirname, join } from "node:path";
import type { Ctx } from "./ctx.js";

export type ShellKind = "bash" | "powershell" | "sh";
export interface HookShell {
  kind: ShellKind;
  file: string;
  /** Arguments before the command string. Login shells, so a profile that prints text is found (it breaks hook JSON, S1). */
  args: string[];
}

function envOf(ctx: Ctx, name: string): string | undefined {
  const v = ctx.env[name] ?? process.env[name];
  return v === undefined || v === "" ? undefined : v;
}

/** Git for Windows' bash: the variable Claude Code honours, the usual install folders, then the bin folder beside git on PATH. */
function gitBash(ctx: Ctx): string | null {
  const candidates = [envOf(ctx, "CLAUDE_CODE_GIT_BASH_PATH")];
  for (const root of [envOf(ctx, "ProgramFiles"), envOf(ctx, "ProgramFiles(x86)"), envOf(ctx, "ProgramW6432")]) if (root !== undefined) candidates.push(join(root, "Git", "bin", "bash.exe"));
  for (const dir of (envOf(ctx, "PATH") ?? envOf(ctx, "Path") ?? "").split(delimiter)) {
    if (dir !== "" && existsSync(join(dir, "git.exe"))) candidates.push(join(dirname(dir), "bin", "bash.exe"));
  }
  return candidates.find((c): c is string => c !== undefined && existsSync(c)) ?? null;
}

/** PROSEGATE_HOOK_SHELL (bash | powershell | sh) overrides the detection, for a Claude Code that is set up differently. */
export function detectShell(ctx: Ctx): HookShell {
  const forced = envOf(ctx, "PROSEGATE_HOOK_SHELL");
  if (ctx.platform === "win32") {
    const bash = forced === "powershell" ? null : gitBash(ctx);
    if (bash !== null) return { kind: "bash", file: bash, args: ["-l", "-c"] };
    return { kind: "powershell", file: "powershell.exe", args: ["-NoLogo", "-Command"] };
  }
  const user = envOf(ctx, "SHELL");
  if (forced !== "sh" && user !== undefined && /^(bash|zsh)$/.test(basename(user)) && existsSync(user)) return { kind: "bash", file: user, args: ["-l", "-c"] };
  return { kind: "sh", file: "/bin/sh", args: ["-c"] };
}

/** Paths in a hook command use forward slashes: Git Bash, PowerShell and node all read them, and no backslash needs escaping. */
const slashes = (p: string): string => p.replace(/\\/g, "/");

/** A refusal for a path that cannot be single-quoted, else null. */
export function quoteProblem(...paths: string[]): string | null {
  const bad = paths.find((p) => p.includes("'") || /[\r\n]/.test(p));
  return bad === undefined ? null : `Prosegate: ${bad} contains a character a hook command cannot hold safely (a single quote or a line break). Install Node, or set PROSEGATE_HOME, in a path without one, then run this again.`;
}

/**
 * The command registered in Claude Code's settings: the Node that is running init (not whatever `node` is on PATH later) and the
 * launcher, each single-quoted, which is literal in bash, sh and PowerShell (`$` and backticks included); PowerShell needs `&`.
 */
export function hookCommand(shell: HookShell, nodePath: string, launcher: string, event: string): string {
  const call = `'${slashes(nodePath)}' '${slashes(launcher)}' ${event}`;
  return shell.kind === "powershell" ? `& ${call}` : call;
}

export interface ShellRun {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: NodeJS.ErrnoException;
}

/** Runs `command` through the shell, as Claude Code does, with `input` on stdin. */
export function runInShell(shell: HookShell, command: string, input: string, env: NodeJS.ProcessEnv, cwd?: string): ShellRun {
  const r = spawnSync(shell.file, [...shell.args, command], { input, encoding: "utf8", timeout: 20_000, windowsHide: true, env, ...(cwd === undefined ? {} : { cwd }) });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "", ...(r.error === undefined ? {} : { error: r.error as NodeJS.ErrnoException }) };
}
