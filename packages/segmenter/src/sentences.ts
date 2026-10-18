/**
 * Sentence splitter for one paragraph element. A break needs terminal punctuation (`.` `!` `?`
 * `…`, as a run), optional closing quotes/brackets/emphasis marks that stay with the sentence,
 * whitespace, and then a character that can start a sentence. Abbreviations, initials, "No. 5",
 * month-day dates and inline step numbers veto a break. Terminators inside masks (inline code),
 * Markdown link text and attributed quote segments are ignored, except that a quote ending in a
 * terminator can end the sentence.
 */

import { isAsciiAlnum, isWs, skipWs, trimEnd } from "./lines.js";
import type { Span } from "./types.js";

const UPPER_RE = /^[\p{Lu}\p{Lt}]$/u;
const DIGIT_RE = /^\p{Nd}$/u;
/** Emoji, dingbats and arrows can start a sentence ("Done. ✅ Tests pass. ⚠️ One warning."). */
const SYMBOL_START_RE = /^[\p{Extended_Pictographic}←-⇿✓✗]$/u;

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

/** Can the code point at `m` begin a sentence? Uppercase letter, digit, quote, bracket, emphasis/code opener, emoji or arrow. */
function startsSentence(text: string, m: number): boolean {
  const c = text.charCodeAt(m);
  if (c >= 65 && c <= 90) return true;
  if (c >= 48 && c <= 57) return true;
  if (c === 34 || c === 39 || c === 40 || c === 91 || c === 123) return true; // " ' ( [ {
  if (c === 42 || c === 95 || c === 96) return true; // * _ `
  if (c === 0x201c || c === 0x2018 || c === 0xab || c === 0x2039) return true;
  if (c < 128) return false;
  const cp = String.fromCodePoint(text.codePointAt(m) as number);
  return UPPER_RE.test(cp) || DIGIT_RE.test(cp) || SYMBOL_START_RE.test(cp);
}

/**
 * Abbreviations after which a period never ends a sentence, whatever follows. Titles and company
 * suffixes are matched case-sensitively in their capitalised form (a lowercase "ms." is
 * milliseconds and does end sentences); the Latin and bibliographic ones are matched ignoring case.
 */
const NO_BREAK_CAPITALISED = new Set(["Mr", "Mrs", "Ms", "Dr", "Prof", "Inc", "Ltd", "St", "Jr", "Sr", "Dept"]);
const NO_BREAK_ANY_CASE = new Set([
  "e.g",
  "i.e",
  "vs",
  "cf",
  "approx",
  "u.s",
  "fig",
  "vol",
  "eq",
  "ca",
  "al",
  "co",
  "corp",
  "esp",
  "incl",
  "viz",
]);
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
/** These end sentences, except before a weekday, a month or a time-zone-like ALLCAPS token ("9 a.m. Monday"). */
const SOFT_ABBREVIATIONS = new Set(["a.m", "p.m", "etc"]);
const WEEKDAYS_AND_MONTHS = new Set(
  (
    "monday tuesday wednesday thursday friday saturday sunday mon tue tues wed thu thur thurs fri sat sun " +
    "january february march april june july august september october november december jan feb mar apr jun jul " +
    "aug sep sept oct nov dec"
  ).split(" "),
);
const INITIALS_RE = /^(?:[A-Z]\.)*[A-Z]$/;
/** Words that start sentences far more often than they follow an initial as a surname. */
const SENTENCE_STARTERS = new Set(
  (
    "the this that these those it he she they we you i in on at an if when but and or so then next however for as " +
    "our my your there here what why how also now see note please let use run add make thanks otherwise because " +
    "instead therefore thus finally still second third meanwhile afterwards additionally similarly overall once " +
    "after before with without during unless since while although though whereas each every all some no yes ok " +
    "okay today tomorrow yesterday"
  ).split(" "),
);
/** A lowercase word before a single capital that still leaves it an initial ("written by J. Smith"). */
const INITIAL_LEAD_WORDS = new Set(
  "by and with from of said says wrote named called via cc thanks attn dear".split(" "),
);

/** The alphanumeric/dot token immediately before the period at `dotAt` (at most 12 code units). */
function tokenBefore(text: string, dotAt: number, s: number): { tok: string; start: number } {
  let a = dotAt;
  while (a > s && dotAt - a < 12) {
    const c = text.charCodeAt(a - 1);
    if (isAsciiAlnum(c) || c === 46) a--;
    else break;
  }
  while (a < dotAt && text.charCodeAt(a) === 46) a++;
  return { tok: text.slice(a, dotAt), start: a };
}

/** The run of ASCII letters starting at `from`. */
function wordAt(text: string, from: number): string {
  let w = from;
  while (w < text.length && isAsciiAlnum(text.charCodeAt(w))) w++;
  return text.slice(from, w);
}

/** Is the token starting at `tokStart` the first thing in the unit, or right after a clause/sentence boundary? */
function startsUnitOrClause(text: string, tokStart: number, s: number): boolean {
  let k = tokStart - 1;
  while (k >= s && isWs(text.charCodeAt(k))) k--;
  if (k < s) return true;
  const c = text.charCodeAt(k);
  if (c === 46) {
    // a period only counts when it ends a sentence, not an abbreviation ("Vol. 3.", "No. 7.")
    const { tok } = tokenBefore(text, k, s);
    return !(NO_BREAK_CAPITALISED.has(tok) || NO_BREAK_ANY_CASE.has(tok.toLowerCase()) || NO_BREAK_BEFORE_DIGIT.has(tok) || tok === "No");
  }
  return c === 58 || c === 59 || c === 33 || c === 63; // : ; ! ?
}

/** Is the single capital at `tokStart` first in the unit, or after a capitalised word or another initial, or after a name lead-in? */
function initialContext(text: string, tokStart: number, s: number): boolean {
  let k = tokStart - 1;
  while (k >= s && (isWs(text.charCodeAt(k)) || text.charCodeAt(k) === 40 || text.charCodeAt(k) === 34)) k--;
  if (k < s) return true; // first token of the unit
  let ps = k;
  while (ps > s && !isWs(text.charCodeAt(ps - 1))) ps--;
  const prev = text.slice(ps, k + 1);
  const last = prev.charCodeAt(prev.length - 1);
  if (last === 46 || last === 33 || last === 63 || last === 58) return true; // the initial opens a sentence or clause
  const c0 = prev.charCodeAt(0);
  if (c0 >= 65 && c0 <= 90) return true; // capitalised word, or an initial such as "J."
  if (c0 > 127 && UPPER_RE.test(String.fromCodePoint(prev.codePointAt(0) as number))) return true;
  return INITIAL_LEAD_WORDS.has(prev.toLowerCase().replace(/[^a-z]/g, ""));
}

/** Is there a step marker "N." or "N)" (N a number) set off by whitespace inside text[lo, hi)? */
function hasMarker(text: string, lo: number, hi: number, n: number): boolean {
  if (hi <= lo) return false;
  const win = text.slice(lo, hi);
  for (const suffix of [".", ")"]) {
    const needle = String(n) + suffix;
    for (let k = win.indexOf(needle); k >= 0; k = win.indexOf(needle, k + 1)) {
      const before = lo + k === 0 ? 32 : text.charCodeAt(lo + k - 1);
      const after = lo + k + needle.length < text.length ? text.charCodeAt(lo + k + needle.length) : 32;
      if (isWs(before) && isWs(after)) return true;
    }
  }
  return false;
}

/** Window (code units) in which a neighbouring step marker is looked for. */
const MARKER_WINDOW = 600;

function vetoed(text: string, dotAt: number, s: number, e: number, next: number): boolean {
  const { tok, start: tokStart } = tokenBefore(text, dotAt, s);
  if (tok.length === 0) return false;
  const lower = tok.toLowerCase();
  if (NO_BREAK_CAPITALISED.has(tok) || NO_BREAK_ANY_CASE.has(lower)) return true;
  const nc = text.charCodeAt(next);
  if ((NO_BREAK_BEFORE_DIGIT.has(tok) || tok === "No") && nc >= 48 && nc <= 57) return true;
  // Inline numbered steps ("Steps: 1. Install it. 2. Run it."): the number stays with its step.
  // Only a number that belongs to a sequence is a step marker: "Exit code: 1. The build failed." is a sentence end.
  if (tok.length <= 2 && /^\d{1,2}$/.test(tok) && startsUnitOrClause(text, tokStart, s)) {
    const n = Number(tok);
    if (hasMarker(text, next, Math.min(e, next + MARKER_WINDOW), n + 1)) return true;
    if (n > 1 && hasMarker(text, Math.max(s, tokStart - MARKER_WINDOW), tokStart, n - 1)) return true;
  }
  if (SOFT_ABBREVIATIONS.has(lower)) {
    const w = wordAt(text, next);
    // A weekday or month follows 9 a.m. / etc.; a time zone (ALLCAPS, 2-4 letters) follows a clock time only.
    return WEEKDAYS_AND_MONTHS.has(w.toLowerCase()) || ((lower === "a.m" || lower === "p.m") && /^[A-Z]{2,4}$/.test(w));
  }
  // Dotted multi-letter initials (J.P. Morgan, J.K. Rowling, U.K. Government, J.R.R. Tolkien): no left context needed.
  if (tok.includes(".") && INITIALS_RE.test(tok) && nc >= 65 && nc <= 90) {
    const w = wordAt(text, next);
    if (w.length === 1) return text.charCodeAt(next + 1) === 46;
    return !SENTENCE_STARTERS.has(w.toLowerCase());
  }
  // "J. Smith", "J.R.R. Tolkien": an initial before a name. Not before a word that starts sentences
  // ("Appendix A. The next step"), a single capital after it only counts as a further initial
  // ("J. R. Smith"), and the initial itself must follow a capitalised word, another initial, a name
  // lead-in ("by J. Smith") or the start of the unit ("Use option B. Otherwise..." breaks).
  if (tok !== "I" && INITIALS_RE.test(tok) && nc >= 65 && nc <= 90) {
    const w = wordAt(text, next);
    if (w.length === 1) return text.charCodeAt(next + 1) === 46;
    if (SENTENCE_STARTERS.has(w.toLowerCase())) return false;
    return initialContext(text, tokStart, s);
  }
  return false;
}

/** Spans of `[link text]` that is followed by `(`: a sentence never ends inside link text. */
function linkTextSpans(text: string, s: number, e: number): Span[] {
  const out: Span[] = [];
  const stack: number[] = [];
  for (let k = s; k < e; k++) {
    const c = text.charCodeAt(k);
    if (c === 91) stack.push(k);
    else if (c === 93) {
      const open = stack.pop();
      if (open !== undefined && k + 1 < e && text.charCodeAt(k + 1) === 40) out.push({ start: open, end: k + 1 });
    }
  }
  return out;
}

/**
 * Sentence ranges of the element [s, e), each trimmed of surrounding whitespace, in order.
 * `masks` and `quotes` must be sorted, non-overlapping, and lie inside [s, e).
 */
export function splitSentences(text: string, s: number, e: number, masks: Span[], quotes: Span[]): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  let start = skipWs(text, s, e);
  if (start >= e) return out;

  const links = linkTextSpans(text, s, e);
  const opaque = links.length === 0 ? masks : [...masks, ...links].sort((x, y) => x.start - y.start || x.end - y.end);

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
    while (mi < opaque.length && (opaque[mi] as Span).end <= i) mi++;
    const mk = opaque[mi];
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
    if (b !== null && !(c === 46 && j - i === 1 && vetoed(text, i, s, e, b[1]))) {
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
