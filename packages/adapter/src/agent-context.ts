// ADR-27, ADR-30: commands that lower enforcement, or change what the next turn is held to (`profile <id>`;
// the model's own route is the select_profile tool, Phase 5), refuse when run from an agent's tool context. The
// test is "a harness marker in the environment together with a non-TTY stdin". A marker counts as
// set when it is present at all, empty or not. Claude Code sets CLAUDECODE and the CLAUDE_CODE_*
// variables in the environment of every shell tool call; other shims register their own marker here.
//
// Residual (stated in ADR-27 and ADR-30): a deliberate agent can still get past this. `env -u` of
// every marker works, and on Windows `Start-Process` opens a new console, whose stdin is a TTY. The
// lowered-enforcement notice (lowering.ts) is what catches those: the user is told, once per session,
// whatever path lowered enforcement.

import type { Ctx } from "./ctx.js";

/** Environment variables that mean "a coding agent is running this command". */
export const AGENT_MARKERS: readonly string[] = ["CLAUDECODE", "CLAUDE_CODE_CHILD_SESSION", "CLAUDE_CODE_SESSION_ID", "CLAUDE_CODE_ENTRYPOINT"];

export function isAgentContext(ctx: Pick<Ctx, "env" | "stdinIsTTY">): boolean {
  // Windows environment names are case-insensitive; compare upper-cased names.
  const present = new Set(Object.keys(ctx.env).map((k) => k.toUpperCase()));
  const marked = AGENT_MARKERS.some((name) => present.has(name));
  return marked && !ctx.stdinIsTTY;
}

/** ADR-28 wording. `command` is `advisory`, `off`, `quiet`, `rule off` or `profile`. */
export function agentRefusal(command: string): string {
  return `Prosegate: ${command} was refused because it looks like the agent ran it. In Claude Code, a command typed after ! counts as the agent; run it in a separate terminal.`;
}
