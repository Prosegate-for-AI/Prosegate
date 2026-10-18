import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HookCall } from "../src/hook-bridge.js";
import { claudeCodeHook, modeOf } from "../src/claude-code.js";
import { tmpDir } from "./helpers.js";

// The Claude Code mapping (05, ADR-9, ADR-11, ADR-13, ADR-30, ADR-31, ADR-33): what is sent to the adapter for each hook event
// and what is written back. The adapter itself is replaced by a recorder; the golden tests run the real one.

const state = vi.hoisted(() => ({
  calls: [] as Array<{ command: string; payload: Record<string, unknown> }>,
  reply: ((): HookCall => ({ out: {}, stderr: "" })) as (command: string) => HookCall,
}));
vi.mock("../src/hook-bridge.js", () => ({
  callHook: (command: string, payload: Record<string, unknown>): Promise<HookCall> => {
    state.calls.push({ command, payload });
    return Promise.resolve(state.reply(command));
  },
}));

const SESSION = "5d1b8a52-2f0e-4c3e-9a77-0b1e7f3c9a10";
const PROMPT = "c0ffee00-1111-4222-8333-444455556666";
const answer = (out: Record<string, unknown>, stderr = ""): HookCall => ({ out, stderr });
const call = (event: string, fields: Record<string, unknown>, env: Record<string, string> = {}) =>
  claudeCodeHook({ event, raw: JSON.stringify({ session_id: SESSION, ...fields }), env });

beforeEach(() => {
  state.calls.length = 0;
  state.reply = () => answer({});
});

describe("SessionStart", () => {
  const reply = { inject: "Guard line.\nActive profile: Base.", notice: "Prosegate · profile pr-description updated to v5 (2 rules changed)" };

  it("sends session-start the session, cwd, mode and source; inject becomes additionalContext and notice becomes systemMessage", async () => {
    state.reply = () => answer(reply);
    const r = await call("SessionStart", { cwd: "/work", source: "resume" });
    expect(state.calls).toEqual([{ command: "session-start", payload: { session_id: SESSION, harness: "claude-code", cwd: "/work", mode: "interactive", source: "resume" } }]);
    expect(r.json).toEqual({
      hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: "Guard line.\nActive profile: Base." },
      systemMessage: "Prosegate · profile pr-description updated to v5 (2 rules changed)",
    });
    expect(r.sid).toBe(SESSION);
  });

  it("passes every Claude Code source through and drops one it does not know", async () => {
    for (const s of ["startup", "resume", "clear", "compact", "fork", "something-new"]) await call("SessionStart", { cwd: "/w", source: s });
    expect(state.calls.map((c) => c.payload["source"])).toEqual(["startup", "resume", "clear", "compact", "fork", undefined]);
  });

  it("says nothing when there is nothing to say, and folds a multi-line notice into the one notice (ADR-33)", async () => {
    expect((await call("SessionStart", { cwd: "/w" })).json).toBeUndefined();
    state.reply = () => answer({ inject: "", notice: ["Prosegate · enforcement is lowered in this session (advisory) · prosegate status", "Prosegate · only the first 100 KB of prose in this reply was reviewed"].join("\n") });
    const r = await call("SessionStart", { cwd: "/w" });
    expect(r.json).toEqual({ systemMessage: "Prosegate · only the first 100 KB of prose in this reply was reviewed · enforcement is lowered in this session (advisory)" });
  });

  it.each([
    ["CI is set", { CI: "true" }, "headless"],
    ["PROSEGATE_MODE=headless", { PROSEGATE_MODE: "headless" }, "headless"],
    ["CI=false", { CI: "false" }, "interactive"],
    ["CI=0", { CI: "0" }, "interactive"],
    ["PROSEGATE_MODE=interactive beats CI", { CI: "1", PROSEGATE_MODE: "interactive" }, "interactive"],
    ["PROSEGATE_MODE=advisory is not a harness mode", { PROSEGATE_MODE: "advisory" }, "interactive"],
    ["nothing is set", {}, "interactive"],
  ])("mode when %s", async (_name, env, expected) => {
    expect(modeOf(env)).toBe(expected);
    await call("SessionStart", { cwd: "/w" }, env);
    expect(state.calls[0]?.payload["mode"]).toBe(expected);
  });
});

describe("UserPromptSubmit", () => {
  it("sends turn-start the prompt and prompt_id as turn_id (ADR-33), and returns inject as plain text", async () => {
    state.reply = () => answer({ inject: "Use the pr-description profile.", candidate: null });
    const r = await call("UserPromptSubmit", { prompt: "write the PR description", prompt_id: PROMPT });
    expect(state.calls).toEqual([{ command: "turn-start", payload: { session_id: SESSION, turn_id: PROMPT, user_message: "write the PR description", tool_calls_so_far: [] } }]);
    expect(r.text).toBe("Use the pr-description profile.\n");
  });

  it("says nothing when inject is null, and leaves turn_id out when Claude Code sends no prompt_id", async () => {
    state.reply = () => answer({ inject: null, candidate: null });
    const r = await call("UserPromptSubmit", { prompt: "hello" });
    expect(r.text).toBeUndefined();
    expect("turn_id" in (state.calls[0]?.payload ?? {})).toBe(false);
  });
});

describe("Stop", () => {
  it("sends turn-end the turn text, prompt_id as turn_id, the continuation flag and continue_supported (ADR-30, ADR-31)", async () => {
    await call("Stop", { prompt_id: PROMPT, last_assistant_message: "The reply.", stop_hook_active: true });
    await call("Stop", { prompt_id: PROMPT, last_assistant_message: "Another reply." });
    const base = { session_id: SESSION, turn_id: PROMPT, tool_calls: [], continue_supported: true };
    expect(state.calls.map((c) => c.payload)).toEqual([
      { ...base, assistant_text: "The reply.", continuation: true },
      { ...base, assistant_text: "Another reply.", continuation: false },
    ]);
  });

  it("reads this turn's tool names from the transcript path", async () => {
    const file = join(tmpDir("pg-transcript-"), "t.jsonl");
    const lines = [
      { type: "user", promptId: PROMPT, message: { content: "do it" } },
      { type: "assistant", message: { content: [{ type: "tool_use", name: "Bash" }] } },
    ];
    writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n"));
    await call("Stop", { prompt_id: PROMPT, transcript_path: file, last_assistant_message: "x" });
    await call("Stop", { prompt_id: PROMPT, transcript_path: 42, last_assistant_message: "x" });
    expect(state.calls.map((c) => c.payload["tool_calls"])).toEqual([["Bash"], []]);
  });

  it("continue: additionalContext = feedback_text exactly, and no systemMessage even when the adapter sent a notice (ADR-13)", async () => {
    state.reply = () => answer({ decision: "continue", feedback_text: "[Prosegate] 1 finding\nReply with the revised response only.", notice: "Prosegate · a notice" });
    const r = await call("Stop", { prompt_id: PROMPT, last_assistant_message: "x" });
    expect(JSON.stringify(r.json)).toBe('{"hookSpecificOutput":{"hookEventName":"Stop","additionalContext":"[Prosegate] 1 finding\\nReply with the revised response only."}}');
  });

  it("an empty feedback_text on continue is an error the launcher turns into a visible fail-open (ADR-33)", async () => {
    state.reply = () => answer({ decision: "continue", feedback_text: "" });
    await expect(call("Stop", { prompt_id: PROMPT, last_assistant_message: "x" })).rejects.toThrow("continue with an empty feedback_text");
  });

  it("allow with a notice: systemMessage only, folded to one notice with at most three finding lines", async () => {
    const rows = ['  a "1"', '  b "2"', '  c "3"', '  d "4"'];
    state.reply = () => answer({ decision: "allow", notice: ["Prosegate · enforcement is lowered in this session (advisory) · prosegate status", "Prosegate · profile base · 4 findings (filler 4) · advisory, not enforced", ...rows].join("\n") });
    const r = await call("Stop", { prompt_id: PROMPT, last_assistant_message: "x" });
    expect(r.json).toEqual({
      systemMessage: ["Prosegate · profile base · 4 findings (filler 4) · advisory, not enforced · enforcement is lowered in this session (advisory)", ...rows.slice(0, 3), "  …and 1 more"].join("\n"),
    });
  });

  it("allow without a notice says nothing, and the adapter's stderr is passed on (the headless summary line, 09)", async () => {
    state.reply = () => answer({ decision: "allow", notice: null }, "Prosegate | turn 1 | profile base | clean\n");
    const r = await call("Stop", { prompt_id: PROMPT, last_assistant_message: "x" });
    expect(r.json).toBeUndefined();
    expect(r.stderr).toBe("Prosegate | turn 1 | profile base | clean\n");
  });

  it("a problem from the adapter comes back with the session id", async () => {
    state.reply = () => ({ problem: { why: "input too large", where: "/logs/x.log", detail: "turn-end: exit 1" } });
    const r = await call("Stop", { prompt_id: PROMPT, last_assistant_message: "x" });
    expect(r).toEqual({ sid: SESSION, problem: { why: "input too large", where: "/logs/x.log", detail: "turn-end: exit 1" } });
  });
});

describe("unreadable input and other events", () => {
  it.each(["", "{nope", "[]", "null", '{"hook_event_name":"Stop"}', '{"session_id":5}'])("%j is a problem with its own reason, and the adapter is not called", async (raw) => {
    const r = await claudeCodeHook({ event: "Stop", raw, env: {} });
    expect(r.problem?.why).toBe("its input could not be read");
    expect(state.calls).toEqual([]);
  });

  it("a byte order mark on the input is stripped, not an error (S14)", async () => {
    const raw = String.fromCharCode(0xfeff) + JSON.stringify({ session_id: SESSION, prompt_id: PROMPT, last_assistant_message: "text" });
    const r = await claudeCodeHook({ event: "Stop", raw, env: {} });
    expect(r.problem).toBeUndefined();
    expect(state.calls[0]?.payload["assistant_text"]).toBe("text");
  });

  it("an unknown event calls nothing", async () => {
    expect(await call("PostToolUse", {})).toEqual({ sid: SESSION });
    expect(state.calls).toEqual([]);
  });
});
