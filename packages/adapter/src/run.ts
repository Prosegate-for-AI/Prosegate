import { join } from "node:path";
import type { ZodType } from "zod";
import { COMMAND_NAMES, runCommand } from "./commands.js";
import { createCtx, type Ctx } from "./ctx.js";
import { runInit, runUninit } from "./init.js";
import { describeError, log } from "./log.js";
import { sessionStart, turnEnd, turnStart, type HandlerOutcome } from "./hooks.js";
import { SessionStartInputSchema, TurnEndInputSchema, TurnStartInputSchema } from "./schemas.js";
import { recordErrorLockFree } from "./telemetry.js";
import { VERSION } from "./version.js";

export interface Writer {
  write(chunk: string): unknown;
}

export interface RunIO {
  /** Reads all of stdin. The caller bounds the wait. */
  stdin: () => Promise<string>;
  stdout: Writer;
  stderr: Writer;
  /** Defaults to createCtx() (the real process). */
  ctx?: Ctx;
}

/** Thrown when stdin is larger than the hard cap (12 MB, ADR-30). */
export class InputTooLargeError extends Error {
  override readonly name = "InputTooLargeError";
}

// At most 80 columns (UX S8).
const USAGE = `usage: prosegate <command>

Set up (once):
  init --harness claude-code [--scope project|user] [--local]
                   register the hooks in Claude Code (user scope by default)
  uninit [--scope project|user]
                   remove exactly what init added

Run these in your own terminal, in the directory your agent works in:
  status           show mode, profile and rules switched off
  advisory         show findings, never ask the model to revise (this session)
  quiet            keep revising, hide Prosegate's own notices (this session)
  off              review nothing (this session)
  enforce          undo advisory, quiet or off
  profile [<id>]   list profiles, or use another from the next turn
  rule off <id>    switch one rule off in every session
  rule on <id>     switch it back on
  rule list        list the rules switched off
  reload           re-read profiles and rule packs

advisory, quiet, off and rule off are refused when the agent runs them. In
Claude Code, a command typed after ! counts as the agent, so use a separate
terminal for those four. enforce and the rest work anywhere.

Environment: PROSEGATE_MODE=advisory|off (CI), PROSEGATE_SESSION=<id>
Hooks, called by the harness shim: session-start | turn-start | turn-end
Debug: add --debug to a hook to write that turn's text to the session
debug directory.  Also: --version, --help
`;

/** Time a hook waits for its stdin before failing open. */
export const STDIN_TIMEOUT_MS = 5000;

const HOOKS = {
  "session-start": { schema: SessionStartInputSchema, handler: sessionStart, what: "start Prosegate for this session" },
  "turn-start": { schema: TurnStartInputSchema, handler: turnStart, what: "prepare this turn" },
  "turn-end": { schema: TurnEndInputSchema, handler: turnEnd, what: "review this turn" },
} as const;
type HookName = keyof typeof HOOKS;

function isHook(name: string | undefined): name is HookName {
  return name !== undefined && Object.hasOwn(HOOKS, name);
}

async function readWithin(read: () => Promise<string>, ms: number): Promise<string> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("stdin timed out")), ms);
    timer.unref();
  });
  try {
    return await Promise.race([read(), timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** The failure in words, without a library class name (UX S9). */
function plainFailure(error: unknown): string {
  const name = typeof error === "object" && error !== null ? (error as { name?: unknown }).name : undefined;
  switch (name) {
    case "ZodError":
    case "SyntaxError":
      return "invalid hook input";
    case "InputTooLargeError":
      return "input too large";
    case "LockTimeoutError":
      return "Prosegate's files were busy";
    default:
      return typeof error === "object" && error !== null && (error as { message?: unknown }).message === "stdin timed out" ? "no input arrived" : "internal error";
  }
}

export function logPathFor(ctx: Ctx): string {
  return join(ctx.home, "logs", `${new Date(ctx.now()).toISOString().slice(0, 10)}.log`);
}

/**
 * Runs one hook. Any error (malformed input, a bug, a full disk) is caught here: one line on
 * stderr, a log entry without text, an `adapter_error` telemetry event appended without any lock (so a
 * planted lock cannot hide failures), exit 1. The shim treats exit 1 as allow (05 "fail open"), so the
 * adapter never holds a turn hostage to its own bug.
 */
async function runHook(name: HookName, io: RunIO, ctx: Ctx): Promise<number> {
  try {
    const raw = await readWithin(io.stdin, STDIN_TIMEOUT_MS);
    const entry = HOOKS[name];
    const input: unknown = (entry.schema as ZodType).parse(JSON.parse(raw.replace(/^\uFEFF/, "")));
    const handler = entry.handler as (i: unknown, c: Ctx) => HandlerOutcome<unknown>;
    const { output, stderr } = handler(input, ctx);
    io.stdout.write(`${JSON.stringify(output)}\n`);
    for (const line of stderr) io.stderr.write(`${line}\n`);
    return 0;
  } catch (error) {
    log(ctx, "error", "adapter_error", `${name} failed: ${describeError(error)}`);
    recordErrorLockFree(ctx, "adapter_error");
    const effect = name === "turn-end" ? "your reply was not held" : "nothing was blocked";
    io.stderr.write(`prosegate: could not ${HOOKS[name].what} (${name} failed: ${plainFailure(error)}); ${effect}. Details: ${logPathFor(ctx)}\n`);
    return 1;
  }
}

/** Removes `--session <id>` from the arguments and returns the id. */
function takeSessionFlag(args: string[]): { args: string[]; session: string | null } {
  const i = args.indexOf("--session");
  if (i === -1) return { args, session: null };
  const id = args[i + 1];
  return { args: [...args.slice(0, i), ...args.slice(i + 2)], session: id ?? "" };
}

/** CLI body, free of process globals so it is testable. Returns the exit code. */
export async function run(argv: readonly string[], io: RunIO): Promise<number> {
  const withoutDebug = argv.filter((a) => a !== "--debug");
  const debugFlag = withoutDebug.length !== argv.length;
  const { args, session } = takeSessionFlag(withoutDebug);
  const [first] = args;
  switch (first) {
    case undefined:
    case "--help":
    case "-h":
    case "help":
      io.stdout.write(USAGE);
      return 0;
    case "--version":
    case "-v":
      io.stdout.write(`${VERSION}\n`);
      return 0;
  }
  const base = io.ctx ?? createCtx();
  let ctx: Ctx = debugFlag ? { ...base, debug: true } : base;
  if (session !== null) ctx = { ...ctx, env: { ...ctx.env, PROSEGATE_SESSION: session } };
  if (first === "init" || first === "uninit") {
    try {
      const r = (first === "init" ? runInit : runUninit)(args.slice(1), ctx);
      if (r.out !== "") io.stdout.write(r.out);
      if (r.err !== "") io.stderr.write(r.err);
      return r.code;
    } catch (error) {
      log(ctx, "error", "adapter_error", `${first} failed: ${describeError(error)}`);
      io.stderr.write(`prosegate: ${first} failed (${plainFailure(error)}); nothing was changed that a backup does not cover. Details: ${logPathFor(ctx)}\n`);
      return 1;
    }
  }
  if (isHook(first)) return runHook(first, io, ctx);
  if ((COMMAND_NAMES as readonly string[]).includes(first)) {
    try {
      const r = runCommand(args, ctx);
      if (r.out !== "") io.stdout.write(r.out);
      if (r.err !== "") io.stderr.write(r.err);
      return r.code;
    } catch (error) {
      log(ctx, "error", "adapter_error", `${first} failed: ${describeError(error)}`);
      io.stderr.write(`prosegate: ${first} failed (${plainFailure(error)}). Details: ${logPathFor(ctx)}\n`);
      return 1;
    }
  }
  io.stderr.write(`prosegate: unknown command "${first.slice(0, 40).replace(/[^\x20-\x7e]/g, "?")}". Run prosegate --help.\n`);
  return 1;
}
