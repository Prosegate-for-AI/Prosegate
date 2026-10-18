// ADR-30: lowered enforcement is always visible to the user. The agent can edit any file the user can
// (overlays, state.json, lock files), so prevention is impossible locally; visibility is required.
//
// Effective enforcement is "lowered" when it is weaker than the active profile's OWN definition, by any
// path: a mode below enforce (command, environment or an edited state.json); a local overlay that lowers
// the mode, lowers severities or switches rules off; or local profile and pack files that changed since
// the session started. This module computes that from facts the turn already has. The caller shows the
// one-line notice (through `notice` / systemMessage, never the model) once, and again when the reason
// changes, and reports `override_used` for every turn on which it holds.
//
// `quiet` is not a lowering: it keeps enforcing and only hides Prosegate's own notices.

import type { CompiledPack } from "@prosegate/engine";
import { effectiveRule, type ResolvedProfile } from "@prosegate/profiles";
import type { Category } from "@prosegate/schema";
import { MODE_RANK, profileDefaultMode, type EffectiveMode } from "./modes.js";
import type { SessionState } from "./schemas.js";

export interface Lowering {
  /** The text for `<what>` in the notice; '' when enforcement is not lowered. */
  what: string;
  /** The mode, when it is below the profile's own default. */
  mode: "advisory" | "off" | null;
  rulesOff: string[];
  /** Rules whose severity a local file lowered, and the categories they belong to. */
  severityLowered: string[];
  categoriesLowered: Category[];
  filesChanged: boolean;
}

const SEVERITY_RANK = { block: 2, warn: 1, info: 0 } as const;

export const NOT_LOWERED: Lowering = { what: "", mode: null, rulesOff: [], severityLowered: [], categoriesLowered: [], filesChanged: false };

function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

export function computeLowering(p: {
  state: SessionState;
  eff: EffectiveMode;
  resolved: ResolvedProfile;
  /** The same profile with no local file applied; null if it has no such definition. */
  baseline: ResolvedProfile | null;
  /** The packs the profile pinned; empty when they were not loaded (mode off). */
  packs: readonly CompiledPack[];
  /** sha256 of the local files as they are now. */
  currentHashes: Readonly<Record<string, string>>;
}): Lowering {
  const { state, eff, resolved, baseline, packs } = p;
  // Under `required` local files and modes cannot lower anything (ADR-18).
  if (eff.required) return NOT_LOWERED;

  const reference = baseline ?? resolved;
  const defaultMode = profileDefaultMode(reference);
  const mode = MODE_RANK[eff.mode] < MODE_RANK[defaultMode] && (eff.mode === "advisory" || eff.mode === "off") ? eff.mode : null;

  const rulesOff: string[] = [];
  const severityLowered: string[] = [];
  const categories = new Set<Category>();
  if (baseline !== null && eff.mode !== "off") {
    for (const pack of packs) {
      for (const rule of pack.rules) {
        let now;
        let before;
        try {
          now = effectiveRule(resolved, rule);
          before = effectiveRule(baseline, rule);
        } catch {
          continue; // the baseline does not pin this pack (a local pack), so it has nothing to lower
        }
        if (before.enabled && !now.enabled) {
          rulesOff.push(rule.id);
          categories.add(rule.category);
        } else if (before.enabled && now.enabled && SEVERITY_RANK[now.severity] < SEVERITY_RANK[before.severity]) {
          severityLowered.push(rule.id);
          categories.add(rule.category);
        }
      }
    }
  }

  // Local files changed since the session started (the integrity record, taken at session start).
  let filesChanged = false;
  const recorded = state.local_hashes;
  for (const key of new Set([...Object.keys(recorded), ...Object.keys(p.currentHashes)])) {
    if (recorded[key] !== p.currentHashes[key]) filesChanged = true;
  }

  const parts: string[] = [];
  if (mode !== null) parts.push(mode === "off" ? "off" : "advisory");
  if (rulesOff.length > 0) parts.push(`${plural(rulesOff.length, "rule")} switched off`);
  if (severityLowered.length > 0) parts.push(`severity lowered on ${plural(severityLowered.length, "rule")}`);
  if (filesChanged) parts.push("local profile files changed since the session started");
  return {
    what: parts.join(", "),
    mode,
    rulesOff,
    severityLowered,
    categoriesLowered: [...categories].sort(),
    filesChanged,
  };
}

/** ADR-30, 09. */
export function loweredNoticeLine(what: string): string {
  return `Prosegate · enforcement is lowered in this session (${what}) · prosegate status`;
}

export function isLowered(l: Lowering): boolean {
  return l.what !== "";
}
