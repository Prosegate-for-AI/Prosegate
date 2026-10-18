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

interface Stats {
  p50: number;
  p95: number;
  max: number;
  min: number;
}

function bench(fn: () => void, warm: number, runs: number): Stats {
  for (let i = 0; i < warm; i++) fn();
  const ts: number[] = [];
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    fn();
    ts.push(performance.now() - t0);
  }
  ts.sort((a, b) => a - b);
  return { p50: percentile(ts, 0.5), p95: percentile(ts, 0.95), max: ts[ts.length - 1] as number, min: ts[0] as number };
}

/** Five trials of 100 iterations each; the trial with the median p95 is the result (robust to a noisy trial). */
export function benchMedianTrial(fn: () => void, trials = 5, runs = 100): Stats {
  for (let i = 0; i < 30; i++) fn();
  const results: Stats[] = [];
  for (let k = 0; k < trials; k++) results.push(bench(fn, 0, runs));
  results.sort((a, b) => a.p95 - b.p95);
  return results[Math.floor(results.length / 2)] as Stats;
}

/** Best-of-`n` wall time of one call, after a warm-up call. */
function bestOf(fn: () => void, n = 3): number {
  fn();
  let best = Infinity;
  for (let i = 0; i < n; i++) {
    const t0 = performance.now();
    fn();
    best = Math.min(best, performance.now() - t0);
  }
  return best;
}

/** A realistic ~2,000-word markdown turn: real fixtures (PR text, design doc, chat, quotes, tables, code) cycled. */
function realisticDoc(): string {
  const parts = ["pr-description", "design-doc", "chat-reply", "quote-says", "table", "nested-lists", "bold", "fence-in-list", "hazard-urls-emails", "hazard-abbreviations", "list-item-code", "quote-in-list-item"].map(fx);
  let doc = "";
  for (let i = 0; analyse(doc).prose_words < 2000; i++) doc += `${parts[i % parts.length]}\n`;
  return doc;
}

/**
 * A fixed pure-JS workload (PRNG fill, numeric sort, split, regex scan) used to normalise for machine
 * speed: analyse() on the realistic document costs about 0.4 of it on any machine, in the same process.
 */
function makeReference(doc: string): () => number {
  return () => {
    let seed = 12345;
    const arr: number[] = [];
    for (let i = 0; i < 20000; i++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      arr.push(seed);
    }
    arr.sort((a, b) => a - b);
    let n = 0;
    for (const w of doc.split(/\s+/)) if (/^[a-z]+$/i.test(w)) n += w.length;
    return n + (arr[0] ?? 0);
  };
}
/** analyse() p50 relative to the reference workload: measured 0.40; a 3x slowdown gives 1.2. */
const REALISTIC_RELATIVE_BUDGET = 0.65;

/** The budget used by the realistic-document test; exported shape kept simple so a red run can change one number. */
const REALISTIC_P95_BUDGET_MS = 5;

describe("performance", () => {
  it("analyse() on a 2,000-word realistic markdown turn: p95 <= 5 ms warm (median of 5 trials x 100 iterations)", () => {
    const doc = realisticDoc();
    const a = checkInvariants(doc, "perf doc");
    expect(a.prose_words).toBeGreaterThanOrEqual(2000);
    // Median of 5 trials of 100 iterations; up to 3 attempts so that a CPU-starved moment (the suite runs files in
    // parallel) cannot fail the build, while a genuine 3x slowdown (p95 above 6 ms here) fails every attempt.
    const reference = makeReference(doc);
    let r = benchMedianTrial(() => analyse(doc));
    let ratio = r.p50 / benchMedianTrial(reference).p50;
    for (let attempt = 1; attempt < 3 && (r.p95 > REALISTIC_P95_BUDGET_MS || ratio > REALISTIC_RELATIVE_BUDGET); attempt++) {
      r = benchMedianTrial(() => analyse(doc));
      ratio = r.p50 / benchMedianTrial(reference).p50;
    }
    console.log(`PERF relative to the reference workload: ${ratio.toFixed(3)} (budget ${REALISTIC_RELATIVE_BUDGET})`);
    expect(ratio).toBeLessThanOrEqual(REALISTIC_RELATIVE_BUDGET);
    console.log(
      `PERF 2000-word doc: ${doc.length} chars, ${a.prose_words} prose words, ${a.segments.length} segments, ${a.units.length} units, ${a.masks.length} masks: median-trial p50 ${r.p50.toFixed(3)} ms, p95 ${r.p95.toFixed(3)} ms, max ${r.max.toFixed(3)} ms`,
    );
    expect(r.p95).toBeLessThanOrEqual(REALISTIC_P95_BUDGET_MS);
  });

  it("the harness fails for a 3x slowdown (analyse three times per iteration)", () => {
    const doc = realisticDoc();
    // Retried: a loaded machine can spoil one measurement, but a real 3x slowdown shows in every attempt.
    let ok = false;
    for (let attempt = 0; attempt < 4 && !ok; attempt++) {
      const base = benchMedianTrial(() => analyse(doc), 3, 60);
      const slow = benchMedianTrial(
        () => {
          analyse(doc);
          analyse(doc);
          analyse(doc);
        },
        3,
        60,
      );
      console.log(`PERF harness check: base p95 ${base.p95.toFixed(3)} ms min ${base.min.toFixed(3)}, 3x p95 ${slow.p95.toFixed(3)} ms min ${slow.min.toFixed(3)} (budget ${REALISTIC_P95_BUDGET_MS} ms)`);
      ok = slow.min > base.min * 2;
    }
    expect(ok).toBe(true);
  });

  const foreign: Array<[string, string]> = [
    ["Cyrillic", "Рабочий сервер упал вчера вечером из-за плохо подготовленной миграции. Мы восстановили базу данных из резервной копии полуночи, а затем по одной повторно выполнили недостающие транзакции. Данные клиентов не были потеряны, но несколько заказов задержались на несколько часов.\n\n- Добавлена повторная попытка с экспоненциальной задержкой\n- Исправлен нестабильный тест\n\n"],
    ["Greek", "Ο διακομιστής παραγωγής σταμάτησε χθες το βράδυ εξαιτίας μιας κακώς προετοιμασμένης μετάβασης. Επαναφέραμε τη βάση δεδομένων από το αντίγραφο ασφαλείας του μεσονυκτίου και στη συνέχεια εκτελέσαμε ξανά τις συναλλαγές που έλειπαν μία προς μία.\n\n- Προστέθηκε επανάληψη με εκθετική καθυστέρηση\n- Διορθώθηκε ασταθές τεστ\n\n"],
    ["Polish", "Serwer produkcyjny przestał działać wczoraj wieczorem z powodu źle przygotowanej migracji. Przywróciliśmy bazę danych z kopii zapasowej z północy, a następnie ponownie wykonaliśmy brakujące transakcje jedna po drugiej.\n\n- Dodano ponawianie z wykładniczym opóźnieniem\n- Naprawiono niestabilny test\n\n"],
  ];
  for (const [name, unit] of foreign) {
    it(`${name} text of 2,000 words: p95 <= 5 ms (per-token script counts are not a cost)`, () => {
      let doc = "";
      while (analyse(doc).prose_words < 2000) doc += unit;
      const a = analyse(doc);
      expect(a.language).toBe("non_en");
      let r = benchMedianTrial(() => analyse(doc));
      for (let attempt = 1; attempt < 3 && r.p95 > REALISTIC_P95_BUDGET_MS; attempt++) r = benchMedianTrial(() => analyse(doc));
      console.log(`PERF ${name} ${doc.length} chars, ${a.prose_words} words: median-trial p50 ${r.p50.toFixed(3)} ms, p95 ${r.p95.toFixed(3)} ms`);
      expect(r.p95).toBeLessThanOrEqual(REALISTIC_P95_BUDGET_MS);
    });
  }

  it("normalizeForMatching on the same doc is far below the budget", () => {
    const doc = realisticDoc();
    const r = bench(() => normalizeForMatching(doc), 30, 100);
    console.log(`PERF normalizeForMatching: p50 ${r.p50.toFixed(4)} ms, p95 ${r.p95.toFixed(4)} ms`);
    expect(r.p95).toBeLessThan(1);
  });

  it("a 70,000-character URL ending in ')' characters is linear (was 7.5 s): under 20 ms", () => {
    for (const t of [`see http://a.b/${")".repeat(70_000)}`, `see http://a.b/${"(".repeat(70_000)}`, `see http://a.b/${"()".repeat(35_000)}`, `see http://a.b/${".)".repeat(35_000)}`, `see (http://a.b/${")".repeat(70_000)}`]) {
      const ms = bestOf(() => analyse(t));
      console.log(`PERF url-parens ${JSON.stringify(t.slice(0, 22))}… (${t.length} chars): ${ms.toFixed(2)} ms`);
      expect(ms).toBeLessThan(20);
    }
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
    ['quote marks """…', (n) => mk('"', n)],
    ['alternating a" b" c"', (n) => mk('a" b" c" ', n)],
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
    ["URL then closing parens", (n) => `see http://a.b/${mk(")", n)}`],
    ["slashes and dots a/b.c/", (n) => mk("a/b.c/", n)],
    ["markdown links ](](](…", (n) => mk("](", n)],
    ["link text [a. b](c) …", (n) => mk("[a. b](c) ", n)],
    ["open brackets [[[[…", (n) => mk("[", n)],
    ['attributed quotes You said "a b c" …', (n) => mk('You said "a b c" and ', n)],
    ['short quotes You said "a" …', (n) => mk('You said "a" and ', n)],
    ['dash credits "a b c" — Ada …', (n) => mk('"a b c" — Ada ', n)],
    ["curly quotes “ “ “ …", (n) => mk("“ a ", n)],
    ["cue lines You asked:\\n\\n\"a\"", (n) => mk('You asked:\n\n"a b c"\n\n', n)],
    ["blank-line soup", (n) => mk("a\n\n", n)],
    ["CRLF soup", (n) => mk("a\r\n", n)],
    ["lone CR soup", (n) => mk("a\r", n)],
    ["list markers - - - -", (n) => mk("- ", n)],
    ["typographic bullets • • •", (n) => mk("• a\n", n)],
    ["fence on list marker - ```", (n) => mk("- ```\n  x\n", n)],
    ["nested list indent", (n) => { let s = ""; for (let i = 0; s.length < n; i++) s += `${" ".repeat((i % 20) * 2)}- item\n`; return s.slice(0, n); }],
    ["headings ####…", (n) => mk("# h\n", n)],
    ["table rows |a|b|", (n) => `|a|b|\n|-|-|\n${mk("|1|2|\n", n)}`],
    ["table in list", (n) => `- a\n\n${mk("    |a|b|\n    |-|-|\n", n)}`],
    ["fence openers ``` x", (n) => mk("```\nx\n", n)],
    ["setext underlines", (n) => mk("t\n---\n", n)],
    ["front matter openers", (n) => mk("---\na: b\n", n)],
    ["HTML comments <!-- x --> …", (n) => mk("<!-- x --> a ", n)],
    ["unclosed HTML comment openers <!--", (n) => mk("<!-- ", n)],
    ["unicode astral soup", (n) => mk("😀 𝒳 ", n)],
    ["pipes |||| (not a table)", (n) => mk("|", n)],
    ["unmatched brackets ((((", (n) => mk("(", n)],
    ["emphasis ***a*** …", (n) => mk("***a*** ", n)],
    ["language: foreign words und und …", (n) => mk("und der die ", n)],
    ["step numbers 1. a 2. b …", (n) => mk("1. a 2. b ", n)],
  ];

  for (const [name, make] of cases) {
    it(`${name}: 10k chars well under budget; 160k costs less than 8x the 40k time + 2 ms`, () => {
      const small = make(N);
      const mid = make(N * 4);
      const big = make(N * 16);
      // A quadratic fails every attempt; a noisy machine passes at least one of three.
      let t1 = 0;
      let t4 = 0;
      let t16 = 0;
      let ok = false;
      for (let attempt = 0; attempt < 3 && !ok; attempt++) {
        t1 = bestOf(() => analyse(small), 5);
        t4 = bestOf(() => analyse(mid), 5);
        t16 = bestOf(() => analyse(big), 5);
        ok = t16 < 8 * t4 + 2;
      }
      console.log(
        `PERF path ${name.padEnd(44)} 10k: ${t1.toFixed(2).padStart(7)} ms   40k: ${t4.toFixed(2).padStart(7)} ms   160k: ${t16.toFixed(2).padStart(8)} ms   160k/40k ${(t16 / Math.max(t4, 0.05)).toFixed(1)}`,
      );
      expect(t1, "10k chars").toBeLessThan(150);
      // Linear would be 4x between 40k and 160k; a quadratic would be 16x. Allow noise, fail on quadratic.
      expect(ok, `160k took ${t16.toFixed(1)} ms vs 40k ${t4.toFixed(1)} ms`).toBe(true);
      checkInvariants(small, name);
    });
  }
});
