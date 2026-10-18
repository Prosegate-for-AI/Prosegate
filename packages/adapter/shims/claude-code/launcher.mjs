#!/usr/bin/env node
// Prosegate launcher (ADR-33): the one file Claude Code's settings name (~/.prosegate/app/hook.mjs); it never changes between versions.
// It imports app/current's shim and writes its answer, and owns what must work when the shim cannot: exit 0 always, a 7.5 s
// watchdog, one JSON object on stdout, and the visible line when a turn was not reviewed.
import { clearTimeout, setTimeout } from "node:timers";
import { performance } from "node:perf_hooks";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const APP = dirname(fileURLToPath(import.meta.url));
const HOME = dirname(APP);
const [event, ...flags] = process.argv.slice(2);
const LOG = join(HOME, "logs", `${new Date().toISOString().slice(0, 10)}.log`);
// Only this file writes to stdout, which Claude Code reads as JSON: console.log and the like are muted and the one reply goes
// straight to fd 1. Residual (D-29): a dependency that writes to fd 1 itself while the bundle is imported cannot be stopped.
process.stdout.write = () => true;
let [answered, problem, sid] = [false, null, null]; // answered: exactly one JSON object goes to stdout; problem: { why, where } when nothing was reviewed
let writeAtomic = (file, text) => { writeFileSync(`${file}.tmp`, text, { mode: 0o600 }); renameSync(`${file}.tmp`, file); };

function reply(text) {
  if (answered) return;
  answered = true;
  const buf = Buffer.from(text);
  for (let off = 0, spins = 0; off < buf.length;) try { off += writeSync(1, buf, off); } catch (error) { if (error.code !== "EAGAIN" || ++spins > 2000) throw error; }
}

function log(code, detail) {
  try {
    mkdirSync(dirname(LOG), { recursive: true });
    appendFileSync(LOG, `${new Date().toISOString()} error shim_${code} ${String(detail).trim().replace(/[^\x20-\x7e]/g, "?").slice(0, 400)}\n`);
  } catch { /* logging never fails a hook */ }
}

function unreviewed() { // a silent permanent fail-open is invisible: say so once per session, event and reason
  try {
    if (answered || !problem) return;
    const file = join(HOME, "shim-notices.json");
    const key = `${event}:${problem.why}`;
    const id = sid ?? "unknown-session";
    const seen = Object.create(null);
    try { for (const [k, v] of Object.entries(JSON.parse(readFileSync(file, "utf8")))) if (Array.isArray(v)) seen[k] = v.filter((x) => typeof x === "string"); } catch { /* first time */ }
    if (Object.hasOwn(seen, id) && seen[id].includes(key)) return;
    seen[id] = [...(Object.hasOwn(seen, id) ? seen[id] : []), key];
    try { mkdirSync(HOME, { recursive: true }); writeAtomic(file, JSON.stringify(Object.fromEntries(Object.entries(seen).slice(-50)))); } catch { /* shown again next time */ }
    const what = event === "Stop" ? "this turn was not reviewed" : "this session may not be reviewed";
    reply(`${JSON.stringify({ systemMessage: `Prosegate · ${what} (${problem.why}) · details: ${problem.where ?? LOG}` })}\n`);
  } catch (error) { log("notice", error && error.message); }
}

const giveUp = (code, detail, why = "internal error") => { log(code, detail); problem ||= { why, where: LOG }; unreviewed(); setTimeout(() => process.exit(0), 100); };

async function main() {
  let raw = "";
  try { process.stdin.setEncoding("utf8"); for await (const chunk of process.stdin) raw += chunk; } catch { /* handled as unreadable input */ }
  let version = flags.find((f) => f.startsWith("--use="))?.slice(6) ?? ""; // init pins the new version for its self-check
  if (version === "") try { version = readFileSync(join(APP, "current"), "utf8").trim(); } catch { /* missing */ }
  const shim = join(APP, version, "shims", "claude-code", "hook.mjs");
  if (!/^[A-Za-z0-9._+-]+$/.test(version) || !existsSync(shim) || !existsSync(join(APP, version, "dist", "prosegate.mjs"))) {
    try { sid = JSON.parse(raw).session_id; } catch { /* keyed to "unknown-session" */ }
    problem = { why: 'its files are missing; run "npx prosegate init" again', where: LOG };
    return log("missing", `version "${version.slice(0, 40)}" not found under ${APP}`);
  }
  const loaded = await import(pathToFileURL(shim).href);
  writeAtomic = loaded.writeAtomic ?? writeAtomic;
  const r = await loaded.handle({ event, flags, raw });
  sid = r.sid ?? null;
  if (r.stderr) process.stderr.write(r.stderr); // the headless one-line summary (09), or --debug notes
  if (r.problem) { problem = { why: r.problem.why, where: r.problem.where }; log("failed", r.problem.detail); }
  else if (r.json) reply(`${JSON.stringify(r.json)}\n`);
  else if (r.text) reply(r.text);
}

// The timer also keeps the process alive (an unsettled promise would end it with code 13); 7.5 s from process start, inside Claude Code's 10 s (D-29: no sync loops).
const watchdog = setTimeout(() => giveUp("timeout", `${event} took longer than 7.5 s`, "it took too long"),Math.max(0, 7500 - performance.now()));
for (const signal of ["uncaughtException", "unhandledRejection"]) process.on(signal, (e) => giveUp(signal, e && e.message));
try { await main(); } catch (error) { problem = { why: "internal error", where: LOG }; log("error", error && error.message); }
clearTimeout(watchdog);
unreviewed();
