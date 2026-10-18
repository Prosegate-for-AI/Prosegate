/**
 * analyse(): partition a turn into segments and extract the prose units, paragraphs, masks and
 * bold spans the engine needs. See the notes at the top of index.ts for the decisions that the
 * spec left open.
 */

import type { Segment, SegmentKind } from "@prosegate/schema";
import { type ProseBlock, type ProseLine, scanBlocks } from "./blocks.js";
import { endsWithCueLine, findBold, findMasks, findQuotes } from "./inline.js";
import { LANGUAGE_MIN_WORDS, decideLanguage, languageStats } from "./language.js";
import { isBlankRange, skipWs, splitLines, trimEnd } from "./lines.js";
import { splitSentences } from "./sentences.js";
import type { Analysis, Mask, Paragraph, Span, Unit } from "./types.js";
import { countWords, normalizeForMatching } from "./words.js";

interface Element {
  kind: "heading" | "list_item" | "paragraph";
  s: number;
  e: number;
  /** Identity of the block this element belongs to: one list (by run id) or the element itself. */
  key: string;
}

interface Draft {
  start: number;
  end: number;
  textStart: number;
  kind: Unit["kind"];
  words: number;
  continuation: boolean;
  continued: boolean;
  key: string;
  seg: number;
}

interface RawSegment {
  kind: SegmentKind;
  s: number;
  e: number;
}

function buildElements(lines: ProseLine[], nextId: () => number): Element[] {
  const els: Element[] = [];
  let i = 0;
  while (i < lines.length) {
    const L = lines[i] as ProseLine;
    if (L.kind === "h") {
      if (L.cend > L.cs) els.push({ kind: "heading", s: L.cs, e: L.cend, key: `E${nextId()}` });
      i++;
    } else if (L.kind === "sh") {
      let j = i;
      while (j + 1 < lines.length && (lines[j + 1] as ProseLine).kind === "sh") j++;
      els.push({ kind: "heading", s: L.cs, e: (lines[j] as ProseLine).cend, key: `E${nextId()}` });
      i = j + 1;
    } else if (L.kind === "li") {
      let j = i;
      while (j + 1 < lines.length && (lines[j + 1] as ProseLine).kind === "cont") j++;
      let s = L.cs;
      if (s >= L.cend && j > i) s = (lines[i + 1] as ProseLine).cs; // empty marker line, text on the next line
      const e = (lines[j] as ProseLine).cend;
      if (e > s) els.push({ kind: "list_item", s, e, key: `L${L.run}` });
      i = j + 1;
    } else if (L.kind === "p") {
      let j = i;
      while (j + 1 < lines.length && (lines[j + 1] as ProseLine).kind === "p") j++;
      els.push({ kind: "paragraph", s: L.cs, e: (lines[j] as ProseLine).cend, key: `E${nextId()}` });
      i = j + 1;
    } else {
      i++; // thematic break, setext underline, orphan continuation: no text
    }
  }
  return els;
}

/** Items of `items` (sorted by start) that do not overlap any span of `quotes` (sorted, disjoint). */
function outside<T extends Span>(items: T[], quotes: Span[]): T[] {
  if (quotes.length === 0) return items;
  const out: T[] = [];
  let qi = 0;
  for (const it of items) {
    while (qi < quotes.length && (quotes[qi] as Span).end <= it.start) qi++;
    const q = quotes[qi];
    if (q !== undefined && q.start < it.end) continue;
    out.push(it);
  }
  return out;
}

/** Keep only the outermost of nested spans; `spans` sorted by start, outer first. */
function outermost(spans: Span[]): Span[] {
  const out: Span[] = [];
  let lastEnd = -1;
  for (const sp of spans) {
    if (sp.start < lastEnd) continue; // nested or crossing: only the first opened span counts
    out.push(sp);
    lastEnd = sp.end;
  }
  return out;
}

const WORD_CHAR_RE = /^[\p{L}\p{N}]$/u;

/**
 * Offset of the first word character in [from, to): skips markers, quotes, brackets, emoji and symbols,
 * and anything that is not prose text: masks (inline code, URLs, comments, ...), Markdown images
 * ![alt](src) and keycap emoji (1\uFE0F\u20E3). `mp` is a forward-only index into the sorted `masks`.
 * If the unit has no word character outside those, the first word character anywhere is returned.
 */
function firstWordChar(text: string, from: number, to: number, masks: Mask[], mp: { i: number }): number {
  while (mp.i < masks.length && (masks[mp.i] as Mask).end <= from) mp.i++;
  let m = mp.i;
  let i = from;
  while (i < to) {
    while (m < masks.length && (masks[m] as Mask).end <= i) m++;
    const mk = masks[m];
    if (mk !== undefined && mk.start <= i) {
      i = mk.end;
      continue;
    }
    const c = text.charCodeAt(i);
    if (c === 33 && text.charCodeAt(i + 1) === 91) {
      // ![alt](src)
      let j = i + 2;
      while (j + 1 < to && !(text.charCodeAt(j) === 93 && text.charCodeAt(j + 1) === 40)) j++;
      let k = j + 2;
      while (j + 1 < to && k < to && text.charCodeAt(k) !== 41) k++;
      if (j + 1 < to && k < to) {
        i = k + 1;
        continue;
      }
    }
    if ((c >= 48 && c <= 57) || c === 35 || c === 42) {
      const n1 = text.charCodeAt(i + 1);
      if (n1 === 0x20e3) {
        i += 2;
        continue;
      }
      if (n1 === 0xfe0f && text.charCodeAt(i + 2) === 0x20e3) {
        i += 3;
        continue;
      }
    }
    if ((c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122)) return i;
    if (c >= 128) {
      const cp = text.codePointAt(i) as number;
      if (WORD_CHAR_RE.test(String.fromCodePoint(cp))) return i;
      i += cp > 0xffff ? 2 : 1;
    } else {
      i++;
    }
  }
  // Nothing outside masks: fall back to the first word character anywhere in the unit.
  for (let p = from; p < to; ) {
    const c = text.charCodeAt(p);
    if ((c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122)) return p;
    const cp = text.codePointAt(p) as number;
    if (c >= 128 && WORD_CHAR_RE.test(String.fromCodePoint(cp))) return p;
    p += cp > 0xffff ? 2 : 1;
  }
  return from;
}

function detectLanguage(text: string, units: Unit[], masks: Mask[], proseWords: number): Analysis["language"] {
  if (proseWords < LANGUAGE_MIN_WORDS) return "unknown";
  return decideLanguage(
    languageStats(
      text,
      units.map((u): [number, number] => [u.start, u.end]),
      masks,
    ),
  );
}

export function analyse(text: string): Analysis {
  const normalized = normalizeForMatching(text);
  const lines = splitLines(text);
  const blocks = scanBlocks(text, lines);

  const raw: RawSegment[] = [];
  const drafts: Draft[] = [];
  const masks: Mask[] = [];
  const bold: Span[] = [];
  let idCounter = 0;
  const nextId = (): number => ++idCounter;
  /** The previous element ended in an attribution cue and a colon: a following whole-element quote is attributed. */
  let cueCarry: { key: string | null } | null = null;

  const processProse = (b: ProseBlock): void => {
    const firstDraft = drafts.length;
    const quotesAll: Span[] = [];
    for (const el of buildElements(b.lines, nextId)) {
      const elMasks = findMasks(text, el.s, el.e);
      // The carry covers the first list or paragraph after the cue line, and nothing after that.
      if (cueCarry !== null && cueCarry.key === null) cueCarry.key = el.key;
      if (cueCarry !== null && (cueCarry.key !== el.key || el.kind === "heading")) cueCarry = null;
      const cueLine = cueCarry !== null;
      const quotes = el.kind === "heading" ? [] : findQuotes(text, el.s, el.e, elMasks, cueLine);
      const keptMasks = outside(elMasks, quotes);
      for (const m of keptMasks) masks.push(m);
      const spans = findBold(text, el.s, el.e, elMasks).sort((x, y) => x.start - y.start || y.end - x.end);
      for (const bs of outermost(outside(spans, quotes))) bold.push(bs);
      for (const q of quotes) quotesAll.push(q);
      if (!cueLine) cueCarry = el.kind !== "heading" && endsWithCueLine(text, el.s, el.e) ? { key: null } : null;
      else if (el.kind !== "list_item") cueCarry = null; // a paragraph uses up the carry; list items keep it for the rest of the list

      const ranges: Array<[number, number]> =
        el.kind === "paragraph" ? splitSentences(text, el.s, el.e, keptMasks, quotes) : [[el.s, el.e]];
      const kind: Unit["kind"] = el.kind === "paragraph" ? "sentence" : el.kind;
      let qi = 0;
      const maskPtr = { i: 0 };
      for (const [a, c] of ranges) {
        let ps = a;
        let idx = 0;
        const cut = (pe: number, continued: boolean): void => {
          const ts = skipWs(text, ps, pe);
          const te = trimEnd(text, ts, pe);
          if (te > ts) {
            const words = countWords(text.slice(ts, te));
            if (words > 0) {
              drafts.push({
                start: ts,
                end: te,
                textStart: firstWordChar(text, ts, te, keptMasks, maskPtr),
                kind,
                words,
                continuation: idx > 0,
                continued,
                key: el.key,
                seg: -1,
              });
            }
          }
          idx++;
        };
        while (qi < quotes.length && (quotes[qi] as Span).start < a) qi++;
        while (qi < quotes.length && (quotes[qi] as Span).start < c) {
          const q = quotes[qi] as Span;
          cut(q.start, true);
          ps = q.end;
          qi++;
        }
        cut(c, false);
      }
    }

    // Segments: the block, carved around its attributed quotes. Whitespace-only prose pieces are
    // not segments; they become gaps absorbed by the preceding segment below.
    const proseSegs: Array<{ s: number; e: number; idx: number }> = [];
    const addProse = (s: number, e: number): void => {
      if (e > s && !isBlankRange(text, s, e)) {
        proseSegs.push({ s, e, idx: raw.length });
        raw.push({ kind: "prose", s, e });
      }
    };
    let cur = b.s;
    for (const q of quotesAll) {
      addProse(cur, q.start);
      raw.push({ kind: "quote", s: q.start, e: q.end });
      cur = q.end;
    }
    addProse(cur, b.e);

    let pi = 0;
    for (let d = firstDraft; d < drafts.length; d++) {
      const dr = drafts[d] as Draft;
      while (pi < proseSegs.length - 1 && (proseSegs[pi] as { e: number }).e <= dr.start) pi++;
      dr.seg = (proseSegs[pi] as { idx: number }).idx;
    }
  };

  for (const b of blocks) {
    if (b.kind === "prose") {
      processProse(b);
    } else {
      cueCarry = null;
      raw.push({ kind: b.kind, s: b.s, e: b.e });
    }
  }

  // Partition: each segment starts where its content starts and runs to the next segment's start;
  // the first starts at 0 and the last ends at text.length. The gaps this absorbs are whitespace.
  const segments: Segment[] = [];
  if (raw.length === 0) {
    if (text.length > 0) segments.push({ id: "s1", kind: "prose", start: 0, end: text.length });
  } else {
    for (let k = 0; k < raw.length; k++) {
      const r = raw[k] as RawSegment;
      const next = raw[k + 1];
      segments.push({
        id: `s${k + 1}`,
        kind: r.kind,
        start: k === 0 ? 0 : r.s,
        end: next === undefined ? text.length : next.s,
      });
    }
  }

  const units: Unit[] = drafts.map((d) => ({
    segment_id: `s${d.seg + 1}`,
    start: d.start,
    end: d.end,
    text_start: d.textStart,
    kind: d.kind,
    words: d.words,
    continuation: d.continuation,
    continued: d.continued,
  }));

  // Paragraphs: consecutive units of one block (one text paragraph, one heading, or one list) in
  // one segment. Block ids number the blocks in document order; a list that a blank line or a
  // code block interrupts keeps its block id.
  const paragraphs: Paragraph[] = [];
  const blockIds = new Map<string, string>();
  let pg: Paragraph | null = null;
  let pgKey = "";
  for (let k = 0; k < drafts.length; k++) {
    const d = drafts[k] as Draft;
    const u = units[k] as Unit;
    if (pg !== null && pgKey === d.key && pg.segment_id === u.segment_id) {
      pg.end = u.end;
      pg.unit_indexes.push(k);
    } else {
      let id = blockIds.get(d.key);
      if (id === undefined) {
        id = `b${blockIds.size + 1}`;
        blockIds.set(d.key, id);
      }
      pg = {
        segment_id: u.segment_id,
        kind: u.kind === "heading" ? "heading" : u.kind === "list_item" ? "list" : "text",
        block_id: id,
        start: u.start,
        end: u.end,
        unit_indexes: [k],
      };
      pgKey = d.key;
      paragraphs.push(pg);
    }
  }

  bold.sort((x, y) => x.start - y.start || x.end - y.end);
  let proseWords = 0;
  for (const u of units) proseWords += u.words;

  return {
    text,
    normalized,
    segments,
    units,
    paragraphs,
    masks,
    bold,
    prose_words: proseWords,
    language: detectLanguage(text, units, masks, proseWords),
  };
}
