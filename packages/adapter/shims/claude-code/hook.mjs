// Prosegate shim for Claude Code (05, ADR-34): imports the adapter bundle, not spawns it (a second
// Node costs a whole process start per hook), and hands the hook to its Claude Code mapping.
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const BUNDLE = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "dist", "prosegate.mjs");
const MISSING = 'its files are missing; run "npx prosegate init" again';

export async function handle({ event, raw, env = process.env }) {
  let mod;
  try {
    globalThis.__prosegateEmbedded = true; // the bundle then exports its functions, not the CLI
    mod = await import(pathToFileURL(BUNDLE).href);
  } catch (error) {
    // Only the bundle itself missing means "files missing"; a dependency inside it is a bug.
    const gone = error?.code === "ERR_MODULE_NOT_FOUND"
      && /Cannot find module .*prosegate\.mjs/.test(error.message);
    const detail = `${error?.code ?? "error"}: ${error?.message}`;
    return { problem: { why: gone ? MISSING : "internal error", where: null, detail } };
  }
  return mod.claudeCodeHook({ event, raw, env });
}
