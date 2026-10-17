import semver from "semver";
import { z } from "zod";
import { ACTIONS, FINDINGS_SCHEMA_VERSION, RULE_CATEGORIES } from "@prosegate/schema";
import { ResolutionError, summariseIssues, type Issue, type ParseResult } from "./errors.js";
import { findTextViolation, TEXT_VIOLATION_MESSAGE } from "./text.js";
import { MAX_PACK_BYTES, parseYamlStrict, zodToIssues } from "./yaml.js";

// Rule-pack schema, prosegate.rulepack/1 (04 "Rule pack").
//
// NOT checked here: that `regex` patterns and `starts_with` patterns are valid RE2. The engine
// compiles them with re2js at load (plan 6.3), and re2js must not run inside the Cloudflare Worker
// that validates `PUT /rule-packs`. This schema only bounds the pattern length (500 chars).

export const SUPPORTED_FINDINGS_SCHEMA = FINDINGS_SCHEMA_VERSION;

/** 04 "Match kinds": the v0 metrics. A pack naming any other metric is rejected. */
export const SENTENCE_METRICS = ["word_count", "starts_with", "comma_count", "similarity_to_prior"] as const;
export const DOCUMENT_METRICS = [
  "bullet_ratio",
  "headers_per_100_words",
  "sentence_length_cv",
  "closing_similarity",
  "bold_per_100_words",
] as const;

const PACK_ID = /^[a-z0-9-]+$/;
const RULE_CATEGORY_PATTERN = RULE_CATEGORIES.join("|");
const RULE_ID_SHAPE = new RegExp(`^[a-z0-9-]+\\.(${RULE_CATEGORY_PATTERN})\\.\\d{3}$`);

export const PackIdSchema = z.string().regex(PACK_ID, "must match [a-z0-9-]+").max(64);
/** Any rule id, in any pack: `<pack>.<category>.<nnn>`. Used by profile overrides. */
export const RuleIdSchema = z
  .string()
  .max(100)
  .regex(RULE_ID_SHAPE, "must look like <pack>.<category>.<nnn>, e.g. core.hedge.001");

/** Plain-text field that reaches a model. The caps run first; the content check only runs within them. */
export function plainText(min: number, max: number) {
  return z
    .string()
    .min(min)
    .max(max)
    .superRefine((text, ctx) => {
      if (text.length > max) return;
      const violation = findTextViolation(text);
      if (violation !== null) ctx.addIssue({ code: "custom", message: TEXT_VIOLATION_MESSAGE[violation] });
    });
}

export const SeveritySchema = z.enum(["block", "warn", "info"]);
const threshold = z.number().finite().min(0);

const PhraseMatch = z.strictObject({
  kind: z.literal("phrase"),
  phrases: z.array(z.string().min(1).max(80)).min(1).max(500),
  boundary: z.enum(["word", "none"]).default("word"),
  case_insensitive: z.boolean().default(true),
  position: z.enum(["any", "sentence_start", "closing"]).default("any"),
  max_doc_words: z.number().int().positive().optional(),
});

const RegexMatch = z.strictObject({
  kind: z.literal("regex"),
  pattern: z.string().min(1).max(500),
  // "a string over [i]": the only flag in v0 is case-insensitive, and at most once.
  flags: z.string().regex(/^i?$/, "may only be 'i'").optional(),
});

const SentenceMetricMatch = z
  .strictObject({
    kind: z.literal("sentence_metric"),
    metric: z.enum(SENTENCE_METRICS),
    above: threshold.optional(),
    below: threshold.optional(),
    pattern: z.string().min(1).max(500).optional(),
  })
  .superRefine((m, ctx) => {
    if ((m.above === undefined) === (m.below === undefined)) {
      ctx.addIssue({ code: "custom", message: "exactly one of above or below is required" });
    }
    if (m.metric === "starts_with" && m.pattern === undefined) {
      ctx.addIssue({ code: "custom", path: ["pattern"], message: "pattern is required for starts_with" });
    }
    if (m.metric !== "starts_with" && m.pattern !== undefined) {
      ctx.addIssue({ code: "custom", path: ["pattern"], message: "pattern is only valid for starts_with" });
    }
  });

const DocumentMetricMatch = z
  .strictObject({
    kind: z.literal("document_metric"),
    metric: z.enum(DOCUMENT_METRICS),
    above: threshold.optional(),
    below: threshold.optional(),
    min_sentences: z.number().int().positive().optional(),
  })
  .superRefine((m, ctx) => {
    if ((m.above === undefined) === (m.below === undefined)) {
      ctx.addIssue({ code: "custom", message: "exactly one of above or below is required" });
    }
  });

const Match = z.discriminatedUnion("kind", [PhraseMatch, RegexMatch, SentenceMetricMatch, DocumentMetricMatch]);

const exampleList = z.array(z.string().min(1).max(4000)).min(1).max(50);

const RuleSchema = z.strictObject({
  id: RuleIdSchema,
  category: z.enum(RULE_CATEGORIES),
  severity: SeveritySchema,
  match: Match,
  // 07 threat 3: ≤ 200 chars, no URL, no backtick, no control characters; the action is a fixed enum.
  instruction: z.strictObject({
    action: z.enum(ACTIONS),
    text: plainText(1, 200),
  }),
  examples: z.strictObject({ hit: exampleList, miss: exampleList }),
});

const RulePackSchema = z
  .strictObject({
    schema: z.literal("prosegate.rulepack/1"),
    id: PackIdSchema,
    version: z.string().refine((v) => semver.valid(v) === v, "must be a semver version such as 0.3.0"),
    findings_schema: z.number().int().positive(),
    rules: z.array(RuleSchema).min(1).max(500),
  })
  .superRefine((pack, ctx) => {
    const seen = new Set<string>();
    pack.rules.forEach((rule, index) => {
      const [packPart, categoryPart] = rule.id.split(".");
      if (packPart !== pack.id) {
        ctx.addIssue({ code: "custom", path: ["rules", index, "id"], message: `must start with the pack id '${pack.id}.'` });
      }
      if (categoryPart !== rule.category) {
        ctx.addIssue({ code: "custom", path: ["rules", index, "id"], message: `category segment must equal the rule's category '${rule.category}'` });
      }
      if (seen.has(rule.id)) {
        ctx.addIssue({ code: "custom", path: ["rules", index, "id"], message: "duplicate rule id in this pack" });
      }
      seen.add(rule.id);
    });
  });

export type RulePack = z.infer<typeof RulePackSchema>;
export type Rule = RulePack["rules"][number];
export type RuleMatch = Rule["match"];

function invalidPack(issues: Issue[]): ResolutionError {
  return new ResolutionError("invalid_pack", `Rule pack is invalid: ${summariseIssues(issues)}`, [], issues);
}

/** Validates an already-parsed value (for callers that hold JSON). */
export function parseRulePack(input: unknown): ParseResult<RulePack> {
  // A pack that targets a newer findings schema is reported as that, not as a pile of unknown
  // fields it may legitimately carry for the newer schema.
  if (typeof input === "object" && input !== null && "findings_schema" in input) {
    const declared = (input as { findings_schema: unknown }).findings_schema;
    if (typeof declared === "number" && Number.isInteger(declared) && declared !== SUPPORTED_FINDINGS_SCHEMA) {
      const id = (input as { id?: unknown }).id;
      const label = typeof id === "string" && PACK_ID.test(id) ? ` '${id}'` : "";
      return {
        ok: false,
        error: new ResolutionError(
          "unsupported_findings_schema",
          `Rule pack${label} targets findings_schema ${declared}; this build supports ${SUPPORTED_FINDINGS_SCHEMA}`,
          label === "" ? [] : [String(id)],
          [{ path: "findings_schema", message: `unsupported value ${declared}; supported: ${SUPPORTED_FINDINGS_SCHEMA}` }],
        ),
      };
    }
  }
  const result = RulePackSchema.safeParse(input);
  if (!result.success) return { ok: false, error: invalidPack(zodToIssues(result.error)) };
  return { ok: true, value: result.data };
}

/** Parses and validates rule-pack YAML (≤ 256 KB). Never throws; the error is a ResolutionError. */
export function parseRulePackYaml(text: string): ParseResult<RulePack> {
  const yaml = parseYamlStrict(text, MAX_PACK_BYTES);
  if (!yaml.ok) return { ok: false, error: invalidPack(yaml.issues) };
  return parseRulePack(yaml.value);
}
