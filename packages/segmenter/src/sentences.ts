/**
 * Sentence splitter for one paragraph element. A break needs terminal punctuation (`.` `!` `?`
 * `…`, as a run), optional closing quotes/brackets/emphasis marks that stay with the sentence,
 * whitespace, and then a character that can start a sentence. Abbreviations, initials, "No. 5" and
 * month-day dates veto a break. Terminators inside masks (inline code) and inside attributed quote
 * segments are ignored, except that a quote ending in a terminator can end the sentence.
 */

import { isAsciiAlnum, isWs, skipWs, trimEnd } from "./lines.js";
import type { Mask, Span } from "./types.js";

const UPPER_RE = /^[\p{Lu}\p{Lt}]$/u;
const DIGIT_RE = /^\p{Nd}$/u;

function isTerm(c: number): boolean {
  return c === 46 || c === 33 || c === 63 || c === 0x2026;
}

function isCloser(c: number): boolean {
  return (
    c === 34 || // "
    c === 39 || // '
    c === 41 || // )
    c === 93 || // ]
    c === 125 || // }
    c === 42 || // *
    c === 95 || // _
    c === 126 || // ~
    c === 0x201d ||
    c === 0x2019 ||
    c === 0xbb ||
    c === 0x203a
  );
}

/** Can the code point at `m` begin a sentence? Uppercase letter, digit, quote, bracket, or an emphasis/code opener. */
function startsSentence(text: string, m: number): boolean {
  const c = text.charCodeAt(m);
  if (c >= 65 && c <= 90) return true;
  if (c >= 48 && c <= 57) return true;
  if (c === 34 || c === 39 || c === 40 || c === 91 || c === 123) return true; // " ' ( [ {
  if (c === 42 || c === 95 || c === 96) return true; // * _ `
  if (c === 0x201c || c === 0x2018 || c === 0xab || c === 0x2039) return true;
  if (c < 128) return false;
  const cp = String.fromCodePoint(text.codePointAt(m) as number);
  return UPPER_RE.test(cp) || DIGIT_RE.test(cp);
}

/**
 * Abbreviations after which a period never ends a sentence, whatever follows. Titles and company
 * suffixes are matched case-sensitively in their capitalised form (a lowercase "ms." is
 * milliseconds and does end sentences); the Latin and bibliographic ones are matched ignoring case.
 */
const NO_BREAK_CAPITALISED = new Set(["Mr", "Mrs", "Ms", "Dr", "Prof", "Inc", "Ltd", "St", "Jr", "Sr", "Dept"]);
const NO_BREAK_ANY_CASE = new Set(["e.g", "i.e", "vs", "cf", "approx", "u.s", "fig", "vol", "eq", "ca"]);
/** Abbreviations that only veto a break when a digit follows ("No. 5", "Mar. 3"). */
const NO_BREAK_BEFORE_DIGIT = new Set([
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Sept",
  "Oct",
  "Nov",
  "Dec",
]);
const INITIALS_RE = /^(?:[A-Z]\.)*[A-Z]$/;
/** Words that start sentences far more often than they follow an initial as a surname. */
const SENTENCE_STARTERS = new Set(
  (
    "the this that these those it he she they we you i in on at an if when but and so then next however for as " +
    "our my your there here what why how also now see note please let use run add make thanks"
  ).split(" "),
);

/** The alphanumeric/dot token immediately before the period at `dotAt` (at most 12 code units). */
function tokenBefore(text: string, dotAt: number, s: number): string {
  let a = dotAt;
  while (a > s && dotAt - a < 12) {
    const c = text.charCodeAt(a - 1);
    if (isAsciiAlnum(c) || c === 46) a--;
    else break;
  }
  while (a < dotAt && text.charCodeAt(a) === 46) a++;
  return text.slice(a, dotAt);
}

function vetoed(text: string, dotAt: number, s: number, next: number): boolean {
  const tok = tokenBefore(text, dotAt, s);
  if (tok.length === 0) return false;
  if (NO_BREAK_CAPITALISED.has(tok) || NO_BREAK_ANY_CASE.has(tok.toLowerCase())) return true;
  const nc = text.charCodeAt(next);
  if (NO_BREAK_BEFORE_DIGIT.has(tok) || tok === "No") {
    if (nc >= 48 && nc <= 57) return true;
  }
  // "J. Smith", "J.R.R. Tolkien": an initial before a name. Not before a word that starts sentences
  // ("Appendix A. The next step"), and a single capital after it only counts as a further initial ("J. R. Smith").
  if (tok !== "I" && INITIALS_RE.test(tok) && nc >= 65 && nc <= 90) {
    let w = next;
    while (w < text.length && isAsciiAlnum(text.charCodeAt(w))) w++;
    if (w - next === 1) return text.charCodeAt(w) === 46;
    return !SENTENCE_STARTERS.has(text.slice(next, w).toLowerCase());
  }
  return false;
}

/**
 * Sentence ranges of the element [s, e), each trimmed of surrounding whitespace, in order.
 * `masks` and `quotes` must be sorted, non-overlapping, and lie inside [s, e).
 */
export function splitSentences(text: string, s: number, e: number, masks: Mask[], quotes: Span[]): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  let start = skipWs(text, s, e);
  if (start >= e) return out;

  /** Where would a sentence break if the terminator run ends at `k`? Returns [sentenceEnd, nextStart] or null. */
  const breakAfter = (k: number): [number, number] | null => {
    let a = k;
    while (a < e && isCloser(text.charCodeAt(a))) a++;
    if (a >= e || !isWs(text.charCodeAt(a))) return null;
    let m = a;
    while (m < e && isWs(text.charCodeAt(m))) m++;
    if (m >= e || !startsSentence(text, m)) return null;
    return [a, m];
  };
  const emit = (end: number, next: number): void => {
    const te = trimEnd(text, start, end);
    if (te > start) out.push([start, te]);
    start = next;
  };

  let mi = 0;
  let qi = 0;
  let i = start;
  while (i < e) {
    while (mi < masks.length && (masks[mi] as Mask).end <= i) mi++;
    const mk = masks[mi];
    if (mk !== undefined && mk.start <= i) {
      i = mk.end;
      continue;
    }
    while (qi < quotes.length && (quotes[qi] as Span).end <= i) qi++;
    const q = quotes[qi];
    if (q !== undefined && q.start <= i) {
      // The quote is opaque, but a terminator just inside its closing mark ends the sentence there.
      if (q.end - 2 > q.start && isTerm(text.charCodeAt(q.end - 2))) {
        const b = breakAfter(q.end - 1);
        if (b !== null) emit(b[0], b[1]);
      }
      i = Math.max(q.end, start);
      continue;
    }
    const c = text.charCodeAt(i);
    if (!isTerm(c)) {
      i++;
      continue;
    }
    let j = i + 1;
    while (j < e && isTerm(text.charCodeAt(j))) j++;
    const b = breakAfter(j);
    if (b !== null && !(c === 46 && j - i === 1 && vetoed(text, i, s, b[1]))) {
      emit(b[0], b[1]);
      i = b[1];
    } else {
      i = j;
    }
  }
  const te = trimEnd(text, start, e);
  if (te > start) out.push([start, te]);
  return out;
}
