// A fake Claude Code for the golden tests (plan section 10). It lays out an installed package in a temp
// directory (dist/prosegate.mjs next to shims/claude-code/hook.mjs), then feeds the shim the exact JSON Claude
// Code sends for each hook event, one fresh process per call, and reads back what Claude Code would read:
// stdout, stderr and the exit code. Nothing here touches the real ~/.claude or ~/.prosegate.

import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { buildBundle, cleanEnv, pg, tmpDir, ADAPTER_DIR, type Proc } from "../helpers.js";

export const SHIM_SOURCE = join(ADAPTER_DIR, "shims", "claude-code", "hook.mjs");

export interface Pkg {
  dir: string;
  bundle: string;
  shim: string;
}

/** An installed package layout around `bundleFile` (the shim finds the adapter at ../../dist/prosegate.mjs). */
export function layoutPkg(bundleFile: string | null, dirName = "node_modules-prosegate", shimSource = SHIM_SOURCE): Pkg {
  const dir = join(tmpDir("pg-pkg-"), dirName);
  const bundle = join(dir, "dist", "prosegate.mjs");
  const shim = join(dir, "shims", "claude-code", "hook.mjs");
  mkdirSync(dirname(bundle), { recursive: true });
  mkdirSync(dirname(shim), { recursive: true });
  if (bundleFile !== null) copyFileSync(bundleFile, bundle);
  copyFileSync(shimSource, shim);
  return { dir, bundle, shim };
}

export async function releasePkg(): Promise<Pkg> {
  return layoutPkg(await buildBundle("release"));
}

export async function testPkg(): Promise<Pkg> {
  return layoutPkg(await buildBundle("test"));
}

/** A stand-in adapter bundle: a script body that runs where dist/prosegate.mjs would. */
export function stubPkg(body: string): Pkg {
  const pkg = layoutPkg(null);
  writeFileSync(pkg.bundle, body);
  return pkg;
}

/** The environment of every fake-Claude-Code child: agent markers and real homes scrubbed, temp homes set (helpers.ts). */
export { cleanEnv };

export const SESSION = "5d1b8a52-2f0e-4c3e-9a77-0b1e7f3c9a10";
export const PROMPT_ID = "c0ffee00-1111-4222-8333-444455556666";

export interface HookRun extends Proc {
  /** stdout parsed as one JSON object, or null when stdout was empty. */
  json: Record<string, unknown> | null;
}

/** stdout as one JSON object, or null when it is empty or plain text (a UserPromptSubmit inject is plain text). */
function parsed(stdout: string): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(stdout);
    return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export class FakeClaudeCode {
  readonly pkg: Pkg;
  readonly home: string;
  readonly cwd: string;
  readonly transcript: string;
  env: Record<string, string | undefined>;
  sessionId: string;

  constructor(pkg: Pkg, opts: { home?: string; env?: Record<string, string | undefined>; sessionId?: string; cwd?: string } = {}) {
    this.pkg = pkg;
    this.home = opts.home ?? join(tmpDir("pg-home-"), ".prosegate");
    this.cwd = opts.cwd ?? tmpDir("pg-proj-");
    this.transcript = join(tmpDir("pg-transcript-"), "t.jsonl");
    this.env = opts.env ?? {};
    this.sessionId = opts.sessionId ?? SESSION;
  }

  private common(event: string): Record<string, unknown> {
    return { session_id: this.sessionId, transcript_path: this.transcript, cwd: this.cwd, hook_event_name: event };
  }

  /** The shim as Claude Code runs it: `node <shim> <Event>`, JSON on stdin, a fresh process each time. */
  hook(event: "SessionStart" | "UserPromptSubmit" | "Stop", fields: Record<string, unknown>, flags: string[] = []): HookRun {
    const r = spawnSync(process.execPath, [this.pkg.shim, event, ...flags], {
      input: JSON.stringify({ ...this.common(event), ...fields }),
      encoding: "utf8",
      env: cleanEnv(this.home, this.env),
      cwd: this.cwd,
      timeout: 60_000,
    });
    return { code: r.status, stdout: r.stdout, stderr: r.stderr, json: parsed(r.stdout) };
  }

  sessionStart(source = "startup", flags: string[] = []): HookRun {
    return this.hook("SessionStart", { source }, flags);
  }

  prompt(prompt: string, promptId = PROMPT_ID): HookRun {
    return this.hook("UserPromptSubmit", { prompt_id: promptId, permission_mode: "default", prompt });
  }

  stop(lastAssistantMessage: string, over: Record<string, unknown> = {}): HookRun {
    return this.hook("Stop", {
      prompt_id: PROMPT_ID,
      permission_mode: "default",
      stop_hook_active: false,
      last_assistant_message: lastAssistantMessage,
      background_tasks: [],
      session_crons: [],
      ...over,
    });
  }

  /** `prosegate <args>` as the user types it in a terminal (no agent marker), for the session in this project. */
  cli(args: string[], extraEnv: Record<string, string | undefined> = {}): Proc {
    return pg(this.pkg.bundle, args, { home: this.home, cwd: this.cwd, env: { PROSEGATE_SESSION: this.sessionId, ...this.env, ...extraEnv } });
  }
}
