import { describe, expect, it } from 'vitest';
import { dropMismatchedSpans, spanMatches } from './spans.js';

const f = (start: number, end: number, text: string) => ({ id: `${start}`, span: { start, end, text } });

describe('spanMatches', () => {
  const text = 'It is robust. \u{1d4b3} marks the spot.';
  it('is true for an exact slice', () => {
    expect(spanMatches(text, f(6, 12, 'robust'))).toBe(true);
  });
  it('counts offsets in UTF-16 code units (astral character)', () => {
    expect(spanMatches(text, f(14, 16, '\u{1d4b3}'))).toBe(true);
    expect(spanMatches(text, f(14, 15, '\u{1d4b3}'))).toBe(false);
  });
  it('is false for different text, shifted offsets and case changes', () => {
    expect(spanMatches(text, f(6, 12, 'Robust'))).toBe(false);
    expect(spanMatches(text, f(7, 13, 'robust'))).toBe(false);
  });

  // P01-P06: the edges of the range check
  it('is false when end runs past the text, even though slice() would clamp it', () => {
    expect(spanMatches('abc', f(1, 4, 'bc'))).toBe(false); // slice(1,4) === 'bc' but end > length
    expect(spanMatches('abc', f(0, 999, 'abc'))).toBe(false);
    expect(spanMatches('abc', f(1, 3, 'bc'))).toBe(true); // end === length is fine
  });
  it('is false for a negative start, even though slice() would count from the end', () => {
    expect(spanMatches('abc', f(-2, 3, 'bc'))).toBe(false); // slice(-2,3) === 'bc'
    expect(spanMatches('abc', f(-1, -1, ''))).toBe(false);
  });
  it('is false for non-integer, NaN and infinite offsets', () => {
    expect(spanMatches('abcd', f(0.5, 2, 'ab'))).toBe(false);
    expect(spanMatches('abcd', f(0, 2.5, 'ab'))).toBe(false);
    expect(spanMatches('abcd', f(Number.NaN, 2, 'ab'))).toBe(false);
    expect(spanMatches('abcd', f(0, Number.POSITIVE_INFINITY, 'abcd'))).toBe(false);
  });
  it('is false for inverted offsets, and an empty span only matches an empty slice', () => {
    expect(spanMatches(text, f(12, 6, ''))).toBe(false);
    expect(spanMatches('abc', f(1, 1, ''))).toBe(true);
    expect(spanMatches('abc', f(1, 1, 'b'))).toBe(false);
  });
  it('compares whitespace exactly: no trimming, no collapsing, no newline folding', () => {
    expect(spanMatches('a b', f(0, 3, 'a  b'))).toBe(false);
    expect(spanMatches(' ab ', f(0, 4, 'ab'))).toBe(false);
    expect(spanMatches(' ab ', f(0, 4, ' ab '))).toBe(true);
    expect(spanMatches('a\r\nb', f(0, 4, 'a\nb'))).toBe(false);
    expect(spanMatches('a\nb', f(0, 3, 'a\nb'))).toBe(true);
    expect(spanMatches('a\u00a0b', f(0, 3, 'a b'))).toBe(false);
  });
  it('does no unicode normalisation', () => {
    expect(spanMatches('a\u00e9b', f(1, 2, 'e\u0301'))).toBe(false);
  });
});

describe('dropMismatchedSpans', () => {
  it('drops mismatches, keeps order and does not mutate the input', () => {
    const text = 'alpha beta gamma';
    const input = [f(0, 5, 'alpha'), f(6, 10, 'BETA'), f(11, 16, 'gamma')];
    const copy = [...input];
    expect(dropMismatchedSpans(text, input).map((x) => x.id)).toEqual(['0', '11']);
    expect(input).toEqual(copy);
  });
  it('returns an empty array when everything mismatches, and keeps everything when nothing does', () => {
    expect(dropMismatchedSpans('abc', [f(0, 2, 'zz')])).toEqual([]);
    expect(dropMismatchedSpans('abc', [f(0, 1, 'a'), f(1, 3, 'bc')])).toHaveLength(2);
    expect(dropMismatchedSpans('abc', [])).toEqual([]);
  });
});
