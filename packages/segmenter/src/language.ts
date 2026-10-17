/**
 * Language gate. English text is recognised by function-word share; a text is declared non-English
 * only when the English share is low AND a second signal agrees: another language's function-word
 * share beats the English share (and is substantial), or most letters are in a non-Latin script.
 * Terse English (changelog bullets, decision records) has few function words but no second signal.
 */

import { WORD_SOURCE, isAsciiAlnumCode } from "./words.js";

/** Bit per language in the word table. */
const EN = 1;
const OTHERS = ["de", "fr", "es", "pt", "it", "nl"] as const;
type Other = (typeof OTHERS)[number];

const LISTS: Record<"en" | Other, string> = {
  en:
    "the of and to a in is it that he was for on are with as i his they be at have this from or had by not but " +
    "what all were we when your can there an each which she do how their if will up other about out then them " +
    "these so her would him into has more no could my than been who its now did may our us me just also very " +
    "too any only over such here where why while because should must does being those after before between " +
    "through under within during without against among per am",
  de:
    "der die das den dem des ein eine einer eines einem einen und ist nicht mit von zu auf für sich auch als " +
    "aber oder bei nach aus wir ich sie es im wird sind noch dass kann nur hat wurde werden sein",
  fr:
    "le la les des du un une et est en que qui dans pour pas sur au aux avec ce cette ces son sa ses nous vous " +
    "ils elle ne se mais ou où par plus sont été être avoir fait",
  es:
    "el la los las del que y en un una es por con para se su sus al lo como más pero sin sobre entre este esta " +
    "esto son fue ha han hay muy ya también todos así",
  pt:
    "o os as do da dos das em um uma que e é para com não se por mais como mas foi ao ele ela seu sua já " +
    "também são está tem ser",
  it:
    "il lo gli le di del della che è un una per con non sono da al alla nel nella si come più ma anche questo " +
    "questa ha hanno essere",
  nl:
    "de het een van en is dat op te voor met niet zijn er aan ook als maar om bij uit nog naar deze dit wordt " +
    "worden door tot dan ze hij wij",
};

/** word -> bit mask: bit 0 English, bit k+1 = OTHERS[k]. */
const TABLE = new Map<string, number>();
let MAX_LEN = 0;
for (const [lang, words] of Object.entries(LISTS)) {
  const bit = lang === "en" ? EN : 2 << OTHERS.indexOf(lang as Other);
  for (const w of words.split(" ")) {
    TABLE.set(w, (TABLE.get(w) ?? 0) | bit);
    MAX_LEN = Math.max(MAX_LEN, w.length);
  }
}

export interface LanguageStats {
  tokens: number;
  en: number;
  others: number[]; // parallel to OTHERS
  letters: number;
  nonLatinLetters: number;
}

const STICKY_WORD_RE = new RegExp(WORD_SOURCE, "uy");
const LETTER_RE = /\p{L}/gu;
const NON_LATIN_LETTER_RE = /(?!\p{Script=Latin})\p{L}/gu;

function count(re: RegExp, s: string): number {
  re.lastIndex = 0;
  let n = 0;
  while (re.exec(s) !== null) n++;
  return n;
}

function tally(stats: LanguageStats, tokenLower: string): void {
  if (tokenLower.length > MAX_LEN) return;
  const bits = TABLE.get(tokenLower);
  if (bits === undefined) return;
  if (bits & EN) stats.en++;
  for (let k = 0; k < OTHERS.length; k++) if (bits & (2 << k)) (stats.others[k] as number)++;
}

/**
 * Word-token statistics over `ranges` (sorted, disjoint), skipping tokens that start inside a mask.
 * Tokens follow countWords(); pure-ASCII tokens take a fast path.
 */
export function languageStats(
  text: string,
  ranges: ReadonlyArray<readonly [number, number]>,
  masks: ReadonlyArray<{ start: number; end: number }>,
): LanguageStats {
  const stats: LanguageStats = { tokens: 0, en: 0, others: OTHERS.map(() => 0), letters: 0, nonLatinLetters: 0 };
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
          stats.tokens++;
          stats.letters += j - i;
          if (j - i <= MAX_LEN) tally(stats, text.slice(i, j).toLowerCase());
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
        const tok = m[0];
        stats.tokens++;
        stats.letters += count(LETTER_RE, tok);
        stats.nonLatinLetters += count(NON_LATIN_LETTER_RE, tok);
        tally(stats, tok.length <= MAX_LEN ? tok.toLowerCase() : "");
        i += tok.length;
      }
    }
  }
  return stats;
}

/** English function-word share below which the English signal says "not English". */
export const NON_EN_STOP_WORD_SHARE = 0.15;
/** Fewer prose words than this: the gate does not decide. */
export const LANGUAGE_MIN_WORDS = 40;
/** The best other language needs at least this share (and more than English) to be a second signal. */
export const OTHER_LANGUAGE_MIN_SHARE = 0.1;
/** A share of non-Latin letters above this is a second signal on its own. */
export const NON_LATIN_LETTER_SHARE = 0.3;

export function decideLanguage(stats: LanguageStats): "en" | "non_en" {
  if (stats.tokens === 0) return "en"; // nothing but masked text: do not call it foreign
  const enShare = stats.en / stats.tokens;
  if (enShare >= NON_EN_STOP_WORD_SHARE) return "en";
  const bestOther = Math.max(...stats.others) / stats.tokens;
  const otherAgrees = bestOther > enShare && bestOther >= OTHER_LANGUAGE_MIN_SHARE;
  const scriptAgrees = stats.letters > 0 && stats.nonLatinLetters / stats.letters > NON_LATIN_LETTER_SHARE;
  return otherAgrees || scriptAgrees ? "non_en" : "en";
}
