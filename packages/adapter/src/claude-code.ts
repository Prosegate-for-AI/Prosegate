// The Claude Code hook mapping (05 "Claude Code reference mapping", ADR-9, ADR-11, ADR-13, ADR-33): one hook event in, one
// adapter command called, and the answer shaped as what Claude Code reads. It lives in the adapter so the shim stays small and
// this is testable without a process (ADR-34); the shim and the launcher only import it and handle the process.

import { foldClaudeNotice } from "./claude-notice.js";
import { callHook, type HookProblem } from "./hook-bridge.js";
import { toolNames } from "./transcript.js";

export interface HookAnswer {
  sid?: string;
  /** One JSON object for stdout. */
  json?: object;
  /** Plain text for stdout (a UserPromptSubmit inject). */
  text?: string;
  /** For the shim's stderr: the headless summary line, or --debug notes. */
  stderr?: string;
  problem?: HookProblem;
}

type Env = Readonly<Record<string, string | undefined>>;
type Fields = Record<string, unknown>;

const SOURCES = ["startup", "resume", "clear", "compact", "fork"];
const text = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);

/** `headless` when CI or PROSEGATE_MODE says so (05); otherwise `interactive`. */
export function modeOf(env: Env): "headless" | "interactive" {
  const m = (env["PROSEGATE_MODE"] ?? "").trim().toLowerCase();
  const ci = env["CI"] !== undefined && env["CI"] !== "" && !/^(0|false)$/i.test(env["CI"]);
  return m === "headless" || (m !== "interactive" && ci) ? "headless" : "interactive";
}

function unreadable(): HookAnswer {
  const detail = "hook input was not JSON with a session_id";
  return { problem: { why: "its input could not be read", where: null, detail } };
}

export async function claudeCodeHook(p: { event: string; raw: string; env: Env }): Promise<HookAnswer> {
  let input: Fields | null = null;
  try {
    const parsed: unknown = JSON.parse(p.raw.charCodeAt(0) === 0xfeff ? p.raw.slice(1) : p.raw);
    input = typeof parsed === "object" && parsed !== null ? (parsed as Fields) : null;
  } catch {
    // reported below
  }
  const sid = input?.["session_id"];
  if (input === null || typeof sid !== "string") return unreadable();
  const turn = text(input["prompt_id"]) === null ? {} : { turn_id: input["prompt_id"] };
  const ask = async (command: string, payload: Fields, answer: (o: Fields) => Partial<HookAnswer>): Promise<HookAnswer> => {
    const r = await callHook(command, { session_id: sid, ...payload });
    return "problem" in r ? { sid, problem: r.problem } : { sid, stderr: r.stderr, ...answer(r.out) };
  };
  const fold = (notice: unknown): string => foldClaudeNotice(String(notice));

  if (p.event === "SessionStart") {
    const source = SOURCES.includes(String(input["source"])) ? { source: input["source"] } : {};
    const cwd = text(input["cwd"]) ?? process.cwd();
    const start = { harness: "claude-code", cwd, mode: modeOf(p.env), ...source };
    return ask("session-start", start, (o) => {
      const [inject, notice] = [text(o["inject"]), text(o["notice"])];
      if (inject === null && notice === null) return {};
      const context = inject === null ? {} : { hookSpecificOutput: { hookEventName: p.event, additionalContext: inject } };
      return { json: { ...context, ...(notice === null ? {} : { systemMessage: fold(notice) }) } };
    });
  }
  if (p.event === "UserPromptSubmit") {
    const payload = { ...turn, user_message: String(input["prompt"] ?? ""), tool_calls_so_far: [] };
    return ask("turn-start", payload, (o) => (text(o["inject"]) === null ? {} : { text: `${String(o["inject"])}\n` }));
  }
  if (p.event !== "Stop") return { sid };
  const path = input["transcript_path"];
  const payload = {
    ...turn,
    assistant_text: String(input["last_assistant_message"] ?? ""),
    tool_calls: typeof path === "string" ? toolNames(path, input["prompt_id"]) : [],
    continuation: input["stop_hook_active"] === true,
    continue_supported: true,
  };
  return ask("turn-end", payload, (o) => {
    if (o["decision"] === "continue") {
      // ADR-11, ADR-13: feedback_text only; Claude Code shows it to the user, so no systemMessage beside it.
      const feedback = text(o["feedback_text"]);
      if (feedback === null) throw new Error("continue with an empty feedback_text");
      return { json: { hookSpecificOutput: { hookEventName: p.event, additionalContext: feedback } } };
    }
    return text(o["notice"]) === null ? {} : { json: { systemMessage: fold(o["notice"]) } };
  });
}
