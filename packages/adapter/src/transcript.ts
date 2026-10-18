// Tool names for one turn, read from Claude Code's transcript (05, 07 threat 6). Best effort: at Stop the file may lag, its last line
// may be partial, and it holds the whole session. Only the tail is read, only the lines after this turn's user prompt count, and
// nothing is ever written. The turn text itself comes from `last_assistant_message`, never from here (ADR-9).

import { closeSync, fstatSync, openSync, readSync } from "node:fs";

/** How much of the file's end is read: a turn with more than this between its prompt and Stop reports no tools (it never reads an earlier turn). */
export const TRANSCRIPT_TAIL_BYTES = 4 * 1024 * 1024;
const MAX_NAME = 300;

interface Line {
  type?: unknown;
  isSidechain?: unknown;
  isMeta?: unknown;
  promptId?: unknown;
  message?: { content?: unknown } | null;
}

/** A line that starts a turn: a user message with text, not a tool result, not a sub-agent's. */
function isPrompt(line: Line | null): boolean {
  if (line === null || typeof line !== "object" || line.type !== "user" || line.isSidechain === true || line.isMeta === true) return false;
  const content = line.message?.content;
  return typeof content === "string" || (Array.isArray(content) && content.some((b: unknown) => typeof b === "object" && b !== null && (b as { type?: unknown }).type === "text"));
}

export function toolNames(path: string, promptId?: unknown): string[] {
  try {
    const fd = openSync(path, "r");
    try {
      const size = fstatSync(fd).size;
      const start = Math.max(0, size - TRANSCRIPT_TAIL_BYTES);
      const buf = Buffer.alloc(size - start);
      readSync(fd, buf, 0, buf.length, start);
      // A read that starts mid-file begins inside a line: drop it.
      const lines = buf.toString("utf8").split("\n").slice(start > 0 ? 1 : 0);
      const parsed: Array<Line | null> = lines.flatMap((l) => {
        try {
          return [JSON.parse(l) as Line | null];
        } catch {
          return [];
        }
      });
      // The last prompt line; if the file names its prompts it must be this turn's, or a file that lags would hand back an earlier turn.
      let turn = -1;
      for (let i = parsed.length - 1; i >= 0 && turn === -1; i--) if (isPrompt(parsed[i] ?? null)) turn = i;
      const prompt = parsed[turn];
      if (turn === -1 || prompt === null || prompt === undefined) return [];
      if (typeof promptId === "string" && promptId !== "" && typeof prompt.promptId === "string" && prompt.promptId !== "" && prompt.promptId !== promptId) return [];
      const names: string[] = [];
      for (const line of parsed.slice(turn + 1)) {
        const content = line?.type === "assistant" && line.isSidechain !== true ? line.message?.content : null;
        if (!Array.isArray(content)) continue;
        for (const b of content as Array<{ type?: unknown; name?: unknown } | null>) {
          if (b !== null && typeof b === "object" && b.type === "tool_use" && typeof b.name === "string") names.push(b.name.slice(0, MAX_NAME));
        }
      }
      return names;
    } finally {
      closeSync(fd);
    }
  } catch {
    return [];
  }
}
