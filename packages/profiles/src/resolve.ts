import semver from "semver";
import {
  DEFAULT_THRESHOLDS,
  REVIEWER_CATEGORIES,
  type Category,
  type Severity,
} from "@prosegate/schema";
import { ResolutionError, summariseIssues } from "./errors.js";
import { parseProfileYaml, type Profile } from "./profile.js";
import type { RulePack } from "./rulepack.js";
import {
  OrgPolicySchema,
  SNAPSHOT_SCHEMA,
  contentHash,
  type OrgPolicy,
  type ResolvedProfile,
} from "./snapshot.js";
import { zodToIssues } from "./yaml.js";

/** 04: "chain depth ≤ 3 (base → domain → project)". Counted in distinct profile ids. */
export const MAX_PROFILE_DEPTH = 3;
/** Hard stop for the walk so a pathological source set cannot make resolution unbounded. */
const WALK_LIMIT = 32;

/** A synced (or bundled) profile document. `signed` is the adapter's verdict on its signature (06). */
export interface ProfileSource {
  yaml: string;
  signed: boolean;
}

/** One available version of a rule pack. The resolver needs versions, not pack bodies. */
export interface PackVersionSource {
  version: string;
  signed: boolean;
}

export interface ResolutionSources {
  /** Synced and bundled profiles, keyed by profile id. */
  profiles: Readonly<Record<string, ProfileSource>>;
  /** Available pack versions, keyed by pack id. */
  packs: Readonly<Record<string, readonly PackVersionSource[]>>;
}

/** Files under `~/.prosegate/`: unsigned-but-trusted (06 "Signing"). */
export interface LocalOverlay {
  profiles?: Readonly<Record<string, { yaml: string }>>;
  /** Local pack ids with their available versions. */
  packs?: Readonly<Record<string, readonly string[]>>;
}

export interface ResolveOptions {
  /**
   * Org policy (06 `/orgs/{id}/policy`). 06 says "policy is merged into every org profile at
   * resolution": the caller passes the policy of the org that owns the profile being resolved, and
   * the resolver applies it to this resolution. Omit it for a personal or free-tier profile.
   */
  policy?: OrgPolicy | undefined;
  local?: LocalOverlay | undefined;
}

interface Layer {
  id: string;
  /** Names the layer in messages: the id, plus a marker for a local overlay. */
  label: string;
  profile: Profile;
  origin: "synced" | "local";
  signed: boolean;
}

interface Node {
  id: string;
  /** Synced document first, then the local overlay of it if there is one. */
  layers: Layer[];
}

const has = (record: object | undefined, key: string): boolean => record !== undefined && Object.hasOwn(record, key);

function parseLayer(id: string, yaml: string, origin: "synced" | "local", signed: boolean): Layer {
  const label = origin === "local" ? `${id} (local overlay)` : id;
  const parsed = parseProfileYaml(yaml);
  if (!parsed.ok) {
    throw new ResolutionError(
      "invalid_profile",
      `Profile '${label}' is invalid: ${summariseIssues(parsed.error.issues)}`,
      [id],
      parsed.error.issues,
    );
  }
  if (parsed.value.id !== id) {
    throw new ResolutionError(
      "invalid_profile",
      `Profile stored as '${id}' declares id '${parsed.value.id}'`,
      [id, parsed.value.id],
      [{ path: "id", message: `expected '${id}'` }],
    );
  }
  return { id, label, profile: parsed.value, origin, signed };
}

function loadNode(id: string, sources: ResolutionSources, local: LocalOverlay | undefined, childId: string | null): Node {
  const layers: Layer[] = [];
  const synced = has(sources.profiles, id) ? sources.profiles[id] : undefined;
  if (synced !== undefined) layers.push(parseLayer(id, synced.yaml, "synced", synced.signed));
  const overlay = has(local?.profiles, id) ? local?.profiles?.[id] : undefined;
  if (overlay !== undefined) layers.push(parseLayer(id, overlay.yaml, "local", false));
  if (layers.length === 0) {
    throw new ResolutionError(
      "missing_parent",
      childId === null ? `Profile '${id}' was not found` : `Profile '${childId}' extends '${id}', which was not found`,
      childId === null ? [id] : [childId, id],
    );
  }
  return { id, layers };
}

function checkLocalPacks(sources: ResolutionSources, local: LocalOverlay | undefined): void {
  for (const [packId, localVersions] of Object.entries(local?.packs ?? {})) {
    if (has(sources.packs, packId)) {
      const synced = (sources.packs[packId] ?? []).map((v) => v.version);
      throw new ResolutionError(
        "pack_conflict_local_synced",
        `Local rule pack '${packId}' (versions: ${localVersions.join(", ") || "none"}) conflicts with synced rule pack '${packId}' (versions: ${synced.join(", ") || "none"}); a local pack may not reuse a synced pack's id`,
        [packId],
      );
    }
  }
}

interface PackPin {
  range: string;
  pinnedBy: string;
  label: string;
}

type RuleState = {
  enabled?: { value: boolean; origin: string };
  severity?: { value: Severity; origin: string };
};

/**
 * Resolves a leaf profile into one immutable snapshot (04 "Inheritance and resolution").
 *
 * Walks `extends` from the leaf to the root, then merges root-first so the child wins:
 *  - `rule_packs`: union by id; the child's range wins, but two ranges with no overlap are a
 *    `range_conflict`. The winning range is the child's own range, not the intersection. Each pack
 *    then resolves to the highest available version in that range.
 *  - `overrides.categories|rules|thresholds`: deep merge, child wins per key (a rule override's
 *    `enabled` and `severity` merge separately, each with its own origin).
 *  - `allow_terms`: union. `reviewer.register`: whole-object replace.
 *  - `reviewer.enabled|categories`, `enforcement.*`, `trigger.*`: replaced when present.
 *
 * Local overlay (04 "Versioning, pinning and caching"): a local profile with the id of a synced
 * profile merges as a child of it (local wins) and counts as the same chain entry, so it does not
 * count toward the depth limit. A local pack with a synced pack's id is `pack_conflict_local_synced`
 * whether or not any profile uses it.
 *
 * Throws {@link ResolutionError}. Pure: no I/O, no clock.
 */
export function resolveProfile(leafId: string, sources: ResolutionSources, opts: ResolveOptions = {}): ResolvedProfile {
  const local = opts.local;
  const policy = parsePolicy(opts.policy);
  checkLocalPacks(sources, local);

  // 1. Walk leaf to root.
  const walked: Node[] = [];
  const seen = new Set<string>();
  let next: string | undefined = leafId;
  let childId: string | null = null;
  while (next !== undefined) {
    if (seen.has(next)) {
      const path = [...walked.map((n) => n.id), next];
      throw new ResolutionError("cycle", `Profile inheritance cycle: ${path.join(" -> ")}`, [...seen]);
    }
    if (walked.length >= WALK_LIMIT) {
      throw new ResolutionError("depth_exceeded", `Profile chain starting at '${leafId}' is longer than ${WALK_LIMIT}; the limit is ${MAX_PROFILE_DEPTH}`, [leafId]);
    }
    seen.add(next);
    const node = loadNode(next, sources, local, childId);
    walked.push(node);
    childId = next;
    // An overlay's `extends` wins over the synced document's, like any other field.
    next = [...node.layers].reverse().find((l) => l.profile.extends !== undefined)?.profile.extends;
  }
  if (walked.length > MAX_PROFILE_DEPTH) {
    const chain = walked.map((n) => n.id).join(" -> ");
    throw new ResolutionError(
      "depth_exceeded",
      `Profile chain is ${walked.length} deep (${chain}); the limit is ${MAX_PROFILE_DEPTH}`,
      walked.map((n) => n.id),
    );
  }
  const nodes = walked.reverse(); // root first
  const layers = nodes.flatMap((n) => n.layers);

  // 2. Merge root-first.
  let name = "";
  const trigger: { description?: string; patterns?: string[]; harness_hints?: string[]; sticky?: boolean } = {};
  const pins = new Map<string, PackPin>();
  const categories = new Map<Category, { severity: Severity; origin: string }>();
  const rules = new Map<string, RuleState>();
  const allow = new Set<string>();
  const thresholds: { token_floor_words?: number; reviewer_floor_words?: number } = {};
  let reviewerEnabled: boolean | undefined;
  let reviewerCategories: readonly string[] | undefined;
  let register: ResolvedProfile["reviewer"]["register"] | undefined;
  let mode: "enforce" | "advisory" | undefined;
  let passCap: 1 | 2 | undefined;
  let render: "diff" | "summary" | "none" | undefined;

  for (const layer of layers) {
    const p = layer.profile;
    name = p.name;

    if (p.trigger?.description !== undefined) trigger.description = p.trigger.description;
    if (p.trigger?.patterns !== undefined) trigger.patterns = [...p.trigger.patterns];
    if (p.trigger?.harness_hints !== undefined) trigger.harness_hints = [...p.trigger.harness_hints];
    if (p.trigger?.sticky !== undefined) trigger.sticky = p.trigger.sticky;

    for (const ref of p.rule_packs ?? []) {
      const prev = pins.get(ref.id);
      if (prev !== undefined && !semver.intersects(prev.range, ref.version)) {
        throw new ResolutionError(
          "range_conflict",
          `Rule pack '${ref.id}' has conflicting version ranges: '${prev.label}' requires '${prev.range}' but '${layer.label}' requires '${ref.version}', and the two do not overlap`,
          [prev.pinnedBy, layer.id, ref.id],
        );
      }
      pins.set(ref.id, { range: ref.version, pinnedBy: layer.id, label: layer.label });
    }

    for (const [category, override] of Object.entries(p.overrides?.categories ?? {})) {
      categories.set(category as Category, { severity: override.severity, origin: layer.id });
    }
    for (const [ruleId, override] of Object.entries(p.overrides?.rules ?? {})) {
      const state: RuleState = rules.get(ruleId) ?? {};
      if (override.enabled !== undefined) state.enabled = { value: override.enabled, origin: layer.id };
      if (override.severity !== undefined) state.severity = { value: override.severity, origin: layer.id };
      rules.set(ruleId, state);
    }
    for (const term of p.overrides?.allow_terms ?? []) allow.add(term);
    if (p.overrides?.thresholds?.token_floor_words !== undefined) thresholds.token_floor_words = p.overrides.thresholds.token_floor_words;
    if (p.overrides?.thresholds?.reviewer_floor_words !== undefined) thresholds.reviewer_floor_words = p.overrides.thresholds.reviewer_floor_words;

    if (p.reviewer?.enabled !== undefined) reviewerEnabled = p.reviewer.enabled;
    if (p.reviewer?.categories !== undefined) reviewerCategories = p.reviewer.categories;
    if (p.reviewer?.register !== undefined) register = { ...p.reviewer.register };

    if (p.enforcement?.mode !== undefined) mode = p.enforcement.mode;
    if (p.enforcement?.pass_cap !== undefined) passCap = p.enforcement.pass_cap;
    if (p.enforcement?.render !== undefined) render = p.enforcement.render;
  }

  // 3. Pick the highest available pack version in each winning range.
  const packs: ResolvedProfile["packs"] = [...pins.keys()].sort().map((packId) => {
    const pin = pins.get(packId) as PackPin;
    const candidates = availablePackVersions(packId, sources, local);
    const best = semver.maxSatisfying(
      candidates.map((c) => c.version),
      pin.range,
    );
    const chosen = best === null ? undefined : candidates.find((c) => c.version === best);
    if (chosen === undefined) {
      const offered = candidates.map((c) => c.version).join(", ") || "none";
      throw new ResolutionError(
        "no_pack_version",
        `Profile '${pin.pinnedBy}' pins rule pack '${packId}' at '${pin.range}', but no available version satisfies it (available: ${offered})`,
        [pin.pinnedBy, packId],
      );
    }
    return {
      id: packId,
      range: pin.range,
      version: chosen.version,
      pinned_by: pin.pinnedBy,
      signed: chosen.signed,
      origin: chosen.origin,
    };
  });

  // 4. Org policy, then defaults.
  const required = policy?.enforcement_default === "required";
  const policyMode = policy?.enforcement_default === "advisory" || policy?.enforcement_default === "enforce" ? policy.enforcement_default : undefined;
  // `required` forces enforce whatever the profile says; enforce|advisory only fill a gap.
  const effectiveMode = required ? "enforce" : (mode ?? policyMode ?? "enforce");

  const leaf = layers[layers.length - 1] as Layer;
  const content: Omit<ResolvedProfile, "version"> = {
    schema: SNAPSHOT_SCHEMA,
    id: leafId,
    resolved_from: nodes.map((n) => n.id),
    name,
    sources: layers.map((l) => ({ id: l.id, version: l.profile.version, signed: l.signed, origin: l.origin })),
    trigger: {
      description: trigger.description ?? null,
      patterns: trigger.patterns ?? [],
      harness_hints: trigger.harness_hints ?? [],
      // 04 gives no default; a profile stays active unless it says it is one-shot.
      sticky: trigger.sticky ?? true,
    },
    packs,
    categories: Object.fromEntries(categories) as ResolvedProfile["categories"],
    rules: Object.fromEntries(rules) as ResolvedProfile["rules"],
    allow_terms: [...allow].sort(),
    thresholds: { ...DEFAULT_THRESHOLDS, ...thresholds },
    reviewer: {
      // No default is stated either; the reviewer sends the draft to a provider, so it is off
      // unless some profile in the chain turns it on (the bundled `base` does).
      enabled: reviewerEnabled ?? false,
      categories: REVIEWER_CATEGORIES.filter((c) => (reviewerCategories ?? []).includes(c)),
      register: register ?? {},
    },
    enforcement: { mode: effectiveMode, pass_cap: passCap ?? 2, render: render ?? "diff", required },
    policy,
  };

  return { ...content, version: `${leaf.profile.version}+${contentHash(content)}` };
}

function availablePackVersions(
  packId: string,
  sources: ResolutionSources,
  local: LocalOverlay | undefined,
): Array<{ version: string; signed: boolean; origin: "synced" | "local" }> {
  const out: Array<{ version: string; signed: boolean; origin: "synced" | "local" }> = [];
  const check = (version: string): string => {
    if (semver.valid(version) !== version) {
      throw new ResolutionError("invalid_pack", `Rule pack '${packId}' lists '${version.slice(0, 40)}', which is not a semver version`, [packId]);
    }
    return version;
  };
  if (has(sources.packs, packId)) {
    for (const v of sources.packs[packId] ?? []) out.push({ version: check(v.version), signed: v.signed, origin: "synced" });
  }
  if (has(local?.packs, packId)) {
    for (const v of local?.packs?.[packId] ?? []) out.push({ version: check(v), signed: false, origin: "local" });
  }
  return out;
}

function parsePolicy(policy: OrgPolicy | undefined): ResolvedProfile["policy"] {
  if (policy === undefined) return null;
  const parsed = OrgPolicySchema.safeParse(policy);
  if (!parsed.success) {
    const issues = zodToIssues(parsed.error);
    throw new ResolutionError("invalid_profile", `Org policy is invalid: ${summariseIssues(issues)}`, [], issues);
  }
  const p = parsed.data;
  return {
    org: p.org,
    ...(p.enforcement_default !== undefined ? { enforcement_default: p.enforcement_default } : {}),
    ...(p.allowed_providers !== undefined ? { allowed_providers: [...new Set(p.allowed_providers)].sort() } : {}),
    ...(p.byok_required !== undefined ? { byok_required: p.byok_required } : {}),
    ...(p.sharing_allowed !== undefined ? { sharing_allowed: p.sharing_allowed } : {}),
  };
}

export interface EffectiveRule {
  enabled: boolean;
  severity: Severity;
  /** Profile id that set the winning value; for a rule nobody overrode, the profile that pinned its pack. */
  origin: string;
}

/**
 * The severity, enablement and provenance of one pack rule under a resolved profile.
 *
 * Severity precedence: rule override > category override > the pack rule's own severity.
 * Origin (feeds `Finding.profile_origin`, 03):
 *  - rule disabled: the profile that set `enabled: false`;
 *  - otherwise the profile that set the severity actually used (rule override, else category
 *    override);
 *  - otherwise the profile that explicitly set `enabled: true` on the rule, if any;
 *  - otherwise the profile whose `rule_packs` entry pinned the rule's pack.
 * Throws when the rule's pack is not pinned by the profile (a caller bug: the engine only loads
 * pinned packs).
 */
export function effectiveRule(
  resolved: ResolvedProfile,
  rule: Pick<RulePack["rules"][number], "id" | "category" | "severity">,
): EffectiveRule {
  const packId = rule.id.slice(0, rule.id.indexOf("."));
  const pack = resolved.packs.find((p) => p.id === packId);
  if (pack === undefined) {
    throw new Error(`effectiveRule: rule '${rule.id}' belongs to pack '${packId}', which profile '${resolved.id}' does not pin`);
  }
  const ruleOverride = Object.hasOwn(resolved.rules, rule.id) ? resolved.rules[rule.id] : undefined;
  const categoryOverride = resolved.categories[rule.category];

  const enabled = ruleOverride?.enabled?.value ?? true;
  const severity = ruleOverride?.severity?.value ?? categoryOverride?.severity ?? rule.severity;
  if (!enabled) {
    return { enabled, severity, origin: (ruleOverride?.enabled as { origin: string }).origin };
  }
  const origin = ruleOverride?.severity?.origin ?? categoryOverride?.origin ?? ruleOverride?.enabled?.origin ?? pack.pinned_by;
  return { enabled, severity, origin };
}
