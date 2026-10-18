import type { Mask } from "@prosegate/segmenter";
import { isStopWord } from "./stopwords.js";

// ---- word characters (ADR-15 "Boundaries") -----------------------------------------------------

const WORD_CHAR = /^[\p{L}\p{N}_\p{M}]$/u;

function isAsciiWord(c: number): boolean {
  return (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95;
}

/** True when the code point `cp` (a one- or two-unit string) is a word character: [\p{L}\p{N}_\p{M}]. */
export function isWordCodePoint(cp: string): boolean {
  const c = cp.charCodeAt(0);
  if (c < 128) return isAsciiWord(c);
  return WORD_CHAR.test(cp);
}

/** The code point that ends right before index `i` of `s`, or null at the start. */
export function codePointBefore(s: string, i: number): string | null {
  if (i <= 0) return null;
  const lo = s.charCodeAt(i - 1);
  if (lo >= 0xdc00 && lo <= 0xdfff && i >= 2) {
    const hi = s.charCodeAt(i - 2);
    if (hi >= 0xd800 && hi <= 0xdbff) return s.slice(i - 2, i);
  }
  return s[i - 1] as string;
}

/** The code point that starts at index `i` of `s`, or null at the end. */
export function codePointAt(s: string, i: number): string | null {
  if (i >= s.length) return null;
  const hi = s.charCodeAt(i);
  if (hi >= 0xd800 && hi <= 0xdbff && i + 1 < s.length) {
    const lo = s.charCodeAt(i + 1);
    if (lo >= 0xdc00 && lo <= 0xdfff) return s.slice(i, i + 2);
  }
  return s[i] as string;
}

/** The last code point of `s.slice(start, end)` (end > start). */
export function lastCodePoint(s: string, start: number, end: number): string {
  const cp = codePointBefore(s, end);
  return cp !== null && end - cp.length >= start ? cp : (s[end - 1] as string);
}

/** A hyphen between two word characters is word-internal (consistent with the segmenter's word count; ADR-24). */
function wordBefore(s: string, i: number): boolean {
  const before = codePointBefore(s, i);
  if (before === null) return false;
  if (isWordCodePoint(before)) return true;
  if (before !== "-") return false;
  const beyond = codePointBefore(s, i - 1);
  return beyond !== null && isWordCodePoint(beyond);
}

function wordAfter(s: string, i: number): boolean {
  const after = codePointAt(s, i);
  if (after === null) return false;
  if (isWordCodePoint(after)) return true;
  if (after !== "-") return false;
  const beyond = codePointAt(s, i + 1);
  return beyond !== null && isWordCodePoint(beyond);
}

/** True when a match [s, e) of the text starts on a word character that follows another word character (or a letter-hyphen). */
export function startsMidWord(s: string, start: number, end: number): boolean {
  const first = codePointAt(s, start);
  if (first === null || start >= end || !isWordCodePoint(first)) return false;
  return wordBefore(s, start);
}

/** True when a match [s, e) of the text ends on a word character that is followed by another word character (or a hyphen and one). */
export function endsMidWord(s: string, start: number, end: number): boolean {
  if (end <= start) return false;
  if (!isWordCodePoint(lastCodePoint(s, start, end))) return false;
  return wordAfter(s, end);
}

// ---- masks ---------------------------------------------------------------------------------------

/** Answers "does [s, e) intersect any mask?" in O(log n). Masks need not be sorted or disjoint. */
export class MaskIndex {
  private readonly starts: number[];
  private readonly ends: number[];
  /** maxEnd[i] = the largest end among masks 0..i (sorted by start). */
  private readonly maxEnd: number[];

  constructor(masks: readonly Mask[]) {
    const sorted = [...masks].sort((a, b) => a.start - b.start || a.end - b.end);
    this.starts = sorted.map((m) => m.start);
    this.ends = sorted.map((m) => m.end);
    this.maxEnd = [];
    let max = -1;
    for (const e of this.ends) {
      max = Math.max(max, e);
      this.maxEnd.push(max);
    }
  }

  get size(): number {
    return this.starts.length;
  }

  /** Index of the last mask whose start is < `pos`, or -1. */
  private lastStartBefore(pos: number): number {
    let lo = 0;
    let hi = this.starts.length - 1;
    let ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if ((this.starts[mid] as number) < pos) {
        ans = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return ans;
  }

  intersects(start: number, end: number): boolean {
    if (this.starts.length === 0) return false;
    const i = this.lastStartBefore(end);
    return i >= 0 && (this.maxEnd[i] as number) > start;
  }

  /** The disjoint pieces of [start, end) that lie outside every mask. */
  outside(start: number, end: number): Array<[number, number]> {
    if (!this.intersects(start, end)) return [[start, end]];
    const covered: Array<[number, number]> = [];
    const first = this.firstMaybeIntersecting(start);
    for (let i = first; i < this.starts.length && (this.starts[i] as number) < end; i++) {
      if ((this.ends[i] as number) > start) covered.push([Math.max(start, this.starts[i] as number), Math.min(end, this.ends[i] as number)]);
    }
    const out: Array<[number, number]> = [];
    let pos = start;
    for (const [s, e] of covered) {
      if (s > pos) out.push([pos, s]);
      pos = Math.max(pos, e);
    }
    if (pos < end) out.push([pos, end]);
    return out;
  }

  /** Smallest index i such that maxEnd[i] > pos (every earlier mask ends at or before pos). */
  private firstMaybeIntersecting(pos: number): number {
    let lo = 0;
    let hi = this.maxEnd.length - 1;
    let ans = this.maxEnd.length;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if ((this.maxEnd[mid] as number) > pos) {
        ans = mid;
        hi = mid - 1;
      } else {
        lo = mid + 1;
      }
    }
    return ans;
  }
}

// ---- content-word bags ---------------------------------------------------------------------------

const TOKEN_RE = /[\p{L}\p{N}][\p{L}\p{N}\p{M}]*(?:['-][\p{L}\p{N}][\p{L}\p{N}\p{M}]*)*/gu;

/**
 * Adds the content words of `s` (the normalised text: curly apostrophes and U+2010/2011 are
 * already ASCII) to `bag`: lowercase word tokens, `'s` stripped, stop words dropped.
 */
export function addContentWords(s: string, bag: Map<string, number>): void {
  TOKEN_RE.lastIndex = 0; // shared instance: synchronous and non-reentrant
  let m: RegExpExecArray | null;
  while ((m = TOKEN_RE.exec(s)) !== null) {
    let t = m[0].toLowerCase();
    if (t.endsWith("'s")) t = t.slice(0, -2);
    if (t.length === 0 || isStopWord(t)) continue;
    bag.set(t, (bag.get(t) ?? 0) + 1);
  }
}

export interface Bag {
  tf: Map<string, number>;
  /** Euclidean norm of the term-frequency vector. */
  norm: number;
}

export function finishBag(tf: Map<string, number>): Bag {
  let sq = 0;
  for (const v of tf.values()) sq += v * v;
  return { tf, norm: Math.sqrt(sq) };
}

export function cosine(a: Bag, b: Bag): number {
  if (a.norm === 0 || b.norm === 0) return 0;
  const [small, large] = a.tf.size <= b.tf.size ? [a.tf, b.tf] : [b.tf, a.tf];
  let dot = 0;
  for (const [k, v] of small) {
    const w = large.get(k);
    if (w !== undefined) dot += v * w;
  }
  return dot / (a.norm * b.norm);
}

/** Collapses runs of whitespace to one space and trims; used to compare spans with allow_terms. */
export function squashSpace(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

// ---- allow_terms ---------------------------------------------------------------------------------

const WORD_RE = /[\p{L}\p{N}][\p{L}\p{N}\p{M}]*(?:['-][\p{L}\p{N}][\p{L}\p{N}\p{M}]*)*/gu;

/** Lowercase word tokens of `s` (a hyphenated or apostrophised word is one token). */
export function wordTokens(s: string): string[] {
  return s.toLowerCase().match(WORD_RE) ?? [];
}

export interface AllowTerm {
  /** The term, normalised, lowercase, whitespace squashed. */
  text: string;
  tokens: string[];
}

export function makeAllowTerm(normalised: string): AllowTerm {
  const text = squashSpace(normalised.toLowerCase());
  return { text, tokens: wordTokens(text) };
}

/**
 * True when an allowed term equals the whole span, or equals a run of whole word tokens inside it
 * (so "landscape" exempts "the current landscape", and "robust" does not exempt "robustness").
 */
export function spanAllowed(span: string, terms: readonly AllowTerm[]): boolean {
  const whole = squashSpace(span.toLowerCase());
  if (terms.some((t) => t.text === whole)) return true;
  const tokens = wordTokens(span);
  for (const t of terms) {
    const n = t.tokens.length;
    if (n === 0 || n > tokens.length) continue;
    for (let i = 0; i + n <= tokens.length; i++) {
      let same = true;
      for (let k = 0; k < n; k++) {
        if (tokens[i + k] !== t.tokens[k]) {
          same = false;
          break;
        }
      }
      if (same) return true;
    }
  }
  return false;
}
