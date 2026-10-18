// Prosegate shim for Claude Code (05): the mapping only; the launcher (launcher.mjs) reads the input, calls handle() and does the output,
// the watchdog and the fail-open line. The adapter bundle is imported, not spawned: a second Node costs a whole process start per hook.
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ADAPTER = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "dist", "prosegate.mjs");
let mod = null; // the adapter bundle, once imported

export const writeAtomic = (file, text) => (mod?.writeFileAtomic ?? writeFileSync)(file, text);

function mode(env, flags) {
  const m = (env.PROSEGATE_MODE || "").trim().toLowerCase();
  const ci = env.CI !== undefined && env.CI !== "" && !/^(0|false)$/i.test(env.CI);
  return m === "headless" || flags.includes("--headless") || (m !== "interactive" && ci) ? "headless" : "interactive";
}

/** Runs one adapter command in this process: { out, stderr }, or a `problem` for the launcher to log and show. The payload stays in memory, never on argv (ADR-14). */
async function call(command, payload) {
  let stdout = "";
  let stderr = "";
  const bad = (detail, why) => ({ problem: { why: why ?? /failed: ([^)]+)\)/.exec(stderr)?.[1] ?? "internal error", where: /Details: (.+?)\s*$/m.exec(stderr)?.[1] ?? null, detail: `${command}: ${detail}` } });
  try {
    globalThis.__prosegateEmbedded = true; // the bundle then exports `run` instead of running the command line
    mod ??= await import(pathToFileURL(ADAPTER).href);
    const io = { stdin: async () => JSON.stringify(typeof payload === "function" ? payload(mod) : payload), stdout: { write: (s) => { stdout += s; } }, stderr: { write: (s) => { stderr += s; } } };
    const code = await mod.run([command], io);
    if (code !== 0) return bad(`exit ${code}: ${stderr}`);
  } catch (error) {
    // Only the bundle itself missing means "its files are missing"; a missing dependency inside it is an internal error.
    const gone = error && error.code === "ERR_MODULE_NOT_FOUND" && /Cannot find module .*prosegate\.mjs/.test(String(error.message));
    return bad(`${error && error.code ? error.code : "error"}: ${error && error.message}`, gone ? 'its files are missing; run "npx prosegate init" again' : undefined);
  }
  try { return { out: JSON.parse(stdout), stderr }; } catch { return bad("the adapter's output was not JSON"); }
}

/** Maps one hook event to the adapter and back: { json } or { text } for stdout, { stderr }, or { problem }. */
export async function handle({ event, flags = [], raw, env = process.env }) {
  let input = null;
  try { input = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw); } catch { /* reported below */ }
  if (!input || typeof input.session_id !== "string") return { problem: { why: "invalid hook input", where: null, detail: "hook input was not JSON with a session_id" } };
  const sid = input.session_id;
  const turnId = typeof input.prompt_id === "string" && input.prompt_id !== "" ? { turn_id: input.prompt_id } : {};
  const fold = (n) => (mod?.foldClaudeNotice ? mod.foldClaudeNotice(n) : n);
  const text = (v) => (typeof v === "string" && v !== "" ? v : null);
  const done = (r, fn) => (r.problem ? { sid, problem: r.problem } : { sid, stderr: r.stderr, ...fn(r.out) });
  if (event === "SessionStart") {
    const source = ["startup", "resume", "clear", "compact", "fork"].includes(input.source) ? { source: input.source } : {};
    const start = { harness: "claude-code", session_id: sid, cwd: input.cwd || process.cwd(), mode: mode(env, flags), ...source };
    return done(await call("session-start", start), (o) => {
      const [inject, notice] = [text(o.inject), text(o.notice)];
      return inject || notice ? { json: { ...(inject ? { hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: inject } } : {}), ...(notice ? { systemMessage: fold(notice) } : {}) } } : {};
    });
  }
  if (event === "UserPromptSubmit") {
    const r = await call("turn-start", { session_id: sid, ...turnId, user_message: String(input.prompt ?? ""), tool_calls_so_far: [] });
    return done(r, (o) => (text(o.inject) ? { text: `${o.inject}\n` } : {}));
  }
  if (event !== "Stop") return { sid };
  const tools = (m) => (typeof input.transcript_path === "string" ? (m.toolNames?.(input.transcript_path, input.prompt_id) ?? []) : []);
  const r = await call("turn-end", (m) => ({ session_id: sid, ...turnId, assistant_text: String(input.last_assistant_message ?? ""), tool_calls: tools(m), continuation: input.stop_hook_active === true, continue_supported: true }));
  // ADR-11, ADR-13: a continuation carries feedback_text only, because Claude Code shows it to the user; no systemMessage beside it.
  return done(r, (o) => {
    if (o.decision === "continue") {
      if (!text(o.feedback_text)) throw new Error("continue with an empty feedback_text");
      return { json: { hookSpecificOutput: { hookEventName: "Stop", additionalContext: o.feedback_text } } };
    }
    return text(o.notice) ? { json: { systemMessage: fold(o.notice) } } : {};
  });
}
