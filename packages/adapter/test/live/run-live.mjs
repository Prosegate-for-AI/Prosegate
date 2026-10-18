// Live end-to-end run of the Claude Code shim against the real `claude` CLI (W3.2). Not part of `pnpm test`: it
// needs a logged-in CLI and spends a few model turns. Run it from the repository root after `pnpm build`:
//   node packages/adapter/test/live/run-live.mjs [--keep] [--model haiku]
// It makes a scratch project and a scratch Prosegate home, adds a recorder hook of its own to the project
// settings (to prove init leaves other hooks alone and to capture the exact stdin Claude Code sends), installs
// Prosegate with `prosegate init --scope project` (never --scope user: that edits the real ~/.claude/settings.json),
// drives `claude -p` headless twice (enforcing, then PROSEGATE_MODE=advisory), asserts from the stream-json
// output and the session transcript, prints excerpts, and deletes the scratch directory and the transcripts it made.
import { spawnSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const bundle = resolve(here, "..", "..", "dist", "prosegate.mjs");
const keep = process.argv.includes("--keep");
const model = process.argv.includes("--model") ? process.argv[process.argv.indexOf("--model") + 1] : "haiku";
const scratchRoot = resolve(process.env.PROSEGATE_LIVE_DIR ?? join(here, "..", "..", "..", "..", ".scratch"));
mkdirSync(scratchRoot, { recursive: true });
const root = mkdtempSync(join(scratchRoot, "live-"));
const project = join(root, "project");
const home = join(root, "prosegate-home");
const recorded = join(root, "recorded.jsonl");
mkdirSync(join(project, ".claude"), { recursive: true });

// The host session's own variables would make the child think it is nested (docs/spikes/s1-stop-hook/run.mjs).
const base = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(CLAUDECODE|CLAUDE_CODE_|ANTHROPIC_BASE_URL|CI$|PROSEGATE_)/i.test(k)));
const env = { ...base, PROSEGATE_HOME: home };
const claudeDir = env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
const transcriptDir = join(claudeDir, "projects", project.replace(/[^A-Za-z0-9]/g, "-"));

// The prompt hands the model a hedge as a first draft but tells it to follow a later revision request, so the run
// tests Prosegate's mechanism rather than whether the model disobeys the user (an explicit "begin with X" is kept
// through every revision, which is correct behaviour and was observed).
const PROMPT =
  "Write a note of about 90 words, in at least three sentences, on why a service should cache catalog reads per tenant. " +
  "Your first draft must open with the words 'It's worth noting that'. If you are then asked to revise it, do what the revision request asks and drop that opening. " +
  "Reply with the note only.";
const FLAGGED = /it[’']s worth noting that/i;

const problems = [];
const check = (ok, what) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${what}`);
  if (!ok) problems.push(what);
};
const short = (v, n = 600) => JSON.stringify(v).slice(0, n);
const jsonl = (text) => text.split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return { unparsed: l.slice(0, 100) }; } });

function claude(extraEnv) {
  const r = spawnSync("claude", ["-p", PROMPT, "--model", model, "--output-format", "stream-json", "--verbose"], {
    cwd: project, env: { ...env, ...extraEnv }, encoding: "utf8", timeout: 300_000,
  });
  const lines = jsonl(r.stdout ?? "");
  const sessionId = lines.find((l) => l.type === "system" && l.subtype === "init")?.session_id;
  const transcript = sessionId && existsSync(join(transcriptDir, `${sessionId}.jsonl`)) ? jsonl(readFileSync(join(transcriptDir, `${sessionId}.jsonl`), "utf8")) : [];
  const stops = transcript.filter((l) => l.type === "attachment" && l.attachment?.type === "hook_success" && l.attachment.hookEvent === "Stop" && /hook\.mjs"? Stop/.test(l.attachment.command ?? ""));
  return {
    status: r.status, raw: r.stdout ?? "", stderr: r.stderr ?? "", lines, transcript, sessionId,
    texts: lines.filter((l) => l.type === "assistant").map((l) => (l.message?.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join("")).filter(Boolean),
    stopOutputs: stops.map((s) => ({ ms: s.attachment.durationMs, out: jsonl(s.attachment.stdout ?? "")[0] ?? null, stderr: s.attachment.stderr })),
    result: lines.find((l) => l.type === "result"),
  };
}

try {
  // A hook of the user's own, in every event Prosegate uses, that records the stdin Claude Code sends it.
  const recorder = join(root, "recorder.mjs");
  writeFileSync(recorder, `import { appendFileSync, readFileSync } from "node:fs";\nappendFileSync(${JSON.stringify(recorded)}, JSON.stringify({ event: process.argv[2], input: JSON.parse(readFileSync(0, "utf8")) }) + "\\n");\n`);
  const mine = (event) => [{ hooks: [{ type: "command", command: `node "${recorder.replace(/\\/g, "/")}" ${event}` }] }];
  const original = { permissions: { allow: ["Bash(git status)"] }, hooks: { SessionStart: mine("SessionStart"), UserPromptSubmit: mine("UserPromptSubmit"), Stop: mine("Stop") } };
  writeFileSync(join(project, ".claude", "settings.json"), JSON.stringify(original, null, 2));

  const t0 = performance.now();
  const init = spawnSync(process.execPath, [bundle, "init", "--harness", "claude-code", "--scope", "project", "--local"], { cwd: project, env, encoding: "utf8" });
  console.log(init.stdout.trimEnd());
  console.log(`(init took ${Math.round(performance.now() - t0)} ms)`);
  check(init.status === 0, `init --scope project exits 0 (${init.stderr.trim() || "ok"})`);
  const after = JSON.parse(readFileSync(join(project, ".claude", "settings.json"), "utf8"));
  check(JSON.stringify(after.permissions) === JSON.stringify(original.permissions) && after.hooks.Stop.length === 2 && after.hooks.Stop[0].hooks[0].command.includes("recorder.mjs"), "init left the user's own permissions and hooks in place");
  console.log(`claude ${spawnSync("claude", ["--version"], { encoding: "utf8" }).stdout.trim()}, model ${model}\n`);

  // ---- enforcing ----------------------------------------------------------------------------
  const run = claude({});
  writeFileSync(join(root, "enforce-stream.jsonl"), run.raw);
  if (/Failed to authenticate|not logged in|Invalid API key/i.test(run.raw + run.stderr)) {
    console.log("SKIP  the claude CLI is not logged in; nothing was run. Log in, then rerun.");
    process.exitCode = 3;
  } else {
    console.log(`enforcing: ${run.stopOutputs.length} Prosegate Stop hook call(s); ${run.texts.length} assistant text(s)`);
    run.stopOutputs.forEach((s, i) => console.log(`  Stop #${i + 1} (${s.ms} ms) stdout: ${short(s.out, 900)}`));
    console.log(`  Stop says (stream): ${short(run.lines.filter((l) => l.subtype === "informational").map((l) => l.content))}`);
    check(FLAGGED.test(run.texts[0] ?? ""), "the first reply contained the flagged span");
    const cont = run.stopOutputs.find((s) => s.out?.hookSpecificOutput?.additionalContext?.startsWith("[Prosegate] "));
    check(cont !== undefined && cont.out.hookSpecificOutput.hookEventName === "Stop", "a continuation happened with Prosegate's feedback_text as additionalContext");
    check(cont !== undefined && Object.keys(cont.out).join() === "hookSpecificOutput", "the continuation carries no systemMessage and no decision:block");
    check(run.transcript.every((l) => !(l.type === "system" && l.subtype === "stop_hook_summary" && (l.hookErrors ?? []).length > 0)), "Claude Code recorded no hook error");
    console.log(`  first reply : ${short((run.texts[0] ?? "").slice(0, 200))}`);
    console.log(`  final result: ${short((run.result?.result ?? "").slice(0, 300))}`);
    check(typeof run.result?.result === "string" && run.result.result !== "" && !FLAGGED.test(run.result.result), "the revised final text no longer contains the flagged span");
    check(run.status === 0, "claude exits 0");

    // What Claude Code really sends: the user's own recorder hook saw it too.
    const seen = jsonl(readFileSync(recorded, "utf8"));
    const stopIn = seen.filter((s) => s.event === "Stop").map((s) => s.input);
    const prompt = run.transcript.find((l) => l.type === "user" && typeof l.message?.content === "string");
    console.log(`  Stop stdin fields: ${Object.keys(stopIn[0] ?? {}).join(", ")}`);
    console.log(`  stop_hook_active: ${short(stopIn.map((s) => s.stop_hook_active))}; prompt_id: ${short([...new Set(stopIn.map((s) => s.prompt_id))])}; transcript promptId: ${short(prompt?.promptId)}`);
    check(stopIn.length === 2 && stopIn[0].stop_hook_active === false && stopIn.slice(1).every((s) => s.stop_hook_active === true), "the Stop hook fired on the reply and again after the continuation, with stop_hook_active false then true");
    check(new Set(stopIn.map((s) => s.prompt_id)).size === 1 && stopIn[0].prompt_id === prompt?.promptId, "prompt_id is constant across the continuation and equals the transcript's promptId");
    check(stopIn[0]?.last_assistant_message === run.texts[0], "last_assistant_message equals the model's reply byte for byte");
    check(seen.some((s) => s.event === "SessionStart") && seen.some((s) => s.event === "UserPromptSubmit"), "the user's own hooks still ran in SessionStart and UserPromptSubmit");
    const logFile = join(home, "logs", `${new Date().toISOString().slice(0, 10)}.log`);
    const logText = existsSync(logFile) ? readFileSync(logFile, "utf8") : "";
    check(!/shim_|adapter_error/.test(logText), `no shim or adapter errors in the Prosegate log (${logText === "" ? "no log written" : `${logText.trim().split("\n").length} lines`})`);

    // ---- advisory -----------------------------------------------------------------------------
    const adv = claude({ PROSEGATE_MODE: "advisory" });
    writeFileSync(join(root, "advisory-stream.jsonl"), adv.raw);
    console.log(`\nadvisory: ${adv.stopOutputs.length} Prosegate Stop hook call(s); ${adv.texts.length} assistant text(s)`);
    adv.stopOutputs.forEach((s, i) => console.log(`  Stop #${i + 1} (${s.ms} ms) stdout: ${short(s.out, 900)}`));
    check(adv.stopOutputs.length === 1 && adv.texts.length === 1, "advisory: one reply, one Stop hook call, no continuation");
    check(!JSON.stringify(adv.stopOutputs).includes("additionalContext"), "advisory: the shim never sent additionalContext");
    const msg = adv.stopOutputs[0]?.out?.systemMessage;
    check(typeof msg === "string" && msg.includes("advisory, not enforced") && msg.includes("core.hedge.001"), "advisory: the shim sent the advisory notice, with the finding, as systemMessage");
  }
} finally {
  if (keep) console.log(`\nkept: ${root} (transcripts in ${transcriptDir})`);
  else {
    for (const dir of [root, transcriptDir]) {
      try {
        rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
      } catch (error) {
        console.log(`could not remove ${dir} (${error.code}); delete it by hand`);
      }
    }
  }
}
if (problems.length > 0) {
  console.log(`\n${problems.length} check(s) failed`);
  process.exitCode ||= 1;
}
