// Turns the hand-written anchors in test/fixtures/specs.mjs into numeric <name>.expected.json files.
//
// This tool never calls analyse(). Offsets come from String.indexOf over the fixture text, the word
// counts from an independent copy of the word regex, and the segment partition from the rule
// written in the segmenter's notes (gap whitespace belongs to the preceding segment; the first
// segment starts at 0; the last ends at text.length). `*.crlf.md` fixtures are first normalised to
// CRLF line endings (anchors containing "\n" are matched as "\r\n").
//
// Usage: node packages/segmenter/test/tools/build-expected.mjs        (run from the repo root)

import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { specs } from "../fixtures/specs.mjs";

const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures");
const WORD = /[\p{L}\p{N}][\p{L}\p{N}\p{M}]*(?:['\u2019\u02bc\u2010\u2011-][\p{L}\p{N}][\p{L}\p{N}\p{M}]*)*/gu;

/** First 30 UTF-16 units of a slice, never cutting a surrogate pair. */
function head(s) {
  let end = Math.min(30, s.length);
  const c = s.charCodeAt(end - 1);
  if (end < s.length && c >= 0xd800 && c <= 0xdbff) end--;
  return s.slice(0, end);
}

function fail(name, msg) {
  throw new Error(`${name}: ${msg}`);
}

function build(name, spec) {
  const file = join(dir, `${name}.md`);
  const crlf = name.endsWith(".crlf");
  let text = readFileSync(file, "utf8");
  if (crlf) {
    text = text.replace(/\r?\n/g, "\r\n");
    writeFileSync(file, text);
  }
  const nl = (s) => (crlf ? s.replace(/\n/g, "\r\n") : s);
  const find = (what, anchor, from) => {
    const a = nl(anchor);
    const i = text.indexOf(a, from);
    if (i < 0) fail(name, `${what} anchor not found after ${from}: ${JSON.stringify(anchor)}`);
    return [i, i + a.length];
  };

  // Segments: content ranges from anchors, then the partition rule.
  const content = [];
  let cur = 0;
  for (const [kind, a, b] of spec.segments) {
    const [s, aEnd] = find("segment start", a, cur);
    const e = b === undefined ? aEnd : find("segment end", b, s)[1];
    if (e < s) fail(name, `segment end before start: ${JSON.stringify(a)}`);
    if (!/^\s*$/.test(text.slice(cur, s))) fail(name, `non-whitespace gap before segment ${JSON.stringify(a)}`);
    content.push({ kind, s, e });
    cur = e;
  }
  if (!/^\s*$/.test(text.slice(cur))) fail(name, "non-whitespace text after the last segment");
  const segments = content.map((c, k) => ({
    id: `s${k + 1}`,
    kind: c.kind,
    start: k === 0 ? 0 : c.s,
    end: k + 1 < content.length ? content[k + 1].s : text.length,
  }));
  if (segments.length === 0 && text.length > 0) fail(name, "non-empty text needs at least one segment");

  const segmentOf = (pos) => segments.find((s) => s.start <= pos && pos < s.end);

  // Units
  const units = [];
  cur = 0;
  for (const [kind, t, flag] of spec.units) {
    const [s, e] = find("unit", t, cur);
    const seg = segmentOf(s);
    if (seg === undefined || seg.kind !== "prose") fail(name, `unit not in a prose segment: ${JSON.stringify(t)}`);
    if (e > seg.end) fail(name, `unit crosses a segment boundary: ${JSON.stringify(t)}`);
    units.push({
      segment_id: seg.id,
      kind,
      start: s,
      end: e,
      words: (text.slice(s, e).match(WORD) ?? []).length,
      text_start: s + text.slice(s, e).search(/[\p{L}\p{N}]/u), // first word character
      continuation: (flag ?? "").split(" ").includes("cont"),
      continued: (flag ?? "").split(" ").includes("cut"),
      head: head(text.slice(s, e)),
    });
    cur = e;
  }

  const out = {
    text_length: text.length,
    segments: segments.map((s) => ({ ...s, head: head(text.slice(s.start, s.end)) })),
    units,
  };

  if (spec.paragraphs !== undefined) {
    // pblocks: the block number of each paragraph (paragraphs of one list, or of one text paragraph a
    // quote cut, share a number); default is one block per paragraph.
    const pblocks = spec.pblocks ?? spec.paragraphs.map((_, k) => k + 1);
    if (pblocks.length !== spec.paragraphs.length) fail(name, "pblocks must match paragraphs");
    out.paragraphs = spec.paragraphs.map((idx, k) => {
      const first = units[idx[0]];
      const last = units[idx[idx.length - 1]];
      if (first === undefined || last === undefined) fail(name, `bad paragraph ${JSON.stringify(idx)}`);
      const pk = first.kind === "heading" ? "heading" : first.kind === "list_item" ? "list" : "text";
      if (idx.some((i) => units[i].kind !== first.kind)) fail(name, `paragraph ${k} mixes unit kinds`);
      return { segment_id: first.segment_id, kind: pk, block_id: `b${pblocks[k]}`, start: first.start, end: last.end, unit_indexes: idx };
    });
    const flat = spec.paragraphs.flat();
    if (flat.length !== units.length || flat.some((v, i) => v !== i)) fail(name, "paragraphs must cover units in order");
  }

  if (spec.masks !== undefined) {
    out.masks = [];
    cur = 0;
    for (const [kind, t] of spec.masks) {
      const [s, e] = find("mask", t, cur);
      const seg = segmentOf(s);
      if (seg === undefined || seg.kind !== "prose" || e > seg.end) fail(name, `mask outside prose: ${JSON.stringify(t)}`);
      out.masks.push({ kind, start: s, end: e, text: t });
      cur = e;
    }
  }
  if (spec.bold !== undefined) {
    out.bold = [];
    cur = 0;
    for (const t of spec.bold) {
      const [s, e] = find("bold", t, cur);
      out.bold.push({ start: s, end: e, text: t });
      cur = s + 1; // bold spans may nest, so only move past the start
    }
  }

  const words = units.reduce((n, u) => n + u.words, 0);
  if (spec.words !== undefined && spec.words !== words) fail(name, `expected ${spec.words} prose words, anchors give ${words}`);
  out.prose_words = words;
  out.language = spec.language ?? (words < 40 ? "unknown" : "en");
  if (out.language !== "unknown" && words < 40) fail(name, "language other than unknown needs 40 words");

  writeFileSync(join(dir, `${name}.expected.json`), `${JSON.stringify(out, null, 2)}\n`);
}

const names = new Set(Object.keys(specs));
for (const f of readdirSync(dir)) {
  if (f.endsWith(".md") && !names.has(f.slice(0, -3))) fail(f, "fixture has no spec");
}
for (const [name, spec] of Object.entries(specs)) build(name, spec);
console.log(`wrote ${names.size} expected files`);
