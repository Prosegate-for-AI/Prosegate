#!/usr/bin/env node
// Stable launcher: bounded fail-open hooks (ADR-33), or a long-lived MCP stream (ADR-36).
import { clearTimeout, setTimeout } from "node:timers";
import { performance } from "node:perf_hooks";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const APP = dirname(fileURLToPath(import.meta.url));
const HOME = dirname(APP);
process.env.PROSEGATE_HOME = HOME; // the hooks use the home they were installed under
const [event, ...flags] = process.argv.slice(2);
if (event === "mcp") {
  // MCP is a long-lived stream, so it must not use the hook's stdout guard or watchdog.
  try {
    const version = readFileSync(join(APP, "current"), "utf8").trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(version)) throw new Error("invalid version");
    await import(pathToFileURL(join(APP, version, "dist", "prosegate.mjs")).href);
  } catch {
    const message = 'Prosegate: MCP failed; run "prosegate init --harness claude-code" again.';
    process.stderr.write(message + "\n");
    process.exitCode = 1;
  }
} else {
const LOG = join(HOME, "logs", `${new Date().toISOString().slice(0, 10)}.log`);
const MISSING = 'its files are missing; run "npx prosegate init" again';
// One JSON reply via fd 1; mute stdout helpers. Raw dependency fd writes remain D-29.
process.stdout.write = () => true;
let [answered, problem, sid] = [false, null, null]; // answered: one JSON object only
function reply(text) {
  if (answered) return;
  answered = true;
  const buf = Buffer.from(text);
  for (let off = 0, spins = 0; off < buf.length;) {
    try { off += writeSync(1, buf, off); } catch (error) {
      if (error.code !== "EAGAIN" || ++spins > 2000) throw error;
    }
  }
}
function log(code, detail) {
  try {
    mkdirSync(dirname(LOG), { recursive: true });
    const line = String(detail).trim().replace(/[^\x20-\x7e]/g, "?").slice(0, 400);
    appendFileSync(LOG, `${new Date().toISOString()} error shim_${code} ${line}\n`);
  } catch { /* logging never fails a hook */ }
}
/** True the first time this session has this reason (a file per session, one reason per line). */
function firstTime() {
  const id = createHash("sha256").update(sid ?? "unknown-session").digest("hex").slice(0, 16);
  const file = join(HOME, "notices", id);
  let seen = "";
  try { seen = readFileSync(file, "utf8"); } catch { /* none yet */ }
  if (seen.split("\n").includes(problem.why)) return false;
  try {
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, `${problem.why}\n`, { mode: 0o600 });
  } catch { /* shown again next time */ }
  return true;
}
// Prompt only logs; startup may show but never spends a notice; Stop dedupes per session.
function unreviewed() {
  try {
    if (answered || !problem || event === "UserPromptSubmit") return;
    if (event === "Stop" && !firstTime()) return;
    const stop = event === "Stop";
    const what = stop ? "this turn was not reviewed" : "this session may not be reviewed";
    const where = problem.where ?? LOG;
    const message = `Prosegate · ${what} (${problem.why}) · details: ${where}`;
    reply(`${JSON.stringify({ systemMessage: message })}\n`);
  } catch (error) { log("notice", error && error.message); }
}

const giveUp = (code, detail, why = "internal error") => {
  log(code, detail);
  problem ||= { why, where: LOG };
  unreviewed();
  setTimeout(() => process.exit(0), 100);
};

async function main() {
  let raw = "";
  try {
    process.stdin.setEncoding("utf8");
    for await (const chunk of process.stdin) raw += chunk;
  } catch { /* handled as unreadable input */ }
  // Read first, so a failure is deduped per session, never machine-wide.
  try {
    const id = JSON.parse(raw).session_id;
    if (typeof id === "string") sid = id;
  } catch { /* no session id */ }
  const pin = flags.find((f) => f.startsWith("--use=")); // init pins a version for its self-check
  let version = pin?.slice(6) ?? "";
  if (version === "") {
    try { version = readFileSync(join(APP, "current"), "utf8").trim(); } catch { /* missing */ }
  }
  const base = join(APP, version);
  const files = ["shims/claude-code/hook.mjs", "dist/prosegate.mjs"];
  const safe = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(version); // not "." or "..", no separator
  if (!safe || !files.every((f) => existsSync(join(base, f)))) {
    problem = { why: MISSING, where: LOG };
    return log("missing", `version "${version.slice(0, 40)}" not found under ${APP}`);
  }
  const shim = await import(pathToFileURL(join(base, files[0])).href);
  const r = await shim.handle({ event, raw });
  sid = r.sid ?? sid;
  if (r.stderr) process.stderr.write(r.stderr); // the one-line CI summary (09), or debug notes
  if (r.problem) {
    problem = { why: r.problem.why, where: r.problem.where };
    log("failed", r.problem.detail);
  } else if (r.json) reply(`${JSON.stringify(r.json)}\n`);
  else if (r.text) reply(r.text);
}

// Inside Claude's 10 s; also holds unsettled promises alive. Cannot stop synchronous loops (D-29).
const left = Math.max(0, 7500 - performance.now());
const late = () => giveUp("timeout", `${event} over 7.5 s`, "it took too long");
const watchdog = setTimeout(late, left);
for (const signal of ["uncaughtException", "unhandledRejection"]) {
  process.on(signal, (e) => giveUp(signal, e && e.message));
}
try { await main(); } catch (error) {
  problem = { why: "internal error", where: LOG };
  log("error", error && error.message);
}
clearTimeout(watchdog);
unreviewed();
}
