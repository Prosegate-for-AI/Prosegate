// ADR-27: commands that lower enforcement refuse when run from an agent's tool context. The test is
// "a harness marker in the environment together with a non-TTY stdin". Claude Code sets CLAUDECODE in
// the environment of every shell tool call; other shims register their own marker here. Residual
// (stated in ADR-27): an agent that fakes a TTY or unsets the variable can still get through; the
// attempt stays visible because every mode change emits `override_used` telemetry.

import type { Ctx } from "./ctx.js";

/** Environment variables that mean "a coding agent is running this command". */
export const AGENT_MARKERS: readonly string[] = ["CLAUDECODE"];

export function isAgentContext(ctx: Pick<Ctx, "env" | "stdinIsTTY">): boolean {
  const marked = AGENT_MARKERS.some((name) => {
    const v = ctx.env[name];
    return v !== undefined && v !== "";
  });
  return marked && !ctx.stdinIsTTY;
}

export function agentRefusal(command: string): string {
  return `prosegate ${command} must be run by you in a terminal, not by the agent.`;
}
