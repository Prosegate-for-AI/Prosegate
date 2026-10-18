import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { commandFor } from "../../src/init.js";
import { buildBundle, testHooks, tmpDir } from "../helpers.js";
import { FakeClaudeCode, PROMPT_ID, SESSION, cleanEnv, layoutPkg, stubPkg, testPkg, SHIM_SOURCE } from "./driver.js";

// The shim's contract with the adapter and with Claude Code, tested against a stand-in adapter that records what
// it is sent and answers with what a test tells it to, plus the failure modes (05: fail open everywhere).

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
  io.stdout.write(process.env.STUB_REPLY + "\\n");
  if (process.env.STUB_STDERR) io.stderr.write(process.env.STUB_STDERR);
  return 0;
}
`;

function stubbed(reply: unknown, env: Record<string, string> = {}): { cc: FakeClaudeCode; sent: (cmd: string) => unknown[]; logText: () => string } {
  const out = tmpDir("pg-stub-");
  const cc = new FakeClaudeCode(stubPkg(STUB), { env: { STUB_OUT: out, STUB_REPLY: JSON.stringify(reply), ...env } });
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
/** The one line a fail-open shows the user (N14). */
const unreviewedNotice = (cc: FakeClaudeCode, why: string): object => ({ systemMessage: `Prosegate \u00b7 this turn was not reviewed (${why}) \u00b7 details: ${logFile(cc)}` });

const END_TURN = { decision: "allow", feedback_text: "", render: "none", result: {}, notice: null };

describe("the shim file", () => {
  it("is at most 150 lines (05: a shim that needs more is doing the adapter's job)", () => {
    expect(readFileSync(SHIM_SOURCE, "utf8").trimEnd().split("\n").length).toBeLessThanOrEqual(150);
  });
});

describe("SessionStart", () => {
  const reply = { inject: "Guard line.\nActive profile: Base.", notice: "Prosegate \u00b7 profile pr-description updated to v5 (2 rules changed)", active_profile: "local/base", offline: true };

  it("sends session-start the session, cwd, mode and source, and prints inject as additionalContext and notice as systemMessage", () => {
    const { cc, sent } = stubbed(reply);
    const r = cc.sessionStart("resume");
    expect(r.code).toBe(0);
    expect(sent("session-start")).toEqual([{ harness: "claude-code", session_id: SESSION, cwd: cc.cwd, mode: "interactive", source: "resume" }]);
    expect(r.json).toEqual({
      hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: "Guard line.\nActive profile: Base." },
      systemMessage: "Prosegate \u00b7 profile pr-description updated to v5 (2 rules changed)",
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

  it.each([
    ["CI is set", { CI: "true" }, [], "headless"],
    ["PROSEGATE_MODE=headless", { PROSEGATE_MODE: "headless" }, [], "headless"],
    ["init registered --headless", {}, ["--headless"], "headless"],
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
  it("sends turn-start the prompt and prints inject when there is one", () => {
    const { cc, sent } = stubbed({ inject: "Use the pr-description profile.", candidate: null });
    const r = cc.prompt("write the PR description");
    expect(sent("turn-start")).toEqual([{ session_id: SESSION, user_message: "write the PR description", tool_calls_so_far: [] }]);
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
    expect(sent("turn-end")).toEqual([
      { session_id: SESSION, turn_id: PROMPT_ID, assistant_text: "The reply.", tool_calls: [], continuation: true, continue_supported: true },
      { session_id: SESSION, turn_id: PROMPT_ID, assistant_text: "Another reply.", tool_calls: [], continuation: false, continue_supported: true },
    ]);
  });

  it("leaves turn_id out when Claude Code sends no prompt_id (the adapter derives one)", () => {
    const { cc, sent } = stubbed(END_TURN);
    cc.stop("The reply.", { prompt_id: undefined });
    expect("turn_id" in (sent("turn-end")[0] as object)).toBe(false);
  });

  it("continue: prints additionalContext = feedback_text exactly, and no systemMessage even when the adapter sent a notice (ADR-13)", () => {
    const { cc } = stubbed({ ...END_TURN, decision: "continue", feedback_text: "[Prosegate] 1 finding\nReply with the revised response only.", notice: "Prosegate \u00b7 a notice" });
    const r = cc.stop("x");
    expect(r.stdout).toBe('{"hookSpecificOutput":{"hookEventName":"Stop","additionalContext":"[Prosegate] 1 finding\\nReply with the revised response only."}}\n');
    expect(r.stdout).not.toContain("systemMessage");
    expect(r.stdout).not.toContain("decision");
    expect(r.code).toBe(0);
  });

  it("allow with a notice: prints systemMessage only", () => {
    const { cc } = stubbed({ ...END_TURN, notice: "Prosegate \u00b7 1 finding remains after 2 passes \u00b7 shipped as is" });
    expect(cc.stop("x").stdout).toBe(`${JSON.stringify({ systemMessage: "Prosegate · 1 finding remains after 2 passes · shipped as is" })}
`);
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

describe("tool names from the transcript (05, 07 threat 6)", () => {
  const user = (text: string, promptId = PROMPT_ID): object => ({ type: "user", promptId, message: { role: "user", content: text } });
  const tool = (name: string, extra: object = {}): object => ({ type: "assistant", ...extra, message: { role: "assistant", content: [{ type: "text", text: "x" }, { type: "tool_use", id: "t", name, input: {} }] } });
  const result = (): object => ({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: "ok" }] } });
  const write = (cc: FakeClaudeCode, lines: unknown[], tail = ""): void => {
    mkdirSync(join(cc.transcript, ".."), { recursive: true });
    writeFileSync(cc.transcript, lines.map((l) => JSON.stringify(l)).join("\n") + tail);
  };
  const names = (sent: (c: string) => unknown[]): string[] => (sent("turn-end").at(-1) as { tool_calls: string[] }).tool_calls;

  it("reads only the tool-use names after the last user prompt: earlier turns, tool results, sub-agent lines and a partial last line", () => {
    const { cc, sent } = stubbed(END_TURN);
    write(
      cc,
      [user("first prompt", "old-prompt"), tool("Bash"), result(), tool("Write"), user("second prompt"), tool("Read"), result(), tool("Edit"), tool("Task", { isSidechain: true }), result(), tool("Bash")],
      '\n{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","na',
    );
    cc.stop("x");
    expect(names(sent)).toEqual(["Read", "Edit", "Bash"]);
  });

  it("a transcript that lags (the new prompt is not in the file yet) gives no names rather than an earlier turn's", () => {
    const { cc, sent } = stubbed(END_TURN);
    write(cc, [user("first prompt", "old-prompt"), tool("Bash"), tool("Write")]);
    cc.stop("x");
    expect(names(sent)).toEqual([]);
  });

  it("a missing, empty or unreadable transcript gives no names and still reviews the turn", () => {
    const { cc, sent } = stubbed(END_TURN);
    cc.stop("one");
    writeFileSync(cc.transcript, "");
    cc.stop("two");
    cc.stop("three", { transcript_path: 42 });
    expect(sent("turn-end").map((i) => (i as { tool_calls: string[] }).tool_calls)).toEqual([[], [], []]);
  });

  it("only the tail of a very large transcript is read", () => {
    const { cc, sent } = stubbed(END_TURN);
    const filler = Array.from({ length: 40 }, () => tool("Old", {})) as unknown[];
    const big = "x".repeat(300_000);
    const lines = [user("earlier", "old"), ...filler, ...Array.from({ length: 20 }, () => ({ type: "attachment", pad: big })), user("this turn"), tool("Grep")];
    write(cc, lines);
    cc.stop("x");
    expect(names(sent)).toEqual(["Grep"]);
  });
});

describe("fail open (05)", () => {
  it("an adapter that exits 1: nothing on stdout, exit 0, its stderr appended to the log", () => {
    const { cc, logText } = stubbed(END_TURN, { STUB_MODE: "exit1" });
    const r = cc.stop("x");
    expect(r).toMatchObject({ code: 0, stderr: "", json: unreviewedNotice(cc, "internal error") });
    expect(logText()).toMatch(/ error shim_turn-end_failed exit 1: prosegate: could not review this turn \(turn-end failed: internal error\); your reply was not held\.\s*$/m);
  });

  it("an adapter that exits 2 is not a block: the shim allows", () => {
    const { cc } = stubbed(END_TURN, { STUB_MODE: "exit2" });
    expect(cc.stop("x")).toMatchObject({ code: 0, stderr: "", json: unreviewedNotice(cc, "internal error") });
  });

  it("an adapter whose output is not JSON: nothing on stdout, exit 0, one log line", () => {
    const { cc, logText } = stubbed(END_TURN, { STUB_MODE: "garbage" });
    expect(cc.stop("x")).toMatchObject({ code: 0, json: unreviewedNotice(cc, "internal error") });
    expect(logText()).toContain("shim_turn-end_failed the adapter's output was not JSON");
  });

  it("text the adapter prints to stdout itself (a banner, a library) never reaches Claude Code: the shim's own stdout is clean JSON", () => {
    const { cc } = stubbed({ ...END_TURN, decision: "continue", feedback_text: "F" }, { STUB_MODE: "junk" });
    const r = cc.stop("x");
    expect(r.stdout).toBe('{"hookSpecificOutput":{"hookEventName":"Stop","additionalContext":"F"}}\n');
  });

  it("the same through the real adapter: a wrapper bundle that prints a banner at import, then delegates", async () => {
    const real = await buildBundle("release");
    const pkg = layoutPkg(real, "wrapped");
    const realCopy = join(pkg.dir, "dist", "real.mjs");
    writeFileSync(realCopy, readFileSync(real));
    writeFileSync(pkg.bundle, ["process.stdout.write('Loading profile...' + String.fromCharCode(10));", `const m = await import(${JSON.stringify(pathToFileURL(realCopy).href)});`, "export const run = m.run;"].join(String.fromCharCode(10)));
    const cc = new FakeClaudeCode(pkg);
    const r = cc.sessionStart();
    expect(r.code).toBe(0);
    expect(r.stdout.startsWith('{"hookSpecificOutput":{"hookEventName":"SessionStart"')).toBe(true);
  });

  it("an adapter that throws, or a bundle with no run export, fails open and is logged", () => {
    const thrown = stubbed(END_TURN, { STUB_MODE: "throw" });
    expect(thrown.cc.stop("x")).toMatchObject({ code: 0, stderr: "", json: unreviewedNotice(thrown.cc, "internal error") });
    expect(thrown.logText()).toContain("shim_turn-end_failed error: boom");
    const bare = new FakeClaudeCode(stubPkg("export const nothing = 1;"));
    expect(bare.stop("x")).toMatchObject({ code: 0, stderr: "", json: unreviewedNotice(bare, "internal error") });
    expect(readdirSync(join(bare.home, "logs"))).toHaveLength(1);
  });

  it("a hook input that is not JSON, or has no session id: nothing on stdout, exit 0", () => {
    const { cc, logText } = stubbed(END_TURN);
    for (const raw of ["", "{nope", "[]", '{"hook_event_name":"Stop"}']) {
      const r = spawnSync(process.execPath, [cc.pkg.shim, "Stop"], { input: raw, encoding: "utf8", env: cleanEnv(cc.home, cc.env) });
      expect({ raw, code: r.status, stdout: r.stdout }).toEqual({ raw, code: 0, stdout: "" });
    }
    expect(logText()).toContain("shim_stdin_unreadable");
  });

  it("an unknown event does nothing", () => {
    const { cc, sent } = stubbed(END_TURN);
    const r = spawnSync(process.execPath, [cc.pkg.shim, "PostToolUse"], { input: JSON.stringify({ session_id: SESSION }), encoding: "utf8", env: cleanEnv(cc.home, cc.env) });
    expect({ code: r.status, stdout: r.stdout }).toEqual({ code: 0, stdout: "" });
    expect(sent("turn-end")).toEqual([]);
  });

  it("an adapter that hangs is stopped before Claude Code's 10 s Stop timeout: nothing on stdout, exit 0", () => {
    const { cc, logText } = stubbed(END_TURN, { STUB_MODE: "hang" });
    const t0 = performance.now();
    const r = cc.stop("x");
    expect(performance.now() - t0).toBeLessThan(9900);
    expect(r).toMatchObject({ code: 0, json: unreviewedNotice(cc, "it took too long") });
    expect(logText()).toContain("shim_timeout Stop took longer than 9 s");
  }, 20_000);

  it("a missing adapter bundle (an npx cache that was cleared): exit 0, and the user is told the files are missing", () => {
    const cc = new FakeClaudeCode(layoutPkg(null));
    expect(cc.stop("x")).toMatchObject({ code: 0, json: unreviewedNotice(cc, "the Prosegate files are missing") });
  });
});

describe("a permanent fail-open is visible once (N14)", () => {
  it("shows one systemMessage per session and reason, then stays silent; a new session or a new reason shows it again", () => {
    const { cc } = stubbed(END_TURN, { STUB_MODE: "exit1" });
    const first = cc.stop("x");
    expect(first.json).toEqual(unreviewedNotice(cc, "internal error"));
    expect(cc.stop("y", { prompt_id: "next" })).toMatchObject({ code: 0, stdout: "", stderr: "" });
    expect(cc.prompt("hello")).toMatchObject({ code: 0, stdout: "", stderr: "" });
    cc.sessionId = "a-second-session";
    expect(cc.stop("z").json).toEqual(unreviewedNotice(cc, "internal error"));
    cc.env = { ...cc.env, STUB_MODE: "exit1b" };
    cc.sessionId = SESSION;
    // The reason and the path come from the adapter's stderr line.
    expect(cc.stop("w").json).toEqual({ systemMessage: "Prosegate · this turn was not reviewed (input too large) · details: /logs/x.log" });
  });

  it("session start and prompt submit say the session may not be reviewed", () => {
    const { cc } = stubbed(END_TURN, { STUB_MODE: "exit1" });
    expect(cc.sessionStart().json).toEqual({ systemMessage: `Prosegate \u00b7 this session may not be reviewed (internal error) \u00b7 details: ${logFile(cc)}` });
    expect(cc.prompt("hi").stdout).toBe("");
  });

  it("takes the reason and the log path from the adapter's own stderr line: a crash fixture through the real adapter (test build)", async () => {
    const cc = new FakeClaudeCode(await testPkg(), { env: testHooks({ crash: "turn-end" }) });
    cc.sessionStart();
    const r = cc.stop("The cache is per tenant.");
    expect(r.code).toBe(0);
    expect(r.stderr).toBe("");
    expect(r.stdout).toBe(`${JSON.stringify({ systemMessage: `Prosegate \u00b7 this turn was not reviewed (internal error) \u00b7 details: ${logFile(cc)}` })}\n`);
    // The same failure in the same session is not shown again.
    expect(cc.stop("Again.", { prompt_id: "p2" })).toMatchObject({ code: 0, stdout: "" });
  });
});

describe("paths with spaces (Windows)", () => {
  let spaced: ReturnType<typeof layoutPkg>;
  beforeAll(async () => {
    spaced = layoutPkg(await buildBundle("release"), join("Program Files (x86)", "pro segate"));
  });

  it("the registered command, run through a shell the way Claude Code runs it, works from a directory with spaces", () => {
    expect(spaced.shim).toContain(" ");
    const home = join(tmpDir(), "My Home", ".prosegate");
    const cmd = commandFor("SessionStart", spaced.shim, false);
    expect(cmd.startsWith('node "')).toBe(true);
    const r = spawnSync(cmd, {
      shell: true,
      input: JSON.stringify({ session_id: SESSION, cwd: tmpDir(), hook_event_name: "SessionStart", source: "startup" }),
      encoding: "utf8",
      env: cleanEnv(home),
    });
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toHaveProperty("hookSpecificOutput.additionalContext");
  });

  it("commandFor writes forward slashes, so Git Bash and PowerShell read the same string", () => {
    expect(commandFor("Stop", "C:\\Program Files\\node_modules\\prosegate\\shims\\claude-code\\hook.mjs", false)).toBe(
      'node "C:/Program Files/node_modules/prosegate/shims/claude-code/hook.mjs" Stop',
    );
  });
});

