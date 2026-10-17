// Syntactic checks on rule-pack phrases and patterns (ADR-15, ADR-19).
//
// These run in the config Worker, which has no RE2 engine, so they are purely lexical. They do not
// prove a pattern is valid RE2: the publish job compiles with re2js before signing. They reject the
// constructs RE2 refuses or that cost too much (lookaround, backreferences, nested counted
// repetition), the markdown escapes that compile but never match (`\|`, `\\b`), and text the
// segmenter folds before matching, which could never match a pattern written with it.
//
// Phrases and patterns never reach a model, so they are exempt from the injected-text filter.

/** Characters the segmenter folds to ASCII before matching: curly quotes, NBSP-class spaces, U+2010/2011. */
const FOLDED = /[\u{2018}\u{2019}\u{201c}\u{201d}\u{a0}\u{1680}\u{2000}-\u{200a}\u{202f}\u{205f}\u{3000}\u{2010}\u{2011}]/u;

export const MAX_COUNTED_REPETITION = 1000;
/** Cap on the sum of all counted repeats in one pattern (the product cap alone lets `\p{L}{1000}` repeat 8 times). */
export const MAX_REPETITION_TOTAL = 5000;
export const MAX_REGEX_RULES = 100;
export const MAX_PATTERN_BYTES = 32 * 1024;

export function lintPhrase(phrase: string): string | null {
  if (!/\p{L}/u.test(phrase)) return "must contain a letter";
  if (FOLDED.test(phrase)) return "contains a character the segmenter folds (curly quote, no-break space, U+2010/2011); write the ASCII form";
  if (phrase !== phrase.toLowerCase()) return "must be lowercase";
  return null;
}

/** Strips what may legitimately be uppercase inside a lowercase pattern. */
function withoutEscapes(pattern: string): string {
  return pattern
    .replace(/\\[pP]\{[^}]*\}/g, "")
    .replace(/\\x\{[^}]*\}/g, "")
    .replace(/\\Q[\s\S]*?(?:\\E|$)/g, "")
    .replace(/\(\?P</g, "")
    .replace(/\\[\s\S]/g, "");
}

export function lintPattern(pattern: string): string | null {
  if (pattern.includes("\\|")) return "contains \\| (a markdown table escape; write a plain | for alternation)";
  if (pattern.includes("\\\\b")) return "contains \\\\b (a doubled backslash; write \\b)";
  if (FOLDED.test(pattern)) return "contains a character the segmenter folds (curly quote, no-break space, U+2010/2011); write the ASCII form";
  const text = withoutEscapes(pattern);
  if (text !== text.toLowerCase()) return "must be lowercase outside escapes";
  if (pattern.split("(?P<span>").length - 1 > 1) return "uses the named group (?P<span>) more than once";
  return scan(pattern);
}

interface Frame {
  /** The largest repetition product seen anywhere directly or nested inside this group. */
  inner: number;
}

const COUNTED = /^\{(\d+)(?:,(\d*))?\}/;

/** One left-to-right pass: lookaround, backreferences, counted repetition and its nesting. */
function scan(p: string): string | null {
  const stack: Frame[] = [{ inner: 1 }];
  const top = (): Frame => stack[stack.length - 1] as Frame;
  let atom: number | null = null; // repetition product of the atom a quantifier would apply to
  let repeatTotal = 0; // sum of every counted repeat in the pattern
  let inClass = false;
  let i = 0;
  while (i < p.length) {
    const c = p[i] as string;
    if (c === "\\") {
      const n = p[i + 1];
      if (n !== undefined && n >= "1" && n <= "9") return "uses a backreference (RE2 has none)";
      if (n === "Q") {
        const end = p.indexOf("\\E", i + 2);
        i = end === -1 ? p.length : end + 2;
      } else if ((n === "p" || n === "P" || n === "x") && p[i + 2] === "{") {
        const end = p.indexOf("}", i + 3);
        i = end === -1 ? p.length : end + 1;
      } else {
        i += 2;
      }
      if (!inClass) atom = 1;
      continue;
    }
    if (inClass) {
      if (c === "[" && p[i + 1] === ":") {
        const end = p.indexOf(":]", i + 2);
        i = end === -1 ? p.length : end + 2;
      } else {
        if (c === "]") {
          inClass = false;
          atom = 1;
        }
        i += 1;
      }
      continue;
    }
    if (c === "[") {
      inClass = true;
      i += 1;
      if (p[i] === "^") i += 1;
      if (p[i] === "]") i += 1;
      continue;
    }
    if (c === "(") {
      if (p[i + 1] === "?") {
        const two = p.slice(i + 2, i + 4);
        if (two.startsWith("=") || two.startsWith("!")) return "uses lookahead (RE2 has none)";
        if (two === "<=" || two === "<!") return "uses lookbehind (RE2 has none)";
        // (?:  (?P<name>  (?<name>  (?flags:  (?flags)
        const close = p.slice(i + 2).search(/[:>)]/);
        const end = close === -1 ? p.length : i + 2 + close;
        if (p[end] === ")") {
          i = end + 1; // a bare flag group such as (?i): zero width, nothing to quantify
          atom = null;
          continue;
        }
        i = end + 1;
      } else {
        i += 1;
      }
      stack.push({ inner: 1 });
      atom = null;
      continue;
    }
    if (c === ")") {
      if (stack.length > 1) {
        const frame = stack.pop() as Frame;
        top().inner = Math.max(top().inner, frame.inner);
        atom = frame.inner;
      }
      i += 1;
      continue;
    }
    if (c === "{") {
      const m = COUNTED.exec(p.slice(i, i + 24));
      if (m !== null && atom !== null) {
        const min = Number(m[1]);
        const max = m[2] === undefined ? min : m[2] === "" ? Number.POSITIVE_INFINITY : Number(m[2]);
        if (min > MAX_COUNTED_REPETITION || (Number.isFinite(max) && max > MAX_COUNTED_REPETITION)) {
          return `repeats more than ${MAX_COUNTED_REPETITION} times`;
        }
        // An open upper bound ({n,}) counts as at least two, so it cannot hide a nested product.
        const product = atom * (Number.isFinite(max) ? max : Math.max(min, 2));
        if (product > MAX_COUNTED_REPETITION) return `nested counted repetition multiplies to more than ${MAX_COUNTED_REPETITION}`;
        // Sequential repeats do not multiply, but each one still costs: cap the sum for the pattern.
        repeatTotal += Number.isFinite(max) ? max : Math.max(min, 2);
        if (repeatTotal > MAX_REPETITION_TOTAL) return `repeat counts total more than ${MAX_REPETITION_TOTAL}`;
        top().inner = Math.max(top().inner, product);
        atom = product;
        i += (m[0] as string).length;
        continue;
      }
    }
    if (c === "*" || c === "+" || c === "?" || c === "|") {
      if (c === "|") atom = null;
      i += 1;
      continue;
    }
    atom = 1;
    i += 1;
  }
  return null;
}
