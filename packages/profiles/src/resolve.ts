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
import { sanitizeInput } from "./sanitize.js";
import {
  OrgPolicyInputSchema,
  SNAPSHOT_SCHEMA,
  contentHash,
  type OrgPolicyInput,
  type ResolvedPolicy,
  type ResolvedProfile,
} from "./snapshot.js";
import { zodToIssues } from "./yaml.js";

/** 04: "chain depth ≤ 3 (base → domain → project)". Counted in distinct profile ids. */
export const MAX_PROFILE_DEPTH = 3;
/** Hard stop for the walk so a pathological source set cannot make resolution unbounded. */
const WALK_LIMIT = 32;

/**
 * A synced or bundled profile document. `signed` is the adapter's verdict on its signature (06);
 * content from the network (`synced`) is only accepted signed (ADR-19). Content shipped inside the
 * adapter is `bundled` and carries no service signature.
 */
export interface ProfileSource {
  yaml: string;
  signed: boolean;
  origin: "synced" | "bundled";
}

/** One available version of a rule pack. The resolver needs versions, not pack bodies. */
export interface PackVersionSource {
  version: string;
  signed: boolean;
  origin: "synced" | "bundled";
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
   * The signed org policy of the ACCOUNT, passed for every resolution, whatever the profile's
   * namespace (ADR-18): an org's policy binds the whole session, not only profiles in the org's
   * namespace. Omit it (or pass null) for an account with no org. Under `required` the leaf must be
   * in the policy's namespace and local overlays are ignored.
   */
  policy?: OrgPolicyInput | null | undefined;
  local?: LocalOverlay | undefined;
}

interface Layer {
  id: string;
  /** Names the layer in messages: the id, plus a marker for a local overlay. */
  label: string;
  profile: Profile;
  origin: "synced" | "bundled" | "local";
  signed: boolean;
}

interface Node {
  id: string;
  /** Synced or bundled document first, then the local overlay of it if there is one. */
  layers: Layer[];
}

const has = (record: object | undefined, key: string): boolean => record !== undefined && Object.hasOwn(record, key);

function validateSources(sources: ResolutionSources): void {
  for (const [id, source] of Object.entries(sources.profiles)) {
    if (source.origin === "synced" && !source.signed) {
      throw new ResolutionError("invalid_profile", `Profile '${id}' is synced content but unsigned; unsigned network content is refused`, [id]);
    }
  }
  for (const [packId, versions] of Object.entries(sources.packs)) {
    for (const v of versions) {
      if (v.origin === "synced" && !v.signed) {
        throw new ResolutionError("invalid_pack", `Rule pack '${packId}' ${v.version.slice(0, 40)} is synced content but unsigned; unsigned network content is refused`, [packId]);
      }
    }
  }
}

function parseLayer(id: string, yaml: string, origin: Layer["origin"], signed: boolean): Layer {
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
  const base = has(sources.profiles, id) ? sources.profiles[id] : undefined;
  if (base !== undefined) layers.push(parseLayer(id, base.yaml, base.origin, base.signed));
  const overlay = has(local?.profiles, id) ? local?.profiles?.[id] : undefined;
  if (overlay !== undefined) {
    const layer = parseLayer(id, overlay.yaml, "local", false);
    // ADR-18: an overlay changes how the synced profile behaves, not where it sits in the tree.
    const baseLayer = layers[0];
    if (baseLayer !== undefined && layer.profile.extends !== baseLayer.profile.extends) {
      throw new ResolutionError(
        "invalid_profile",
        `Local overlay of '${id}' must keep the synced profile's extends (${baseLayer.profile.extends ?? "none"})`,
        [id],
        [{ path: "extends", message: "a local overlay cannot change extends" }],
      );
    }
    layers.push(layer);
  }
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

interface Pin {
  range: string;
  /** The profile id whose rule_packs entry this is. */
  pinnedBy: string;
  label: string;
  /** A pin from a signed layer may only resolve to signed or bundled pack versions (ADR-19). */
  signedLayer: boolean;
}

/** Whether some version satisfies every range at once (each may be an `||` union). */
function haveCommonVersion(ranges: readonly string[]): boolean {
  const sets = ranges.map((r) => r.split("||"));
  const go = (i: number, acc: string | null): boolean => {
    const options = sets[i];
    if (options === undefined) return true;
    return options.some((option) => {
      if (acc === null) return go(i + 1, option);
      return semver.intersects(acc, option) && go(i + 1, `${acc} ${option}`);
    });
  };
  return go(0, null);
}

type RuleState = {
  enabled?: { value: boolean; origin: string; layer: number };
  severity?: { value: Severity; origin: string; layer: number };
};

type Provenance<T> = { value: T; origin: string; layer: number };

/**
 * Resolves a leaf profile into one immutable snapshot (04 "Inheritance and resolution").
 *
 * Walks `extends` from the leaf to the root, then merges root-first so the child wins:
 *  - `rule_packs`: union by id; the child's range wins. Every pair of ranges for one pack, and all
 *    of them together, must intersect, or it is a `range_conflict` naming the pair. The winning
 *    range is the child's own, not the intersection. Each pack resolves to the highest available
 *    version in that range; prereleases only when the range names one.
 *  - `overrides.categories|rules|thresholds`: deep merge, child wins per key. A rule's effective
 *    severity comes from the closest layer that sets a rule or category override for it (ADR-18);
 *    see {@link effectiveRule}. `enabled` merges as its own key.
 *  - `allow_terms`: union. `reviewer.register`: whole-object replace.
 *  - `reviewer.enabled|categories`, `enforcement.*`, `trigger.*`: replaced when present.
 *
 * Local overlay (04, ADR-18): a local profile with the id of a synced profile merges as a child of
 * it (local wins), must keep its `extends`, and counts as the same chain entry (no depth cost). The
 * snapshot's integer version is the synced leaf's; the hash covers the overlay. A local pack with a
 * synced pack's id is `pack_conflict_local_synced` whether or not any profile uses it.
 *
 * Org policy (ADR-18): see {@link ResolveOptions.policy}. Under `required`, local overlays are
 * ignored (the snapshot says so) and a leaf outside the policy's namespace is refused with
 * `policy_requires_org_profile`.
 *
 * Throws {@link ResolutionError}. Pure: no I/O, no clock.
 */
export function resolveProfile(leafId: string, sources: ResolutionSources, opts: ResolveOptions = {}): ResolvedProfile {
  validateSources(sources);
  const policy = resolvePolicy(opts.policy);
  const required = policy?.enforcement_default === "required";
  if (policy !== null && required && leafId.split("/")[0] !== policy.namespace) {
    throw new ResolutionError("policy_requires_org_profile", `Enforcement is required by ${policy.org_name}; ask an admin, or uninstall.`, [leafId]);
  }
  const overlaysIgnored = required && opts.local !== undefined && (Object.keys(opts.local.profiles ?? {}).length > 0 || Object.keys(opts.local.packs ?? {}).length > 0);
  const local = required ? undefined : opts.local;
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
    next = node.layers[0]?.profile.extends;
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
  const pins = new Map<string, Pin[]>();
  const categories = new Map<Category, { severity: Severity; origin: string; layer: number }>();
  const rules = new Map<string, RuleState>();
  const allow = new Set<string>();
  const thresholds: { token_floor_words?: number; reviewer_floor_words?: number } = {};
  let reviewerEnabled: Provenance<boolean> | undefined;
  let reviewerCategories: Provenance<readonly string[]> | undefined;
  let register: Provenance<ResolvedProfile["reviewer"]["register"]> | undefined;
  let mode: "enforce" | "advisory" | undefined;
  let passCap: 1 | 2 | undefined;
  let render: "diff" | "summary" | "none" | undefined;

  layers.forEach((layer, index) => {
    const p = layer.profile;
    name = p.name;

    if (p.trigger?.description !== undefined) trigger.description = p.trigger.description;
    if (p.trigger?.patterns !== undefined) trigger.patterns = [...p.trigger.patterns];
    if (p.trigger?.harness_hints !== undefined) trigger.harness_hints = [...p.trigger.harness_hints];
    if (p.trigger?.sticky !== undefined) trigger.sticky = p.trigger.sticky;

    for (const ref of p.rule_packs ?? []) {
      const previous = pins.get(ref.id) ?? [];
      for (const earlier of previous) {
        if (!semver.intersects(earlier.range, ref.version)) {
          throw new ResolutionError(
            "range_conflict",
            `Rule pack '${ref.id}' has conflicting version ranges: '${earlier.label}' requires '${earlier.range}' but '${layer.label}' requires '${ref.version}', and the two do not overlap`,
            [...new Set([earlier.pinnedBy, layer.id, ref.id])],
          );
        }
      }
      const pin: Pin = { range: ref.version, pinnedBy: layer.id, label: layer.label, signedLayer: layer.origin === "synced" && layer.signed };
      const all = [...previous, pin];
      if (!haveCommonVersion(all.map((x) => x.range))) {
        throw new ResolutionError(
          "range_conflict",
          `Rule pack '${ref.id}' has version ranges with no version in common: ${all.map((x) => `'${x.label}' requires '${x.range}'`).join(", ")}`,
          [...new Set([...all.map((x) => x.pinnedBy), ref.id])],
        );
      }
      pins.set(ref.id, all);
    }

    for (const [category, override] of Object.entries(p.overrides?.categories ?? {})) {
      categories.set(category as Category, { severity: override.severity, origin: layer.id, layer: index });
    }
    for (const [ruleId, override] of Object.entries(p.overrides?.rules ?? {})) {
      const state: RuleState = rules.get(ruleId) ?? {};
      if (override.enabled !== undefined) state.enabled = { value: override.enabled, origin: layer.id, layer: index };
      if (override.severity !== undefined) state.severity = { value: override.severity, origin: layer.id, layer: index };
      rules.set(ruleId, state);
    }
    for (const term of p.overrides?.allow_terms ?? []) allow.add(term);
    if (p.overrides?.thresholds?.token_floor_words !== undefined) thresholds.token_floor_words = p.overrides.thresholds.token_floor_words;
    if (p.overrides?.thresholds?.reviewer_floor_words !== undefined) thresholds.reviewer_floor_words = p.overrides.thresholds.reviewer_floor_words;

    if (p.reviewer?.enabled !== undefined) reviewerEnabled = { value: p.reviewer.enabled, origin: layer.id, layer: index };
    if (p.reviewer?.categories !== undefined) reviewerCategories = { value: p.reviewer.categories, origin: layer.id, layer: index };
    if (p.reviewer?.register !== undefined) register = { value: { ...p.reviewer.register }, origin: layer.id, layer: index };

    if (p.enforcement?.mode !== undefined) mode = p.enforcement.mode;
    if (p.enforcement?.pass_cap !== undefined) passCap = p.enforcement.pass_cap;
    if (p.enforcement?.render !== undefined) render = p.enforcement.render;
  });

  // 3. Pick the highest available pack version in each winning range.
  const packs: ResolvedProfile["packs"] = [...pins.keys()].sort().map((packId) => {
    const all = pins.get(packId) as Pin[];
    const pin = all[all.length - 1] as Pin;
    const candidates = availablePackVersions(packId, sources, local, pin.signedLayer);
    const best = semver.maxSatisfying(
      candidates.map((c) => c.version),
      pin.range,
    );
    const chosen = best === null ? undefined : candidates.find((c) => c.version === best);
    if (chosen === undefined) {
      const offered = candidates.map((c) => c.version).join(", ") || "none";
      throw new ResolutionError(
        "no_pack_version",
        `Profile '${pin.pinnedBy}' pins rule pack '${packId}' at '${pin.range}', but no available version satisfies it (available: ${offered}${pin.signedLayer ? "; a signed profile only accepts signed or bundled versions" : ""}; prerelease versions are only considered when the range names one)`,
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
  const policyMode = policy?.enforcement_default === "advisory" || policy?.enforcement_default === "enforce" ? policy.enforcement_default : undefined;
  // `required` forces enforce whatever the profile says; enforce|advisory only fill a gap.
  const effectiveMode = required ? "enforce" : (mode ?? policyMode ?? "enforce");

  // ADR-18: `enabled: true` with no categories means all three; an explicit empty list means off.
  const explicitCategories = reviewerCategories?.value;
  const categoryList = REVIEWER_CATEGORIES.filter((c) => (explicitCategories ?? REVIEWER_CATEGORIES).includes(c));
  let reviewerOn = reviewerEnabled?.value ?? false;
  if (explicitCategories !== undefined && categoryList.length === 0) reviewerOn = false;
  if (policy?.allowed_providers?.length === 0) reviewerOn = false;

  const leafNode = nodes[nodes.length - 1] as Node;
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
      // No default is stated for `enabled`; the reviewer sends the draft to a provider, so it is off
      // unless some profile in the chain turns it on (the bundled `base` does).
      enabled: reviewerOn,
      categories: reviewerOn || explicitCategories !== undefined ? categoryList : [],
      register: register?.value ?? {},
      origins: {
        enabled: reviewerEnabled?.origin ?? null,
        categories: reviewerCategories?.origin ?? null,
        register: register?.origin ?? null,
      },
    },
    enforcement: { mode: effectiveMode, pass_cap: passCap ?? 2, render: render ?? "diff", required },
    policy,
    overlays_ignored: overlaysIgnored,
  };

  // The integer is the synced leaf's (ADR-18); the hash covers everything, overlay included.
  const leafVersion = (leafNode.layers[0] as Layer).profile.version;
  return { ...content, version: `${leafVersion}+${contentHash(content)}` };
}

/** Candidate versions of a pack. With duplicates of one version, the most trusted wins (synced, bundled, local). */
function availablePackVersions(
  packId: string,
  sources: ResolutionSources,
  local: LocalOverlay | undefined,
  signedOnly: boolean,
): Array<{ version: string; signed: boolean; origin: "synced" | "bundled" | "local" }> {
  const rank = { synced: 0, bundled: 1, local: 2 } as const;
  const best = new Map<string, { version: string; signed: boolean; origin: "synced" | "bundled" | "local" }>();
  const offer = (version: string, signed: boolean, origin: "synced" | "bundled" | "local"): void => {
    if (semver.valid(version) !== version) {
      throw new ResolutionError("invalid_pack", `Rule pack '${packId}' lists '${version.slice(0, 40)}', which is not a semver version`, [packId]);
    }
    // ADR-19: a pin from a signed layer resolves to signed (or bundled) versions only.
    if (signedOnly && origin === "local") return;
    const current = best.get(version);
    if (current === undefined || rank[origin] < rank[current.origin]) best.set(version, { version, signed, origin });
  };
  if (has(sources.packs, packId)) {
    for (const v of sources.packs[packId] ?? []) offer(v.version, v.signed, v.origin);
  }
  if (has(local?.packs, packId)) {
    for (const v of local?.packs?.[packId] ?? []) offer(v, false, "local");
  }
  return [...best.values()];
}

function resolvePolicy(input: OrgPolicyInput | null | undefined): ResolvedPolicy | null {
  if (input === null || input === undefined) return null;
  const clean = sanitizeInput(input);
  const parsed = clean.issues.length > 0 ? null : OrgPolicyInputSchema.safeParse(clean.value);
  if (parsed === null || !parsed.success) {
    const issues = parsed === null ? clean.issues : zodToIssues(parsed.error);
    throw new ResolutionError("invalid_policy", `Org policy is invalid: ${summariseIssues(issues)}`, [], issues);
  }
  const p = parsed.data;
  return {
    org_id: p.org_id,
    org_name: p.org_name,
    namespace: p.namespace,
    ...(p.enforcement_default !== undefined ? { enforcement_default: p.enforcement_default } : {}),
    ...(p.allowed_providers !== undefined ? { allowed_providers: [...new Set(p.allowed_providers)].sort() } : {}),
    byok_required: p.byok_required ?? false,
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
 * Severity (ADR-18): the closest layer, walking from the leaf to the root, that sets a rule
 * override or a category override for the rule decides; within one layer the rule override beats
 * the category override; with none, the pack rule's own severity applies. (A rule override that
 * sets only `enabled` is not a severity override.)
 * Origin (feeds `Finding.profile_origin`, 03):
 *  - rule disabled: the profile that set `enabled: false`;
 *  - otherwise the profile that set the severity actually used;
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
  const fromRule = ruleOverride?.severity;
  const winner: { value: Severity; origin: string } | undefined =
    fromRule !== undefined && categoryOverride !== undefined
      ? fromRule.layer >= categoryOverride.layer
        ? fromRule
        : { value: categoryOverride.severity, origin: categoryOverride.origin }
      : (fromRule ?? (categoryOverride === undefined ? undefined : { value: categoryOverride.severity, origin: categoryOverride.origin }));
  const severity = winner?.value ?? rule.severity;
  if (!enabled) {
    return { enabled, severity, origin: (ruleOverride?.enabled as { origin: string }).origin };
  }
  return { enabled, severity, origin: winner?.origin ?? ruleOverride?.enabled?.origin ?? pack.pinned_by };
}

export interface EffectiveReviewer {
  enabled: boolean;
  categories: readonly string[];
  register: ResolvedProfile["reviewer"]["register"];
  /** Profile id that set each; the leaf id when no profile in the chain set it (a default). */
  origin: { enabled: string; categories: string; register: string };
}

/**
 * The reviewer settings with provenance. For `Finding.profile_origin` on a reviewer finding (03),
 * use the category override's origin from `resolved.categories` when one exists, else
 * `origin.enabled`.
 */
export function effectiveReviewer(resolved: ResolvedProfile): EffectiveReviewer {
  const o = resolved.reviewer.origins;
  return {
    enabled: resolved.reviewer.enabled,
    categories: resolved.reviewer.categories,
    register: resolved.reviewer.register,
    origin: {
      enabled: o.enabled ?? resolved.id,
      categories: o.categories ?? resolved.id,
      register: o.register ?? resolved.id,
    },
  };
}
