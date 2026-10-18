import { RE2JS } from "re2js";
import type { Action } from "@prosegate/schema";
import { DOCUMENT_METRICS, SENTENCE_METRICS, type Rule, type RulePack } from "@prosegate/profiles";
import { normalizeForMatching } from "@prosegate/segmenter";

// compilePack: turns a parsed rule pack into an immutable CompiledPack (04, ADR-15, S4 "opt B").
//
// The matching pipeline this prepares for (search.ts):
//  - patterns are compiled WITHOUT their outer \b and run case-sensitively on the segmenter's
//    normalised, ASCII-lowercased copy of the text (1:1, so offsets are the original's);
//  - the word boundary is checked in JS, only where the match's edge character is a word character
//    ([\p{L}\p{N}_\p{M}]), which is also what makes it Unicode-correct ("naive" with a diaeresis
//    never yields "ve");
//  - the LOOKBEHINDS flag of re2js is never passed, so packs stay portable to other RE2 ports.

export class PackCompileError extends Error {
  override readonly name = "PackCompileError";
  constructor(
    message: string,
    /** The rule whose pattern could not be compiled (or null for a pack-level problem). */
    readonly ruleId: string | null,
    readonly packId: string,
  ) {
    super(message);
  }
}

export interface SearchFilters {
  position: "any" | "sentence_start" | "closing";
  /** Rule inactive when the document has more prose words than this. */
  maxDocWords: number | null;
  sentenceMaxWords: number | null;
  /** A unit in which this pattern matches anywhere is skipped. */
  sentenceExclude: RE2JS | null;
}

/** One phrase or regex part of a rule (a `phrase` or `regex` rule has exactly one; `any` has several). */
export interface SearchPart {
  readonly kind: "search";
  readonly source: "phrase" | "regex";
  readonly re: RE2JS;
  /** Index of the `span` group in `re`, or 0 for the whole match. */
  readonly spanGroup: number;
  /** Check a word boundary in JS before the match's first / after its last character. */
  readonly checkLead: boolean;
  readonly checkTrail: boolean;
  /**
   * Phrase parts only: the normalised phrases, longest first. When the alternation's longest hit
   * fails the trailing boundary, a shorter phrase that starts at the same place may still be valid
   * ("foo" inside the rejected "foo bar" in "foo barx"); `sticky(i)` matches phrase i there.
   */
  readonly phrases: readonly string[] | null;
  readonly sticky: (i: number) => RegExp;
  /**
   * Regex parts whose trailing  was stripped: the same pattern with RE2's own trailing  kept, compiled on
   * first use. When the stripped pattern's match fails the trailing boundary, RE2 backtracks into the other
   * alternatives (or a longer lazy match) at the same start with this one; the JS Unicode check runs again after.
   */
  readonly strict: () => RE2JS | null;
  readonly filters: SearchFilters;
}

export interface SentenceMetricMatch {
  readonly kind: "sentence_metric";
  readonly metric: (typeof SENTENCE_METRICS)[number];
  readonly above: number | null;
  readonly below: number | null;
  readonly minWords: number;
  /** `starts_with`: the pattern, anchored at the start of the sentence's text. */
  readonly startsWith: RE2JS | null;
}

export interface DocumentMetricMatch {
  readonly kind: "document_metric";
  readonly metric: (typeof DOCUMENT_METRICS)[number];
  readonly above: number | null;
  readonly below: number | null;
  readonly minSentences: number;
  readonly minItemWords: number;
}

export interface SearchMatch {
  readonly kind: "search";
  readonly parts: readonly SearchPart[];
}

export type CompiledMatch = SearchMatch | SentenceMetricMatch | DocumentMetricMatch;

export interface CompiledRule {
  readonly id: string;
  readonly category: Rule["category"];
  /** The pack's severity; the profile's effective severity is applied at review time. */
  readonly severity: Rule["severity"];
  readonly instruction: { readonly action: Action; readonly text: string };
  readonly match: CompiledMatch;
}

export interface CompiledPack {
  readonly id: string;
  readonly version: string;
  readonly rules: readonly CompiledRule[];
}

// ---- pattern helpers ---------------------------------------------------------------------------

const REGEX_META = /[\\^$.|?*+()[\]{}]/g;

/** `s` with every regex metacharacter escaped. */
export function escapeRegex(s: string): string {
  return s.replace(REGEX_META, "\\$&");
}

function phraseSource(phrases: readonly string[]): { source: string; list: string[] } {
  const list = [...new Set(phrases.map((p) => normalizeForMatching(p).trim().replace(/\s+/g, " ")))].filter((p) => p.length > 0);
  list.sort((a, b) => b.length - a.length || (a < b ? -1 : a > b ? 1 : 0));
  const alts = list.map((p) => p.split(" ").map(escapeRegex).join("\\s+"));
  return { source: `(?:${alts.join("|")})`, list };
}

/**
 * A literal space in a regex matches a run of whitespace (`\s+`), as a space does in a phrase. The text
 * has its line breaks and tabs turned into spaces one for one, so a CRLF wrap is two of them
 * ("worth\r\nnoting") and a pattern written with one space would otherwise miss it. A space inside a
 * character class, an escaped space, and a space that carries its own quantifier are left alone.
 */
export function whitespaceRuns(pattern: string): string {
  let out = "";
  let inClass = false;
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i] as string;
    if (c === "\\") {
      out += c + (pattern[i + 1] ?? "");
      i++;
    } else if (inClass) {
      if (c === "]") inClass = false;
      out += c;
    } else if (c === "[") {
      inClass = true;
      out += c;
      if (pattern[i + 1] === "^") out += pattern[++i];
      if (pattern[i + 1] === "]") out += pattern[++i];
    } else if (c === " " && !"?*+{".includes(pattern[i + 1] ?? "")) {
      out += "\\s+";
    } else {
      out += c;
    }
  }
  return out;
}

/** True when `p` has a `|` outside every group and character class. */
function hasTopLevelAlternation(p: string): boolean {
  let depth = 0;
  let inClass = false;
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === "\\") {
      i++;
      continue;
    }
    if (inClass) {
      if (c === "]") inClass = false;
      continue;
    }
    if (c === "[") {
      inClass = true;
      if (p[i + 1] === "^") i++;
      if (p[i + 1] === "]") i++;
    } else if (c === "(") depth++;
    else if (c === ")") depth--;
    else if (c === "|" && depth === 0) return true;
  }
  return false;
}

/**
 * Strips a leading and a trailing `\b` from a regex so RE2 can use its fast paths (S4); the caller
 * re-checks the boundary in JS. A pattern with a top-level alternation is left alone: its `\b`
 * may belong to one branch only.
 */
export function stripOuterBoundaries(pattern: string): { source: string; lead: boolean; trail: boolean } {
  if (hasTopLevelAlternation(pattern)) return { source: pattern, lead: false, trail: false };
  let source = pattern;
  let lead = false;
  let trail = false;
  if (source.startsWith("\\b") && source.length > 2) {
    source = source.slice(2);
    lead = true;
  }
  if (source.endsWith("\\b") && source.length > 2) {
    let slashes = 0;
    for (let i = source.length - 3; i >= 0 && source[i] === "\\"; i--) slashes++;
    if (slashes % 2 === 0) {
      source = source.slice(0, -2);
      trail = true;
    }
  }
  return { source, lead, trail };
}

function compileRe2(source: string, ruleId: string, what: string, packId: string): RE2JS {
  try {
    // Flags 0 on purpose: never RE2JS.LOOKBEHINDS, never CASE_INSENSITIVE (the text is lowercased).
    return RE2JS.compile(source, 0);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new PackCompileError(`Rule ${ruleId}: ${what} does not compile in RE2: ${reason}`, ruleId, packId);
  }
}

function compileFilters(
  f: { position?: "any" | "sentence_start" | "closing" | undefined; max_doc_words?: number | undefined; sentence_max_words?: number | undefined; sentence_exclude?: string | undefined },
  ruleId: string,
  packId: string,
): SearchFilters {
  return {
    position: f.position ?? "any",
    maxDocWords: f.max_doc_words ?? null,
    sentenceMaxWords: f.sentence_max_words ?? null,
    sentenceExclude: f.sentence_exclude === undefined ? null : compileRe2(f.sentence_exclude, ruleId, "sentence_exclude", packId),
  };
}

type PartInput =
  | {
      kind: "phrase";
      phrases: string[];
      boundary: "word" | "none";
      position?: "any" | "sentence_start" | "closing" | undefined;
      max_doc_words?: number | undefined;
      sentence_max_words?: number | undefined;
      sentence_exclude?: string | undefined;
    }
  | {
      kind: "regex";
      pattern: string;
      position?: "any" | "sentence_start" | "closing" | undefined;
      max_doc_words?: number | undefined;
      sentence_max_words?: number | undefined;
      sentence_exclude?: string | undefined;
    };

function compilePart(part: PartInput, ruleId: string, packId: string): SearchPart {
  const filters = compileFilters(part, ruleId, packId);
  if (part.kind === "phrase") {
    const { source, list } = phraseSource(part.phrases);
    if (list.length === 0) throw new PackCompileError(`Rule ${ruleId}: a phrase part has no usable phrase`, ruleId, packId);
    const re = compileRe2(source, ruleId, "phrase list", packId);
    const cache: Array<RegExp | undefined> = [];
    const sticky = (i: number): RegExp => {
      let r = cache[i];
      if (r === undefined) {
        r = new RegExp((list[i] as string).split(" ").map(escapeRegex).join("\\s+"), "y");
        cache[i] = r;
      }
      return r;
    };
    const word = part.boundary === "word";
    return { kind: "search", source: "phrase", re, spanGroup: 0, checkLead: word, checkTrail: word, phrases: list, sticky, strict: () => null, filters };
  }
  const { source, lead, trail } = stripOuterBoundaries(whitespaceRuns(part.pattern));
  const re = compileRe2(source, ruleId, "pattern", packId);
  const group = re.namedGroups()["span"];
  let strictRe: RE2JS | undefined;
  return {
    kind: "search",
    source: "regex",
    re,
    spanGroup: group ?? 0,
    checkLead: lead,
    checkTrail: trail,
    phrases: null,
    strict: () => {
      if (!trail) return null;
      strictRe ??= compileRe2(`(?:${source})\\b`, ruleId, "pattern", packId);
      return strictRe;
    },
    sticky: () => {
      throw new Error("sticky() is for phrase parts");
    },
    filters,
  };
}

function compileRule(rule: Rule, packId: string): CompiledRule {
  const m = rule.match;
  let match: CompiledMatch;
  switch (m.kind) {
    case "phrase":
    case "regex":
      match = { kind: "search", parts: [compilePart(m, rule.id, packId)] };
      break;
    case "any":
      match = { kind: "search", parts: m.parts.map((p) => compilePart(p, rule.id, packId)) };
      break;
    case "sentence_metric": {
      if (!(SENTENCE_METRICS as readonly string[]).includes(m.metric)) {
        throw new PackCompileError(`Rule ${rule.id}: sentence metric '${m.metric}' is not implemented`, rule.id, packId);
      }
      const startsWith = m.metric === "starts_with" && m.pattern !== undefined ? compileRe2(`^(?:${m.pattern})`, rule.id, "starts_with pattern", packId) : null;
      match = {
        kind: "sentence_metric",
        metric: m.metric,
        above: m.above ?? null,
        below: m.below ?? null,
        minWords: m.min_words ?? 0,
        startsWith,
      };
      break;
    }
    case "document_metric": {
      if (!(DOCUMENT_METRICS as readonly string[]).includes(m.metric)) {
        throw new PackCompileError(`Rule ${rule.id}: document metric '${m.metric}' is not implemented`, rule.id, packId);
      }
      if (m.min_sentences === undefined) {
        throw new PackCompileError(`Rule ${rule.id}: a document_metric must declare min_sentences`, rule.id, packId);
      }
      match = {
        kind: "document_metric",
        metric: m.metric,
        above: m.above ?? null,
        below: m.below ?? null,
        minSentences: m.min_sentences,
        minItemWords: m.min_item_words ?? 0,
      };
      break;
    }
  }
  return {
    id: rule.id,
    category: rule.category,
    severity: rule.severity,
    instruction: { action: rule.instruction.action, text: rule.instruction.text },
    match,
  };
}

// ---- cache -------------------------------------------------------------------------------------

interface CacheEntry {
  fingerprint: string;
  compiled: CompiledPack;
}

const CACHE = new Map<string, CacheEntry>();

/**
 * Compiles `pack` once; later calls with the same `id@version` and the same content return the same
 * object. The content is fingerprinted on every call, so a pack mutated in place or republished under
 * the same id@version recompiles and replaces the entry: a stale compile is never served.
 */
export function compilePack(pack: RulePack): CompiledPack {
  const key = `${pack.id}@${pack.version}`;
  const fingerprint = JSON.stringify(pack);
  const hit = CACHE.get(key);
  if (hit !== undefined && hit.fingerprint === fingerprint) return hit.compiled;
  const rules = pack.rules.map((r) => Object.freeze(compileRule(r, pack.id)));
  const compiled: CompiledPack = Object.freeze({ id: pack.id, version: pack.version, rules: Object.freeze(rules) });
  CACHE.set(key, { fingerprint, compiled });
  return compiled;
}

/** Empties the compile cache (tests, and a long-lived process that wants to release memory). */
export function clearPackCache(): void {
  CACHE.clear();
}
