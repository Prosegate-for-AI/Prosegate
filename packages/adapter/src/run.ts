import type { ZodType } from "zod";
import { COMMAND_NAMES, runCommand } from "./commands.js";
import { createCtx, type Ctx } from "./ctx.js";
import { describeError, log } from "./log.js";
import { sessionStart, turnEnd, turnStart, type HandlerOutcome } from "./hooks.js";
import { SessionStartInputSchema, TurnEndInputSchema, TurnStartInputSchema } from "./schemas.js";
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

const USAGE = `usage: prosegate <command>

hooks (read one JSON object on stdin, write one on stdout; a harness shim calls these):
  session-start | turn-start | turn-end

commands (act on the session in this directory, or PROSEGATE_SESSION):
  advisory           show findings, never continue the model, until the session ends
  enforce            restore enforcement
  quiet              keep enforcing, hide the notices
  off                review nothing for this session
  profile <id>       use another profile from the next turn
  reload             re-read profiles and rule packs
  rule off <id>      switch one rule off in a local overlay of the active profile
  rule on <id>       switch it on again
  rule list          list the rules switched off locally
  status             show mode, profile and the rules switched off locally

  --version          print the version
  --help             show this help
  init               set up a harness (not available in this build yet)

advisory, off, quiet and rule off refuse when an agent runs them; run them yourself in a
terminal. Claude Code's ! shell escape counts as the agent, so use a separate terminal.
Add --debug (or PROSEGATE_DEBUG=1) to a hook to write the turn text to the session's debug directory.
`;

/** Time a hook waits for its stdin before failing open. */
export const STDIN_TIMEOUT_MS = 5000;

const HOOKS = {
  "session-start": { schema: SessionStartInputSchema, handler: sessionStart },
  "turn-start": { schema: TurnStartInputSchema, handler: turnStart },
  "turn-end": { schema: TurnEndInputSchema, handler: turnEnd },
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

/**
 * Runs one hook. Any error (malformed input, a bug, a full disk) is caught here: one line on
 * stderr, a log entry without text, exit 1. The shim treats exit 1 as allow (05 "fail open"), so
 * the adapter never holds a turn hostage to its own bug.
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
    const what = describeError(error);
    log(ctx, "error", "adapter_error", `${name} failed: ${what}`);
    io.stderr.write(`prosegate: ${name} failed (${what.split(" ")[0] ?? "Error"}); failing open.\n`);
    return 1;
  }
}

/** CLI body, free of process globals so it is testable. Returns the exit code. */
export async function run(argv: readonly string[], io: RunIO): Promise<number> {
  const args = argv.filter((a) => a !== "--debug");
  const debugFlag = args.length !== argv.length;
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
    case "init":
      io.stderr.write("prosegate init is not available in this build yet.\n");
      return 1;
  }
  const base = io.ctx ?? createCtx();
  const ctx: Ctx = debugFlag ? { ...base, debug: true } : base;
  if (isHook(first)) return runHook(first, io, ctx);
  if ((COMMAND_NAMES as readonly string[]).includes(first)) {
    try {
      const r = runCommand(args, ctx);
      if (r.out !== "") io.stdout.write(r.out);
      if (r.err !== "") io.stderr.write(r.err);
      return r.code;
    } catch (error) {
      const what = describeError(error);
      log(ctx, "error", "adapter_error", `${first} failed: ${what}`);
      io.stderr.write(`prosegate: ${first} failed (${what.split(" ")[0] ?? "Error"}).\n`);
      return 1;
    }
  }
  io.stderr.write(`prosegate: unknown command "${first.slice(0, 40).replace(/[^\x20-\x7e]/g, "?")}". Run prosegate --help.\n`);
  return 1;
}
