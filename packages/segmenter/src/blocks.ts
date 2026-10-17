/**
 * Block scanner: one linear pass over the lines of a turn. It finds the non-prose blocks (fenced
 * and indented code, pipe tables, blockquotes) and groups everything else into prose blocks: a
 * prose block is a maximal run of non-blank prose lines, each tagged as heading / list item /
 * list continuation / plain text / thematic break. It is a purpose-built scanner for the subset of
 * CommonMark that model output uses, not a CommonMark implementation.
 */

import { type Line, isBlankRange, isWs, skipWs, trimEnd } from "./lines.js";

export type ProseLineKind =
  | "h" // ATX heading
  | "sh" // setext heading text line
  | "su" // setext underline
  | "li" // list item first line
  | "cont" // list item continuation (lazy or indented) line
  | "p" // plain paragraph text
  | "hr"; // thematic break

export interface ProseLine {
  s: number;
  ce: number;
  kind: ProseLineKind;
  /** Content start: after heading marks / list marker and task box, else the first non-blank code unit. */
  cs: number;
  /** Content end: trimmed of trailing whitespace and of an ATX closing sequence. */
  cend: number;
}

export interface NonProseBlock {
  kind: "code" | "table" | "quote";
  s: number;
  e: number;
}

export interface ProseBlock {
  kind: "prose";
  s: number;
  e: number;
  lines: ProseLine[];
}

export type Block = NonProseBlock | ProseBlock;

const SPACE = 32;
const TAB = 9;
const BACKTICK = 96;
const TILDE = 126;
const HASH = 35;
const GT = 62;
const PIPE = 124;

function isSpaceTab(c: number): boolean {
  return c === SPACE || c === TAB;
}

function isDigit(c: number): boolean {
  return c >= 48 && c <= 57;
}

function indentOf(text: string, s: number, ce: number): { indent: number; pos: number } {
  let col = 0;
  let i = s;
  for (; i < ce; i++) {
    const c = text.charCodeAt(i);
    if (c === SPACE) col++;
    else if (c === TAB) col += 4 - (col % 4);
    else break;
  }
  return { indent: col, pos: i };
}

function fenceOpen(text: string, pos: number, ce: number): { ch: number; len: number } | null {
  const c = text.charCodeAt(pos);
  if (c !== BACKTICK && c !== TILDE) return null;
  let j = pos;
  while (j < ce && text.charCodeAt(j) === c) j++;
  const len = j - pos;
  if (len < 3) return null;
  if (c === BACKTICK) {
    for (let k = j; k < ce; k++) if (text.charCodeAt(k) === BACKTICK) return null; // inline code, not a fence
  }
  return { ch: c, len };
}

function fenceClose(text: string, s: number, ce: number, ch: number, len: number): boolean {
  const pos = skipWs(text, s, ce);
  let j = pos;
  while (j < ce && text.charCodeAt(j) === ch) j++;
  return j - pos >= len && isBlankRange(text, j, ce);
}

function atxHeading(text: string, pos: number, ce: number): { cs: number; cend: number } | null {
  if (text.charCodeAt(pos) !== HASH) return null;
  let j = pos;
  while (j < ce && text.charCodeAt(j) === HASH) j++;
  if (j - pos > 6) return null;
  if (j < ce && !isSpaceTab(text.charCodeAt(j))) return null;
  const cs = skipWs(text, j, ce);
  let cend = trimEnd(text, cs, ce);
  let k = cend;
  while (k > cs && text.charCodeAt(k - 1) === HASH) k--;
  if (k < cend && (k === cs || isSpaceTab(text.charCodeAt(k - 1)))) cend = trimEnd(text, cs, k);
  return { cs, cend };
}

function isThematicBreak(text: string, pos: number, ce: number): boolean {
  const c = text.charCodeAt(pos);
  if (c !== 45 && c !== 42 && c !== 95) return false;
  let count = 0;
  for (let i = pos; i < ce; i++) {
    const d = text.charCodeAt(i);
    if (d === c) count++;
    else if (!isSpaceTab(d)) return false;
  }
  return count >= 3;
}

/** 0 = not an underline, 1 = `===` (h1), 2 = `--` or more (h2). */
function setextLevel(text: string, pos: number, ce: number): 0 | 1 | 2 {
  const c = text.charCodeAt(pos);
  if (c !== 61 && c !== 45) return 0;
  let j = pos;
  while (j < ce && text.charCodeAt(j) === c) j++;
  if (!isBlankRange(text, j, ce)) return 0;
  if (c === 61) return 1;
  return j - pos >= 2 ? 2 : 0;
}

interface ListMarker {
  cs: number;
  ordered: boolean;
  num: number;
  empty: boolean;
}

function listMarker(text: string, pos: number, ce: number): ListMarker | null {
  const c = text.charCodeAt(pos);
  let j: number;
  let ordered = false;
  let num = 0;
  if (c === 45 || c === 42 || c === 43) {
    j = pos + 1;
  } else if (isDigit(c)) {
    let k = pos;
    while (k < ce && isDigit(text.charCodeAt(k)) && k - pos < 9) k++;
    if (k >= ce) return null;
    const d = text.charCodeAt(k);
    if (d !== 46 && d !== 41) return null;
    ordered = true;
    num = Number(text.slice(pos, k));
    j = k + 1;
  } else {
    return null;
  }
  if (j < ce && !isSpaceTab(text.charCodeAt(j))) return null;
  let cs = j;
  while (cs < ce && isSpaceTab(text.charCodeAt(cs))) cs++;
  // GFM task box
  if (cs + 2 < ce &&text.charCodeAt(cs) === 91 && text.charCodeAt(cs + 2) === 93) {
    const x = text.charCodeAt(cs + 1);
    if ((x === SPACE || x === 120 || x === 88) && (cs + 3 >= ce || isSpaceTab(text.charCodeAt(cs + 3)))) {
      cs += 3;
      while (cs < ce && isSpaceTab(text.charCodeAt(cs))) cs++;
    }
  }
  return { cs, ordered, num, empty: cs >= ce };
}

/**
 * Number of cells in a table row, or -1. For a delimiter row (`delim`) every cell must be
 * `:?-+:?`; for a header row any content is fine. A row must contain at least one `|`.
 */
function tableCells(text: string, s: number, ce: number, delim: boolean): number {
  let p = skipWs(text, s, ce);
  let end = trimEnd(text, p, ce);
  let hasPipe = false;
  for (let i = p; i < end; i++) {
    if (text.charCodeAt(i) === PIPE && (i === p || text.charCodeAt(i - 1) !== 92)) {
      hasPipe = true;
      break;
    }
  }
  if (!hasPipe) return -1;
  if (text.charCodeAt(p) === PIPE) p++;
  if (end > p && text.charCodeAt(end - 1) === PIPE && (end - 1 === p || text.charCodeAt(end - 2) !== 92)) end--;
  let cells = 1;
  let dashes = 0;
  for (let i = p; i <= end; i++) {
    if (i === end || (text.charCodeAt(i) === PIPE && text.charCodeAt(i - 1) !== 92)) {
      if (delim && dashes === 0) return -1;
      if (i < end) cells++;
      dashes = 0;
      continue;
    }
    if (delim) {
      const c = text.charCodeAt(i);
      if (c === 45) dashes++;
      else if (c !== 58 && !isSpaceTab(c)) return -1;
    }
  }
  return cells;
}

function isTableStart(text: string, lines: Line[], i: number): boolean {
  const h = lines[i];
  const d = lines[i + 1];
  if (h === undefined || d === undefined) return false;
  const hc = tableCells(text, h.s, h.ce, false);
  if (hc < 0) return false;
  return tableCells(text, d.s, d.ce, true) === hc;
}

function hasPipe(text: string, s: number, ce: number): boolean {
  for (let i = s; i < ce; i++) if (text.charCodeAt(i) === PIPE) return true;
  return false;
}

/** After the first `>`: does the line carry any content besides further `>` markers and whitespace? */
function quoteHasContent(text: string, pos: number, ce: number): boolean {
  for (let i = pos; i < ce; i++) {
    const c = text.charCodeAt(i);
    if (c !== GT && !isWs(c)) return true;
  }
  return false;
}

export function scanBlocks(text: string, lines: Line[]): Block[] {
  const n = lines.length;
  const blocks: Block[] = [];
  // Mutable scan state lives in one object so closures and the main loop see the same declared types.
  const st: { prose: ProseBlock | null; paraStart: number } = { prose: null, paraStart: -1 };
  let listActive = false;
  let prevBlank = true;

  const closeProse = (): void => {
    if (st.prose !== null && st.prose.lines.length > 0) blocks.push(st.prose);
    st.prose = null;
    st.paraStart = -1;
  };
  const pushLine = (pl: ProseLine): void => {
    if (st.prose === null) st.prose = { kind: "prose", s: pl.s, e: pl.ce, lines: [] };
    st.prose.lines.push(pl);
    st.prose.e = pl.ce;
  };
  const lastKind = (): ProseLineKind | null => {
    if (st.prose === null) return null;
    const l = st.prose.lines[st.prose.lines.length - 1];
    return l === undefined ? null : l.kind;
  };

  let i = 0;
  while (i < n) {
    const L = lines[i] as Line;
    if (isBlankRange(text, L.s, L.ce)) {
      closeProse();
      prevBlank = true;
      i++;
      continue;
    }
    const { indent, pos } = indentOf(text, L.s, L.ce);
    const lk = lastKind();

    const hr = indent < 4 && isThematicBreak(text, pos, L.ce);
    let lm = hr ? null : listMarker(text, pos, L.ce);
    if (lm !== null) {
      if (indent >= 4 && !listActive) lm = null;
      else if (lk === "p" && !listActive && ((lm.ordered && lm.num !== 1) || lm.empty)) lm = null; // cannot interrupt a top-level paragraph
    }
    if (listActive && lm === null && indent < 2) listActive = false;

    const inLikeTop = indent < 4 || listActive;

    // 1. fenced code
    const fo = inLikeTop ? fenceOpen(text, pos, L.ce) : null;
    if (fo !== null) {
      closeProse();
      let j = i + 1;
      let end = L.ce;
      while (j < n) {
        const M = lines[j] as Line;
        end = M.ce;
        j++;
        if (fenceClose(text, M.s, M.ce, fo.ch, fo.len)) break;
      }
      blocks.push({ kind: "code", s: L.s, e: end });
      prevBlank = false;
      i = j;
      continue;
    }

    // 2. indented code
    if (indent >= 4 && !listActive && (prevBlank || st.prose === null)) {
      closeProse();
      let j = i + 1;
      let lastNonBlank = i;
      while (j < n) {
        const M = lines[j] as Line;
        if (isBlankRange(text, M.s, M.ce)) {
          j++;
          continue;
        }
        if (indentOf(text, M.s, M.ce).indent < 4) break;
        lastNonBlank = j;
        j++;
      }
      blocks.push({ kind: "code", s: L.s, e: (lines[lastNonBlank] as Line).ce });
      prevBlank = false;
      i = lastNonBlank + 1;
      continue;
    }

    // 3. blockquote (with CommonMark lazy continuation of paragraph text)
    if (inLikeTop && text.charCodeAt(pos) === GT) {
      closeProse();
      let j = i;
      let lastHadContent = true;
      let end = L.ce;
      while (j < n) {
        const M = lines[j] as Line;
        if (isBlankRange(text, M.s, M.ce)) break;
        const mi = indentOf(text, M.s, M.ce);
        if ((mi.indent < 4 || listActive) && text.charCodeAt(mi.pos) === GT) {
          lastHadContent = quoteHasContent(text, mi.pos + 1, M.ce);
        } else if (
          lastHadContent &&
          fenceOpen(text, mi.pos, M.ce) === null &&
          atxHeading(text, mi.pos, M.ce) === null &&
          !isThematicBreak(text, mi.pos, M.ce) &&
          listMarker(text, mi.pos, M.ce) === null
        ) {
          // lazy continuation line: part of the quote
        } else {
          break;
        }
        end = M.ce;
        j++;
      }
      blocks.push({ kind: "quote", s: L.s, e: end });
      prevBlank = false;
      i = j;
      continue;
    }

    // 4. ATX heading
    const ah = inLikeTop ? atxHeading(text, pos, L.ce) : null;
    if (ah !== null) {
      pushLine({ s: L.s, ce: L.ce, kind: "h", cs: ah.cs, cend: ah.cend });
      st.paraStart = -1;
      prevBlank = false;
      i++;
      continue;
    }

    // 5. setext underline closing an open paragraph
    if (st.prose !== null && lk === "p" && st.paraStart >= 0 && indent < 4) {
      const lvl = setextLevel(text, pos, L.ce);
      if (lvl > 0) {
        for (let k = st.paraStart; k < st.prose.lines.length; k++) (st.prose.lines[k] as ProseLine).kind = "sh";
        pushLine({ s: L.s, ce: L.ce, kind: "su", cs: pos, cend: trimEnd(text, pos, L.ce) });
        st.paraStart = -1;
        prevBlank = false;
        i++;
        continue;
      }
    }

    // 6. thematic break
    if (hr) {
      pushLine({ s: L.s, ce: L.ce, kind: "hr", cs: pos, cend: trimEnd(text, pos, L.ce) });
      st.paraStart = -1;
      prevBlank = false;
      i++;
      continue;
    }

    // 7. pipe table
    if (indent < 4 && isTableStart(text, lines, i)) {
      closeProse();
      let j = i + 2;
      let end = (lines[i + 1] as Line).ce;
      while (j < n) {
        const M = lines[j] as Line;
        if (isBlankRange(text, M.s, M.ce) || !hasPipe(text, M.s, M.ce)) break;
        end = M.ce;
        j++;
      }
      blocks.push({ kind: "table", s: L.s, e: end });
      prevBlank = false;
      i = j;
      continue;
    }

    // 8. list item
    if (lm !== null) {
      pushLine({ s: L.s, ce: L.ce, kind: "li", cs: lm.cs, cend: trimEnd(text, lm.cs, L.ce) });
      st.paraStart = -1;
      listActive = true;
      prevBlank = false;
      i++;
      continue;
    }

    // 9. plain text: a list continuation after a list item, else a paragraph line
    const lazy = lk === "li" || lk === "cont";
    if (!lazy && lk !== "p") st.paraStart = st.prose === null ? 0 : st.prose.lines.length;
    pushLine({ s: L.s, ce: L.ce, kind: lazy ? "cont" : "p", cs: pos, cend: trimEnd(text, pos, L.ce) });
    prevBlank = false;
    i++;
  }
  closeProse();
  return blocks;
}
