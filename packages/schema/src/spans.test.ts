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
  it('is false for out-of-range or inverted offsets instead of throwing', () => {
    expect(spanMatches(text, f(6, 999, 'robust'))).toBe(false);
    expect(spanMatches(text, f(12, 6, ''))).toBe(false);
    expect(spanMatches(text, f(-1, 3, 'It '))).toBe(false);
  });
  it('does no whitespace or unicode normalisation', () => {
    expect(spanMatches('aéb', f(1, 2, 'é'))).toBe(false);
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
  it('returns an empty array when everything mismatches', () => {
    expect(dropMismatchedSpans('abc', [f(0, 2, 'zz')])).toEqual([]);
  });
});
