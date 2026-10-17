import semver from "semver";
import { z } from "zod";
import { CATEGORIES, REVIEWER_CATEGORIES } from "@prosegate/schema";
import { ResolutionError, summariseIssues, type Issue, type ParseResult } from "./errors.js";
import { PackIdSchema, plainText, RuleIdSchema, SeveritySchema } from "./rulepack.js";
import { MAX_PROFILE_BYTES, parseYamlStrict, zodToIssues } from "./yaml.js";

// Profile schema, prosegate.profile/1 (04 "Profile"). Every section except schema/id/version/name
// is optional so a child can say little.

export const ProfileIdSchema = z
  .string()
  .max(129)
  .regex(/^[a-z0-9-]+\/[a-z0-9-]+$/, "must be <namespace>/<slug>, both [a-z0-9-]+");

const shortList = (item: z.ZodString) => z.array(item).max(50);

const TriggerSchema = z.strictObject({
  // The model reads this when choosing with select_profile, so it gets the plain-text filter too.
  description: plainText(1, 200).optional(),
  patterns: shortList(z.string().min(1).max(100)).optional(),
  harness_hints: shortList(z.string().min(1).max(64)).optional(),
  sticky: z.boolean().optional(),
});

const RulePackRefSchema = z.strictObject({
  id: PackIdSchema,
  version: z
    .string()
    .max(100)
    .refine((range) => semver.validRange(range) !== null, "must be a semver range such as >=0.3.0 <1.0.0"),
});

// 04's example shows `{ enabled: false }` only. 08's starter profiles need rule-level severity
// ("002 -> info"), so a rule override accepts enabled, severity, or both. At least one is required.
const RuleOverrideSchema = z
  .strictObject({ enabled: z.boolean().optional(), severity: SeveritySchema.optional() })
  .refine((o) => o.enabled !== undefined || o.severity !== undefined, "must set enabled, severity, or both");

const OverridesSchema = z.strictObject({
  categories: z.partialRecord(z.enum(CATEGORIES), z.strictObject({ severity: SeveritySchema })).optional(),
  rules: z.record(RuleIdSchema, RuleOverrideSchema).optional(),
  allow_terms: z.array(z.string().min(1).max(80)).max(500).optional(),
  thresholds: z
    .strictObject({
      token_floor_words: z.number().int().min(0).optional(),
      reviewer_floor_words: z.number().int().min(0).optional(),
    })
    .optional(),
});

// tone and format are injected into the model's context at session start (plan 6.5): same filter
// as instruction text, with a slightly larger budget.
export const RegisterSchema = z.strictObject({
  max_words: z.number().int().positive().max(100_000).optional(),
  tone: plainText(1, 200).optional(),
  format: plainText(1, 300).optional(),
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
    name: z.string().min(1).max(100),
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

function invalidProfile(issues: Issue[]): ResolutionError {
  return new ResolutionError("invalid_profile", `Profile is invalid: ${summariseIssues(issues)}`, [], issues);
}

/** Validates an already-parsed value (for callers that hold JSON). */
export function parseProfile(input: unknown): ParseResult<Profile> {
  const result = ProfileSchema.safeParse(input);
  if (!result.success) return { ok: false, error: invalidProfile(zodToIssues(result.error)) };
  return { ok: true, value: result.data };
}

/** Parses and validates profile YAML (≤ 64 KB). Never throws; the error is a ResolutionError. */
export function parseProfileYaml(text: string): ParseResult<Profile> {
  const yaml = parseYamlStrict(text, MAX_PROFILE_BYTES);
  if (!yaml.ok) return { ok: false, error: invalidProfile(yaml.issues) };
  return parseProfile(yaml.value);
}
