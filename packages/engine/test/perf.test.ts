import { describe, expect, it } from "vitest";
import { analyse } from "@prosegate/segmenter";
import { reviewRulesDetailed, type DetailedReview } from "../src/index.js";
import { pathological, realisticDoc } from "./fixtures.js";
import { CORE_COMPILED, noFloor, profile, request } from "./helpers.js";

// Wall-clock budgets (ADR-10). This file runs serially via `pnpm test:perf` (vitest.perf.config.ts), not in
// the parallel unit run. Every timing here is read from an independent clock around the call; the engine's own
// stats.rules_latency_ms is only cross-checked against it (a stats field that reads 0 must not be able to
// turn these tests into no-ops).

const resolved = noFloor(profile());

function review(text: string, budgetMs?: number): DetailedReview {
  return reviewRulesDetailed({ request: request(text), resolved, packs: [CORE_COMPILED], enforce: true, budgetMs });
}

/** Independent wall time of one whole review (segmenter included), and the result. */
function timed(text: string, budgetMs?: number): { ms: number; r: DetailedReview } {
  const t0 = performance.now();
  const r = review(text, budgetMs);
  return { ms: performance.now() - t0, r };
}

function percentile(sorted: number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)] as number;
}

interface Stats {
  p50: number;
  p95: number;
  max: number;
}

/** Five trials of 100 iterations; the trial with the median p95 is the result (robust to a noisy trial), as in the segmenter's perf test. */
function medianTrial(sample: () => number, trials = 5, runs = 100): Stats {
  for (let i = 0; i < 30; i++) sample();
  const results: Stats[] = [];
  for (let k = 0; k < trials; k++) {
    const ts: number[] = [];
    for (let i = 0; i < runs; i++) ts.push(sample());
    ts.sort((a, b) => a - b);
    results.push({ p50: percentile(ts, 0.5), p95: percentile(ts, 0.95), max: ts[ts.length - 1] as number });
  }
  results.sort((a, b) => a.p95 - b.p95);
  return results[Math.floor(results.length / 2)] as Stats;
}

const fmt = (s: Stats): string => `p50 ${s.p50.toFixed(2)} ms, p95 ${s.p95.toFixed(2)} ms, max ${s.max.toFixed(2)} ms`;

describe("warm performance", () => {
  const doc = realisticDoc(2000);
  const proseWords = analyse(doc).prose_words;

  it("the fixture is a realistic 2,000-word turn", () => {
    expect(proseWords).toBeGreaterThanOrEqual(2000);
    expect(proseWords).toBeLessThan(2300);
    expect(review(doc).diagnostics.all_findings.length).toBeGreaterThan(3); // hits exist, so the match paths run
  });

  it("stats.rules_latency_ms is real: positive and about the independently measured rules time", () => {
    for (let i = 0; i < 20; i++) review(doc);
    for (let i = 0; i < 10; i++) {
      const { ms, r } = timed(doc);
      const rules = r.result.stats.rules_latency_ms;
      expect(rules).toBeGreaterThan(0);
      expect(rules).toBeLessThanOrEqual(ms);
      // the rest of the call is the segmenter and the feedback rendering; the rules are the bulk of it
      expect(rules).toBeGreaterThanOrEqual(0.2 * ms);
    }
  });

  it("p95 <= 50 ms on 2,000 words, segmenter and rules together, on an independent clock (target ~10 ms)", () => {
    const s = medianTrial(() => timed(doc).ms);
    console.log(`warm analyse + rules over ${proseWords} words (independent clock, median of 5 trials x 100): ${fmt(s)}`);
    expect(s.p95).toBeLessThanOrEqual(50);
  });

  it("rules_latency_ms alone is also inside 50 ms, and its p50 is not zero", () => {
    const s = medianTrial(() => review(doc).result.stats.rules_latency_ms);
    console.log(`warm rules_latency_ms: ${fmt(s)}`);
    expect(s.p50).toBeGreaterThan(0.5);
    expect(s.p95).toBeLessThanOrEqual(50);
  });

  it("a dense document (a third of the sentences hit) stays inside the budget too", () => {
    const dense = realisticDoc(2000, 0.35, 11);
    const s = medianTrial(() => timed(dense).ms);
    console.log(`warm analyse + rules, dense hits: ${fmt(s)}`);
    expect(s.p95).toBeLessThanOrEqual(50);
  });
});

describe("pathological inputs: linear, and under 100 ms of engine work", () => {
  const best = (text: string): number => {
    timed(text); // warm-up
    let b = Infinity;
    for (let i = 0; i < 3; i++) b = Math.min(b, timed(text).ms);
    return b;
  };

  it("a 50 KB single paragraph of prose", () => {
    const paragraph = realisticDoc(12_000).replace(/\n+/g, " ").replace(/[`#|>*]/g, "").slice(0, 50_000);
    expect(paragraph.length).toBe(50_000);
    expect(analyse(paragraph).units.length).toBeGreaterThan(300);
    const ms = best(paragraph);
    console.log(`50 KB single paragraph (${analyse(paragraph).prose_words} words): ${ms.toFixed(1)} ms`);
    expect(ms).toBeLessThan(100);
  });

  it("a 50 KB paragraph the segmenter cannot split (one unit, unbalanced backtick)", () => {
    const paragraph = realisticDoc(12_000).replace(/\n+/g, " ").slice(0, 50_000);
    expect(analyse(paragraph).units.length).toBe(1);
    const ms = best(paragraph);
    console.log(`50 KB single unit (${analyse(paragraph).prose_words} words): ${ms.toFixed(1)} ms`);
    expect(ms).toBeLessThan(200);
  });

  for (const [name] of pathological(50_000)) {
    it(`S4 input at 50 KB: ${name}`, () => {
      const pick = (chars: number): string => (pathological(chars).find(([n]) => n === name) as [string, string])[1];
      const small = best(pick(12_500));
      const big = best(pick(50_000));
      console.log(`${name.padEnd(48)} 12.5 KB ${small.toFixed(1).padStart(6)} ms, 50 KB ${big.toFixed(1).padStart(6)} ms`);
      expect(big).toBeLessThan(100);
      // linear: 4x the input costs about 4x the time (a quadratic engine would show 16x); allow a wide margin for noise
      if (big > 10) expect(big / Math.max(small, 0.5)).toBeLessThan(9);
    });
  }
});

describe("the adversarial worst cases stay under 200 ms of engine work (ADR-24)", () => {
  // similarity_to_prior worst cases found by the reviewer's sweep of near-duplicate corpora (about 6,000 words)
  function nearDup(targetWords: number, pool: number, per: number, uniq: number, seed = 1): string {
    let s = seed;
    const r = (): number => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    const common = Array.from({ length: pool }, (_, i) => `term${String.fromCharCode(97 + (i % 26))}${String.fromCharCode(97 + Math.floor(i / 26))}`);
    const out: string[] = [];
    let words = 0;
    let i = 0;
    while (words + per + uniq + 1 <= targetWords) {
      const used = new Set<number>();
      while (used.size < per) used.add(Math.floor(r() * pool));
      const ws = [...used].map((k) => common[k] as string);
      for (let u = 0; u < uniq; u++) ws.push(`w${(i++).toString(36)}`);
      out.push(`The ${ws.join(" ")}.`);
      words += per + uniq + 1;
    }
    return out.join(" ");
  }

  it.each([
    [7, 17, 2],
    [8, 14, 3],
    [4, 14, 1],
    [7, 13, 2],
  ])("simsweep per=%i pool=%i uniq=%i (about 6,000 words of near duplicates)", (per, pool, uniq) => {
    const text = nearDup(5990, pool, per, uniq);
    timed(text, 1e9);
    const { ms, r } = timed(text, 1e9);
    console.log(`simsweep per=${per} pool=${pool} uniq=${uniq}: ${ms.toFixed(1)} ms (similarity ${r.diagnostics.per_rule_ms["core.repetition.001"]?.toFixed(1)} ms)`);
    expect(ms).toBeLessThan(200);
    expect(r.diagnostics.budget_exceeded).toBe(false);
  });

  const rep = (u: string, chars: number): string => u.repeat(Math.ceil(chars / u.length)).slice(0, chars);
  it.each([
    ["single unit, utilizingx rejections", "the value is good and utilizingx stays here "],
    ["single unit, robustness rejections", "the robustness of the value is fine and stays here "],
    ["single unit, xrobust lead rejections", "the value is good and xrobust stays here "],
    ["short sentences, robustness rejections", "The robustness of the value is fine here. "],
  ])("%s at 100 KB", (_name, unit) => {
    const text = rep(unit, 100 * 1024);
    timed(text, 1e9);
    const { ms, r } = timed(text, 1e9);
    console.log(`${_name} at 100 KB: ${ms.toFixed(1)} ms`);
    expect(ms).toBeLessThan(200);
    expect(r.diagnostics.budget_exceeded).toBe(false);
  });

  it("50 KB of 'robust ' (a match per word)", () => {
    const text = rep("robust ", 50 * 1024);
    timed(text);
    const { ms, r } = timed(text);
    console.log(`50 KB of "robust ": ${ms.toFixed(1)} ms, ${r.diagnostics.candidates.length} candidates, ${r.result.findings.length} findings`);
    expect(ms).toBeLessThan(200);
    expect(r.result.findings.length).toBeLessThanOrEqual(50);
    expect(r.diagnostics.candidates.length).toBeGreaterThan(7000);
  });

  it("48 KB of 'Robust `x`. ' (many masks and units: a linear unitAt or MaskIndex shows here)", () => {
    const text = rep("Robust `x`. ", 48 * 1024);
    timed(text);
    const { ms, r } = timed(text);
    console.log(`48 KB of "Robust \`x\`. ": ${ms.toFixed(1)} ms, ${r.diagnostics.candidates.length} candidates`);
    expect(ms).toBeLessThan(200);
    expect(r.diagnostics.budget_exceeded).toBe(false);
    expect(r.diagnostics.candidates.filter((c) => c.rule_id === "core.vocab.003").length).toBeGreaterThan(3000);
  });
});
