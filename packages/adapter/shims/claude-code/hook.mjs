#!/usr/bin/env node
// Prosegate shim for Claude Code (05 "Claude Code reference mapping"). Glue only: it maps one hook event onto the
// adapter's session-start / turn-start / turn-end and prints what Claude Code reads. It fails open everywhere:
// on any error it prints nothing, exits 0 and logs to ~/.prosegate/logs/. The adapter runs in this process
// (the shim imports its bundle) because a spawned second Node costs a whole extra process start on every hook.
// Usage (registered by `prosegate init`): node hook.mjs <SessionStart|UserPromptSubmit|Stop> [--headless]
import { clearTimeout, setTimeout } from "node:timers";
import { appendFileSync, closeSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ADAPTER = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "dist", "prosegate.mjs");
const [event, ...flags] = process.argv.slice(2);
const env = process.env;
const TRANSCRIPT_TAIL = 4 * 1024 * 1024;
// Only this shim writes to stdout, which Claude Code reads as JSON: a banner or a library that tries is dropped.
const emit = process.stdout.write.bind(process.stdout);
process.stdout.write = () => true;

const HOME = env.PROSEGATE_HOME || join(homedir(), ".prosegate");
const LOG = join(HOME, "logs", `${new Date().toISOString().slice(0, 10)}.log`);

/** One log line, ASCII only and capped: the adapter's stderr names files, never prose. */
function log(code, detail) {
  try {
    mkdirSync(dirname(LOG), { recursive: true });
    appendFileSync(LOG, `${new Date().toISOString()} error shim_${code} ${String(detail).trim().replace(/[^\x20-\x7e]/g, "?").slice(0, 400)}\n`);
  } catch { /* logging never fails a hook */ }
  return null;
}

/** Why the adapter gave no answer, taken from its own stderr line (`... (turn-end failed: <why>); ... Details: <log>`), for the one visible line (N14). */
let problem = null;
let sid = null;
function failed(command, err, detail, why) {
  problem = { why: why ?? /failed: ([^)]+)\)/.exec(err)?.[1] ?? "internal error", where: /Details: (.+?)\s*$/m.exec(err)?.[1] ?? LOG };
  return log(`${command}_failed`, detail);
}

/** A silent permanent fail-open is invisible, so say so: once per session and reason, remembered in a small file of the shim's own. */
function unreviewed(done) {
  const file = join(HOME, "shim-notices.json");
  let seen = {};
  try { seen = JSON.parse(readFileSync(file, "utf8")); } catch { /* first time */ }
  if (!problem || !sid || (seen[sid] ||= []).includes(problem.why)) return done?.();
  seen[sid].push(problem.why);
  try { writeFileSync(file, JSON.stringify(Object.fromEntries(Object.entries(seen).slice(-50)))); } catch { /* shown again next time */ }
  const what = event === "Stop" ? "this turn was not reviewed" : "this session may not be reviewed";
  emit(`${JSON.stringify({ systemMessage: `Prosegate · ${what} (${problem.why}) · details: ${problem.where}` })}\n`, done);
}

/** `headless` when CI or PROSEGATE_MODE says so, or init registered --headless (05); otherwise `interactive`. */
function mode() {
  const m = (env.PROSEGATE_MODE || "").trim().toLowerCase();
  const ci = env.CI !== undefined && env.CI !== "" && !/^(0|false)$/i.test(env.CI);
  return m === "headless" || flags.includes("--headless") || (m !== "interactive" && ci) ? "headless" : "interactive";
}

/** Runs one adapter command in this process; null on any failure. The payload stays in memory, never on argv (ADR-14). */
async function call(command, payload) {
  let out = "";
  let err = "";
  try {
    globalThis.__prosegateEmbedded = true; // the bundle then exports `run` instead of running the command line
    const { run } = await import(pathToFileURL(ADAPTER).href);
    const code = await run([command], { stdin: async () => JSON.stringify(payload), stdout: { write: (s) => { out += s; } }, stderr: { write: (s) => { err += s; } } });
    if (code !== 0) return failed(command, err, `exit ${code}: ${err}`);
  } catch (error) {
    return failed(command, "", `${error && error.code ? error.code : "error"}: ${error && error.message}`, error && error.code === "ERR_MODULE_NOT_FOUND" ? "the Prosegate files are missing" : undefined);
  }
  try {
    return { out: JSON.parse(out), stderr: err };
  } catch {
    return failed(command, "", "the adapter's output was not JSON");
  }
}

/** A line that starts a turn: a user message with text, not a tool result, not a sub-agent's (07 threat 6 reads only this turn). */
function isPrompt(line) {
  if (line.type !== "user" || line.isSidechain || line.isMeta) return false;
  const c = line.message && line.message.content;
  return typeof c === "string" || (Array.isArray(c) && c.some((b) => b && b.type === "text"));
}

/** Tool names used since this turn's user prompt, best effort: the file lags at Stop and its last line may be partial. */
function toolNames(path, promptId) {
  try {
    const fd = openSync(path, "r");
    try {
      const size = fstatSync(fd).size;
      const start = Math.max(0, size - TRANSCRIPT_TAIL);
      const buf = Buffer.alloc(size - start);
      readSync(fd, buf, 0, buf.length, start);
      const lines = buf.toString("utf8").split("\n");
      if (start > 0) lines.shift();
      const parsed = lines.flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });
      // The last prompt line; if the file names its prompts it must be this turn's, or a file that lags would hand back an earlier turn.
      const turn = parsed.findLastIndex(isPrompt);
      if (turn === -1 || (promptId && parsed[turn].promptId && parsed[turn].promptId !== promptId)) return [];
      return parsed.slice(turn + 1).filter((l) => l.type === "assistant" && !l.isSidechain)
        .flatMap((l) => (Array.isArray(l.message && l.message.content) ? l.message.content : []))
        .filter((b) => b && b.type === "tool_use" && typeof b.name === "string").map((b) => b.name.slice(0, 300));
    } finally { closeSync(fd); }
  } catch { return []; }
}

async function main() {
  let input;
  try { const raw = readFileSync(0, "utf8"); input = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw); } catch { return log("stdin_unreadable", "hook input was not JSON"); }
  if (!input || typeof input.session_id !== "string") return log("stdin_unreadable", "hook input had no session_id");
  sid = input.session_id;
  const reply = (obj) => emit(`${JSON.stringify(obj)}\n`);
  if (event === "SessionStart") {
    const source = ["startup", "resume", "clear", "compact", "fork"].includes(input.source) ? { source: input.source } : {};
    const r = await call("session-start", { harness: "claude-code", session_id: input.session_id, cwd: input.cwd || process.cwd(), mode: mode(), ...source });
    if (!r) return;
    const { inject, notice } = r.out;
    const out = { ...(inject ? { hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: inject } } : {}), ...(notice ? { systemMessage: notice } : {}) };
    if (Object.keys(out).length > 0) reply(out);
  } else if (event === "UserPromptSubmit") {
    const r = await call("turn-start", { session_id: input.session_id, user_message: String(input.prompt ?? ""), tool_calls_so_far: [] });
    if (r && r.out.inject) emit(`${r.out.inject}\n`);
  } else if (event === "Stop") {
    const turnId = typeof input.prompt_id === "string" && input.prompt_id !== "" ? { turn_id: input.prompt_id } : {};
    const r = await call("turn-end", {
      session_id: input.session_id, ...turnId, assistant_text: String(input.last_assistant_message ?? ""),
      tool_calls: typeof input.transcript_path === "string" ? toolNames(input.transcript_path, input.prompt_id) : [],
      continuation: input.stop_hook_active === true, continue_supported: true,
    });
    if (!r) return;
    if (r.stderr) process.stderr.write(r.stderr); // the headless one-line summary (09), or --debug notes
    // ADR-11, ADR-13: a continuation carries feedback_text only, because Claude Code shows it to the user; no systemMessage beside it.
    if (r.out.decision === "continue") reply({ hookSpecificOutput: { hookEventName: "Stop", additionalContext: r.out.feedback_text } });
    else if (r.out.notice) reply({ systemMessage: r.out.notice });
  }
}

// Exit code 0 always, whatever happens. The timer keeps the process alive until it fires (a promise that never settles would
// otherwise end the process with code 13) and sits under the 10 s Stop timeout that init registers; no process.exit() on the
// normal path, because stdout to a pipe can be asynchronous.
const giveUp = (why, detail) => { log(why, detail); problem ||= { why: "internal error", where: LOG }; unreviewed(() => process.exit(0)); setTimeout(() => process.exit(0), 500); };
const watchdog = setTimeout(() => { problem = { why: "it took too long", where: LOG }; giveUp("timeout", `${event} took longer than 9 s`); }, 9000);
for (const signal of ["uncaughtException", "unhandledRejection"]) process.on(signal, (e) => giveUp(signal, e && e.message));
try { await main(); } catch (error) { log("error", error && error.message); }
clearTimeout(watchdog);
unreviewed();
