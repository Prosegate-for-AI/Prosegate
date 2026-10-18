import { describe, expect, it } from "vitest";
import { analyse } from "@prosegate/segmenter";
import { STOP_WORDS, stagesFor, RULES_BUDGET_MS } from "../src/index.js";
import { DocContext } from "../src/context.js";
import { documentMetricValue } from "../src/metrics.js";
import type { DocumentMetricMatch } from "../src/compile.js";
import { hits, packOf, profile, review, ruleYaml, run } from "./helpers.js";

const sentenceRule = (id: string, match: string) => packOf(ruleYaml(id, match));
function spans(text: string, match: string, id = "core.repetition.001"): string[] {
  return run(text, { packs: [sentenceRule(id, match)] }).diagnostics.all_findings.map((f) => f.span.text);
}
function docValue(text: string, metric: DocumentMetricMatch["metric"], minItemWords = 0): number | null {
  const m: DocumentMetricMatch = { kind: "document_metric", metric, above: 0, below: null, minSentences: 1, minItemWords };
  return documentMetricValue(m, new DocContext(analyse(text)));
}

describe("witness", () => {
  it("W-S02 sentence_max_words boundary is inclusive", () => {
    const pack = packOf(ruleYaml("core.vocab.001", '{ kind: phrase, phrases: ["foo"], sentence_max_words: 5 }'));
    expect(hits("Foo b c d e.", { packs: [pack] })).toHaveLength(1);
    expect(hits("Foo b c d e f.", { packs: [pack] })).toHaveLength(0);
  });
  it("W-S10 code/table/quote/indented BEFORE the first prose unit never match", () => {
    for (const lead of ["```\nrobust seamless\n```", "| a | b |\n| - | - |\n| robust | seamless |", "> robust seamless", "    indented robust code"]) {
      expect(hits(`${lead}\n\nA normal sentence here.`), lead).toEqual([]);
    }
  });
  it("W-S15 overlap valid after a mid-word lead reject", () => {
    const pack = packOf(ruleYaml("core.vocab.001", '{ kind: phrase, phrases: ["ab cd", "cd ef"] }'));
    expect(hits("xab cd ef", { packs: [pack] })).toEqual([["core.vocab.001", "cd ef"]]);
  });
  it("W-S16 overlap valid after a trail reject", () => {
    const pack = packOf(ruleYaml("core.vocab.001", '{ kind: phrase, phrases: ["ab c", "cd ef"] }'));
    expect(hits("ab cd ef", { packs: [pack] })).toEqual([["core.vocab.001", "cd ef"]]);
  });
  it("W-S17 overlap valid after a mask reject", () => {
    const pack = packOf(ruleYaml("core.vocab.001", '{ kind: phrase, phrases: ["ab cd", "cd ef"] }'));
    expect(hits("See https://x.com/ab cd ef now.", { packs: [pack] })).toEqual([["core.vocab.001", "cd ef"]]);
  });
  it("W-S23 a unit longer than 2,000 chars still matches", () => {
    const text = `${"word ".repeat(500)}robust ${"word ".repeat(10)}.`;
    expect(text.length).toBeGreaterThan(2000);
    expect(analyse(text).units.length).toBe(1);
    expect(hits(text).map(([, t]) => t)).toEqual(["robust"]);
  });
  it("W-S19 findings past the first chunk have correct offsets", () => {
    const filler = Array.from({ length: 80 }, (_, i) => `Sentence number ${i} says nothing at all here.`).join(" ");
    const text = `${filler}\n\nThe plan is robust today.`;
    expect(text.length).toBeGreaterThan(3000);
    const pack = packOf(ruleYaml("core.vocab.001", '{ kind: phrase, phrases: ["robust"] }'));
    expect(hits(text, { packs: [pack] })).toEqual([["core.vocab.001", "robust"]]);
  });
  it("W-C06 heading cut by a quote counts once", () => {
    const text = '# You said "this is a long quoted run of words" and that is all\n\nOne two three four five six seven eight nine ten.';
    const heading = analyse(text).units.filter((u) => u.kind === "heading");
    expect(heading.length).toBeGreaterThan(0);
    const v = docValue(text, "headers_per_100_words");
    expect(v).toBeCloseTo((1 / analyse(text).prose_words) * 100, 10);
  });
  it("W-M05 comma_count counts the continuation piece", () => {
    const m = "{ kind: sentence_metric, metric: comma_count, above: 2 }";
    const t = 'Well, ok, you said "this is a long quoted run of words" and that, is, all.';
    expect(analyse(t).units.length).toBe(2);
    expect(spans(t, m).length).toBe(1);
  });
  it("W-M18 similarity_to_prior below", () => {
    const below = "{ kind: sentence_metric, metric: similarity_to_prior, below: 0.3, min_words: 6 }";
    expect(spans("The cache is per tenant. We ship on Friday after lunch ok.", below)).toEqual(["We ship on Friday after lunch ok."]);
    expect(spans("The cache is per tenant. Each tenant has its own cache.", below)).toEqual([]);
    // threshold strictness: cosine exactly 0.7071 vs below 0.7071...
    expect(spans("Alpha beta. Alpha beta gamma delta and the of it is.", "{ kind: sentence_metric, metric: similarity_to_prior, below: 0.71, min_words: 6 }")).toHaveLength(1);
    expect(spans("Alpha beta. Alpha beta gamma delta and the of it is.", "{ kind: sentence_metric, metric: similarity_to_prior, below: 0.7, min_words: 6 }")).toHaveLength(0);
  });
  it("W-M20 below uses the BEST earlier match", () => {
    const below = "{ kind: sentence_metric, metric: similarity_to_prior, below: 0.5, min_words: 2 }";
    expect(spans("Cache tenant. Cache bananas ships rivers oceans. Cache tenant.", below)).toEqual(["Cache bananas ships rivers oceans."]);
  });
  it("W-T08 non-ASCII uppercase tokens are lower-cased in bags", () => {
    const rep = "{ kind: sentence_metric, metric: similarity_to_prior, above: 0.9, min_words: 2 }";
    expect(spans("École cache. ÉCOLE cache.", rep)).toEqual(["ÉCOLE cache."]);
  });
  it("W-M31 closing_similarity opening block merge: cut text paragraph", () => {
    const text = 'You said "this is a long quoted run of words" and the deploy pipeline is slow because tests crawl.\n\nBananas.\n\nThe deploy pipeline is slow because tests crawl.';
    expect(docValue(text, "closing_similarity")).toBeGreaterThan(0.7);
  });
  it("W-M32 closing_similarity opening is first list item only when first is a list", () => {
    const text = "- The deploy pipeline is slow.\n\n- Bananas and ships sail on rivers.\n\nOranges grow here.\n\nThe deploy pipeline is slow.";
    expect(docValue(text, "closing_similarity")).toBeCloseTo(1, 10);
  });
  it("W-T01 match directly after a mask", () => {
    expect(hits("It is `x`robust now.").map(([, t]) => t)).toEqual(["robust"]);
  });
  it("W-T02 match directly before a mask", () => {
    expect(hits("It is robust`x` now.").map(([, t]) => t)).toEqual(["robust"]);
  });
  it("W-T03 bags ignore masked text", () => {
    const rep = "{ kind: sentence_metric, metric: similarity_to_prior, above: 0.9, min_words: 1 }";
    expect(spans("Cache tenant. Cache tenant `alpha beta gamma delta`.", rep)).toEqual(["Cache tenant `alpha beta gamma delta`."]);
    expect(spans("Cache tenant. Cache `x` tenant.", rep)).toEqual(["Cache `x` tenant."]);
  });
  it("W-T06 possessive stripped", () => {
    const rep = "{ kind: sentence_metric, metric: similarity_to_prior, above: 0.7, min_words: 2 }";
    expect(spans("Tenant cache. Tenant's cache.", rep)).toEqual(["Tenant's cache."]);
  });
  it("W-T13 hyphenated tokens stay whole", () => {
    const rep = "{ kind: sentence_metric, metric: similarity_to_prior, above: 0.7, min_words: 2 }";
    expect(spans("Rate limit cache. Rate-limit cache.", rep)).toEqual([]);
  });
  it("W-K03 '.' in a phrase is literal", () => {
    const pack = packOf(ruleYaml("core.vocab.001", '{ kind: phrase, phrases: ["a.b"] }'));
    expect(hits("An axb here.", { packs: [pack] })).toEqual([]);
    expect(hits("An a.b here.", { packs: [pack] })).toHaveLength(1);
  });
  it("W-K04 '?' in a phrase is literal", () => {
    const pack = packOf(ruleYaml("core.vocab.001", '{ kind: phrase, phrases: ["what?"], boundary: none }'));
    expect(hits("Say wha now.", { packs: [pack] })).toEqual([]);
    expect(hits("Say what? now.", { packs: [pack] })).toHaveLength(1);
  });
  it("W-K09 regex trailing boundary is enforced after a non-ASCII letter", () => {
    const pack = packOf(ruleYaml("core.vocab.002", "{ kind: regex, pattern: '\\bve\\b' }"));
    expect(hits("The veé plan.", { packs: [pack] })).toEqual([]);
    expect(hits("The ve plan.", { packs: [pack] })).toHaveLength(1);
  });
  it("W-K13 min_words omitted means no minimum", () => {
    expect(spans("Cache tenant. Cache tenant again.", "{ kind: sentence_metric, metric: similarity_to_prior, above: 0.7 }")).toEqual(["Cache tenant again."]);
  });
  it("W-K14 min_item_words omitted counts every item", () => {
    const rule = packOf(ruleYaml("core.structure.002", "{ kind: document_metric, metric: bullet_ratio, above: 0.6, min_sentences: 2 }"));
    expect(hits("- one\n- two\n- three\n\nOk.", { packs: [rule] })).toHaveLength(1);
  });
  it("W-R17 stagesFor reviewer floor is inclusive, and needs enabled and categories", () => {
    const on = profile("local/base", (r) => ({ ...r, reviewer: { ...r.reviewer, enabled: true, categories: ["register"] }, thresholds: { ...r.thresholds, reviewer_floor_words: 100 } }));
    expect(stagesFor(100, on)).toEqual(["rules", "reviewer"]);
    expect(stagesFor(99, on)).toEqual(["rules"]);
    const noCat = { ...on, reviewer: { ...on.reviewer, categories: [] } };
    expect(stagesFor(500, noCat)).toEqual(["rules"]);
    const off = { ...on, reviewer: { ...on.reviewer, enabled: false } };
    expect(stagesFor(500, off)).toEqual(["rules"]);
  });
  it("W-R28 prose_chars with leading markup", () => {
    const text = "**Note:** the plan is fine here today.";
    const u = analyse(text).units[0] as { start: number; end: number; text_start: number };
    expect(review(text).stats.prose_chars).toBe(u.end - u.start);
  });
  it("W-R30 rules_latency_ms is measured", () => {
    let t = 0;
    const r = run("It is robust, arguably. Truly.", { now: () => (t += 1) });
    expect(r.result.stats.rules_latency_ms).toBeGreaterThan(0);
  });
  it("W-R34 200 ms budget: tick 10 exceeds, tick 1 does not", () => {
    expect(RULES_BUDGET_MS).toBe(200);
    let t = 0;
    expect(run("It is robust, arguably. Truly.", { now: () => (t += 10) }).diagnostics.budget_exceeded).toBe(true);
    let u = 0;
    expect(run("It is robust, arguably. Truly.", { now: () => (u += 1) }).diagnostics.budget_exceeded).toBe(false);
  });
  it("W-R36 budget is checked between metric rules too", () => {
    const pack = packOf(
      ruleYaml("core.structure.001", "{ kind: document_metric, metric: headers_per_100_words, above: 1.5, min_sentences: 1 }"),
      ruleYaml("core.structure.003", "{ kind: document_metric, metric: sentence_length_cv, below: 0.25, min_sentences: 1 }"),
    );
    let t = 0;
    const r = run("One two three. Four five six.", { packs: [pack], now: () => (t += 300) });
    expect(r.diagnostics.rules_unfinished.length).toBeGreaterThan(0);
  });
  it("W-R39 allow_terms are normalised like the text", () => {
    const p = profile("local/base", (r) => ({ ...r, allow_terms: ["today’s landscape"] }));
    expect(hits("Today’s landscape of tools.", { profile: p }).filter(([id]) => id === "core.vocab.002")).toEqual([]);
  });
  it("W-R38 allow_terms lower-cased by the engine", () => {
    const p = profile("local/base", (r) => ({ ...r, allow_terms: ["Robust"] }));
    expect(hits("A robust plan.", { profile: p }).filter(([id]) => id === "core.vocab.003")).toEqual([]);
  });
  it("W-R42 resolved_from carries the whole chain", () => {
    const p = profile("local/design-doc");
    expect(review("The plan is robust today.", { profile: p }).profile.resolved_from).toEqual([...p.resolved_from]);
    expect(p.resolved_from.length).toBeGreaterThan(1);
  });
  it("W-X02 stop list pins content", () => {
    expect(STOP_WORDS).toContain("that");
    expect(STOP_WORDS).toContain("the");
  });
});
