import { z } from "zod";
import { CATEGORIES, REVIEWER_CATEGORIES } from "@prosegate/schema";
import { ResolutionError, summariseIssues, type Issue, type ParseResult } from "./errors.js";
import { injectedText, PackIdSchema, ProfileIdSchema, RangeSchema, RuleIdSchema, SeveritySchema } from "./fields.js";
import { sanitizeInput } from "./sanitize.js";
import { MAX_PROFILE_BYTES, MAX_PROFILE_NODES, parseYamlStrict, zodToIssues } from "./yaml.js";
import { BUNDLED_VALIDATED_PROFILE_JSON } from "./bundled.generated.js";

export { ProfileIdSchema };

// Profile schema, prosegate.profile/1 (04 "Profile"). Every section except schema/id/version/name
// is optional so a child can say little.
//
// Integers: YAML 1.2 would read 0x10 as 16 and 1e3 as 1000. parseYamlStrict rejects every
// non-decimal spelling, so a number reads one way only; this schema then checks integer-ness.

const shortList = (item: z.ZodString) => z.array(item).max(50);

const TriggerSchema = z.strictObject({
  // The model reads this when choosing with select_profile, so it passes the injected-text filter.
  description: injectedText(200).optional(),
  // Never rendered to a model: matched against the user message and tool names by the adapter.
  patterns: shortList(z.string().min(1).max(100)).optional(),
  harness_hints: shortList(z.string().min(1).max(64)).optional(),
  sticky: z.boolean().optional(),
});

const RulePackRefSchema = z.strictObject({
  id: PackIdSchema,
  version: RangeSchema,
});

// 04's example shows `{ enabled: false }` only. 08's starter profiles need rule-level severity
// ("002 -> info"), so a rule override accepts enabled, severity, or both. At least one is required.
const RuleOverrideSchema = z
  .strictObject({ enabled: z.boolean().optional(), severity: SeveritySchema.optional() })
  .refine((o) => o.enabled !== undefined || o.severity !== undefined, "must set enabled, severity, or both");

const OverridesSchema = z.strictObject({
  categories: z
    .partialRecord(z.enum(CATEGORIES), z.strictObject({ severity: SeveritySchema }))
    .superRefine((categories, ctx) => {
      // 08: the reviewer's register findings are capped at warn whatever anything else says.
      if (categories.register?.severity === "block") {
        ctx.addIssue({ code: "custom", path: ["register", "severity"], message: "register findings are capped at warn" });
      }
    })
    .optional(),
  // 400 overrides at about 5 estimated nodes each, plus the other maxima below, stay under the
  // profile node cap of 5,000 (measured in profile-fields.test.ts), so the maxima are reachable.
  rules: z
    .record(RuleIdSchema, RuleOverrideSchema)
    .refine((rules) => Object.keys(rules).length <= 400, "at most 400 rule overrides")
    .optional(),
  // Never rendered to a model. Lowercased: vocab matching is case-insensitive (ADR-15).
  allow_terms: z.array(z.string().min(1).max(80).transform((term) => term.toLowerCase())).max(500).optional(),
  thresholds: z
    .strictObject({
      token_floor_words: z.number().int().min(0).optional(),
      reviewer_floor_words: z.number().int().min(0).optional(),
    })
    .optional(),
});

// tone and format are injected into the model's context at session start (plan 6.5): they pass the
// same filter as instruction text.
export const RegisterSchema = z.strictObject({
  max_words: z.number().int().positive().max(100_000).optional(),
  tone: injectedText(200).optional(),
  format: injectedText(200).optional(),
});

const ReviewerSchema = z.strictObject({
  enabled: z.boolean().optional(),
  categories: z.array(z.enum(REVIEWER_CATEGORIES)).max(REVIEWER_CATEGORIES.length).optional(),
  register: RegisterSchema.optional(),
});

const EnforcementSchema = z.strictObject({
  mode: z.enum(["enforce", "advisory"]).optional(),
  pass_cap: z.union([z.literal(1), z.literal(2)]).optional(),
  render: z.enum(["diff", "summary", "none"]).optional(),
});

const ProfileSchema = z
  .strictObject({
    schema: z.literal("prosegate.profile/1"),
    id: ProfileIdSchema,
    version: z.number().int().positive(),
    name: injectedText(100),
    extends: ProfileIdSchema.optional(),
    trigger: TriggerSchema.optional(),
    rule_packs: z.array(RulePackRefSchema).max(50).optional(),
    overrides: OverridesSchema.optional(),
    reviewer: ReviewerSchema.optional(),
    enforcement: EnforcementSchema.optional(),
  })
  .superRefine((profile, ctx) => {
    const seen = new Set<string>();
    (profile.rule_packs ?? []).forEach((pack, index) => {
      if (seen.has(pack.id)) {
        ctx.addIssue({ code: "custom", path: ["rule_packs", index, "id"], message: "pack listed twice in one profile" });
      }
      seen.add(pack.id);
    });
    if (profile.extends === profile.id) {
      ctx.addIssue({ code: "custom", path: ["extends"], message: "a profile cannot extend itself" });
    }
  });

export type Profile = z.infer<typeof ProfileSchema>;

function documentIds(input: unknown): string[] {
  if (typeof input === "object" && input !== null && "id" in input) {
    const id = (input as { id: unknown }).id;
    if (typeof id === "string" && ProfileIdSchema.safeParse(id).success) return [id];
  }
  return [];
}

function invalidProfile(issues: Issue[], ids: string[] = []): ResolutionError {
  return new ResolutionError("invalid_profile", `Profile is invalid: ${summariseIssues(issues)}`, ids, issues);
}

/** Validates an already-parsed value (for callers that hold JSON). */
export function parseProfile(input: unknown): ParseResult<Profile> {
  const clean = sanitizeInput(input);
  const ids = documentIds(clean.value);
  if (clean.issues.length > 0) return { ok: false, error: invalidProfile(clean.issues, ids) };
  const result = ProfileSchema.safeParse(clean.value);
  if (!result.success) return { ok: false, error: invalidProfile(zodToIssues(result.error), ids) };
  return { ok: true, value: result.data };
}

/** Parses and validates profile YAML (≤ 64 KB). Never throws; the error is a ResolutionError. */
export function parseProfileYaml(text: unknown): ParseResult<Profile> {
  // Exact shipped bytes only: generator + CI apply the full parser/schema/filter.
  // Parse anew so callers cannot mutate a shared trusted value.
  if (typeof text === "string" && Object.hasOwn(BUNDLED_VALIDATED_PROFILE_JSON, text)) {
    return { ok: true, value: JSON.parse(BUNDLED_VALIDATED_PROFILE_JSON[text] as string) as Profile };
  }
  const yaml = parseYamlStrict(text, MAX_PROFILE_BYTES, MAX_PROFILE_NODES);
  if (!yaml.ok) return { ok: false, error: invalidProfile(yaml.issues) };
  return parseProfile(yaml.value);
}
