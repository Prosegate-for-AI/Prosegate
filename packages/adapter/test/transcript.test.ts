import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { TRANSCRIPT_TAIL_BYTES, toolNames } from "../src/transcript.js";
import { tmpDir } from "./helpers.js";

// 05 and 07 threat 6: the transcript is read only for the tool names of THIS turn, best effort.

const PROMPT = "c0ffee00-1111-4222-8333-444455556666";
const user = (text: string, promptId = PROMPT): object => ({ type: "user", promptId, message: { role: "user", content: text } });
const tool = (name: string, extra: object = {}): object => ({ type: "assistant", ...extra, message: { role: "assistant", content: [{ type: "text", text: "x" }, { type: "tool_use", id: "t", name, input: {} }] } });
const result = (): object => ({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: "ok" }] } });
function write(lines: unknown[], tail = ""): string {
  const dir = tmpDir("pg-transcript-");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "t.jsonl");
  writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n") + tail);
  return file;
}

describe("toolNames", () => {
  it("reads only the tool-use names after the last user prompt: earlier turns, tool results, sub-agent lines and a partial last line", () => {
    const file = write(
      [user("first prompt", "old-prompt"), tool("Bash"), result(), tool("Write"), user("second prompt"), tool("Read"), result(), tool("Edit"), tool("Task", { isSidechain: true }), result(), tool("Bash")],
      '\n{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","na',
    );
    expect(toolNames(file, PROMPT)).toEqual(["Read", "Edit", "Bash"]);
  });

  it("a transcript that lags (this turn's prompt is not in the file yet) gives no names rather than an earlier turn's", () => {
    expect(toolNames(write([user("first prompt", "old-prompt"), tool("Bash"), tool("Write")]), PROMPT)).toEqual([]);
  });

  it("without a prompt id it takes the last prompt in the file", () => {
    expect(toolNames(write([user("a", "p1"), tool("Bash"), user("b", "p2"), tool("Read")]), undefined)).toEqual(["Read"]);
  });

  it("a missing file, an empty file, no prompt at all, or JSON null lines give no names and never throw", () => {
    expect(toolNames(join(tmpDir(), "nope.jsonl"), PROMPT)).toEqual([]);
    expect(toolNames(write([]), PROMPT)).toEqual([]);
    expect(toolNames(write([tool("Bash")]), PROMPT)).toEqual([]);
    expect(toolNames(write([null, user("a"), null, tool("Read"), "text", 5]), PROMPT)).toEqual(["Read"]);
  });

  it("meta lines and prompts made only of tool results do not start a turn", () => {
    const meta = { type: "user", isMeta: true, promptId: PROMPT, message: { content: "meta" } };
    expect(toolNames(write([user("a"), tool("Bash"), meta, tool("Read"), result(), tool("Edit")]), PROMPT)).toEqual(["Bash", "Read", "Edit"]);
  });

  it("a sub-agent's own prompt does not start a new turn (S7)", () => {
    const sub = { type: "user", isSidechain: true, promptId: "sub", message: { content: "sub-agent task" } };
    expect(toolNames(write([user("a"), tool("Read"), sub, tool("Task", { isSidechain: true }), tool("Edit")]), PROMPT)).toEqual(["Read", "Edit"]);
  });

  it("a prompt whose content is a list with a text block starts a turn; one with only tool results does not", () => {
    const listed = { type: "user", promptId: PROMPT, message: { content: [{ type: "text", text: "hello" }] } };
    expect(toolNames(write([user("old", "old"), tool("Bash"), listed, tool("Read")]), PROMPT)).toEqual(["Read"]);
  });

  it("only the tail is read, and a name is capped", () => {
    const filler = Array.from({ length: 40 }, () => tool("Old"));
    const pad = Array.from({ length: Math.ceil(TRANSCRIPT_TAIL_BYTES / 300_000) + 2 }, () => ({ type: "attachment", pad: "x".repeat(300_000) }));
    expect(toolNames(write([user("earlier", "old"), ...filler, ...pad, user("this turn"), tool("Grep")]), PROMPT)).toEqual(["Grep"]);
    expect(toolNames(write([user("a"), tool("n".repeat(1000))]), PROMPT)[0]?.length).toBe(300);
  });
});
