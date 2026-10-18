// Local log: ~/.prosegate/logs/<date>.log (07). One line per entry: timestamp, level, code, message.
// Codes are fixed identifiers; messages are ours and never carry prose, user text or exception
// messages (Node's JSON.parse errors quote the input, for instance). Logging never throws.

import { join } from "node:path";
import { appendLine, ensureDir } from "./fs-secure.js";
import type { Ctx } from "./ctx.js";

export type LogLevel = "info" | "warn" | "error";

/** Strips anything but printable ASCII and caps the length, so a message cannot carry prose or forge a line. */
export function cleanLogText(text: string, max = 200): string {
  return text.replace(/[^\x20-\x7e]/g, "?").slice(0, max);
}

export function logLine(ctx: Ctx, level: LogLevel, code: string, message: string): string {
  return `${new Date(ctx.now()).toISOString()} ${level} ${cleanLogText(code, 64)} ${cleanLogText(message)}\n`;
}

export function log(ctx: Ctx, level: LogLevel, code: string, message = ""): void {
  try {
    const dir = join(ctx.home, "logs");
    ensureDir(dir, ctx.platform);
    const day = new Date(ctx.now()).toISOString().slice(0, 10);
    appendLine(join(dir, `${day}.log`), logLine(ctx, level, code, message));
  } catch {
    // A log failure must never turn into a hook failure.
  }
}

/**
 * What can be said about an unknown exception without quoting it: its class name, its errno-style
 * code if it has one, and the first stack frame inside our own bundle (a file:line, no text).
 */
export function describeError(error: unknown): string {
  if (error === null || typeof error !== "object") return "non-object exception";
  const name = (error as { name?: unknown }).name;
  const code = (error as { code?: unknown }).code;
  const stack = (error as { stack?: unknown }).stack;
  const frame = typeof stack === "string" ? /\(?((?:file:\/\/)?[^\s()]+:\d+:\d+)\)?\s*$/m.exec(stack.split("\n").slice(1).join("\n")) : null;
  const parts = [typeof name === "string" ? name : "Error"];
  if (typeof code === "string" || typeof code === "number") parts.push(`code=${String(code)}`);
  if (frame?.[1] !== undefined) parts.push(`at ${frame[1].split(/[\\/]/).pop() ?? ""}`);
  return parts.join(" ");
}
