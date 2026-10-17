import semver from "semver";
import { z } from "zod";
import { ACTIONS, FINDINGS_SCHEMA_VERSION, RULE_CATEGORIES } from "@prosegate/schema";
import { ResolutionError, summariseIssues, type Issue, type ParseResult } from "./errors.js";
import { injectedText, PackIdSchema, RuleIdSchema, SeveritySchema } from "./fields.js";
import { lintPattern, lintPhrase, MAX_PATTERN_BYTES, MAX_REGEX_RULES } from "./patterns.js";
import { sanitizeInput } from "./sanitize.js";
import { MAX_PACK_BYTES, MAX_PACK_NODES, parseYamlStrict, utf8Length, zodToIssues } from "./yaml.js";

export { PackIdSchema, RuleIdSchema, SeveritySchema };

// Rule-pack schema, prosegate.rulepack/1 (04 "Rule pack", ADR-15, ADR-19).
//
// NOT checked here: that `regex` patterns and `starts_with` patterns are valid RE2. The engine
// compiles them with re2js at load (plan 6.3) and the publish job compiles before signing; re2js
// must not run inside the Cloudflare Worker that validates `PUT /rule-packs`. This schema bounds
// pattern length and work (patterns.ts) and rejects constructs RE2 refuses, but it does not prove
// a pattern compiles.
//
// Phrases, patterns, `sentence_exclude` and examples never reach a model, so they are exempt from
// the injected-text filter (text.ts). Only `instruction.text` is filtered.

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

const threshold = z.number().finite().min(0);

const patternField = z
  .string()
  .min(1)
  .max(500)
  .superRefine((pattern, ctx) => {
    if (pattern.length > 500) return;
    const problem = lintPattern(pattern);
    if (problem !== null) ctx.addIssue({ code: "custom", message: `pattern ${problem}` });
  });

const phraseField = z
  .string()
  .min(2)
  .max(80)
  .superRefine((phrase, ctx) => {
    if (phrase.length > 80) return;
    const problem = lintPhrase(phrase);
    if (problem !== null) ctx.addIssue({ code: "custom", message: `phrase ${problem}` });
  });

/** Filters shared by phrase and regex matches (ADR-15). */
const filters = {
  position: z.enum(["any", "sentence_start", "closing"]).default("any"),
  max_doc_words: z.number().int().positive().optional(),
  sentence_max_words: z.number().int().positive().optional(),
  sentence_exclude: patternField.optional(),
};

const PhraseMatch = z.strictObject({
  kind: z.literal("phrase"),
  phrases: z.array(phraseField).min(1).max(500),
  boundary: z.enum(["word", "none"]).default("word"),
  // All matching is case-insensitive on the segmenter's lowercased copy (ADR-15): `false` is not v0.
  case_insensitive: z.literal(true).default(true),
  ...filters,
});

const RegexMatch = z.strictObject({
  kind: z.literal("regex"),
  pattern: patternField,
  ...filters,
});

const AnyMatch = z.strictObject({
  kind: z.literal("any"),
  // No nesting: a part is a phrase or a regex, never another `any`.
  parts: z.array(z.discriminatedUnion("kind", [PhraseMatch, RegexMatch])).min(1).max(20),
});

const SentenceMetricMatch = z
  .strictObject({
    kind: z.literal("sentence_metric"),
    metric: z.enum(SENTENCE_METRICS),
    above: threshold.optional(),
    below: threshold.optional(),
    pattern: patternField.optional(),
    min_words: z.number().int().positive().optional(),
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
    if (m.metric !== "similarity_to_prior" && m.min_words !== undefined) {
      ctx.addIssue({ code: "custom", path: ["min_words"], message: "min_words is only valid for similarity_to_prior" });
    }
    if (m.metric === "similarity_to_prior") {
      // a cosine similarity is in [0, 1]
      for (const key of ["above", "below"] as const) {
        if (m[key] !== undefined && m[key] > 1) ctx.addIssue({ code: "custom", path: [key], message: "a similarity threshold must be at most 1" });
      }
    }
  });

const DocumentMetricMatch = z
  .strictObject({
    kind: z.literal("document_metric"),
    metric: z.enum(DOCUMENT_METRICS),
    above: threshold.optional(),
    below: threshold.optional(),
    min_sentences: z.number().int().positive().optional(),
    min_item_words: z.number().int().positive().optional(),
  })
  .superRefine((m, ctx) => {
    if ((m.above === undefined) === (m.below === undefined)) {
      ctx.addIssue({ code: "custom", message: "exactly one of above or below is required" });
    }
    if (m.metric !== "bullet_ratio" && m.min_item_words !== undefined) {
      ctx.addIssue({ code: "custom", path: ["min_item_words"], message: "min_item_words is only valid for bullet_ratio" });
    }
    if (m.metric === "bullet_ratio" || m.metric === "closing_similarity") {
      // a ratio and a cosine similarity are in [0, 1]
      for (const key of ["above", "below"] as const) {
        if (m[key] !== undefined && m[key] > 1) ctx.addIssue({ code: "custom", path: [key], message: "this metric's threshold must be at most 1" });
      }
    }
  });

const Match = z.discriminatedUnion("kind", [PhraseMatch, RegexMatch, AnyMatch, SentenceMetricMatch, DocumentMetricMatch]);

const exampleList = z.array(z.string().min(1).max(4000)).min(1).max(50);

const RuleSchema = z.strictObject({
  id: RuleIdSchema,
  category: z.enum(RULE_CATEGORIES),
  severity: SeveritySchema,
  match: Match,
  // 07 threat 3 / ADR-19: the model sees this verbatim, so it passes the injected-text filter; the
  // action is a fixed enum.
  instruction: z.strictObject({
    action: z.enum(ACTIONS),
    text: injectedText(200),
  }),
  examples: z.strictObject({ hit: exampleList, miss: exampleList }),
});

type ParsedMatch = z.infer<typeof Match>;
type ParsedPart = Extract<ParsedMatch, { kind: "phrase" | "regex" }>;

/** The regex-like work in one match: compiled regex rules, and every pattern string. */
function patternsOf(match: ParsedMatch): { regexes: number; patterns: string[] } {
  switch (match.kind) {
    case "phrase":
      return { regexes: 0, patterns: match.sentence_exclude === undefined ? [] : [match.sentence_exclude] };
    case "regex":
      return { regexes: 1, patterns: match.sentence_exclude === undefined ? [match.pattern] : [match.pattern, match.sentence_exclude] };
    case "any": {
      let regexes = 0;
      const patterns: string[] = [];
      for (const part of match.parts as ParsedPart[]) {
        const p = patternsOf(part);
        regexes += p.regexes;
        patterns.push(...p.patterns);
      }
      return { regexes, patterns };
    }
    case "sentence_metric":
      return { regexes: 0, patterns: match.pattern === undefined ? [] : [match.pattern] };
    case "document_metric":
      return { regexes: 0, patterns: [] };
  }
}

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
    let regexRules = 0;
    let patternBytes = 0;
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
      const work = patternsOf(rule.match);
      regexRules += work.regexes;
      for (const p of work.patterns) patternBytes += utf8Length(p);
    });
    // ADR-19 work caps, checked in the Worker without an engine.
    if (regexRules > MAX_REGEX_RULES) {
      ctx.addIssue({ code: "custom", path: ["rules"], message: `more than ${MAX_REGEX_RULES} regex rules (parts of an any match count)` });
    }
    if (patternBytes > MAX_PATTERN_BYTES) {
      ctx.addIssue({ code: "custom", path: ["rules"], message: `patterns total more than ${MAX_PATTERN_BYTES} bytes` });
    }
  });

export type RulePack = z.infer<typeof RulePackSchema>;
export type Rule = RulePack["rules"][number];
export type RuleMatch = Rule["match"];

/** The document's own id, for error `ids`, when it parsed far enough to have a well-formed one. */
function documentIds(input: unknown): string[] {
  if (typeof input === "object" && input !== null && "id" in input) {
    const id = (input as { id: unknown }).id;
    if (typeof id === "string" && PackIdSchema.safeParse(id).success) return [id];
  }
  return [];
}

function invalidPack(issues: Issue[], ids: string[] = []): ResolutionError {
  return new ResolutionError("invalid_pack", `Rule pack is invalid: ${summariseIssues(issues)}`, ids, issues);
}

/** Validates an already-parsed value (for callers that hold JSON). */
export function parseRulePack(input: unknown): ParseResult<RulePack> {
  const clean = sanitizeInput(input);
  const ids = documentIds(clean.value);
  if (clean.issues.length > 0) return { ok: false, error: invalidPack(clean.issues, ids) };
  // A pack that targets a newer findings schema is reported as that, not as a pile of unknown
  // fields it may legitimately carry for the newer schema.
  if (typeof clean.value === "object" && clean.value !== null && "findings_schema" in clean.value) {
    const declared = (clean.value as { findings_schema: unknown }).findings_schema;
    if (typeof declared === "number" && Number.isInteger(declared) && declared !== SUPPORTED_FINDINGS_SCHEMA) {
      return {
        ok: false,
        error: new ResolutionError(
          "unsupported_findings_schema",
          `Rule pack${ids[0] === undefined ? "" : ` '${ids[0]}'`} targets findings_schema ${declared}; this build supports ${SUPPORTED_FINDINGS_SCHEMA}`,
          ids,
          [{ path: "findings_schema", message: `unsupported value ${declared}; supported: ${SUPPORTED_FINDINGS_SCHEMA}` }],
        ),
      };
    }
  }
  const result = RulePackSchema.safeParse(clean.value);
  if (!result.success) return { ok: false, error: invalidPack(zodToIssues(result.error), ids) };
  return { ok: true, value: result.data };
}

/** Parses and validates rule-pack YAML (≤ 256 KB). Never throws; the error is a ResolutionError. */
export function parseRulePackYaml(text: unknown): ParseResult<RulePack> {
  const yaml = parseYamlStrict(text, MAX_PACK_BYTES, MAX_PACK_NODES);
  if (!yaml.ok) return { ok: false, error: invalidPack(yaml.issues) };
  return parseRulePack(yaml.value);
}
