import { describe, expect, it } from "vitest";
import { countWords, normalizeForMatching } from "../src/index.js";

describe("countWords", () => {
  const table: Array<[string, number]> = [
    ["", 0],
    ["   \n\t ", 0],
    ["hello", 1],
    ["hello world", 2],
    ["don't", 1],
    ["don’t", 1],
    ["per-tenant", 1],
    ["v1", 1],
    ["v1.2.3", 3], // dots do not join
    ["well-known per-tenant rate-limit", 3],
    ["rock 'n' roll", 3], // leading and trailing apostrophes do not join
    ["'quoted'", 1],
    ["-dash-", 1],
    ["a - b", 2],
    ["end—start", 2], // em dash separates
    ["end–start", 2],
    ["naïve café", 2],
    ["日本語のテキスト", 1], // one run of letters
    ["12 apples and 3.5 pears", 6], // 12, apples, and, 3, 5, pears
    ["🚀 launch 😀", 1],
    ["𝒳 operator", 2], // astral letter counts
    ["no‑break", 2], // U+2011 is not a joiner in the spec set
    ["it's don't can't", 3],
    ["snake_case", 2], // underscore separates
    ["café", 1], // a decomposed accent ends the word
    ["cafés", 2], // ...and splits it when letters follow (documented limitation of the spec regex)
  ];
  for (const [input, n] of table) {
    it(`counts ${JSON.stringify(input)} as ${n}`, () => {
      expect(countWords(input)).toBe(n);
    });
  }

  it("agrees with the spec regex on random ASCII and Unicode strings (fast path vs regex)", () => {
    const alphabet = ["a", "B", "z", "0", "9", "'", "-", " ", "\n", ".", "’", "é", "ß", "日", "😀", "‑", "_", "́", "٣", "—"];
    let seed = 12345;
    const next = (): number => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 4294967296;
    };
    const spec = /[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu;
    for (let i = 0; i < 4000; i++) {
      let s = "";
      const n = Math.floor(next() * 24);
      for (let k = 0; k < n; k++) s += alphabet[Math.floor(next() * alphabet.length)] as string;
      expect(countWords(s), JSON.stringify(s)).toBe((s.match(spec) ?? []).length);
    }
  });

  it("is stable across calls (no shared regex state)", () => {
    for (let i = 0; i < 5; i++) expect(countWords("one two three")).toBe(3);
  });
});

describe("normalizeForMatching", () => {
  it("maps apostrophes, quotes, spaces and hyphens one code unit to one code unit", () => {
    const cases: Array<[string, string]> = [
      ["‘a’ ‚b‛ ʼc′", "'a' 'b' 'c'"],
      ["“q” „r‟", '"q" "r"'],
      ["a b c d e f g", "a b c d e f g"],
      ["x‐y‑z", "x-y-z"],
      ["ABC xyz", "abc xyz"],
    ];
    for (const [input, expected] of cases) {
      const out = normalizeForMatching(input);
      expect(out).toBe(expected);
      expect(out.length).toBe(input.length);
    }
  });

  it("leaves en and em dashes, other punctuation and non-ASCII letters alone", () => {
    const s = "a–b—c…d É é ß ñ …";
    expect(normalizeForMatching(s)).toBe("a–b—c…d É é ß ñ …");
  });

  it("lowercases ASCII A-Z only, never changing length (U+0130 and friends)", () => {
    // toLowerCase() would turn U+0130 into "i" + U+0307 (two code units) and U+1E9E into "ß".
    const s = "İSTANBUL ẞ ǅ ΑΣ K";
    const out = normalizeForMatching(s);
    expect(out.length).toBe(s.length);
    expect(out).toBe("İstanbul ẞ ǅ ΑΣ K");
    expect(s.toLowerCase().length).not.toBe(s.length); // documents why toLowerCase is forbidden
  });

  it("keeps astral characters and lone surrogates at the same indexes", () => {
    const s = "A😀B\uD800C\uDC00D𝒳";
    const out = normalizeForMatching(s);
    expect(out.length).toBe(s.length);
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      const expected = c >= 65 && c <= 90 ? c + 32 : c;
      expect(out.charCodeAt(i)).toBe(expected);
    }
  });

  it("changes exactly the characters it should, at the same indexes, for every BMP code unit", () => {
    const mapped = new Map<number, number>([
      [0x2018, 39], [0x2019, 39], [0x201a, 39], [0x201b, 39], [0x02bc, 39], [0x2032, 39],
      [0x201c, 34], [0x201d, 34], [0x201e, 34], [0x201f, 34],
      [0xa0, 32], [0x202f, 32], [0x2009, 32], [0x2007, 32], [0x2002, 32], [0x2003, 32],
      [0x2010, 45], [0x2011, 45],
    ]);
    for (let c = 0; c < 0x10000; c++) {
      const s = `x${String.fromCharCode(c)}y`;
      const out = normalizeForMatching(s);
      expect(out.length).toBe(3);
      const want = mapped.get(c) ?? (c >= 65 && c <= 90 ? c + 32 : c);
      if (out.charCodeAt(1) !== want) throw new Error(`U+${c.toString(16)} mapped to U+${out.charCodeAt(1).toString(16)}, want U+${want.toString(16)}`);
    }
  });
});
