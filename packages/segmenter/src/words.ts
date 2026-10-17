/**
 * Word counting, 1:1 typographic normalisation and the English stop-word language gate.
 * Pure string functions; no state.
 */

/** Words are runs of letters/digits joined by an internal apostrophe, right single quote or hyphen. */
const WORD_SOURCE = "[\\p{L}\\p{N}]+(?:['\\u2019-][\\p{L}\\p{N}]+)*";

const COUNT_RE = new RegExp(WORD_SOURCE, "gu");

function isAsciiAlnumCode(c: number): boolean {
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

const STOP_WORDS = new Set(
  (
    "the of and to a in is it you that he was for on are with as i his they be at one have this from or had by " +
    "not but what all were we when your can said there use an each which she do how their if will up other about " +
    "out many then them these so some her would make like him into time has look two more write go see no way " +
    "could people my than first been who its now find long down day did get come made may part am our us me " +
    "just also very too any only over such here where why while because should must does being those"
  ).split(" "),
);

const STOP_MAX_LEN = Math.max(...[...STOP_WORDS].map((w) => w.length));

const STICKY_WORD_RE = new RegExp(WORD_SOURCE, "uy");

/**
 * Stop-word share of the word tokens inside `ranges` (sorted, disjoint), skipping tokens that start
 * inside a mask (sorted, disjoint). Tokens follow countWords(); ASCII tokens take a fast path.
 * Returns null when there are no tokens.
 */
export function stopWordShare(
  text: string,
  ranges: ReadonlyArray<readonly [number, number]>,
  masks: ReadonlyArray<{ start: number; end: number }>,
): number | null {
  let total = 0;
  let stop = 0;
  let mi = 0;
  for (const [rs, re] of ranges) {
    let i = rs;
    while (i < re) {
      while (mi < masks.length && (masks[mi] as { end: number }).end <= i) mi++;
      const mk = masks[mi];
      if (mk !== undefined && mk.start <= i) {
        i = mk.end;
        continue;
      }
      const c = text.charCodeAt(i);
      if (isAsciiAlnumCode(c)) {
        let j = i + 1;
        let ascii = true;
        while (j < text.length) {
          const d = text.charCodeAt(j);
          if (isAsciiAlnumCode(d)) j++;
          else if ((d === 39 || d === 45) && j + 1 < text.length && isAsciiAlnumCode(text.charCodeAt(j + 1))) j += 2;
          else {
            ascii = d < 128;
            break;
          }
        }
        if (ascii) {
          total++;
          if (j - i <= STOP_MAX_LEN && STOP_WORDS.has(text.slice(i, j).toLowerCase())) stop++;
          i = j;
          continue;
        }
      } else if (c < 128) {
        i++;
        continue;
      }
      // Non-ASCII somewhere in the token: let the Unicode regex decide where it ends.
      STICKY_WORD_RE.lastIndex = i;
      const m = STICKY_WORD_RE.exec(text);
      if (m === null) {
        i++;
      } else {
        total++;
        if (m[0].length <= STOP_MAX_LEN && STOP_WORDS.has(m[0].toLowerCase())) stop++;
        i += m[0].length;
      }
    }
  }
  return total === 0 ? null : stop / total;
}

/** Share of stop-word tokens below which a text is treated as non-English. */
export const NON_EN_STOP_WORD_SHARE = 0.15;
/** Fewer prose words than this: the gate does not decide. */
export const LANGUAGE_MIN_WORDS = 40;
