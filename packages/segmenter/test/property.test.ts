import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { analyse } from "../src/index.js";
import { checkInvariants } from "./invariants.js";

/** Small seeded PRNG (mulberry32) so failures reproduce from the seed in the test name. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WORDS = [
  "the", "a", "and", "of", "to", "in", "is", "Plan", "Alpha", "beta", "gamma", "delta", "robust", "Dr.", "Mr.", "e.g.",
  "i.e.", "etc.", "No.", "vs.", "U.S.", "a.m.", "J.", "B.", "1.5", "3.14", "v1.2.3", "1.2.x", "README.md", "src/a.ts",
  "./a.b", "C:\\x\\y.json", "and/or", "https://x.io/a.b?c=d", "www.x.io", "a@b.co", "ops@example.com", "d'accord",
  "don’t", "per-tenant", "naïve", "café", "İstanbul", "ẞ", "😀", "𝒳", "𝄞", "—", "–", "…", "...", "\u00a0", "\u2011",
  "\u2019", "\u201c", "\u201d", "\u2018",
  "<!--", "-->", "<!-- a\n\nb -->", "J.P.", "Morgan", "U.K.", "etc.", "API", "3.", "4.", "Cruz", "de", "la", "é", "ä", "[x.", "y](z)", "[a. b](c)", "✅", "→", "⚠️", "a.m.", "p.m.", "9", "1.", "2.", "Monday", "EST", "Jr.", "al.", "Corp.",
  "•", "\uFEFF", "\u3000", "und", "der", "le", "the",
];
const PUNCT = [".", ".", ".", "!", "?", ",", ":", ";", "(", ")", "[", "]", "\"", "\"", "“", "”", "'", "`", "``", "**", "__", "*", "_", "|", "-", "#", "~", "<", ">", "&", "\\"];
const LEADS = ["<!-- c", "![alt](x.png) ", "        ", "---\nkey: v\n- x\n---\n", "1\uFE0F\u20E3 ", "• ", "\u00a0\u00a0\u00a0\u00a0", "\u00a0\u00a0\u00a0", "- ```sh", "1. ```", "    | a | b |\n    |---|---|", "---\ntitle: x\n---\n", "\uFEFF", "", "", "", "- ", "* ", "+ ", "1. ", "2) ", "- [ ] ", "- [x] ", "> ", ">> ", "# ", "## ", "###### ", "    ", "\t", "  ", "   - ", "    - ", "```", "~~~", "````", "---", "***", "===", "| a | b |", "|---|---|", "| 1 | 2 |"];
const CUES = ["You want ", "Here is the draft you wanted:\n\n", "You asked:\n\n", "**You asked:**\n\n", "By ", "Your phrase ", "You asked me to ", "When you say ", "Your request: ", "You asked for ", "Okafor's docs say ", "The error message says ", "You said **", "(you said ", "You said ", "you wrote ", "The user asked ", "According to Nielsen, ", "The docs say ", "The spec says ", "Ada Lovelace wrote ", "As you put it, ", "He said ", "It reads "];
const BREAKS = ["\n", "\n", "\n", "\n\n", "\r\n", "\r\n\r\n", "\r", "\n\n\n", " \n", "\t\n"];

function randomDoc(r: () => number, crlfOnly: boolean): string {
  const pick = <T,>(xs: T[]): T => xs[Math.floor(r() * xs.length)] as T;
  const lines = Math.floor(r() * 14);
  let out = "";
  for (let l = 0; l < lines; l++) {
    out += pick(LEADS);
    const n = Math.floor(r() * 18);
    for (let i = 0; i < n; i++) {
      const x = r();
      if (x < 0.55) out += pick(WORDS);
      else if (x < 0.8) out += pick(PUNCT);
      else if (x < 0.88) out += pick(CUES) + "\"" + pick(WORDS) + " " + pick(WORDS) + " " + pick(WORDS) + "\"";
      else if (x < 0.92) out += "`" + pick(WORDS) + "`";
      else if (x < 0.96) out += "**" + pick(WORDS) + "**";
      else out += "\"" + pick(WORDS) + " " + pick(WORDS) + " " + pick(WORDS) + "\" — Ada Lovelace";
      out += r() < 0.85 ? " " : "";
    }
    let br = pick(BREAKS);
    if (crlfOnly && (br === "\r" || br === "\n" || br === "\n\n" || br === "\n\n\n" || br === " \n" || br === "\t\n")) br = br.replace(/\r?\n/g, "\n");
    out += br;
  }
  return out;
}

describe("properties over seeded random markdown soup", () => {
  const SEEDS = Number(process.env.SEGMENTER_FUZZ_SEEDS ?? 400); // raise for a soak run
  it(`structural invariants hold for ${SEEDS} random documents (seeds 1..${SEEDS})`, () => {
    for (let seed = 1; seed <= SEEDS; seed++) {
      const text = randomDoc(rng(seed), false);
      checkInvariants(text, `seed ${seed}`);
    }
  });

  it("analyse is deterministic", () => {
    for (let seed = 1; seed <= Math.ceil(SEEDS / 4); seed++) {
      const text = randomDoc(rng(seed * 7919), false);
      expect(JSON.stringify(analyse(text)), `seed ${seed * 7919}`).toBe(JSON.stringify(analyse(text)));
    }
  });

  it("CRLF is metamorphic: LF text and its CRLF twin have the same structure", () => {
    for (let seed = 1; seed <= Math.ceil(SEEDS / 2); seed++) {
      const lf = randomDoc(rng(seed * 104729), true).replace(/\r/g, "");
      const crlf = lf.replace(/\n/g, "\r\n");
      const a = checkInvariants(lf, `lf ${seed}`);
      const b = checkInvariants(crlf, `crlf ${seed}`);
      const norm = (s: string): string => s.replace(/\r\n/g, "\n");
      expect(b.segments.map((s) => s.kind), `seed ${seed}`).toEqual(a.segments.map((s) => s.kind));
      expect(b.units.map((u) => [u.kind, u.words, u.continuation, norm(crlf.slice(u.start, u.end))])).toEqual(
        a.units.map((u) => [u.kind, u.words, u.continuation, lf.slice(u.start, u.end)]),
      );
      expect(b.masks.map((m) => [m.kind, norm(crlf.slice(m.start, m.end))])).toEqual(a.masks.map((m) => [m.kind, lf.slice(m.start, m.end)]));
      expect(b.bold.map((m) => norm(crlf.slice(m.start, m.end)))).toEqual(a.bold.map((m) => lf.slice(m.start, m.end)));
      expect(b.paragraphs.map((p) => p.unit_indexes)).toEqual(a.paragraphs.map((p) => p.unit_indexes));
      expect(b.prose_words).toBe(a.prose_words);
      expect(b.language).toBe(a.language);
    }
  });

  it("every prefix of a fixed tricky document still satisfies the invariants (no boundary bug on truncation)", () => {
    const doc = "# H 😀\r\n\r\n- a `x` **b**\r\n  cont\r\n\r\n```js\r\nc\r\n```\r\n\r\n> q\r\n\r\nYou said \"alpha 😀 gamma\" ok. Dr. Who? Yes… \"n\" — Ada\r\n| a | b |\r\n|---|---|\r\n| 1 | 2 |\r\n";
    for (let n = 0; n <= doc.length; n++) {
      const prefix = doc.slice(0, n);
      // A prefix may end between CR and LF or inside a pair; the document itself may not, so only the
      // structural promises are checked (offset legality is judged against the prefix).
      checkInvariants(prefix, `prefix ${n}`);
    }
  });

  it("holds the invariants for every fixture, and for every fixture concatenated with every other", () => {
    const dir = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
    const texts = readdirSync(dir)
      .filter((f) => f.endsWith(".md"))
      .map((f) => readFileSync(join(dir, f), "utf8"));
    for (const t of texts) checkInvariants(t, "fixture");
    const r = rng(42);
    for (let i = 0; i < Math.ceil(SEEDS / 4); i++) {
      const a = texts[Math.floor(r() * texts.length)] as string;
      const b = texts[Math.floor(r() * texts.length)] as string;
      checkInvariants(a + b, "concat");
      checkInvariants(`${a}\n${b}`, "concat-nl");
    }
  });
});
