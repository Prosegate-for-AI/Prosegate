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

// Schema maxima, sized against the pack node cap (25,000 estimated nodes, yaml.ts). A rule written
// at full width in block style (40 phrases, 10 hit and 10 miss examples) costs about 126 nodes, so
// 150 of them use about 19,000: the maxima below can all be reached together. Measured in
// rulepack.test.ts ("a pack of 150 full-width rules").
export const MAX_RULES = 150;
export const MAX_PHRASES = 40;
export const MAX_EXAMPLES = 10;
export const MAX_PARTS = 8;

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
  phrases: z.array(phraseField).min(1).max(MAX_PHRASES),
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
  parts: z.array(z.discriminatedUnion("kind", [PhraseMatch, RegexMatch])).min(1).max(MAX_PARTS),
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

const CORPUS_REF = /^<eval corpus ref: ([a-z0-9-]{1,31})\/(filler|hedge|vocab|triad|structure|repetition)-(\d{3})-(hit|miss)-(\d{2})>$/;

/**
 * A reference to an example kept in the eval corpus: `<eval corpus ref: core/structure-002-hit-01>`
 * (04 "Long examples live in the eval corpus"). Anything else is a literal example sentence.
 */
export function isCorpusRef(example: string): boolean {
  return CORPUS_REF.test(example);
}

/**
 * An example is either a literal sentence or a corpus reference. A string that starts like a
 * reference but is not exactly one (a typo) is rejected, so it is never read as a literal sentence.
 */
const exampleField = z
  .string()
  .min(1)
  .max(4000)
  .superRefine((example, ctx) => {
    if (example.startsWith("<eval corpus ref:") && !isCorpusRef(example)) {
      ctx.addIssue({ code: "custom", message: "looks like a corpus reference but is malformed; expected <eval corpus ref: core/<category>-<nnn>-hit|miss-NN>" });
    }
  });

const exampleList = z.array(exampleField).min(1).max(MAX_EXAMPLES);

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

/**
 * The regex-like work in one match: the number of patterns the engine compiles, and every pattern
 * string. A `sentence_exclude` and a `starts_with` pattern are compiled like a regex rule, so they
 * count toward the regex cap as well as the byte total.
 */
function patternsOf(match: ParsedMatch): { regexes: number; patterns: string[] } {
  switch (match.kind) {
    case "phrase":
      return match.sentence_exclude === undefined ? { regexes: 0, patterns: [] } : { regexes: 1, patterns: [match.sentence_exclude] };
    case "regex":
      return match.sentence_exclude === undefined
        ? { regexes: 1, patterns: [match.pattern] }
        : { regexes: 2, patterns: [match.pattern, match.sentence_exclude] };
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
      return match.pattern === undefined ? { regexes: 0, patterns: [] } : { regexes: 1, patterns: [match.pattern] };
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
    rules: z.array(RuleSchema).min(1).max(MAX_RULES),
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
      for (const kind of ["hit", "miss"] as const) {
        rule.examples[kind].forEach((example, at) => {
          const ref = CORPUS_REF.exec(example);
          if (ref === null) return;
          const expected = `${pack.id}/${rule.id.split(".").slice(1).join("-")}-${kind}-`;
          if (`${ref[1]}/${ref[2]}-${ref[3]}-${ref[4]}-` !== expected) {
            ctx.addIssue({ code: "custom", path: ["rules", index, "examples", kind, at], message: `corpus reference must name this rule and list: ${expected}NN` });
          }
        });
      }
      const work = patternsOf(rule.match);
      regexRules += work.regexes;
      for (const p of work.patterns) patternBytes += utf8Length(p);
    });
    // ADR-19 work caps, checked in the Worker without an engine.
    if (regexRules > MAX_REGEX_RULES) {
      ctx.addIssue({ code: "custom", path: ["rules"], message: `more than ${MAX_REGEX_RULES} compiled patterns (regex rules and parts, sentence_exclude and starts_with patterns all count)` });
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
