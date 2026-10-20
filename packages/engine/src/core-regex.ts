import type { SearchExpression } from "./compile.js";

// Audited, byte-identical core patterns only. Unbounded repetitions consume
// disjoint letters/whitespace, and wildcard/count repetitions are capped at 80.
// No nested ambiguous repetition, backreferences or lookaround are admitted.
// Search windows and retry limits still apply. Editing a pattern opts it out.
const PATTERNS = new Set([
  String.raw`\b(?:it's|it is) (?:also )?(?:important to note|worth noting|worth mentioning)(?: that)?,?`,
  String.raw`\bit should be noted(?: that)?,?`,
  String.raw`\b(?P<span>somewhat|fairly|relatively)\s+[a-z]+`,
  String.raw`\b(may or may not|could potentially|might possibly|can possibly|can potentially)\b`,
  String.raw`\bit depends[.!]`,
  String.raw`\b(?:to|can|could|should|will|would|we|you|they|i|us|we'll|you'll|they'll|then) (?P<span>leverage)\b`,
  String.raw`\b(?P<span>underscore[sd]) (?:the|that|how|why|a|an|our|its|this)\b`,
  String.raw`\b(?:the|this|today's) (?:[a-z-]+ ){0,2}(?P<key>landscape)\b`,
  String.raw`\b(?P<span>highly) (?:effective|efficient|scalable|recommended|likely|unlikely)\b`,
  String.raw`\b[a-z][a-z-]{0,11}, [a-z][a-z-]{0,11},? and [a-z][a-z-]{0,11}\b`,
  String.raw`\bnot (?:(?:just|only|merely|about) .{3,80}?(?:,|;| —|—) (?:but|it's about|it is about)|only .{3,80}? but also)\b`,
  String.raw`\bfrom [a-z]+ to [a-z]+, (?:and )?[a-z]+`,
]);

export function isNativeCorePattern(packId: string, pattern: string): boolean {
  return packId === "core" && PATTERNS.has(pattern);
}

// Preserve RE2's ASCII whitespace and LF-only dot exclusion, including raw
// CR/U+2028/U+2029 inputs. Other escapes/classes in the audited set are shared.
function nativeSource(source: string): string {
  let out = "", inClass = false;
  const input = source.replaceAll("(?P<", "(?<");
  for (let i = 0; i < input.length; i++) {
    const ch = input[i] as string;
    if (ch === "\\") {
      const next = input[++i];
      out += next === "s" ? "[\\t\\n\\f\\r ]" : `\\${next}`;
    } else {
      if (ch === "[") inClass = true;
      if (ch === "]") inClass = false;
      out += ch === "." && !inClass ? "[^\\n]" : ch;
    }
  }
  return out;
}

/** Internal: called only for the audited patterns above or the literal digit filter. */
export function nativeCoreSearch(source: string): SearchExpression {
  const re = new RegExp(nativeSource(source), "dgu");
  return {
    test(text) { re.lastIndex = 0; return re.test(text); },
    matcher(text) {
      let hit: RegExpExecArray | null = null;
      return {
        find(start) {
          const c = text.charCodeAt(start), prev = text.charCodeAt(start - 1);
          // RegExp /u rewinds inside a surrogate pair; RE2 searches forward.
          if (c >= 0xdc00 && c <= 0xdfff && prev >= 0xd800 && prev <= 0xdbff) start++;
          re.lastIndex = start;
          hit = re.exec(text);
          return hit !== null;
        },
        start: (group) => hit?.indices?.[group]?.[0] ?? -1,
        end: (group) => hit?.indices?.[group]?.[1] ?? -1,
      };
    },
  };
}
