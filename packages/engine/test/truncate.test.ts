import { describe, expect, it } from "vitest";
import { run } from "./helpers.js";
import { reviewRulesDetailed } from "../src/index.js";
import { CORE_COMPILED, profile, request, noFloor } from "./helpers.js";

// ADR-30: `maxProseChars` reviews the first N characters of prose (unit-aligned; code does not count)
// instead of the adapter skipping a long reply.

const SENTENCE = "The index is rebuilt during the deploy window of the service. ";
const HEDGE = "It's worth noting that the cache is per tenant. ";

function review(text: string, maxProseChars?: number) {
  return reviewRulesDetailed({
    request: request(text),
    resolved: noFloor(profile()),
    packs: [CORE_COMPILED],
    enforce: true,
    maxProseChars,
  });
}

describe("maxProseChars", () => {
  it("is off by default: the whole text is reviewed and nothing is truncated", () => {
    const text = SENTENCE.repeat(400) + HEDGE;
    const r = run(text);
    expect(r.diagnostics.truncated).toBe(false);
    expect(r.diagnostics.reviewed_chars).toBe(text.length);
    expect(r.result.findings.map((f) => f.rule_id)).toContain("core.hedge.001");
  });

  it("reviews the prefix that holds the allowance, cut at a sentence boundary, and says so", () => {
    const text = HEDGE + SENTENCE.repeat(100) + HEDGE;
    const r = review(text, 2000);
    expect(r.diagnostics.truncated).toBe(true);
    expect(r.result.stats.prose_chars).toBeLessThanOrEqual(2000);
    expect(r.result.stats.prose_chars).toBeGreaterThan(1900);
    expect(text.slice(0, r.diagnostics.reviewed_chars).endsWith(".")).toBe(true);
    // The hedge at the head is found; the one past the cut is not.
    const hedges = r.result.findings.filter((f) => f.rule_id === "core.hedge.001");
    expect(hedges).toHaveLength(1);
    expect(hedges[0]?.span.start).toBe(0);
    expect(r.result.verdict).toBe("revise");
    expect(r.result.stats.prose_chars).toBeLessThanOrEqual(2000);
  });

  it("does not count code toward the allowance", () => {
    const code = "```ts\n" + "const x = 1;\n".repeat(2000) + "```\n\n";
    const text = code + HEDGE + SENTENCE.repeat(5);
    const r = review(text, 1000);
    expect(r.diagnostics.truncated).toBe(false);
    expect(r.result.findings.map((f) => f.rule_id)).toContain("core.hedge.001");
  });

  it("spans of a truncated review still equal their slice of the full text", () => {
    const text = HEDGE + SENTENCE.repeat(200);
    const r = review(text, 1500);
    for (const f of r.result.findings) expect(text.slice(f.span.start, f.span.end)).toBe(f.span.text);
  });

  it("a text exactly at the allowance is not truncated; one character under it is", () => {
    const text = SENTENCE.repeat(10).trimEnd();
    const prose = review(text).result.stats.prose_chars;
    expect(review(text, prose).diagnostics.truncated).toBe(false);
    expect(review(text, prose - 1).diagnostics.truncated).toBe(true);
  });

  it("a single unit longer than the allowance is cut inside it, never an empty review", () => {
    const text = `${"word ".repeat(500)}.`;
    const r = review(text, 300);
    expect(r.diagnostics.truncated).toBe(true);
    expect(r.diagnostics.reviewed_chars).toBeGreaterThan(0);
    expect(r.diagnostics.reviewed_chars).toBeLessThanOrEqual(300);
  });

  it("analyses a bounded window of an enormous text", () => {
    const text = SENTENCE.repeat(40_000) + HEDGE; // about 2.4 MB
    const started = performance.now();
    const r = review(text, 20_000);
    expect(r.diagnostics.truncated).toBe(true);
    expect(r.result.stats.prose_chars).toBeLessThanOrEqual(20_000);
    expect(performance.now() - started).toBeLessThan(5000);
  });
});
