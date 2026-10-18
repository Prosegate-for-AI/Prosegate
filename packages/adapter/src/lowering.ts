// ADR-30: lowered enforcement is always visible to the user. The agent can edit any file the user can
// (overlays, state.json, lock files), so prevention is impossible locally; visibility is required.
//
// The test is a full comparison, made at every session-start and turn-end, of the profile as it
// resolves now against the same profile with no local file applied (its baseline). It reads nothing the
// agent can edit except the files that ARE the lowering: the overlays themselves. Enforcement is
// lowered when, against the baseline:
//
//   - the mode is below enforce (a command, the environment, or the profile's own setting);
//   - a rule is switched off, removed or has a lower severity (including through a category);
//   - token_floor_words or reviewer_floor_words is higher;
//   - allow_terms has terms the baseline does not;
//   - pass_cap is lower;
//   - render is `none`;
//   - the reviewer is off, or has fewer categories.
//
// For a profile that exists only in the user's own files, the baseline is the nearest bundled ancestor
// in its `extends` chain, else local/base; the reason then reads "local profile <id>". The record of
// local file hashes taken at session start adds one more reason ("local profile files changed") but is
// never the only signal and can never remove one. `quiet` is not a lowering: it keeps enforcing.

import { BUNDLED_PACK_YAML, effectiveRule, parseRulePackYaml, type ResolvedProfile, type RulePack } from "@prosegate/profiles";
import type { Category } from "@prosegate/schema";
import type { Ctx } from "./ctx.js";
import { MODE_RANK, profileDefaultMode, type EffectiveMode } from "./modes.js";
import { baseProfileId, resolveBaseline, type LoadedSession } from "./profiles.js";
import type { SessionState } from "./schemas.js";

export interface Lowering {
  /** The text for `<what>` in the notice; '' when enforcement is not lowered. */
  what: string;
  /** The mode, when it is below the baseline's default. */
  mode: "advisory" | "off" | null;
  rulesOff: string[];
  /** Rules whose severity a local file lowered, and the categories they belong to. */
  severityLowered: string[];
  categoriesLowered: Category[];
  /** Other ways the profile is weaker than its baseline (floors, allowed terms, pass cap, render, reviewer). */
  other: string[];
  /** A user-file-only profile that is weaker than its baseline: its id. */
  weakProfile: string | null;
  filesChanged: boolean;
}

const SEVERITY_RANK = { block: 2, warn: 1, info: 0 } as const;

export const NOT_LOWERED: Lowering = {
  what: "",
  mode: null,
  rulesOff: [],
  severityLowered: [],
  categoriesLowered: [],
  other: [],
  weakProfile: null,
  filesChanged: false,
};

function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

type RuleRef = RulePack["rules"][number];

export interface Baseline {
  profile: ResolvedProfile;
  /** The profile has no definition outside the user's files, so a stand-in was used. */
  substituted: boolean;
}

/** What the profile is compared with, or null when no baseline can be resolved (nothing to compare). */
export function baselineFor(ctx: Ctx, resolved: ResolvedProfile): Baseline | null {
  const usesLocal = resolved.sources.some((s) => s.origin === "local") || resolved.packs.some((p) => p.origin === "local");
  if (!usesLocal) return { profile: resolved, substituted: false };
  const own = resolveBaseline(ctx, resolved.id);
  if (own !== null) return { profile: own, substituted: false };
  // A profile that exists only in the user's files: its nearest bundled ancestor, else the base.
  const ancestors = resolved.resolved_from.filter((id) => id !== resolved.id).reverse();
  for (const id of [...ancestors, baseProfileId(ctx)]) {
    const found = resolveBaseline(ctx, id);
    if (found !== null) return { profile: found, substituted: true };
  }
  return null;
}

/** The rules the baseline's packs define, read from what is already loaded or, for a different bundled pack, parsed once. */
function baselineRules(baseline: ResolvedProfile, resolved: ResolvedProfile, bodies: readonly RulePack[]): RuleRef[] | null {
  const out: RuleRef[] = [];
  for (const pin of baseline.packs) {
    const index = resolved.packs.findIndex((p) => p.id === pin.id && p.version === pin.version && p.origin === pin.origin);
    const loaded = index === -1 ? undefined : bodies[index];
    if (loaded !== undefined) {
      out.push(...loaded.rules);
      continue;
    }
    if (pin.origin !== "bundled") return null; // synced content cannot be read here
    const yaml = BUNDLED_PACK_YAML[`${pin.id}@${pin.version}`];
    const parsed = yaml === undefined ? null : parseRulePackYaml(yaml);
    if (parsed === null || !parsed.ok) return null;
    out.push(...parsed.value.rules);
  }
  return out;
}

export function computeLowering(p: {
  eff: EffectiveMode;
  resolved: ResolvedProfile;
  baseline: Baseline | null;
  /** The parsed bodies of the packs the profile pins, in the order of `resolved.packs`; empty when not loaded (mode off). */
  bodies: readonly RulePack[];
  /** The record taken at session start (an extra reason only), and the files as they are now. */
  recordedHashes: Readonly<Record<string, string>>;
  currentHashes: Readonly<Record<string, string>>;
}): Lowering {
  const { eff, resolved } = p;
  // Under `required` local files and modes cannot lower anything (ADR-18).
  if (eff.required) return NOT_LOWERED;

  const reference = p.baseline?.profile ?? resolved;
  const substituted = p.baseline?.substituted === true;
  const defaultMode = profileDefaultMode(reference);
  const belowDefault = MODE_RANK[eff.mode] < MODE_RANK[defaultMode] && (eff.mode === "advisory" || eff.mode === "off");
  const mode = belowDefault ? (eff.mode as "advisory" | "off") : null;
  // A user-file-only profile that sets its own mode is reported as the profile, not as a session mode.
  const modeFromProfile = mode !== null && substituted && eff.source === "profile";

  const rulesOff: string[] = [];
  const severityLowered: string[] = [];
  const categories = new Set<Category>();
  const other: string[] = [];

  // Nothing to compare when the baseline is the very profile in effect (no local file applies).
  if (p.baseline !== null && p.baseline.profile !== resolved) {
    const base = p.baseline.profile;
    // Rules: only when the pack bodies were loaded (they are not when the mode is off).
    if (eff.mode !== "off" && p.bodies.length === resolved.packs.length) {
      const before = baselineRules(base, resolved, p.bodies);
      if (before !== null) {
        const now = new Map<string, RuleRef>();
        for (const body of p.bodies) for (const rule of body.rules) now.set(rule.id, rule);
        for (const rule of before) {
          let was;
          try {
            was = effectiveRule(base, rule);
          } catch {
            continue;
          }
          if (!was.enabled) continue;
          const current = now.get(rule.id);
          if (current === undefined) {
            rulesOff.push(rule.id); // the rule is gone from the packs in effect
            categories.add(rule.category);
            continue;
          }
          let is;
          try {
            is = effectiveRule(resolved, current);
          } catch {
            rulesOff.push(rule.id);
            categories.add(rule.category);
            continue;
          }
          if (!is.enabled) {
            rulesOff.push(rule.id);
            categories.add(rule.category);
          } else if (SEVERITY_RANK[is.severity] < SEVERITY_RANK[was.severity]) {
            severityLowered.push(rule.id);
            categories.add(rule.category);
          }
        }
      }
    }
    if (resolved.thresholds.token_floor_words > base.thresholds.token_floor_words || resolved.thresholds.reviewer_floor_words > base.thresholds.reviewer_floor_words) {
      other.push("review thresholds raised");
    }
    const had = new Set(base.allow_terms);
    const added = resolved.allow_terms.filter((t) => !had.has(t)).length;
    if (added > 0) other.push(`${plural(added, "allowed term")} added`);
    if (resolved.enforcement.pass_cap < base.enforcement.pass_cap) other.push("revision passes reduced");
    if (resolved.enforcement.render === "none" && base.enforcement.render !== "none") other.push("notices turned off by the profile");
    if (base.reviewer.enabled && !resolved.reviewer.enabled) other.push("reviewer switched off");
    else if (base.reviewer.categories.some((c) => !resolved.reviewer.categories.includes(c))) other.push("reviewer categories removed");
  }

  // The integrity record is an extra reason: it can add a line, never remove one.
  let filesChanged = false;
  for (const key of new Set([...Object.keys(p.recordedHashes), ...Object.keys(p.currentHashes)])) {
    if (p.recordedHashes[key] !== p.currentHashes[key]) filesChanged = true;
  }

  const profileModeLower = MODE_RANK[profileDefaultMode(resolved)] < MODE_RANK[defaultMode];
  const profileWeaker = rulesOff.length > 0 || severityLowered.length > 0 || other.length > 0 || profileModeLower;
  const weakProfile = substituted && profileWeaker ? resolved.id : null;
  const parts: string[] = [];
  if (mode !== null && !modeFromProfile) parts.push(mode === "off" ? "off" : "advisory");
  if (weakProfile !== null) {
    parts.push(`local profile ${weakProfile}`);
  } else {
    if (rulesOff.length > 0) parts.push(`${plural(rulesOff.length, "rule")} switched off`);
    if (severityLowered.length > 0) parts.push(`severity lowered on ${plural(severityLowered.length, "rule")}`);
    parts.push(...other);
  }
  if (filesChanged) parts.push("local profile files changed since the session started");
  return {
    what: parts.join(", "),
    mode,
    rulesOff,
    severityLowered,
    categoriesLowered: [...categories].sort(),
    other,
    weakProfile,
    filesChanged,
  };
}

/** The lowering facts for one session-start, turn-end or status (ADR-30). */
export function lowerFor(ctx: Ctx, state: SessionState, eff: EffectiveMode, loaded: LoadedSession): Lowering {
  if (eff.required) return NOT_LOWERED;
  return computeLowering({
    eff,
    resolved: loaded.resolved,
    baseline: baselineFor(ctx, loaded.resolved),
    bodies: loaded.bodies,
    recordedHashes: state.local_hashes,
    currentHashes: loaded.local.hashes,
  });
}

/** ADR-30, 09. */
export function loweredNoticeLine(what: string): string {
  return `Prosegate · enforcement is lowered in this session (${what}) · prosegate status`;
}

export function isLowered(l: Lowering): boolean {
  return l.what !== "";
}
