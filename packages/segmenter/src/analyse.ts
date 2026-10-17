/**
 * analyse(): partition a turn into segments and extract the prose units, paragraphs, masks and
 * bold spans the engine needs. See the package README-level notes in index.ts for the decisions
 * that the spec left open.
 */

import type { Segment, SegmentKind } from "@prosegate/schema";
import { type ProseBlock, type ProseLine, scanBlocks } from "./blocks.js";
import { findBold, findMasks, findQuotes } from "./inline.js";
import { isBlankRange, splitLines, trimEnd, skipWs } from "./lines.js";
import { splitSentences } from "./sentences.js";
import type { Analysis, Mask, Paragraph, Span, Unit } from "./types.js";
import { LANGUAGE_MIN_WORDS, NON_EN_STOP_WORD_SHARE, countWords, normalizeForMatching, stopWordShare } from "./words.js";

interface Element {
  kind: "heading" | "list_item" | "paragraph";
  s: number;
  e: number;
  /** Paragraph group: consecutive list items share one; every heading and paragraph element has its own. */
  group: number;
}

interface Draft {
  start: number;
  end: number;
  kind: Unit["kind"];
  words: number;
  continuation: boolean;
  group: number;
  seg: number;
}

interface RawSegment {
  kind: SegmentKind;
  s: number;
  e: number;
}

function buildElements(lines: ProseLine[]): Element[] {
  const els: Element[] = [];
  let group = 0;
  let prevWasList = false;
  let i = 0;
  while (i < lines.length) {
    const L = lines[i] as ProseLine;
    if (L.kind === "h") {
      if (L.cend > L.cs) els.push({ kind: "heading", s: L.cs, e: L.cend, group: ++group });
      prevWasList = false;
      i++;
    } else if (L.kind === "sh") {
      let j = i;
      while (j + 1 < lines.length && (lines[j + 1] as ProseLine).kind === "sh") j++;
      els.push({ kind: "heading", s: L.cs, e: (lines[j] as ProseLine).cend, group: ++group });
      prevWasList = false;
      i = j + 1;
    } else if (L.kind === "li") {
      let j = i;
      while (j + 1 < lines.length && (lines[j + 1] as ProseLine).kind === "cont") j++;
      let s = L.cs;
      if (s >= L.cend && j > i) s = (lines[i + 1] as ProseLine).cs; // empty marker line, text on the next line
      const e = (lines[j] as ProseLine).cend;
      if (e > s) {
        if (!prevWasList) group++;
        els.push({ kind: "list_item", s, e, group });
        prevWasList = true;
      } else {
        prevWasList = false;
      }
      i = j + 1;
    } else if (L.kind === "p") {
      let j = i;
      while (j + 1 < lines.length && (lines[j + 1] as ProseLine).kind === "p") j++;
      els.push({ kind: "paragraph", s: L.cs, e: (lines[j] as ProseLine).cend, group: ++group });
      prevWasList = false;
      i = j + 1;
    } else {
      // thematic break, setext underline, orphan continuation: no text, but they end a list run
      prevWasList = false;
      i++;
    }
  }
  return els;
}

/** Items of `a` (sorted, disjoint) that do not overlap any span of `quotes` (sorted, disjoint). */
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

function detectLanguage(text: string, units: Unit[], masks: Mask[], proseWords: number): Analysis["language"] {
  if (proseWords < LANGUAGE_MIN_WORDS) return "unknown";
  const share = stopWordShare(
    text,
    units.map((u): [number, number] => [u.start, u.end]),
    masks,
  );
  if (share === null) return "en"; // nothing but masked text: do not call it foreign
  return share < NON_EN_STOP_WORD_SHARE ? "non_en" : "en";
}

export function analyse(text: string): Analysis {
  const normalized = normalizeForMatching(text);
  const lines = splitLines(text);
  const blocks = scanBlocks(text, lines);

  const raw: RawSegment[] = [];
  const drafts: Draft[] = [];
  const masks: Mask[] = [];
  const bold: Span[] = [];

  const processProse = (b: ProseBlock): void => {
    const firstDraft = drafts.length;
    const quotesAll: Span[] = [];
    for (const el of buildElements(b.lines)) {
      const elMasks = findMasks(text, el.s, el.e);
      const quotes = el.kind === "heading" ? [] : findQuotes(text, el.s, el.e, elMasks);
      const keptMasks = outside(elMasks, quotes);
      for (const m of keptMasks) masks.push(m);
      for (const bs of outside(findBold(text, el.s, el.e, elMasks), quotes)) bold.push(bs);
      for (const q of quotes) quotesAll.push(q);

      const ranges: Array<[number, number]> =
        el.kind === "paragraph" ? splitSentences(text, el.s, el.e, keptMasks, quotes) : [[el.s, el.e]];
      const kind: Unit["kind"] = el.kind === "paragraph" ? "sentence" : el.kind;
      let qi = 0;
      for (const [a, c] of ranges) {
        let ps = a;
        let idx = 0;
        const cut = (pe: number): void => {
          const ts = skipWs(text, ps, pe);
          const te = trimEnd(text, ts, pe);
          if (te > ts) {
            const words = countWords(text.slice(ts, te));
            if (words > 0) {
              drafts.push({ start: ts, end: te, kind, words, continuation: idx > 0, group: el.group, seg: -1 });
            }
          }
          idx++;
        };
        while (qi < quotes.length && (quotes[qi] as Span).start < a) qi++;
        while (qi < quotes.length && (quotes[qi] as Span).start < c) {
          const q = quotes[qi] as Span;
          cut(q.start);
          ps = q.end;
          qi++;
        }
        cut(c);
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
    if (b.kind === "prose") processProse(b);
    else raw.push({ kind: b.kind, s: b.s, e: b.e });
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
    kind: d.kind,
    words: d.words,
    continuation: d.continuation,
  }));

  const paragraphs: Paragraph[] = [];
  let pg: Paragraph | null = null;
  let pgGroup = -1;
  for (let k = 0; k < drafts.length; k++) {
    const d = drafts[k] as Draft;
    const u = units[k] as Unit;
    if (pg !== null && pgGroup === d.group && pg.segment_id === u.segment_id) {
      pg.end = u.end;
      pg.unit_indexes.push(k);
    } else {
      pg = { segment_id: u.segment_id, start: u.start, end: u.end, unit_indexes: [k] };
      pgGroup = d.group;
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
