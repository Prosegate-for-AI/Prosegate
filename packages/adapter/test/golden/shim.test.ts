import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { buildBundle, testHooks, tmpDir } from "../helpers.js";
import { FakeClaudeCode, LAUNCHER_SOURCE, PROMPT_ID, SESSION, SHIM_SOURCE, cleanEnv, deleteVersion, installApp, layoutPkg, stubPkg, testPkg } from "./driver.js";

// The shim and the launcher: their contract with the adapter and with Claude Code, tested against a stand-in adapter that records
// what it is sent and answers with what a test tells it to, plus the failure modes (05: fail open everywhere; ADR-33).

const STUB = `
import { appendFileSync } from "node:fs";
export async function run(argv, io) {
  const cmd = argv[0];
  appendFileSync(process.env.STUB_OUT + "/" + cmd + ".in", (await io.stdin()) + "\\n");
  const how = process.env.STUB_MODE || "ok";
  if (how === "junk") process.stdout.write("Debugger attached.\\nWaiting for the debugger to disconnect...\\n");
  if (how === "exit1") { io.stderr.write("prosegate: could not review this turn (turn-end failed: internal error); your reply was not held.\\n"); return 1; }
  if (how === "exit1b") { io.stderr.write("prosegate: could not review this turn (turn-end failed: input too large); your reply was not held. Details: /logs/x.log"); return 1; }
  if (how === "exit2") { io.stderr.write("blocked\\n"); return 2; }
  if (how === "garbage") { io.stdout.write("this is not json\\n"); return 0; }
  if (how === "throw") throw new Error("boom");
  if (how === "hang") await new Promise(() => {});
  if (how === "late") setTimeout(() => { throw new Error("late failure"); }, 20);
  io.stdout.write(process.env.STUB_REPLY + "\\n");
  if (process.env.STUB_STDERR) io.stderr.write(process.env.STUB_STDERR);
  return 0;
}
export const toolNames = (path, promptId) => ["tool-of-" + promptId];
export const foldClaudeNotice = (notice) => process.env.STUB_FOLD ? "FOLDED<" + notice + ">" : notice;
`;

interface Stubbed {
  cc: FakeClaudeCode;
  sent: (cmd: string) => unknown[];
  logText: () => string;
}
function stubbed(reply: unknown, env: Record<string, string> = {}, body = STUB): Stubbed {
  const out = tmpDir("pg-stub-");
  const cc = new FakeClaudeCode(stubPkg(body), { env: { STUB_OUT: out, STUB_REPLY: JSON.stringify(reply), ...env } });
  const sent = (cmd: string): unknown[] => {
    const f = join(out, `${cmd}.in`);
    return existsSync(f) ? readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as unknown) : [];
  };
  const logText = (): string => {
    const dir = join(cc.home, "logs");
    return existsSync(dir) ? readdirSync(dir).map((f) => readFileSync(join(dir, f), "utf8")).join("") : "";
  };
  return { cc, sent, logText };
}

const logFile = (cc: FakeClaudeCode): string => join(cc.home, "logs", `${new Date().toISOString().slice(0, 10)}.log`);
/** The one line a fail-open shows the user (N14, ADR-33). */
const unreviewedNotice = (cc: FakeClaudeCode, why: string, what = "this turn was not reviewed"): object => ({ systemMessage: `Prosegate · ${what} (${why}) · details: ${logFile(cc)}` });
const MISSING = 'its files are missing; run "npx prosegate init" again';
const END_TURN = { decision: "allow", feedback_text: "", render: "none", result: {}, notice: null };
const lineCount = (file: string): number => readFileSync(file, "utf8").trimEnd().split("\n").length;

describe("the shim files", () => {
  it("the shim and the launcher together are at most 150 lines (05: a shim that needs more is doing the adapter's job)", () => {
    expect(lineCount(SHIM_SOURCE) + lineCount(LAUNCHER_SOURCE)).toBeLessThanOrEqual(150);
  });
});

describe("SessionStart", () => {
  const reply = { inject: "Guard line.\nActive profile: Base.", notice: "Prosegate · profile pr-description updated to v5 (2 rules changed)", active_profile: "local/base", offline: true };

  it("sends session-start the session, cwd, mode and source, and prints inject as additionalContext and notice as systemMessage", () => {
    const { cc, sent } = stubbed(reply);
    const r = cc.sessionStart("resume");
    expect(r.code).toBe(0);
    expect(sent("session-start")).toEqual([{ harness: "claude-code", session_id: SESSION, cwd: cc.cwd, mode: "interactive", source: "resume" }]);
    expect(r.json).toEqual({
      hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: "Guard line.\nActive profile: Base." },
      systemMessage: "Prosegate · profile pr-description updated to v5 (2 rules changed)",
    });
  });

  it("passes every Claude Code source through and drops one it does not know", () => {
    const { cc, sent } = stubbed({ ...reply, notice: null });
    for (const s of ["startup", "resume", "clear", "compact", "fork", "something-new"]) cc.sessionStart(s);
    expect(sent("session-start").map((i) => (i as { source?: string }).source)).toEqual(["startup", "resume", "clear", "compact", "fork", undefined]);
  });

  it("prints nothing when there is nothing to say", () => {
    const { cc } = stubbed({ ...reply, inject: "", notice: null });
    expect(cc.sessionStart()).toMatchObject({ code: 0, stdout: "", stderr: "" });
  });

  it("folds the notice through the bundle (one notice per turn, ADR-33)", () => {
    const { cc } = stubbed(reply, { STUB_FOLD: "1" });
    expect((cc.sessionStart().json as { systemMessage: string }).systemMessage).toBe("FOLDED<Prosegate · profile pr-description updated to v5 (2 rules changed)>");
  });

  it.each([
    ["CI is set", { CI: "true" }, [], "headless"],
    ["PROSEGATE_MODE=headless", { PROSEGATE_MODE: "headless" }, [], "headless"],
    ["a --headless flag", {}, ["--headless"], "headless"],
    ["CI=false", { CI: "false" }, [], "interactive"],
    ["PROSEGATE_MODE=interactive beats CI", { CI: "1", PROSEGATE_MODE: "interactive" }, [], "interactive"],
    ["nothing is set", {}, [], "interactive"],
  ])("mode when %s", (_name, env, flags, expected) => {
    const { cc, sent } = stubbed(reply, env);
    cc.sessionStart("startup", flags);
    expect((sent("session-start")[0] as { mode: string }).mode).toBe(expected);
  });
});

describe("UserPromptSubmit", () => {
  it("sends turn-start the prompt and prompt_id as turn_id (ADR-33), and prints inject when there is one", () => {
    const { cc, sent } = stubbed({ inject: "Use the pr-description profile.", candidate: null });
    const r = cc.prompt("write the PR description");
    expect(sent("turn-start")).toEqual([{ session_id: SESSION, turn_id: PROMPT_ID, user_message: "write the PR description", tool_calls_so_far: [] }]);
    expect(r).toMatchObject({ code: 0, stdout: "Use the pr-description profile.\n", stderr: "" });
  });

  it("prints nothing when inject is null", () => {
    const { cc } = stubbed({ inject: null, candidate: null });
    expect(cc.prompt("hello")).toMatchObject({ code: 0, stdout: "", stderr: "" });
  });
});

describe("Stop", () => {
  it("sends turn-end the turn text, prompt_id as turn_id, the continuation flag and continue_supported (ADR-30, ADR-31)", () => {
    const { cc, sent } = stubbed(END_TURN);
    cc.stop("The reply.", { stop_hook_active: true });
    cc.stop("Another reply.");
    const base = { session_id: SESSION, turn_id: PROMPT_ID, tool_calls: [`tool-of-${PROMPT_ID}`], continue_supported: true };
    expect(sent("turn-end")).toEqual([
      { ...base, assistant_text: "The reply.", continuation: true },
      { ...base, assistant_text: "Another reply.", continuation: false },
    ]);
  });

  it("asks the bundle for the tool names with the transcript path and the prompt id, and sends none without a path", () => {
    const { cc, sent } = stubbed(END_TURN);
    cc.stop("x", { transcript_path: undefined });
    expect((sent("turn-end")[0] as { tool_calls: string[] }).tool_calls).toEqual([]);
  });

  it("leaves turn_id out when Claude Code sends no prompt_id (the adapter derives one)", () => {
    const { cc, sent } = stubbed(END_TURN);
    cc.stop("The reply.", { prompt_id: undefined });
    expect("turn_id" in (sent("turn-end")[0] as object)).toBe(false);
  });

  it("continue: prints additionalContext = feedback_text exactly, and no systemMessage even when the adapter sent a notice (ADR-13)", () => {
    const { cc } = stubbed({ ...END_TURN, decision: "continue", feedback_text: "[Prosegate] 1 finding\nReply with the revised response only.", notice: "Prosegate · a notice" });
    const r = cc.stop("x");
    expect(r.stdout).toBe('{"hookSpecificOutput":{"hookEventName":"Stop","additionalContext":"[Prosegate] 1 finding\\nReply with the revised response only."}}\n');
    expect(r.stdout).not.toContain("systemMessage");
    expect(r.stdout).not.toContain("decision");
    expect(r.code).toBe(0);
  });

  it("an empty feedback_text on continue is a fail-open that the user can see (ADR-33)", () => {
    const { cc, logText } = stubbed({ ...END_TURN, decision: "continue", feedback_text: "" });
    expect(cc.stop("x")).toMatchObject({ code: 0, json: unreviewedNotice(cc, "internal error") });
    expect(logText()).toContain("continue with an empty feedback_text");
  });

  it("allow with a notice: prints systemMessage only, folded through the bundle", () => {
    const { cc } = stubbed({ ...END_TURN, notice: "Prosegate · 1 finding remains after 2 passes · shipped as is" });
    expect(cc.stop("x").stdout).toBe(`${JSON.stringify({ systemMessage: "Prosegate · 1 finding remains after 2 passes · shipped as is" })}\n`);
    const folded = stubbed({ ...END_TURN, notice: "N" }, { STUB_FOLD: "1" });
    expect(folded.cc.stop("x").json).toEqual({ systemMessage: "FOLDED<N>" });
  });

  it("allow without a notice: prints nothing", () => {
    const { cc } = stubbed(END_TURN);
    expect(cc.stop("x")).toMatchObject({ code: 0, stdout: "", stderr: "" });
  });

  it("passes the adapter's stderr through on success (the headless summary line, 09)", () => {
    const { cc } = stubbed(END_TURN, { STUB_STDERR: "Prosegate | turn 1 | profile base | clean\n" });
    const r = cc.stop("x");
    expect(r.stdout).toBe("");
    expect(r.stderr).toBe("Prosegate | turn 1 | profile base | clean\n");
  });
});

describe("what reaches stdout", () => {
  async function wrapped(importTime: string): Promise<FakeClaudeCode> {
    const real = await buildBundle("release");
    const pkg = layoutPkg(real, "wrapped");
    const realCopy = join(pkg.dir, "dist", "real.mjs");
    writeFileSync(realCopy, readFileSync(real));
    const nl = String.fromCharCode(10);
    writeFileSync(
      pkg.bundle,
      [`import { writeSync } from "node:fs";`, importTime, `const m = await import(${JSON.stringify(pathToFileURL(realCopy).href)});`, "export const run = m.run;", "export const writeFileAtomic = m.writeFileAtomic;", "export const foldClaudeNotice = m.foldClaudeNotice;", "export const toolNames = m.toolNames;"].join(nl),
    );
    return new FakeClaudeCode(pkg);
  }

  it("console.log from the adapter or a dependency, at import or later, is muted: stdout is exactly one JSON object", async () => {
    const cc = await wrapped(`console.log("Loading profile..."); process.stdout.write("more junk" + String.fromCharCode(10));`);
    const r = cc.sessionStart();
    expect(r.code).toBe(0);
    expect(r.stdout.split("\n").filter(Boolean)).toHaveLength(1);
    expect(r.stdout.startsWith('{"hookSpecificOutput":{"hookEventName":"SessionStart"')).toBe(true);
  });

  it("RESIDUAL (D-29): a dependency that writes to fd 1 itself while it is imported puts text before the JSON; the JSON still comes last and the exit code is 0", async () => {
    const cc = await wrapped(`writeSync(1, "fd one junk" + String.fromCharCode(10));`);
    const r = cc.sessionStart();
    expect(r.code).toBe(0);
    const lines = r.stdout.split("\n").filter(Boolean);
    expect(lines[0]).toBe("fd one junk");
    expect(lines.at(-1)?.startsWith('{"hookSpecificOutput"')).toBe(true);
  });

  it("junk the adapter prints to stdout while it runs never reaches Claude Code", () => {
    const { cc } = stubbed({ ...END_TURN, decision: "continue", feedback_text: "F" }, { STUB_MODE: "junk" });
    expect(cc.stop("x").stdout).toBe('{"hookSpecificOutput":{"hookEventName":"Stop","additionalContext":"F"}}\n');
  });

  it("a failure after the reply was written (an exception a moment later) cannot add a second object", () => {
    const { cc } = stubbed({ ...END_TURN, notice: "Prosegate · something" }, { STUB_MODE: "late" });
    const r = cc.stop("x");
    expect(r.code).toBe(0);
    expect(r.stdout.split("\n").filter(Boolean)).toHaveLength(1);
    expect(JSON.parse(r.stdout)).toEqual({ systemMessage: "Prosegate · something" });
  });
});

describe("fail open (05)", () => {
  it("an adapter that exits 1: exit 0, the user told once, its stderr appended to the log", () => {
    const { cc, logText } = stubbed(END_TURN, { STUB_MODE: "exit1" });
    const r = cc.stop("x");
    expect(r).toMatchObject({ code: 0, stderr: "", json: unreviewedNotice(cc, "internal error") });
    expect(logText()).toMatch(/ error shim_failed turn-end: exit 1: prosegate: could not review this turn \(turn-end failed: internal error\); your reply was not held\.\s*$/m);
  });

  it("an adapter that exits 2 is not a block: the shim allows", () => {
    const { cc } = stubbed(END_TURN, { STUB_MODE: "exit2" });
    expect(cc.stop("x")).toMatchObject({ code: 0, stderr: "", json: unreviewedNotice(cc, "internal error") });
  });

  it("an adapter whose output is not JSON, or that throws, or a bundle with no run export", () => {
    const garbage = stubbed(END_TURN, { STUB_MODE: "garbage" });
    expect(garbage.cc.stop("x")).toMatchObject({ code: 0, json: unreviewedNotice(garbage.cc, "internal error") });
    expect(garbage.logText()).toContain("shim_failed turn-end: the adapter's output was not JSON");
    const thrown = stubbed(END_TURN, { STUB_MODE: "throw" });
    expect(thrown.cc.stop("x")).toMatchObject({ code: 0, stderr: "", json: unreviewedNotice(thrown.cc, "internal error") });
    expect(thrown.logText()).toContain("shim_failed turn-end: error: boom");
    const bare = new FakeClaudeCode(stubPkg("export const nothing = 1;"));
    expect(bare.stop("x")).toMatchObject({ code: 0, stderr: "", json: unreviewedNotice(bare, "internal error") });
  });

  it("a hook input that is not JSON, or has no session id: exit 0, and the user is told (keyed to an unknown session)", () => {
    const { cc, logText } = stubbed(END_TURN);
    const raws = ["", "{nope", "[]", '{"hook_event_name":"Stop"}'];
    const runs = raws.map((raw) => spawnSync(process.execPath, [cc.launcher, "Stop"], { input: raw, encoding: "utf8", env: cleanEnv(cc.home, cc.env) }));
    for (const r of runs) expect(r.status).toBe(0);
    expect(JSON.parse(runs[0]?.stdout ?? "")).toEqual(unreviewedNotice(cc, "invalid hook input"));
    for (const r of runs.slice(1)) expect(r.stdout).toBe(""); // the same reason, shown once
    expect(logText()).toContain("shim_failed hook input was not JSON with a session_id");
  });

  it("a byte order mark on the hook input (S14) is stripped, not an error", () => {
    const { cc, sent } = stubbed({ ...END_TURN, notice: "N" });
    const input = String.fromCharCode(0xfeff) + JSON.stringify({ session_id: SESSION, hook_event_name: "Stop", prompt_id: PROMPT_ID, last_assistant_message: "text", stop_hook_active: false });
    const r = spawnSync(process.execPath, [cc.launcher, "Stop"], { input, encoding: "utf8", env: cleanEnv(cc.home, cc.env) });
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({ systemMessage: "N" });
    expect((sent("turn-end")[0] as { assistant_text: string }).assistant_text).toBe("text");
  });

  it("an unknown event does nothing", () => {
    const { cc, sent } = stubbed(END_TURN);
    const r = spawnSync(process.execPath, [cc.launcher, "PostToolUse"], { input: JSON.stringify({ session_id: SESSION }), encoding: "utf8", env: cleanEnv(cc.home, cc.env) });
    expect({ code: r.status, stdout: r.stdout }).toEqual({ code: 0, stdout: "" });
    expect(sent("turn-end")).toEqual([]);
  });

  it("an adapter that hangs is given up on at 7.5 s from the process start, inside Claude Code's 10 s", () => {
    const { cc, logText } = stubbed(END_TURN, { STUB_MODE: "hang" });
    const t0 = performance.now();
    const r = cc.stop("x");
    expect(performance.now() - t0).toBeLessThan(9900);
    expect(r).toMatchObject({ code: 0, json: unreviewedNotice(cc, "it took too long") });
    expect(logText()).toContain("shim_timeout Stop took longer than 7.5 s");
  }, 20_000);

  it("a stdin that never closes does not hold the hook: the watchdog is live while the input is read", async () => {
    const { cc } = stubbed(END_TURN);
    const t0 = performance.now();
    const child = spawn(process.execPath, [cc.launcher, "Stop"], { env: cleanEnv(cc.home, cc.env), stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    const code = await new Promise<number | null>((resolve) => child.on("close", resolve));
    expect(code).toBe(0);
    expect(performance.now() - t0).toBeLessThan(9900);
    expect(JSON.parse(stdout)).toEqual(unreviewedNotice(cc, "it took too long"));
  }, 20_000);
});

describe("the launcher and a missing version (ADR-33)", () => {
  it("current names a deleted version: the user sees the files-are-missing line, once, and the exit code is 0", () => {
    const { cc } = stubbed(END_TURN);
    deleteVersion(cc.home);
    const first = cc.stop("x");
    expect(first).toMatchObject({ code: 0, stderr: "", json: unreviewedNotice(cc, MISSING) });
    expect(first.stdout).toBe(`${JSON.stringify(unreviewedNotice(cc, MISSING))}\n`);
    // ADR-33's line, character for character.
    expect((first.json as { systemMessage: string }).systemMessage).toBe(`Prosegate · this turn was not reviewed (its files are missing; run "npx prosegate init" again) · details: ${logFile(cc)}`);
    expect(cc.stop("again", { prompt_id: "p2" })).toMatchObject({ code: 0, stdout: "" });
  });

  it("at session start the line says the session may not be reviewed", () => {
    const { cc } = stubbed(END_TURN);
    deleteVersion(cc.home);
    expect(cc.sessionStart().json).toEqual(unreviewedNotice(cc, MISSING, "this session may not be reviewed"));
  });

  it("no current file, an unsafe current, or a version without its bundle are all the same line", () => {
    const none = stubbed(END_TURN);
    rmSync(join(none.cc.home, "app", "current"));
    expect(none.cc.stop("x").json).toEqual(unreviewedNotice(none.cc, MISSING));
    const unsafe = stubbed(END_TURN);
    writeFileSync(join(unsafe.cc.home, "app", "current"), "../../elsewhere\n");
    expect(unsafe.cc.stop("x").json).toEqual(unreviewedNotice(unsafe.cc, MISSING));
    const nobundle = stubbed(END_TURN);
    rmSync(join(nobundle.cc.home, "app", "1.0.0", "dist"), { recursive: true });
    expect(nobundle.cc.stop("x").json).toEqual(unreviewedNotice(nobundle.cc, MISSING));
  });

  it("a dependency missing INSIDE the bundle is an internal error, not 'its files are missing'", () => {
    const { cc, logText } = stubbed(END_TURN, {}, `import "prosegate-no-such-dependency";\nexport async function run() { return 0; }\n`);
    const r = cc.stop("x");
    expect(r.json).toEqual(unreviewedNotice(cc, "internal error"));
    expect(logText()).toContain("ERR_MODULE_NOT_FOUND");
  });

  it("an upgrade swaps the version the launcher runs without the registration changing", () => {
    const first = stubbed({ ...END_TURN, notice: "from the first version" });
    expect(first.cc.stop("x").json).toEqual({ systemMessage: "from the first version" });
    const reply = `{"decision":"allow","notice":"from the second version"}`;
    const second = stubPkg(`export async function run(argv, io) { io.stdout.write(${JSON.stringify(reply)} + "\\n"); return 0; }\n`);
    expect(installApp(second, first.cc.home, "2.0.0")).toBe(first.cc.launcher);
    expect(first.cc.stop("again", { prompt_id: "p2" }).json).toEqual({ systemMessage: "from the second version" });
  });
});

describe("a permanent fail-open is visible once per session, event and reason (N14, F10)", () => {
  it("one systemMessage, then silence; a new session or a new reason shows it again", () => {
    const { cc } = stubbed(END_TURN, { STUB_MODE: "exit1" });
    expect(cc.stop("x").json).toEqual(unreviewedNotice(cc, "internal error"));
    expect(cc.stop("y", { prompt_id: "next" })).toMatchObject({ code: 0, stdout: "", stderr: "" });
    cc.sessionId = "a-second-session";
    expect(cc.stop("z").json).toEqual(unreviewedNotice(cc, "internal error"));
    cc.env = { ...cc.env, STUB_MODE: "exit1b" };
    cc.sessionId = SESSION;
    expect(cc.stop("w").json).toEqual({ systemMessage: "Prosegate · this turn was not reviewed (input too large) · details: /logs/x.log" });
  });

  it("remembers more than one session (S11): the first session is still silent after others have had their notice", () => {
    const { cc } = stubbed(END_TURN, { STUB_MODE: "exit1" });
    const ids = ["session-a", "session-b", "session-c"];
    for (const id of ids) {
      cc.sessionId = id;
      expect(cc.stop("x").json, id).toEqual(unreviewedNotice(cc, "internal error"));
    }
    cc.sessionId = "session-a";
    expect(cc.stop("again", { prompt_id: "p2" })).toMatchObject({ code: 0, stdout: "" });
  });

  it("is keyed on the event too: a Stop notice still shows after a SessionStart notice with the same reason", () => {
    const { cc } = stubbed(END_TURN, { STUB_MODE: "exit1" });
    expect(cc.sessionStart().json).toEqual(unreviewedNotice(cc, "internal error", "this session may not be reviewed"));
    expect(cc.stop("x").json).toEqual(unreviewedNotice(cc, "internal error"));
    expect(cc.prompt("hi").json).toEqual(unreviewedNotice(cc, "internal error", "this session may not be reviewed"));
    expect(cc.prompt("again")).toMatchObject({ stdout: "" });
  });

  it("session ids like __proto__ or constructor are ordinary keys, and a corrupt record is rebuilt", () => {
    for (const id of ["__proto__", "constructor", "hasOwnProperty", "toString"]) {
      const { cc } = stubbed(END_TURN, { STUB_MODE: "exit1" });
      cc.sessionId = id;
      expect(cc.stop("x").json, id).toEqual(unreviewedNotice(cc, "internal error"));
      expect(cc.stop("y", { prompt_id: "p2" }), id).toMatchObject({ code: 0, stdout: "" });
    }
    for (const corrupt of ["[]", "null", '"text"', '{"a":"not a list"}', '{"__proto__":["Stop:internal error"]}', "{broken"]) {
      const { cc } = stubbed(END_TURN, { STUB_MODE: "exit1" });
      mkdirSync(cc.home, { recursive: true });
      writeFileSync(join(cc.home, "shim-notices.json"), corrupt);
      const r = cc.stop("x");
      expect({ corrupt, code: r.code }).toEqual({ corrupt, code: 0 });
      expect(r.json, corrupt).toEqual(unreviewedNotice(cc, "internal error"));
    }
  });

  it("a record file that cannot be read or written (it is a directory) still shows the line and exits 0", () => {
    const { cc } = stubbed(END_TURN, { STUB_MODE: "exit1" });
    mkdirSync(join(cc.home, "shim-notices.json"), { recursive: true });
    expect(cc.stop("x")).toMatchObject({ code: 0, json: unreviewedNotice(cc, "internal error") });
  });

  it("takes the reason and the log path from the adapter's own stderr line: a crash fixture through the real adapter (test build)", async () => {
    const cc = new FakeClaudeCode(await testPkg(), { env: testHooks({ crash: "turn-end" }) });
    cc.sessionStart();
    const r = cc.stop("The cache is per tenant.");
    expect(r.code).toBe(0);
    expect(r.stderr).toBe("");
    expect(r.stdout).toBe(`${JSON.stringify(unreviewedNotice(cc, "internal error"))}\n`);
    expect(cc.stop("Again.", { prompt_id: "p2" })).toMatchObject({ code: 0, stdout: "" });
  });
});
