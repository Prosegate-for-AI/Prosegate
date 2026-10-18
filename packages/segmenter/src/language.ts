/**
 * Language gate. English text is recognised by function-word share; a text is declared non-English
 * only when the English share is low AND a second signal agrees (another language's function words,
 * diacritics, or a non-Latin script), or the English share is almost zero. Terse English (changelog
 * bullets, decision records) has few function words but passes the gate. Tokens inside capitalised
 * runs (names, places, Title Case) are ignored: they say nothing about the language.
 *
 * One hand-written pass over char codes: no regex per token (Cyrillic and Greek text of 2,000 words
 * costs about the same as English).
 */

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

/** Lowercase particles that join the parts of a name ("Juan de la Cruz", "Ana van der Berg"). */
const PARTICLES = new Set("de la van der da dos del von di du den ten ter le el".split(" "));

export interface LanguageStats {
  /** Tokens outside capitalised runs: the denominator of every share. */
  tokens: number;
  en: number;
  others: number[]; // parallel to OTHERS
  /** Letters and digits of those tokens. */
  letters: number;
  /** Non-ASCII Latin letters (diacritics) among them. */
  diacritics: number;
  /** Letters of a non-Latin script among them. */
  nonLatinLetters: number;
}

// Character classes of the scanner.
const NONE = 0;
const ASCII = 1; // ASCII letter or digit
const LATIN = 2; // non-ASCII Latin letter
const OTHER = 3; // letter of another script
const MARK = 4; // combining mark

const ASTRAL_LETTER_RE = /^\p{L}$/u;

function classOf(c: number): number {
  if (c < 128) return (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) ? ASCII : NONE;
  if (c < 0x2c0) return c >= 0xc0 && c !== 0xd7 && c !== 0xf7 ? LATIN : c === 0xaa || c === 0xb5 || c === 0xba ? LATIN : NONE;
  if (c < 0x300) return c >= 0x2b0 ? NONE : LATIN; // IPA extensions
  if (c < 0x370) return MARK;
  if (c < 0x1e00) return c === 0x37e || c === 0x387 || c === 0x55a || c === 0x589 || (c >= 0x5be && c <= 0x5c7 && c !== 0x5c1 && c !== 0x5c2) || c === 0x60c || c === 0x61b || c === 0x61f || c === 0x66a || c === 0x6d4 ? NONE : OTHER;
  if (c < 0x1f00) return LATIN; // Latin Extended Additional
  if (c < 0x2000) return OTHER; // Greek Extended
  if (c < 0x2c00) return NONE; // general punctuation, symbols, arrows
  if (c < 0x2e00) return OTHER; // Glagolitic, Coptic and friends
  if (c >= 0xd800 && c <= 0xdfff) return NONE; // handled by the caller
  if (c < 0x3000) return NONE; // supplemental punctuation
  if (c < 0x3040) return NONE; // CJK symbols and punctuation
  if (c >= 0xe000 && c < 0xf900) return NONE; // private use
  if (c >= 0xfe00 && c < 0xff10) return c >= 0xfe70 ? OTHER : NONE;
  if (c >= 0xff10 && c <= 0xff19) return OTHER;
  if (c >= 0xff21 && c <= 0xff3a) return OTHER;
  if (c >= 0xff41 && c <= 0xff5a) return OTHER;
  if (c >= 0xff66) return c < 0xffe0 ? OTHER : NONE;
  if (c >= 0xff00) return NONE;
  return OTHER; // 0x3040..0xD7FF: kana, CJK, Hangul; 0xF900..0xFDFF: compatibility ideographs, Arabic forms
}

function isJoiner(c: number): boolean {
  return c === 39 || c === 45 || c === 0x2019 || c === 0x2bc || c === 0x2010 || c === 0x2011;
}

/** Is the (non-ASCII) first character of a token an uppercase letter? */
function isUpperNonAscii(c: number): boolean {
  const ch = String.fromCharCode(c);
  return ch !== ch.toLowerCase();
}

function addBits(stats: LanguageStats, bits: number): void {
  if (bits & EN) stats.en++;
  for (let k = 0; k < OTHERS.length; k++) if (bits & (2 << k)) (stats.others[k] as number)++;
}

/**
 * Word-token statistics over `ranges` (sorted, disjoint units), skipping tokens that start inside a
 * mask. Within each range, tokens in capitalised runs (two or more consecutive capitalised tokens,
 * or a capitalised token next to a name particle) are left out of every count.
 */
export function languageStats(
  text: string,
  ranges: ReadonlyArray<readonly [number, number]>,
  masks: ReadonlyArray<{ start: number; end: number }>,
): LanguageStats {
  const stats: LanguageStats = { tokens: 0, en: 0, others: OTHERS.map(() => 0), letters: 0, diacritics: 0, nonLatinLetters: 0 };
  // Per-range token buffers, reused.
  let lowers: string[] = [];
  let caps: boolean[] = [];
  let lets: number[] = [];
  let diacs: number[] = [];
  let nonLat: number[] = [];
  let mi = 0;

  const flush = (): void => {
    const n = lowers.length;
    if (n === 0) return;
    const inRun = new Array<boolean>(n).fill(false);
    for (let i = 0; i + 1 < n; i++) {
      if (caps[i] && caps[i + 1]) {
        inRun[i] = true;
        inRun[i + 1] = true;
      }
    }
    for (let i = 0; i < n; i++) {
      if (caps[i] || !PARTICLES.has(lowers[i] as string)) continue;
      let l = i - 1;
      while (l >= 0 && !caps[l] && PARTICLES.has(lowers[l] as string)) l--;
      let r = i + 1;
      while (r < n && !caps[r] && PARTICLES.has(lowers[r] as string)) r++;
      const left = l >= 0 && caps[l] === true;
      const right = r < n && caps[r] === true;
      if (left || right) {
        inRun[i] = true;
        if (left) inRun[l] = true;
        if (right) inRun[r] = true;
      }
    }
    for (let i = 0; i < n; i++) {
      if (inRun[i]) continue;
      stats.tokens++;
      stats.letters += lets[i] as number;
      stats.diacritics += diacs[i] as number;
      stats.nonLatinLetters += nonLat[i] as number;
      const lw = lowers[i] as string;
      if (lw !== "") {
        const bits = TABLE.get(lw);
        if (bits !== undefined) addBits(stats, bits);
      }
    }
    lowers = [];
    caps = [];
    lets = [];
    diacs = [];
    nonLat = [];
  };

  for (const [rs, re] of ranges) {
    let i = rs;
    while (i < re) {
      while (mi < masks.length && (masks[mi] as { end: number }).end <= i) mi++;
      const mk = masks[mi];
      if (mk !== undefined && mk.start <= i) {
        i = mk.end;
        continue;
      }
      let c = text.charCodeAt(i);
      let cls = classOf(c);
      let width = 1;
      if (c >= 0xd800 && c <= 0xdbff) {
        const cp = text.codePointAt(i) as number;
        cls = ASTRAL_LETTER_RE.test(String.fromCodePoint(cp)) ? OTHER : NONE;
        width = 2;
      }
      if (cls === NONE || cls === MARK) {
        i += width;
        continue;
      }
      // A token starts here.
      const start = i;
      const firstClass = cls;
      const firstCode = c;
      let letters = 0;
      let diac = 0;
      let nonLatin = 0;
      let other = false;
      for (;;) {
        letters++;
        if (cls === LATIN) diac++;
        else if (cls === OTHER) {
          nonLatin++;
          other = true;
        }
        i += width;
        if (i >= re) break;
        c = text.charCodeAt(i);
        cls = classOf(c);
        width = 1;
        if (c >= 0xd800 && c <= 0xdbff) {
          const cp = text.codePointAt(i) as number;
          cls = ASTRAL_LETTER_RE.test(String.fromCodePoint(cp)) ? OTHER : NONE;
          width = 2;
        }
        if (cls === MARK) {
          width = 1;
          letters--; // marks extend a word without being counted as letters
          continue;
        }
        if (cls === NONE) {
          if (isJoiner(c) && i + 1 < re) {
            const nc = text.charCodeAt(i + 1);
            const ncls = nc >= 0xd800 && nc <= 0xdbff ? OTHER : classOf(nc);
            if (ncls !== NONE && ncls !== MARK) {
              i++;
              cls = ncls;
              width = nc >= 0xd800 && nc <= 0xdbff ? 2 : 1;
              continue;
            }
          }
          break;
        }
      }
      const len = i - start;
      const cap = firstClass === ASCII ? firstCode >= 65 && firstCode <= 90 : firstClass === LATIN && isUpperNonAscii(firstCode);
      lowers.push(!other && len <= MAX_LEN ? text.slice(start, i).toLowerCase() : "");
      caps.push(cap);
      lets.push(letters);
      diacs.push(diac);
      nonLat.push(nonLatin);
    }
    flush();
  }
  return stats;
}

/** English function-word share below which the English signal says "not English". */
export const NON_EN_STOP_WORD_SHARE = 0.15;
/** Fewer prose words than this: the gate does not decide. */
export const LANGUAGE_MIN_WORDS = 40;
/** Fewer tokens than this outside capitalised runs: not enough evidence to call a text foreign. */
export const MIN_EVIDENCE_TOKENS = 25;
/** An English share below this, with enough evidence, is "not English" on its own. */
export const EN_FLOOR_SHARE = 0.06;
/** The best other language needs at least this share and more than English to be a second signal... */
export const OTHER_LANGUAGE_MIN_SHARE = 0.1;
/** ...or this share when it is at least twice the English share. */
export const OTHER_LANGUAGE_DOUBLE_MIN_SHARE = 0.06;
/** A share of non-Latin letters above this is a second signal on its own. */
export const NON_LATIN_LETTER_SHARE = 0.3;
/** A share of non-ASCII Latin letters (diacritics) above this is a second signal on its own. */
export const DIACRITIC_LETTER_SHARE = 0.03;

export function decideLanguage(stats: LanguageStats): "en" | "non_en" {
  if (stats.tokens < MIN_EVIDENCE_TOKENS) return "en"; // nothing but masked text, names or a handful of words
  const enShare = stats.en / stats.tokens;
  if (enShare >= NON_EN_STOP_WORD_SHARE) return "en";
  if (stats.letters > 0) {
    if (stats.nonLatinLetters / stats.letters > NON_LATIN_LETTER_SHARE) return "non_en";
    if (stats.diacritics / stats.letters > DIACRITIC_LETTER_SHARE) return "non_en";
  }
  if (enShare < EN_FLOOR_SHARE) return "non_en";
  const bestOther = Math.max(...stats.others) / stats.tokens;
  if (bestOther > enShare && bestOther >= OTHER_LANGUAGE_MIN_SHARE) return "non_en";
  if (bestOther >= OTHER_LANGUAGE_DOUBLE_MIN_SHARE && bestOther >= 2 * enShare) return "non_en";
  return "en";
}
