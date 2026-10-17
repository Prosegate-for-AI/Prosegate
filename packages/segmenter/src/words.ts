/**
 * Word counting and 1:1 typographic normalisation. Pure string functions; no state.
 */

/**
 * Words are runs of letters/digits (combining marks allowed after the first character) joined by an
 * internal apostrophe, right single quote, modifier apostrophe or hyphen (ASCII, U+2010, U+2011).
 */
export const WORD_SOURCE =
  "[\\p{L}\\p{N}][\\p{L}\\p{N}\\p{M}]*(?:['\\u2019\\u02bc\\u2010\\u2011-][\\p{L}\\p{N}][\\p{L}\\p{N}\\p{M}]*)*";

const COUNT_RE = new RegExp(WORD_SOURCE, "gu");

export function isAsciiAlnumCode(c: number): boolean {
  return (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
}

/**
 * Number of words in `s`. ASCII text takes a hand-rolled scanner (identical to the regex on ASCII,
 * about 5x faster); anything else falls back to the Unicode regex.
 */
export function countWords(s: string): number {
  const len = s.length;
  let n = 0;
  let i = 0;
  while (i < len) {
    const c = s.charCodeAt(i);
    if (c >= 128) return countWordsUnicode(s);
    if (isAsciiAlnumCode(c)) {
      n++;
      i++;
      while (i < len) {
        const d = s.charCodeAt(i);
        if (d >= 128) return countWordsUnicode(s);
        if (isAsciiAlnumCode(d)) {
          i++;
        } else if ((d === 39 || d === 45) && i + 1 < len && isAsciiAlnumCode(s.charCodeAt(i + 1))) {
          i += 2;
        } else {
          break;
        }
      }
    } else {
      i++;
    }
  }
  return n;
}

function countWordsUnicode(s: string): number {
  COUNT_RE.lastIndex = 0; // shared instance: synchronous and non-reentrant, so safe
  let n = 0;
  while (COUNT_RE.exec(s) !== null) n++;
  return n;
}

const NORMALIZE_RE = /[A-Z\u02bc\u00a0\u2002\u2003\u2007\u2009\u2010\u2011\u2018-\u201f\u202f\u2032]/g;

function normalizeChar(ch: string): string {
  const c = ch.charCodeAt(0);
  if (c >= 0x41 && c <= 0x5a) return String.fromCharCode(c + 32); // ASCII A-Z only
  if (c === 0x2010 || c === 0x2011) return "-";
  if (c >= 0x201c && c <= 0x201f) return '"';
  if (c === 0x2018 || c === 0x2019 || c === 0x201a || c === 0x201b || c === 0x02bc || c === 0x2032) return "'";
  return " "; // U+00A0, U+202F, U+2009, U+2007, U+2002, U+2003
}

/**
 * Typographic normalisation for rule matching. Every mapping is one UTF-16 code unit to one code
 * unit, so offsets into the result are offsets into the input. Deliberately not toLowerCase()
 * (U+0130 and others change length) and en/em dashes are left alone (S4).
 */
export function normalizeForMatching(s: string): string {
  return s.replace(NORMALIZE_RE, normalizeChar);
}
