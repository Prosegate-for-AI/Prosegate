import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { analyse, normalizeForMatching } from "../src/index.js";
import { checkInvariants } from "./invariants.js";

const dir = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const fx = (n: string): string => readFileSync(join(dir, `${n}.md`), "utf8");

function percentile(sorted: number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)] as number;
}

function bench(fn: () => void, warm: number, runs: number): { p50: number; p95: number; max: number } {
  for (let i = 0; i < warm; i++) fn();
  const ts: number[] = [];
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    fn();
    ts.push(performance.now() - t0);
  }
  ts.sort((a, b) => a - b);
  return { p50: percentile(ts, 0.5), p95: percentile(ts, 0.95), max: ts[ts.length - 1] as number };
}

/** A realistic ~2,000-word markdown turn: real fixtures (PR text, design doc, chat, quotes, tables, code) cycled. */
function realisticDoc(): string {
  const parts = ["pr-description", "design-doc", "chat-reply", "quote-says", "table", "nested-lists", "bold", "fence-in-list", "hazard-urls-emails", "hazard-abbreviations", "list-item-code", "quote-in-list-item"].map(fx);
  let doc = "";
  for (let i = 0; analyse(doc).prose_words < 2000; i++) doc += `${parts[i % parts.length]}\n`;
  return doc;
}

describe("performance", () => {
  it("analyse() on a 2,000-word realistic markdown turn: p95 <= 5 ms warm over 100 iterations", () => {
    const doc = realisticDoc();
    const a = checkInvariants(doc, "perf doc");
    expect(a.prose_words).toBeGreaterThanOrEqual(2000);
    const r = bench(() => analyse(doc), 30, 100);
    console.log(
      `PERF 2000-word doc: ${doc.length} chars, ${a.prose_words} prose words, ${a.segments.length} segments, ${a.units.length} units, ${a.masks.length} masks: p50 ${r.p50.toFixed(3)} ms, p95 ${r.p95.toFixed(3)} ms, max ${r.max.toFixed(3)} ms`,
    );
    expect(r.p95).toBeLessThanOrEqual(5);
  });

  it("normalizeForMatching on the same doc is far below the budget", () => {
    const doc = realisticDoc();
    const r = bench(() => normalizeForMatching(doc), 30, 100);
    console.log(`PERF normalizeForMatching: p50 ${r.p50.toFixed(4)} ms, p95 ${r.p95.toFixed(4)} ms`);
    expect(r.p95).toBeLessThan(1);
  });
});

describe("pathological inputs scale linearly", () => {
  const N = 10_000;
  const mk = (unit: string, n: number): string => unit.repeat(Math.ceil(n / unit.length)).slice(0, n);
  const cases: Array<[string, (n: number) => string]> = [
    ["asterisks ****…", (n) => mk("*", n)],
    ["5,000 backticks / n backticks", (n) => mk("`", n / 2)],
    ["backtick run inside a paragraph", (n) => `a ${mk("`", n / 2)} b`],
    ["asterisk run inside a paragraph", (n) => `a ${mk("*", n)} b`],
    ["nested >>>>… (2,000 / 8,000)", (n) => `${mk(">", n / 5)} text`],
    ["10k-char line, no punctuation", (n) => mk("lorem ipsum dolor sit amet ", n)],
    ["quote marks \"\"\"…", (n) => mk('"', n)],
    ["alternating a\" b\" c\"", (n) => mk('a" b" c" ', n)],
    ["underscores ___…", (n) => mk("_", n)],
    ["unclosed bold **a **a …", (n) => mk("**a ", n)],
    ["backtick pairs `a` `a` …", (n) => mk("`a` ", n)],
    ["mixed backtick run lengths", (n) => { let s = ""; for (let i = 1; s.length < n; i = (i % 40) + 1) s += `${"`".repeat(i)}x `; return s.slice(0, n); }],
    ["period spam . . . .", (n) => mk(". ", n)],
    ["abbreviations e.g. e.g. …", (n) => mk("e.g. ", n)],
    ["sentences A. B. C. …", (n) => mk("A. B. ", n)],
    ["no spaces aaaa…", (n) => mk("a", n)],
    ["@ spam", (n) => mk("@", n)],
    ["emails a@a@a@…", (n) => mk("a@", n)],
    ["URL spam http://http://…", (n) => mk("http://", n)],
    ["slashes and dots a/b.c/", (n) => mk("a/b.c/", n)],
    ["markdown links ](](](…", (n) => mk("](", n)],
    ["attributed quotes You said \"a b c\" …", (n) => mk('You said "a b c" and ', n)],
    ["dash credits \"a b c\" — Ada …", (n) => mk('"a b c" — Ada ', n)],
    ["curly quotes “ “ “ …", (n) => mk("“ a ", n)],
    ["blank-line soup", (n) => mk("a\n\n", n)],
    ["CRLF soup", (n) => mk("a\r\n", n)],
    ["lone CR soup", (n) => mk("a\r", n)],
    ["list markers - - - -", (n) => mk("- ", n)],
    ["nested list indent", (n) => { let s = ""; for (let i = 0; s.length < n; i++) s += `${" ".repeat((i % 20) * 2)}- item\n`; return s.slice(0, n); }],
    ["headings ####…", (n) => mk("# h\n", n)],
    ["table rows |a|b|", (n) => `|a|b|\n|-|-|\n${mk("|1|2|\n", n)}`],
    ["fence openers ``` x", (n) => mk("```\nx\n", n)],
    ["setext underlines", (n) => mk("t\n---\n", n)],
    ["unicode astral soup", (n) => mk("😀 𝒳 ", n)],
    ["pipes |||| (not a table)", (n) => mk("|", n)],
    ["unmatched brackets ((((", (n) => mk("(", n)],
    ["emphasis ***a*** …", (n) => mk("***a*** ", n)],
  ];

  for (const [name, make] of cases) {
    it(`${name}: 10k chars well under budget, 4x input costs about 4x`, () => {
      const small = make(N);
      const big = make(N * 4);
      const time = (s: string): number => {
        analyse(s); // warm
        let best = Infinity;
        for (let i = 0; i < 3; i++) {
          const t0 = performance.now();
          analyse(s);
          best = Math.min(best, performance.now() - t0);
        }
        return best;
      };
      const t1 = time(small);
      const t4 = time(big);
      console.log(`PERF path ${name.padEnd(46)} 10k: ${t1.toFixed(2).padStart(7)} ms   40k: ${t4.toFixed(2).padStart(7)} ms   ratio ${(t4 / Math.max(t1, 0.05)).toFixed(1)}`);
      expect(t1, "10k chars").toBeLessThan(150);
      // Linear would be 4x; allow generous noise but fail on quadratic (16x) behaviour.
      expect(t4, "40k chars").toBeLessThan(Math.max(t1, 1) * 10);
      checkInvariants(small, name);
    });
  }
});
