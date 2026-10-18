// Enforcement mode for one turn: the session's explicit override, the profile's default, the
// process environment (09 "PROSEGATE_MODE=advisory|off ... Process"), and org policy `required`
// (ADR-18), which beats everything that would lower enforcement.

import type { ResolvedProfile } from "@prosegate/profiles";
import type { Ctx } from "./ctx.js";
import type { Mode, SessionState } from "./schemas.js";

export interface EffectiveMode {
  mode: Mode;
  /** The user (a command or the environment) lowered enforcement: `override_used` in telemetry. */
  overrideUsed: boolean;
  headless: boolean;
  required: boolean;
}

/** How far a mode is from full enforcement; used to let the lower of two requests win. */
const RANK: Record<Mode, number> = { off: 0, advisory: 1, quiet: 2, enforce: 2 };

function envFlag(value: string | undefined): boolean {
  return value !== undefined && value !== "" && value.toLowerCase() !== "false" && value !== "0";
}

/**
 * 05 says PROSEGATE_MODE is `interactive` or `headless`; 09 says it is `advisory` or `off`. Both are
 * read from the one variable: the first pair sets the harness mode, the second sets enforcement.
 */
export function envModes(env: Readonly<Record<string, string | undefined>>): { harness: "interactive" | "headless" | null; enforcement: Mode | null } {
  const v = (env["PROSEGATE_MODE"] ?? "").trim().toLowerCase();
  return {
    harness: v === "headless" || v === "interactive" ? v : null,
    enforcement: v === "advisory" || v === "off" ? v : null,
  };
}

export function effectiveMode(ctx: Ctx, state: SessionState, resolved: ResolvedProfile): EffectiveMode {
  const env = envModes(ctx.env);
  const headless = env.harness === "headless" || (env.harness === null && (envFlag(ctx.env["CI"]) || state.context_mode === "headless"));
  const required = resolved.enforcement.required;
  if (required) {
    // The session may not turn enforcement off; `quiet` keeps it on, so it is still allowed.
    return { mode: state.mode === "quiet" ? "quiet" : "enforce", overrideUsed: false, headless, required };
  }
  const profileDefault: Mode = resolved.enforcement.mode === "advisory" ? "advisory" : "enforce";
  let mode: Mode = state.mode ?? profileDefault;
  if (env.enforcement !== null && RANK[env.enforcement] < RANK[mode]) mode = env.enforcement;
  const overrideUsed = mode === "off" || (mode === "advisory" && (state.mode === "advisory" || env.enforcement === "advisory"));
  return { mode, overrideUsed, headless, required };
}

/** What the shim shows the user for this turn (09 render modes). */
export function renderFor(eff: EffectiveMode, resolved: ResolvedProfile, phase: "pass1" | "pass2" | "shipped"): "diff" | "summary" | "none" {
  if (eff.mode === "quiet" || eff.mode === "off") return "none";
  if (eff.headless) return "summary";
  const configured = resolved.enforcement.render;
  if (configured === "none") return "none";
  return phase === "pass2" ? "summary" : configured;
}
