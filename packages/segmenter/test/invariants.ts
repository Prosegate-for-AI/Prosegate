import { expect } from "vitest";
import { type Analysis, analyse, countWords } from "../src/index.js";

const isHigh = (c: number): boolean => c >= 0xd800 && c <= 0xdbff;
const isLow = (c: number): boolean => c >= 0xdc00 && c <= 0xdfff;
const isWs = (ch: string): boolean => /\s/.test(ch);

/** Offset p is a legal boundary of `t`: in range, not inside a surrogate pair, not between CR and LF. */
export function legalBoundary(t: string, p: number): boolean {
  if (!Number.isInteger(p) || p < 0 || p > t.length) return false;
  if (p === 0 || p === t.length) return true;
  const prev = t.charCodeAt(p - 1);
  const cur = t.charCodeAt(p);
  if (isHigh(prev) && isLow(cur)) return false;
  if (prev === 13 && cur === 10) return false;
  return true;
}

const MAPPED = new Map<number, number>([
  [0x2018, 39], [0x2019, 39], [0x201a, 39], [0x201b, 39], [0x02bc, 39], [0x2032, 39],
  [0x201c, 34], [0x201d, 34], [0x201e, 34], [0x201f, 34],
  [0xa0, 32], [0x202f, 32], [0x2009, 32], [0x2007, 32], [0x2002, 32], [0x2003, 32],
  [0x2010, 45], [0x2011, 45],
]);

/** Every structural promise `analyse` makes, checked against an input. Returns the analysis. */
export function checkInvariants(text: string, label = "input"): Analysis {
  const a = analyse(text);
  const ctx = `${label} ${JSON.stringify(text.length > 120 ? `${text.slice(0, 120)}…` : text)}`;

  expect(a.text, ctx).toBe(text);

  // normalized: same length, same code unit at every index except the mapped ones.
  expect(a.normalized.length, `${ctx}: normalized length`).toBe(text.length);
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    const want = MAPPED.get(c) ?? (c >= 65 && c <= 90 ? c + 32 : c);
    if (a.normalized.charCodeAt(i) !== want) throw new Error(`${ctx}: normalized[${i}]`);
  }

  // segments partition the text exactly.
  if (text.length === 0) {
    expect(a.segments, ctx).toEqual([]);
  } else {
    expect(a.segments.length, `${ctx}: at least one segment`).toBeGreaterThan(0);
    expect(a.segments[0]?.start, `${ctx}: first segment starts at 0`).toBe(0);
    expect(a.segments[a.segments.length - 1]?.end, `${ctx}: last segment ends at text.length`).toBe(text.length);
  }
  a.segments.forEach((s, k) => {
    expect(s.id, ctx).toBe(`s${k + 1}`);
    expect(["prose", "code", "table", "quote"], `${ctx}: kind ${s.kind}`).toContain(s.kind);
    expect(s.end, `${ctx}: non-empty segment ${s.id}`).toBeGreaterThan(s.start);
    if (k > 0) expect(s.start, `${ctx}: contiguous at ${s.id}`).toBe((a.segments[k - 1] as { end: number }).end);
    expect(legalBoundary(text, s.start) && legalBoundary(text, s.end), `${ctx}: segment ${s.id} boundaries`).toBe(true);
  });
  const segById = new Map(a.segments.map((s) => [s.id, s]));

  // A prose segment's content never contains a blank line (its trailing gap may).
  for (const s of a.segments) {
    if (s.kind !== "prose") continue;
    const content = text.slice(s.start, s.end).replace(/^\s+|\s+$/g, ""); // the first segment also absorbs leading whitespace
    expect(/[\n\r][ \t\f\v]*[\n\r]/.test(content.replace(/\r\n/g, "\n")), `${ctx}: blank line inside prose ${s.id}`).toBe(false);
  }

  // Units: ordered, disjoint, trimmed, inside one prose segment, with words > 0.
  let prev = 0;
  let words = 0;
  a.units.forEach((u, k) => {
    expect(0 <= u.start && u.start < u.end && u.end <= text.length, `${ctx}: unit ${k} range`).toBe(true);
    expect(legalBoundary(text, u.start) && legalBoundary(text, u.end), `${ctx}: unit ${k} boundaries`).toBe(true);
    expect(u.start, `${ctx}: unit ${k} ordered`).toBeGreaterThanOrEqual(prev);
    prev = u.end;
    const seg = segById.get(u.segment_id);
    expect(seg?.kind, `${ctx}: unit ${k} in prose`).toBe("prose");
    expect(u.start >= (seg?.start ?? 1) && u.end <= (seg?.end ?? -1), `${ctx}: unit ${k} inside ${u.segment_id}`).toBe(true);
    const sl = text.slice(u.start, u.end);
    expect(isWs(sl[0] as string) || isWs(sl[sl.length - 1] as string), `${ctx}: unit ${k} trimmed`).toBe(false);
    expect(u.words, `${ctx}: unit ${k} words`).toBe(countWords(sl));
    expect(u.words).toBeGreaterThan(0);
    expect(["sentence", "list_item", "heading"]).toContain(u.kind);
    if (u.kind === "heading") expect(u.continuation || u.continued).toBe(false);
    expect(u.text_start >= u.start && u.text_start < u.end, `${ctx}: unit ${k} text_start range`).toBe(true);
    expect(/^[\p{L}\p{N}]/u.test(text.slice(u.text_start, u.text_start + 2)), `${ctx}: unit ${k} text_start is a word character`).toBe(true);
    // Word characters before text_start can only be markup the unit skips (masks, images, keycaps), never plain prose.
    if (/[\p{L}\p{N}]/u.test(text.slice(u.start, u.text_start))) {
      const skipped = a.masks.some((m) => m.start >= u.start && m.end <= u.text_start) || /!\[|\u20e3/.test(text.slice(u.start, u.text_start));
      expect(skipped, `${ctx}: unit ${k} text_start skips real words`).toBe(true);
    }
    words += u.words;
  });
  expect(a.prose_words, `${ctx}: prose_words`).toBe(words);
  if (words < 40) expect(a.language, ctx).toBe("unknown");
  else expect(["en", "non_en"], ctx).toContain(a.language);

  // Paragraphs: consecutive units of one segment, covering all units in order.
  const covered: number[] = [];
  for (const p of a.paragraphs) {
    expect(p.unit_indexes.length).toBeGreaterThan(0);
    const first = a.units[p.unit_indexes[0] as number];
    const last = a.units[p.unit_indexes[p.unit_indexes.length - 1] as number];
    expect(p.start, ctx).toBe(first?.start);
    expect(p.end, ctx).toBe(last?.end);
    for (const i of p.unit_indexes) {
      expect(a.units[i]?.segment_id, `${ctx}: paragraph segment`).toBe(p.segment_id);
      covered.push(i);
    }
  }
  expect(covered, `${ctx}: paragraphs cover units in order`).toEqual(a.units.map((_, i) => i));

  // Paragraph kind follows its units; a block id never mixes kinds; ids are b1, b2, ... by first appearance.
  const kindOfBlock = new Map<string, string>();
  for (const p of a.paragraphs) {
    const uk = (a.units[p.unit_indexes[0] as number] as { kind: string }).kind;
    for (const i of p.unit_indexes) expect((a.units[i] as { kind: string }).kind, `${ctx}: paragraph mixes unit kinds`).toBe(uk);
    expect(p.kind, ctx).toBe(uk === "heading" ? "heading" : uk === "list_item" ? "list" : "text");
    const known = kindOfBlock.get(p.block_id);
    if (known === undefined) {
      expect(p.block_id, `${ctx}: block ids by first appearance`).toBe(`b${kindOfBlock.size + 1}`);
      kindOfBlock.set(p.block_id, p.kind);
    } else {
      expect(known, `${ctx}: block ${p.block_id} mixes paragraph kinds`).toBe(p.kind);
    }
  }

  // continuation / continued mean an attributed quote segment sits right before / after the piece.
  a.units.forEach((u, k) => {
    const prevEnd = k > 0 ? (a.units[k - 1] as { end: number }).end : 0;
    const nextStart = k + 1 < a.units.length ? (a.units[k + 1] as { start: number }).start : text.length;
    const quoteBetween = (lo: number, hi: number): boolean =>
      a.segments.some((s) => s.kind === "quote" && s.start >= lo && s.end <= hi && !text.slice(s.start, s.end).trimStart().startsWith(">"));
    if (u.continuation) expect(quoteBetween(prevEnd, u.start + 1), `${ctx}: unit ${k} continuation without a quote before it`).toBe(true);
    if (u.continued) expect(quoteBetween(u.end - 1, nextStart), `${ctx}: unit ${k} continued without a quote after it`).toBe(true);
  });

  // Masks and bold: ordered, inside one prose segment, never inside a quote segment.
  let pm = 0;
  for (const m of a.masks) {
    expect(m.start >= pm && m.start < m.end, `${ctx}: mask order/range`).toBe(true);
    pm = m.end;
    expect(legalBoundary(text, m.start) && legalBoundary(text, m.end), `${ctx}: mask boundaries`).toBe(true);
    const seg = a.segments.find((s) => s.start <= m.start && m.start < s.end);
    expect(seg?.kind, `${ctx}: mask in prose`).toBe("prose");
    expect(m.end <= (seg?.end ?? -1), `${ctx}: mask crosses segment`).toBe(true);
  }
  for (let k = 1; k < a.bold.length; k++) {
    expect((a.bold[k] as { start: number }).start, `${ctx}: bold spans overlap`).toBeGreaterThanOrEqual((a.bold[k - 1] as { end: number }).end);
  }
  for (const b of a.bold) {
    expect(0 <= b.start && b.start < b.end && b.end <= text.length, `${ctx}: bold range`).toBe(true);
    expect(legalBoundary(text, b.start) && legalBoundary(text, b.end), `${ctx}: bold boundaries`).toBe(true);
    const seg = a.segments.find((s) => s.start <= b.start && b.start < s.end);
    expect(seg?.kind, `${ctx}: bold in prose`).toBe("prose");
    expect(b.end <= (seg?.end ?? -1), `${ctx}: bold crosses segment`).toBe(true);
  }

  // Quote segments are blockquote lines or an attributed quoted run of 3+ words.
  for (const s of a.segments) {
    if (s.kind !== "quote") continue;
    const sl = text.slice(s.start, s.end).trimStart();
    if (sl[0] === ">") continue;
    expect(/^["“]/.test(sl), `${ctx}: inline quote starts with a quote mark`).toBe(true);
    expect(/["”]\s*$/.test(sl), `${ctx}: inline quote ends with a quote mark`).toBe(true);
    expect(countWords(sl.slice(1, sl.trimEnd().length - 1)), `${ctx}: inline quote word count`).toBeGreaterThanOrEqual(1);
  }

  return a;
}
