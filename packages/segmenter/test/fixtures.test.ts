import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { analyse } from "../src/index.js";

const dir = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

interface Expected {
  text_length: number;
  segments: Array<{ id: string; kind: string; start: number; end: number; head: string }>;
  units: Array<{
    segment_id: string;
    kind: string;
    start: number;
    end: number;
    words: number;
    continuation: boolean;
    head: string;
  }>;
  paragraphs?: Array<{ segment_id: string; start: number; end: number; unit_indexes: number[] }>;
  masks?: Array<{ kind: string; start: number; end: number; text: string }>;
  bold?: Array<{ start: number; end: number; text: string }>;
  prose_words: number;
  language: string;
}

function head(s: string): string {
  let end = Math.min(30, s.length);
  const c = s.charCodeAt(end - 1);
  if (end < s.length && c >= 0xd800 && c <= 0xdbff) end--;
  return s.slice(0, end);
}

export const fixtureNames = readdirSync(dir)
  .filter((f) => f.endsWith(".md"))
  .map((f) => f.slice(0, -3))
  .sort();

describe("fixture corpus", () => {
  it("has at least 40 turns, each with an expected file", () => {
    expect(fixtureNames.length).toBeGreaterThanOrEqual(40);
    for (const n of fixtureNames) {
      expect(() => readFileSync(join(dir, `${n}.expected.json`), "utf8"), n).not.toThrow();
    }
  });

  it("keeps CRLF fixtures CRLF", () => {
    const crlf = fixtureNames.filter((n) => n.endsWith(".crlf"));
    expect(crlf.length).toBeGreaterThanOrEqual(2);
    for (const n of crlf) {
      const t = readFileSync(join(dir, `${n}.md`), "utf8");
      expect(t.includes("\r\n"), n).toBe(true);
      expect(/(?<!\r)\n/.test(t), `${n}: bare LF`).toBe(false);
    }
  });

  for (const name of fixtureNames) {
    it(`${name}: segments, units, paragraphs, masks, bold, words and language match the hand-written expectation`, () => {
      const text = readFileSync(join(dir, `${name}.md`), "utf8");
      const exp = JSON.parse(readFileSync(join(dir, `${name}.expected.json`), "utf8")) as Expected;
      expect(text.length).toBe(exp.text_length);

      // The expected file must describe this text: readable heads equal the slices.
      for (const s of exp.segments) expect(head(text.slice(s.start, s.end)), `${name} ${s.id} head`).toBe(s.head);
      for (const u of exp.units) expect(head(text.slice(u.start, u.end)), `${name} unit head`).toBe(u.head);

      const a = analyse(text);
      expect(a.text).toBe(text);
      expect(a.segments).toEqual(exp.segments.map(({ id, kind, start, end }) => ({ id, kind, start, end })));
      expect(
        a.units.map((u) => ({ ...u, head: head(text.slice(u.start, u.end)) })),
      ).toEqual(exp.units);
      if (exp.paragraphs !== undefined) expect(a.paragraphs).toEqual(exp.paragraphs);
      if (exp.masks !== undefined) {
        expect(a.masks.map((m) => ({ ...m, text: text.slice(m.start, m.end) }))).toEqual(exp.masks);
      }
      if (exp.bold !== undefined) {
        expect(a.bold.map((b) => ({ ...b, text: text.slice(b.start, b.end) }))).toEqual(exp.bold);
      }
      expect(a.prose_words).toBe(exp.prose_words);
      expect(a.language).toBe(exp.language);
    });
  }
});
