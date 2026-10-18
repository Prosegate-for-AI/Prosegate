import { describe, expect, it } from "vitest";
import { analyse } from "@prosegate/segmenter";
import { reviewRulesDetailed } from "../src/index.js";
import { pathological, realisticDoc } from "./fixtures.js";
import { CORE_COMPILED, noFloor, profile, request } from "./helpers.js";

// Budgets: 05 / ADR-10 "rules under 50 ms for 2,000 words" means rule execution on a loaded pack,
// which is what stats.rules_latency_ms reports. Cold start has its own test (cold.test.ts).

const resolved = noFloor(profile());

/** The engine without the schema validation the other tests wrap around it. */
function review(text: string) {
  return reviewRulesDetailed({ request: request(text), resolved, packs: [CORE_COMPILED], enforce: true });
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
    const r = review(doc);
    expect(r.diagnostics.all_findings.length).toBeGreaterThan(3); // hits exist, so the match paths run
  });

  it("rules_latency_ms p95 <= 50 ms on 2,000 words (target ~10 ms)", () => {
    const s = medianTrial(() => review(doc).result.stats.rules_latency_ms);
    console.log(`warm rules_latency_ms over ${proseWords} words (median of 5 trials x 100): ${fmt(s)}`);
    expect(s.p95).toBeLessThanOrEqual(50);
  });

  it("a dense document (a third of the sentences hit) stays inside the budget too", () => {
    const dense = realisticDoc(2000, 0.35, 11);
    const s = medianTrial(() => review(dense).result.stats.rules_latency_ms);
    console.log(`warm rules_latency_ms, dense hits: ${fmt(s)}`);
    expect(s.p95).toBeLessThanOrEqual(50);
  });

  it("segmenter plus engine, end to end (for reference)", () => {
    const s = medianTrial(() => {
      const t0 = performance.now();
      review(doc);
      return performance.now() - t0;
    });
    console.log(`warm analyse + rules over ${proseWords} words: ${fmt(s)}`);
    expect(s.p95).toBeLessThan(100);
  });
});

describe("pathological inputs: linear and under 100 ms", () => {
  const rulesMs = (text: string): number => {
    review(text); // warm-up
    let best = Infinity;
    for (let i = 0; i < 3; i++) best = Math.min(best, review(text).result.stats.rules_latency_ms);
    return best;
  };

  it("a 50 KB single paragraph of prose", () => {
    const paragraph = realisticDoc(12_000).replace(/\n+/g, " ").replace(/[`#|>*]/g, "").slice(0, 50_000);
    expect(paragraph.length).toBe(50_000);
    expect(analyse(paragraph).units.length).toBeGreaterThan(300);
    const ms = rulesMs(paragraph);
    console.log(`50 KB single paragraph (${analyse(paragraph).prose_words} words): ${ms.toFixed(1)} ms`);
    expect(ms).toBeLessThan(100);
  });

  it("a 50 KB paragraph the segmenter cannot split (one unit, unbalanced backtick), prose with hits", () => {
    const paragraph = realisticDoc(12_000).replace(/\n+/g, " ").slice(0, 50_000);
    expect(analyse(paragraph).units.length).toBe(1);
    const ms = rulesMs(paragraph);
    console.log(`50 KB single unit (${analyse(paragraph).prose_words} words): ${ms.toFixed(1)} ms`);
    // ~75 ms on a quiet machine (the NFA, not the backtracker, handles a unit this long); the bound leaves room for a loaded one
    expect(ms).toBeLessThan(150);
  });

  for (const [name] of pathological(50_000)) {
    it(`S4 input at 50 KB: ${name}`, () => {
      const pick = (chars: number): string => (pathological(chars).find(([n]) => n === name) as [string, string])[1];
      const small = rulesMs(pick(12_500));
      const big = rulesMs(pick(50_000));
      console.log(`${name.padEnd(48)} 12.5 KB ${small.toFixed(1).padStart(6)} ms, 50 KB ${big.toFixed(1).padStart(6)} ms`);
      expect(big).toBeLessThan(100);
      // linear: 4x the input costs about 4x the time (a quadratic engine would show 16x); allow a wide margin for noise
      if (big > 10) expect(big / Math.max(small, 0.5)).toBeLessThan(9);
    });
  }
});
