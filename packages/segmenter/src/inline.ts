/**
 * Inline passes over one prose element (a paragraph, a list item or a heading): masks (inline code,
 * URLs, emails, file paths), bold spans and attributed double-quoted runs. Everything is linear in
 * the element length: no regex runs over unbounded input with nested quantifiers, and every
 * scanning loop either advances or terminates.
 */

import { isAsciiAlnum, isWs } from "./lines.js";
import type { Mask, Span } from "./types.js";
import { countWords } from "./words.js";

// ---------------------------------------------------------------------------------------------
// Masks
// ---------------------------------------------------------------------------------------------

const BACKTICK = 96;

function findInlineCode(text: string, s: number, e: number): Span[] {
  const rs: number[] = [];
  const rl: number[] = [];
  for (let i = s; i < e; ) {
    if (text.charCodeAt(i) === BACKTICK) {
      let j = i;
      while (j < e && text.charCodeAt(j) === BACKTICK) j++;
      rs.push(i);
      rl.push(j - i);
      i = j;
    } else {
      i++;
    }
  }
  const runs = rs.length;
  if (runs < 2) return [];
  // A span opens at a run and closes at the next run of exactly the same length; an opener with no
  // closer is literal text. next[r] makes the whole pass O(runs).
  const next = new Array<number>(runs).fill(-1);
  const lastByLen = new Map<number, number>();
  for (let r = runs - 1; r >= 0; r--) {
    const len = rl[r] as number;
    next[r] = lastByLen.get(len) ?? -1;
    lastByLen.set(len, r);
  }
  const out: Span[] = [];
  let r = 0;
  while (r < runs) {
    const c = next[r] as number;
    if (c >= 0) {
      out.push({ start: rs[r] as number, end: (rs[c] as number) + (rl[c] as number) });
      r = c + 1;
    } else {
      r++;
    }
  }
  return out;
}

const KNOWN_EXTENSIONS = new Set(
  (
    "ts tsx js jsx mjs cjs json md mdx yaml yml toml ini cfg conf env py rb go rs java kt c h cc cpp hpp cs css scss " +
    "html htm xml sh bash zsh ps1 bat txt csv tsv lock sql log svg png jpg jpeg gif pdf zip gz tar wasm php swift " +
    "vue svelte tf proto graphql gql ipynb"
  ).split(" "),
);

const URL_RE = /(?:https?:\/\/|www\.)[^\s<>[\]"'`“”]+/giu;
const LEAD_STRIP = new Set(["(", "[", "{", "<", '"', "'", "*", "_", "“", "‘"]);
const TRAIL_STRIP = new Set([")", "]", "}", ">", '"', "'", ".", ",", ";", ":", "!", "?", "*", "_", "”", "’"]);

function stripUrlEnd(text: string, us: number, ue: number): number {
  let end = ue;
  while (end > us) {
    const ch = text[end - 1] as string;
    if (ch === ")") {
      let open = 0;
      let close = 0;
      for (let k = us; k < end; k++) {
        const d = text.charCodeAt(k);
        if (d === 40) open++;
        else if (d === 41) close++;
      }
      if (close > open) end--;
      else break;
    } else if (".,;:!?'\"*_~}".includes(ch)) {
      end--;
    } else {
      break;
    }
  }
  return end;
}

function isEmailLocal(c: number): boolean {
  return isAsciiAlnum(c) || c === 46 || c === 95 || c === 37 || c === 43 || c === 45;
}

function isEmailDomain(c: number): boolean {
  return isAsciiAlnum(c) || c === 46 || c === 45;
}

/** Emails inside a token [ts, te). Linear: each '@' expands only over its own local part and domain. */
function findEmails(text: string, ts: number, te: number, out: Mask[]): boolean {
  let found = false;
  let from = ts;
  let floor = ts; // masks must not overlap: a local part may not reach back into the previous email
  for (;;) {
    const at = text.indexOf("@", from);
    if (at < 0 || at >= te) break;
    from = at + 1;
    let ls = at;
    while (ls > floor && isEmailLocal(text.charCodeAt(ls - 1))) ls--;
    let re = at + 1;
    while (re < te && isEmailDomain(text.charCodeAt(re))) re++;
    while (re > at + 1 && (text.charCodeAt(re - 1) === 46 || text.charCodeAt(re - 1) === 45)) re--;
    if (ls === at || re <= at + 1) continue;
    const domain = text.slice(at + 1, re);
    const dot = domain.lastIndexOf(".");
    if (dot <= 0 || !/^[A-Za-z]{2,}$/.test(domain.slice(dot + 1))) continue;
    out.push({ start: ls, end: re, kind: "email" });
    found = true;
    from = re;
    floor = re;
  }
  return found;
}

function classifyPath(text: string, ts: number, te: number, out: Mask[]): void {
  let a = ts;
  let b = te;
  while (a < b && LEAD_STRIP.has(text[a] as string)) a++;
  while (b > a && TRAIL_STRIP.has(text[b - 1] as string)) b--;
  if (b - a < 2) return;
  let tok = text.slice(a, b);
  const lineSuffix = /:\d+(?::\d+)?$/.exec(tok);
  if (lineSuffix !== null) tok = tok.slice(0, lineSuffix.index);
  const lastSep = Math.max(tok.lastIndexOf("/"), tok.lastIndexOf("\\"));
  const last = tok.slice(lastSep + 1);
  const dot = last.lastIndexOf(".");
  if (dot < 0 || dot === last.length - 1) return;
  const ext = last.slice(dot + 1);
  let ok: boolean;
  if (lastSep >= 0) ok = /^[A-Za-z0-9]{1,10}$/.test(ext) && /[A-Za-z]/.test(ext);
  else ok = KNOWN_EXTENSIONS.has(ext.toLowerCase());
  if (ok) out.push({ start: a, end: b, kind: "path" });
}

/** A whitespace-delimited token; a Markdown link `[text](dest)` is classified as two pieces. */
function classifyToken(text: string, ts: number, te: number, out: Mask[]): void {
  let a = ts;
  for (let i = ts; i + 1 < te; i++) {
    if (text.charCodeAt(i) === 93 && text.charCodeAt(i + 1) === 40) {
      classifyPiece(text, a, i + 1, out);
      a = i + 2;
      i++;
    }
  }
  classifyPiece(text, a, te, out);
}

function classifyPiece(text: string, ts: number, te: number, out: Mask[]): void {
  let slash = false;
  let at = false;
  let dot = false;
  let colon = false;
  for (let i = ts; i < te; i++) {
    const c = text.charCodeAt(i);
    if (c === 47 || c === 92) slash = true;
    else if (c === 64) at = true;
    else if (c === 46) dot = true;
    else if (c === 58) colon = true;
  }
  if (!slash && !at && !dot) return;
  if (colon || dot) {
    const tok = text.slice(ts, te);
    URL_RE.lastIndex = 0;
    let found = false;
    for (let m = URL_RE.exec(tok); m !== null; m = URL_RE.exec(tok)) {
      const us = ts + m.index;
      const ue = stripUrlEnd(text, us, us + m[0].length);
      if (ue > us) {
        out.push({ start: us, end: ue, kind: "url" });
        found = true;
      }
    }
    if (found) return;
  }
  if (at && findEmails(text, ts, te, out)) return;
  if (dot) classifyPath(text, ts, te, out);
}

/** Masks inside [s, e), sorted by start and non-overlapping. */
export function findMasks(text: string, s: number, e: number): Mask[] {
  const out: Mask[] = [];
  let pos = s;
  const tokens = (a: number, b: number): void => {
    let i = a;
    while (i < b) {
      while (i < b && isWs(text.charCodeAt(i))) i++;
      if (i >= b) break;
      let j = i;
      while (j < b && !isWs(text.charCodeAt(j))) j++;
      classifyToken(text, i, j, out);
      i = j;
    }
  };
  for (const c of findInlineCode(text, s, e)) {
    tokens(pos, c.start);
    out.push({ start: c.start, end: c.end, kind: "inline_code" });
    pos = c.end;
  }
  tokens(pos, e);
  return out;
}

// ---------------------------------------------------------------------------------------------
// Bold
// ---------------------------------------------------------------------------------------------

/** `**x**`, `***x***` and `__x__` spans, markers included. Runs of other lengths are ignored. */
export function findBold(text: string, s: number, e: number, masks: Mask[]): Span[] {
  const out: Span[] = [];
  const pending: Record<number, number> = { 42: -1, 95: -1 };
  let mi = 0;
  let i = s;
  while (i < e) {
    while (mi < masks.length && (masks[mi] as Mask).end <= i) mi++;
    const m = masks[mi];
    if (m !== undefined && m.start <= i) {
      i = m.end;
      continue;
    }
    const c = text.charCodeAt(i);
    if (c !== 42 && c !== 95) {
      i++;
      continue;
    }
    let j = i;
    while (j < e && text.charCodeAt(j) === c) j++;
    const len = j - i;
    if (len === 2 || len === 3) {
      const prev = i > s ? text.charCodeAt(i - 1) : -1;
      const next = j < e ? text.charCodeAt(j) : -1;
      let leftFlanking = next !== -1 && !isWs(next);
      let rightFlanking = prev !== -1 && !isWs(prev);
      if (c === 95) {
        // Underscores never open or close inside a word.
        if (prev !== -1 && isAsciiAlnum(prev)) leftFlanking = false;
        if (next !== -1 && isAsciiAlnum(next)) rightFlanking = false;
      }
      const open = pending[c] as number;
      if (open >= 0 && rightFlanking) {
        out.push({ start: open, end: j });
        pending[c] = -1;
      } else if (leftFlanking) {
        pending[c] = i;
      }
    }
    i = j;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Attributed quotes
// ---------------------------------------------------------------------------------------------

const NAME_TOKEN = "(?:(?:Dr|Mr|Mrs|Ms|Prof|Jr|Sr|St)\\.|\\p{Lu}[\\p{L}\\p{N}'\\u2019&-]*)";
const SEP = "[\\s,:;\\u2014\\u2013-]";
/** Up to three filler words between the cue and the quote, then the quote's opening mark. */
const FILLER = `(?:${SEP}+\\p{L}[\\p{L}\\p{N}'\\u2019]*){0,3}${SEP}*$`;

const CUE_USER = new RegExp(
  `\\b(?:you (?:said|wrote|asked|mentioned|requested|put it)|the user (?:said|wrote|asked))\\b${FILLER}`,
  "iu",
);
const CUE_ACCORDING = new RegExp(
  `\\b[Aa]ccording to\\s+(?:${NAME_TOKEN}|[Tt]he (?:docs|spec|RFC|README|error)\\b)` +
    `(?:[\\s,]+(?:${NAME_TOKEN}|and|of|the|de|van|von|et\\s+al\\.?))*${SEP}*$`,
  "u",
);
const PUT_TOKEN = "(?:(?:Dr|Mr|Mrs|Ms|Prof|Jr|Sr|St)\\.|[\\p{L}\\p{N}'\\u2019-]+)";
const CUE_PUTS_IT = new RegExp(`\\bas\\s+(?:${PUT_TOKEN}\\s+){1,4}?puts?\\s+it\\b${FILLER}`, "iu");
const CUE_VERB = new RegExp(`\\b(says?|said|states|writes|wrote|notes|reads)\\b${FILLER}`, "giu");
const SUBJECT_DOCS = /\bthe\s+(?:docs|spec|RFC|README|error)\s+$/i;
const SUBJECT_NAME = new RegExp(`((?:${NAME_TOKEN}\\s+){0,3}${NAME_TOKEN})\\s+$`, "u");
const AFTER_DASH = new RegExp(
  `^\\s*(?:\\u2014|\\u2013|--)\\s*(${NAME_TOKEN}(?:\\s+(?:${NAME_TOKEN}|of|de|van|von|der|da)){0,3})(?=\\s*$|[.,;!?)\\]])`,
  "u",
);

/** Capitalised words that start sentences or stand in for a name: "He says" is not a named source. */
const NOT_A_NAME = new Set(
  (
    "he she it they we i you this that these those there then and but so who which what one someone everyone " +
    "nobody people some each both however also still here now next first finally ok okay yes no as if when while " +
    "because although the a an my our your his her its their note see"
  ).split(" "),
);

function namedSubject(pre: string): boolean {
  if (SUBJECT_DOCS.test(pre)) return true;
  const m = SUBJECT_NAME.exec(pre);
  if (m === null) return false;
  const tokens = (m[1] as string).split(/\s+/);
  while (tokens.length > 0 && NOT_A_NAME.has((tokens[0] as string).toLowerCase())) tokens.shift();
  return tokens.length > 0;
}

/** Is `before` (the text of the same sentence up to the opening quote mark) ending in an attribution cue? */
function cueBefore(before: string): boolean {
  if (CUE_USER.test(before) || CUE_ACCORDING.test(before) || CUE_PUTS_IT.test(before)) return true;
  CUE_VERB.lastIndex = 0;
  for (let m = CUE_VERB.exec(before); m !== null; m = CUE_VERB.exec(before)) {
    const verb = (m[1] as string).toLowerCase();
    const pre = before.slice(0, m.index);
    if (verb === "say") {
      if (SUBJECT_DOCS.test(pre)) return true;
    } else if (namedSubject(pre)) {
      return true;
    }
    CUE_VERB.lastIndex = m.index + 1;
  }
  return false;
}

/** Is the quote followed by an em/en dash and a capitalised name ("Ship it" — Ada Lovelace)? */
function cueAfter(text: string, from: number, e: number): boolean {
  const LIMIT = 120;
  let rest = text.slice(from, Math.min(e, from + LIMIT));
  if (from + LIMIT < e) rest += "\u0000"; // truncated: the end-of-element lookahead must not match
  const m = AFTER_DASH.exec(rest);
  if (m === null) return false;
  const first = (m[1] as string).split(/\s+/)[0] as string;
  return !NOT_A_NAME.has(first.toLowerCase());
}

function isStraightOpener(text: string, i: number, s: number, e: number): boolean {
  const next = i + 1 < e ? text.charCodeAt(i + 1) : -1;
  if (next === -1 || isWs(next) || next === 34) return false;
  if (i === s) return true;
  const prev = text.charCodeAt(i - 1);
  return (
    isWs(prev) ||
    prev === 40 || // (
    prev === 91 || // [
    prev === 123 || // {
    prev === 58 || // :
    prev === 59 || // ;
    prev === 44 || // ,
    prev === 45 || // -
    prev === 47 || // /
    prev === 0x2014 ||
    prev === 0x2013 ||
    prev === 0x2018 ||
    prev === 0x201c
  );
}

function isStraightCloser(text: string, j: number, s: number, e: number): boolean {
  if (j <= s) return false;
  const prev = text.charCodeAt(j - 1);
  if (isWs(prev)) return false;
  if (j + 1 >= e) return true;
  const next = text.charCodeAt(j + 1);
  return (
    isWs(next) ||
    next === 46 ||
    next === 44 ||
    next === 59 ||
    next === 58 ||
    next === 33 ||
    next === 63 ||
    next === 41 ||
    next === 93 ||
    next === 125 ||
    next === 45 ||
    next === 39 ||
    next === 0x2019 ||
    next === 0x2014 ||
    next === 0x2013 ||
    next === 0x2026
  );
}

/**
 * Attributed double-quoted runs in the element [s, e): a straight or curly double-quoted run of 3
 * or more words, with an attribution cue before it (in the same sentence, at most three filler
 * words away) or a ` — Name` credit after it. Quote marks are included in the span.
 */
export function findQuotes(text: string, s: number, e: number, masks: Mask[]): Span[] {
  const out: Span[] = [];
  let mi = 0;
  let i = s;
  while (i < e) {
    while (mi < masks.length && (masks[mi] as Mask).end <= i) mi++;
    const m0 = masks[mi];
    if (m0 !== undefined && m0.start <= i) {
      i = m0.end;
      continue;
    }
    const c = text.charCodeAt(i);
    const straight = c === 34;
    if (!(straight ? isStraightOpener(text, i, s, e) : c === 0x201c)) {
      i++;
      continue;
    }
    // Find the closing mark; abandon the opener if another opener appears first.
    let close = -1;
    let resume = e;
    let mj = mi;
    for (let j = i + 1; j < e; ) {
      while (mj < masks.length && (masks[mj] as Mask).end <= j) mj++;
      const mm = masks[mj];
      if (mm !== undefined && mm.start <= j) {
        j = mm.end;
        continue;
      }
      const d = text.charCodeAt(j);
      if (straight) {
        if (d === 34) {
          if (isStraightCloser(text, j, s, e)) {
            close = j;
            break;
          }
          if (isStraightOpener(text, j, s, e)) {
            resume = j;
            break;
          }
        }
      } else if (d === 0x201d) {
        close = j;
        break;
      } else if (d === 0x201c) {
        resume = j;
        break;
      }
      j++;
    }
    if (close < 0) {
      i = resume > i ? resume : i + 1;
      continue;
    }
    if (countWords(text.slice(i + 1, close)) >= 3) {
      const before = text.slice(Math.max(s, i - 160), i);
      if (cueBefore(before) || cueAfter(text, close + 1, e)) out.push({ start: i, end: close + 1 });
    }
    i = close + 1;
  }
  return out;
}
