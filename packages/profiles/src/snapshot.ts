import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import semver from "semver";
import { z } from "zod";
import { CATEGORIES, REVIEWER_CATEGORIES } from "@prosegate/schema";
import { ResolutionError, summariseIssues, type Issue, type ParseResult } from "./errors.js";
import { injectedText, NamespaceSchema, PackIdSchema, ProfileIdSchema, RESERVED_NAMESPACES, RuleIdSchema, SeveritySchema } from "./fields.js";
import { RegisterSchema } from "./profile.js";
import { sanitizeInput } from "./sanitize.js";
import { zodToIssues } from "./yaml.js";

export const SNAPSHOT_SCHEMA = "prosegate.resolved/1";

const Origin = ProfileIdSchema;
/** Where a document came from: the config service (signed), the adapter itself (bundled), or `~/.prosegate/` (local, unsigned-but-trusted). */
const SourceOrigin = z.enum(["synced", "bundled", "local"]);

const PROVIDER = /^[a-z0-9_-]{1,31}$/;

/** The 06 policy body (`PUT /orgs/{id}/policy`): exactly these four fields, all optional. */
export const OrgPolicyBodySchema = z.strictObject({
  enforcement_default: z.enum(["enforce", "advisory", "required"]).optional(),
  /** Absent means unrestricted; an empty list means no provider is allowed, so the reviewer is off. */
  allowed_providers: z.array(z.string().regex(PROVIDER, "must match [a-z0-9_-]{1,31}")).max(50).optional(),
  /** Absent means false. */
  byok_required: z.boolean().optional(),
  sharing_allowed: z.boolean().optional(),
});
export type OrgPolicyBody = z.infer<typeof OrgPolicyBodySchema>;

const OrgIdentity = {
  org_id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, "must match [A-Za-z0-9_-]{1,64}"),
  /** Shown to the user and to the model ("Enforcement is required by <org>"), so it passes the injected-text filter. */
  org_name: injectedText(100),
  /** The org's profile namespace; under `required` only profiles in it can be selected (ADR-18). */
  namespace: NamespaceSchema.refine((ns) => !(RESERVED_NAMESPACES as readonly string[]).includes(ns), "is reserved"),
};

/** What the caller hands the resolver: the org's identity plus the signed 06 policy body. */
export const OrgPolicyInputSchema = z.strictObject({ ...OrgIdentity, ...OrgPolicyBodySchema.shape });
export type OrgPolicyInput = z.infer<typeof OrgPolicyInputSchema>;

/** The policy as recorded in a snapshot: the input with `byok_required` resolved to a boolean. */
export const ResolvedPolicySchema = z.strictObject({
  ...OrgIdentity,
  enforcement_default: OrgPolicyBodySchema.shape.enforcement_default,
  allowed_providers: OrgPolicyBodySchema.shape.allowed_providers,
  byok_required: z.boolean(),
  sharing_allowed: OrgPolicyBodySchema.shape.sharing_allowed,
});
export type ResolvedPolicy = z.infer<typeof ResolvedPolicySchema>;

const Provenance = <T extends z.ZodType>(value: T) =>
  z.strictObject({ value, origin: Origin, /** Index into `sources` of the document that set it. */ layer: z.number().int().min(0) });

const ReviewerOrigins = z.strictObject({
  enabled: Origin.nullable(),
  categories: Origin.nullable(),
  register: Origin.nullable(),
});

const BaseSnapshot = z.strictObject({
  schema: z.literal(SNAPSHOT_SCHEMA),
  /** The leaf profile id. */
  id: ProfileIdSchema,
  /** `<synced leaf version>+<first 8 hex of sha256 over the canonical content without this field>`. */
  version: z.string().regex(/^[1-9]\d*\+[0-9a-f]{8}$/),
  /** Distinct profile ids, root first. A local overlay shares its synced profile's entry. */
  resolved_from: z.array(ProfileIdSchema).min(1).max(3),
  name: injectedText(100),
  /** Every YAML document that contributed, root first; a local overlay follows the profile it overlays. */
  sources: z.array(
    z.strictObject({ id: ProfileIdSchema, version: z.number().int().positive(), signed: z.boolean(), origin: SourceOrigin }),
  ).min(1).max(6),
  trigger: z.strictObject({
    description: injectedText(200).nullable(),
    patterns: z.array(z.string().min(1).max(100)).max(50),
    harness_hints: z.array(z.string().min(1).max(64)).max(50),
    sticky: z.boolean(),
  }),
  /** One entry per pinned pack, sorted by id. `pinned_by` is the profile whose rule_packs entry won. */
  packs: z.array(
    z.strictObject({
      id: PackIdSchema,
      range: z.string(),
      version: z.string(),
      pinned_by: Origin,
      signed: z.boolean(),
      origin: SourceOrigin,
    }),
  ).max(50),
  categories: z.partialRecord(
    z.enum(CATEGORIES),
    z.strictObject({ severity: SeveritySchema, origin: Origin, layer: z.number().int().min(0) }),
  ),
  rules: z.record(
    RuleIdSchema,
    z.strictObject({
      enabled: Provenance(z.boolean()).optional(),
      severity: Provenance(SeveritySchema).optional(),
    }),
  ),
  /** Sorted, lowercase and de-duplicated. */
  allow_terms: z.array(z.string().min(1).max(80)).max(500),
  thresholds: z.strictObject({ token_floor_words: z.number().int().min(0), reviewer_floor_words: z.number().int().min(0) }),
  reviewer: z.strictObject({
    enabled: z.boolean(),
    categories: z.array(z.enum(REVIEWER_CATEGORIES)),
    register: RegisterSchema,
    origins: ReviewerOrigins,
  }),
  enforcement: z.strictObject({
    mode: z.enum(["enforce", "advisory"]),
    pass_cap: z.union([z.literal(1), z.literal(2)]),
    render: z.enum(["diff", "summary", "none"]),
    /** True when org policy `enforcement_default: required` applies: the session may not turn enforcement off. */
    required: z.boolean(),
  }),
  policy: ResolvedPolicySchema.nullable(),
  /** True when `required` caused local overlay profiles or packs to be ignored (ADR-18). */
  overlays_ignored: z.boolean(),
});

function check(snapshot: z.infer<typeof BaseSnapshot>, add: (path: PropertyKey[], message: string) => void): void {
  const { sources, resolved_from: chain } = snapshot;

  if (snapshot.id !== chain[chain.length - 1]) add(["id"], "must equal the last entry of resolved_from");
  const distinct = sources.map((s) => s.id).filter((id, i, all) => all.indexOf(id) === i);
  if (distinct.length !== chain.length || distinct.some((id, i) => id !== chain[i])) {
    add(["resolved_from"], "must list the distinct ids of sources, in order");
  }

  const leafDoc = sources.find((s) => s.id === snapshot.id && s.origin !== "local") ?? sources.find((s) => s.id === snapshot.id);
  if (leafDoc !== undefined && Number(snapshot.version.split("+")[0]) !== leafDoc.version) {
    add(["version"], "the number before + must be the synced leaf's version");
  }
  sources.forEach((s, index) => {
    if (s.origin === "synced" && !s.signed) add(["sources", index, "signed"], "synced content must be signed");
  });

  let previous = "";
  snapshot.packs.forEach((pack, index) => {
    if (pack.id <= previous) add(["packs", index, "id"], "packs must be sorted by id, without duplicates");
    previous = pack.id;
    if (semver.valid(pack.version) !== pack.version) add(["packs", index, "version"], "must be a semver version");
    const normal = semver.validRange(pack.range);
    if (normal === null || normal === "*" || normal !== pack.range) add(["packs", index, "range"], "must be a normalised, non-wildcard semver range");
    else if (semver.valid(pack.version) !== null && !semver.satisfies(pack.version, pack.range)) add(["packs", index, "version"], "does not satisfy its range");
    if (!chain.includes(pack.pinned_by)) add(["packs", index, "pinned_by"], "must be a profile in resolved_from");
    if (pack.origin === "synced" && !pack.signed) add(["packs", index, "signed"], "synced content must be signed");
  });

  const checkLayer = (path: PropertyKey[], layer: number, origin: string) => {
    if (sources[layer]?.id !== origin) add(path, "origin must be the id of the source at layer");
  };
  for (const [category, o] of Object.entries(snapshot.categories)) checkLayer(["categories", category, "layer"], o.layer, o.origin);
  for (const [ruleId, o] of Object.entries(snapshot.rules)) {
    if (o.enabled !== undefined) checkLayer(["rules", ruleId, "enabled", "layer"], o.enabled.layer, o.enabled.origin);
    if (o.severity !== undefined) checkLayer(["rules", ruleId, "severity", "layer"], o.severity.layer, o.severity.origin);
  }

  snapshot.allow_terms.forEach((term, index) => {
    const before = snapshot.allow_terms[index - 1];
    if (term !== term.toLowerCase()) add(["allow_terms", index], "must be lowercase");
    if (before !== undefined && before >= term) add(["allow_terms", index], "must be sorted without duplicates");
  });

  for (const key of ["enabled", "categories", "register"] as const) {
    const origin = snapshot.reviewer.origins[key];
    if (origin !== null && !chain.includes(origin)) add(["reviewer", "origins", key], "must be a profile in resolved_from");
  }
  if (snapshot.reviewer.enabled && snapshot.reviewer.categories.length === 0) add(["reviewer", "enabled"], "cannot be on with no categories");
  if (snapshot.policy?.allowed_providers?.length === 0 && snapshot.reviewer.enabled) {
    add(["reviewer", "enabled"], "must be off when the policy allows no provider");
  }

  const required = snapshot.policy?.enforcement_default === "required";
  if (snapshot.enforcement.required !== required) add(["enforcement", "required"], "must equal (policy.enforcement_default === 'required')");
  if (snapshot.enforcement.required && snapshot.enforcement.mode !== "enforce") add(["enforcement", "mode"], "must be enforce when required");
  if (required && snapshot.policy !== null && snapshot.id.split("/")[0] !== snapshot.policy.namespace) {
    add(["id"], "must be in the policy's namespace when enforcement is required");
  }
  if (snapshot.overlays_ignored && !required) add(["overlays_ignored"], "can only be true when enforcement is required");
  if (required && sources.some((s) => s.origin === "local")) add(["sources"], "local sources are ignored when enforcement is required");
}

/**
 * The resolved profile: what everything downstream (engine, reviewer, adapter) sees. Written to
 * `~/.prosegate/sessions/<id>/profile.json` by the adapter; this package never touches disk.
 * Every field is required (no defaults) so a parse never changes the content that was hashed.
 *
 * The `version` hash is a corruption check, not a security control (ADR-19): a process with the
 * user's shell can rewrite the file and recompute the hash. The adapter re-resolves from signed or
 * bundled sources and the signed policy, and treats `profile.json` as a cache.
 */
export const ResolvedProfileSchema = BaseSnapshot.superRefine((snapshot, ctx) => {
  check(snapshot, (path, message) => ctx.addIssue({ code: "custom", path, message }));
});
export type ResolvedProfile = z.infer<typeof BaseSnapshot>;

/**
 * JSON with keys sorted recursively (UTF-16 code-unit order), no whitespace, arrays in the order
 * given, `undefined` object members omitted. Two values with the same content serialise to the
 * same string whatever order their keys were built in; that is what makes the content hash stable.
 */
export function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "string":
    case "boolean":
      return JSON.stringify(value);
    case "number":
      if (!Number.isFinite(value)) throw new TypeError("canonicalJson: non-finite number");
      return JSON.stringify(value);
    case "object": {
      if (Array.isArray(value)) return `[${value.map((item) => (item === undefined ? "null" : canonicalJson(item))).join(",")}]`;
      const record = value as Record<string, unknown>;
      const members = Object.keys(record)
        .filter((key) => record[key] !== undefined)
        .sort()
        .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`);
      return `{${members.join(",")}}`;
    }
    default:
      throw new TypeError(`canonicalJson: cannot serialise ${typeof value}`);
  }
}

/** First 8 hex of sha256 over the canonical JSON of everything except `version`. */
export function contentHash(profile: ResolvedProfile | Omit<ResolvedProfile, "version">): string {
  const content: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(profile)) if (key !== "version") content[key] = value;
  return bytesToHex(sha256(utf8ToBytes(canonicalJson(content)))).slice(0, 8);
}

/** Deterministic text form for `profile.json`: sorted keys, two-space indent, trailing newline. */
export function serializeSnapshot(profile: ResolvedProfile): string {
  return `${JSON.stringify(JSON.parse(canonicalJson(profile)) as unknown, null, 2)}\n`;
}

function invalidSnapshot(message: string, issues: Issue[] = [], ids: string[] = []): ParseResult<never> {
  return { ok: false, error: new ResolutionError("invalid_profile", message, ids, issues) };
}

/**
 * Strict parse of a snapshot: unknown fields are rejected at every level, the cross-field
 * invariants hold, and the `version` suffix must equal the hash of the content (a hand-edited or
 * truncated profile.json fails here instead of silently applying a different profile than the one
 * the turn started with). See the note on {@link ResolvedProfileSchema}: this detects corruption
 * only.
 */
export function parseSnapshot(text: unknown): ParseResult<ResolvedProfile> {
  if (typeof text !== "string") return invalidSnapshot("Profile snapshot is not text");
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return invalidSnapshot("Profile snapshot is not valid JSON");
  }
  const clean = sanitizeInput(raw);
  if (clean.issues.length > 0) return invalidSnapshot(`Profile snapshot is invalid: ${summariseIssues(clean.issues)}`, clean.issues);
  const result = ResolvedProfileSchema.safeParse(clean.value);
  if (!result.success) {
    const issues = zodToIssues(result.error);
    return invalidSnapshot(`Profile snapshot is invalid: ${summariseIssues(issues)}`, issues);
  }
  const expected = contentHash(result.data);
  if (!result.data.version.endsWith(`+${expected}`)) {
    return invalidSnapshot(`Profile snapshot '${result.data.id}' does not match its version hash; it was modified or truncated`, [], [result.data.id]);
  }
  return { ok: true, value: result.data };
}
