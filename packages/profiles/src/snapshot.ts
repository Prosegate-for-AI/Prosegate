import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import { z } from "zod";
import { CATEGORIES, REVIEWER_CATEGORIES } from "@prosegate/schema";
import { ResolutionError, summariseIssues, type ParseResult } from "./errors.js";
import { ProfileIdSchema, RegisterSchema } from "./profile.js";
import { PackIdSchema, RuleIdSchema, SeveritySchema } from "./rulepack.js";
import { zodToIssues } from "./yaml.js";

export const SNAPSHOT_SCHEMA = "prosegate.resolved/1";

const Origin = ProfileIdSchema;
const SourceOrigin = z.enum(["synced", "local"]);

/** 06 org policy, as stored in `orgs.policy_json` and passed to the resolver. */
export const OrgPolicySchema = z.strictObject({
  org: z.string().min(1).max(100),
  enforcement_default: z.enum(["enforce", "advisory", "required"]).optional(),
  allowed_providers: z.array(z.string().min(1).max(64)).max(50).optional(),
  byok_required: z.boolean().optional(),
  sharing_allowed: z.boolean().optional(),
});
export type OrgPolicy = z.infer<typeof OrgPolicySchema>;

const Provenance = <T extends z.ZodType>(value: T) => z.strictObject({ value, origin: Origin });

/**
 * The resolved profile: what everything downstream (engine, reviewer, adapter) sees. Written to
 * `~/.prosegate/sessions/<id>/profile.json` by the adapter; this package never touches disk.
 * Every field is required (no defaults) so a parse never changes the content that was hashed.
 */
export const ResolvedProfileSchema = z.strictObject({
  schema: z.literal(SNAPSHOT_SCHEMA),
  /** The leaf profile id. */
  id: ProfileIdSchema,
  /** `<leaf version>+<first 8 hex of sha256 over the canonical content without this field>`. */
  version: z.string().regex(/^[1-9]\d*\+[0-9a-f]{8}$/),
  /** Distinct profile ids, root first. A local overlay shares its synced profile's entry. */
  resolved_from: z.array(ProfileIdSchema).min(1).max(3),
  name: z.string(),
  /** Every YAML document that contributed, root first; a local overlay follows the synced profile it overlays. */
  sources: z.array(
    z.strictObject({ id: ProfileIdSchema, version: z.number().int().positive(), signed: z.boolean(), origin: SourceOrigin }),
  ),
  trigger: z.strictObject({
    description: z.string().nullable(),
    patterns: z.array(z.string()),
    harness_hints: z.array(z.string()),
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
  ),
  categories: z.partialRecord(z.enum(CATEGORIES), z.strictObject({ severity: SeveritySchema, origin: Origin })),
  rules: z.record(
    RuleIdSchema,
    z.strictObject({
      enabled: Provenance(z.boolean()).optional(),
      severity: Provenance(SeveritySchema).optional(),
    }),
  ),
  /** Sorted and de-duplicated. */
  allow_terms: z.array(z.string()),
  thresholds: z.strictObject({ token_floor_words: z.number().int(), reviewer_floor_words: z.number().int() }),
  reviewer: z.strictObject({
    enabled: z.boolean(),
    categories: z.array(z.enum(REVIEWER_CATEGORIES)),
    register: RegisterSchema,
  }),
  enforcement: z.strictObject({
    mode: z.enum(["enforce", "advisory"]),
    pass_cap: z.union([z.literal(1), z.literal(2)]),
    render: z.enum(["diff", "summary", "none"]),
    /** True when org policy `enforcement_default: required` applies: the session may not turn enforcement off. */
    required: z.boolean(),
  }),
  policy: OrgPolicySchema.nullable(),
});
export type ResolvedProfile = z.infer<typeof ResolvedProfileSchema>;

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

function invalidSnapshot(message: string, issues: ResolutionError["issues"] = []): ParseResult<never> {
  return { ok: false, error: new ResolutionError("invalid_profile", message, [], issues) };
}

/**
 * Strict parse of a snapshot: unknown fields are rejected, and the `version` suffix must equal the
 * hash of the content (a hand-edited or truncated profile.json fails here instead of silently
 * applying a different profile than the one the turn started with).
 */
export function parseSnapshot(text: string): ParseResult<ResolvedProfile> {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return invalidSnapshot("Profile snapshot is not valid JSON");
  }
  const result = ResolvedProfileSchema.safeParse(raw);
  if (!result.success) {
    const issues = zodToIssues(result.error);
    return invalidSnapshot(`Profile snapshot is invalid: ${summariseIssues(issues)}`, issues);
  }
  const expected = contentHash(result.data);
  if (!result.data.version.endsWith(`+${expected}`)) {
    return invalidSnapshot(`Profile snapshot '${result.data.id}' does not match its version hash; it was modified or truncated`);
  }
  return { ok: true, value: result.data };
}
