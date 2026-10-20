import { claudeCodeHook } from "./claude-code.js";
import { createCtx } from "./ctx.js";
import { log } from "./log.js";
import { InputTooLargeError, logPathFor, run } from "./run.js";
import { recordErrorLockFree } from "./telemetry.js";
import { keyWorker } from "./key-worker.js";
import { readSecret } from "./secret-input.js";

/**
 * The bundle is both the `prosegate` command and, for the Claude Code shim, a module that exports
 * `claudeCodeHook`: the shim imports it in its own process instead of spawning a second Node (a spawn
 * costs a whole extra process start on every hook). The shim sets this global before the import;
 * anything else that loads the file gets the command, so a failed detection can only ever leave the
 * command working.
 */
const embedded = (globalThis as { __prosegateEmbedded?: unknown }).__prosegateEmbedded === true;
export { run, claudeCodeHook };

/** The hard cap on what a hook reads (ADR-30): the engine bounds the review, this bounds the bytes. */
const MAX_STDIN_BYTES = 12 * 1024 * 1024;

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const buf = typeof chunk === "string" ? Buffer.from(chunk) : (chunk as Buffer);
    size += buf.length;
    if (size > MAX_STDIN_BYTES) throw new InputTooLargeError("stdin is larger than 12 MB");
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString("utf8");
}

// A last line of defence behind run()'s own catch: an exception that escapes it is still a fail-open
// exit 1 with one line on stderr, a log entry and an `adapter_error` event, not a stack trace (05 "fail open").
function failOpen(kind: string): void {
  let details = "";
  try {
    const ctx = createCtx();
    log(ctx, "error", "adapter_error", `an exception escaped: ${kind}`);
    recordErrorLockFree(ctx, "adapter_error");
    details = ` Details: ${logPathFor(ctx)}`;
  } catch {
    // nothing more can be recorded
  }
  process.stderr.write(`prosegate: could not finish (internal error); nothing was blocked.${details}\n`);
  process.exit(1);
}

if (!embedded && process.argv[2] === "--key-store-worker") {
  // Separate process: a synchronous native call cannot strand the parent hook/CLI.
  try {
    let input = "";
    for await (const chunk of process.stdin) {
      input += String(chunk);
      if (input.length > 4096) throw new Error("invalid input");
    }
    process.stdout.write(JSON.stringify(await keyWorker(input)));
  } catch { process.stdout.write(JSON.stringify({ ok: false, reason: "unavailable" })); }
} else if (!embedded) {
  process.on("uncaughtException", () => failOpen("uncaught exception"));
  process.on("unhandledRejection", () => failOpen("unhandled rejection"));

  const code = await run(process.argv.slice(2), { stdin: readStdin, secret: readSecret, stdout: process.stdout, stderr: process.stderr,
    streams: { stdin: process.stdin, stdout: process.stdout, stderr: process.stderr } });
  process.exitCode = code;
  // stdin may still be open if a hook gave up waiting for it; do not let it keep the process alive.
  process.stdin.destroy();
}
