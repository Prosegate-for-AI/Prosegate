import { run } from "./run.js";

const MAX_STDIN_BYTES = 12 * 1024 * 1024;

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const buf = typeof chunk === "string" ? Buffer.from(chunk) : (chunk as Buffer);
    size += buf.length;
    if (size > MAX_STDIN_BYTES) throw new Error("stdin too large");
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString("utf8");
}

// A last line of defence behind run()'s own catch: an exception that escapes it is still a
// fail-open exit 1 with one line on stderr, not a stack trace (05 "fail open").
function failOpen(kind: string): void {
  process.stderr.write(`prosegate: internal error (${kind}); failing open.\n`);
  process.exit(1);
}
process.on("uncaughtException", () => failOpen("uncaught exception"));
process.on("unhandledRejection", () => failOpen("unhandled rejection"));

const code = await run(process.argv.slice(2), { stdin: readStdin, stdout: process.stdout, stderr: process.stderr });
process.exitCode = code;
// stdin may still be open if a hook gave up waiting for it; do not let it keep the process alive.
process.stdin.destroy();
