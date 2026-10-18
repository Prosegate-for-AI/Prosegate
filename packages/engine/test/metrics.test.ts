import { describe, expect, it } from "vitest";
import { analyse } from "@prosegate/segmenter";
import { isStopWord, SIMILARITY_MAX_WORDS, STOP_WORDS } from "../src/index.js";
import { DocContext } from "../src/context.js";
import { documentMetricValue } from "../src/metrics.js";
import type { DocumentMetricMatch } from "../src/compile.js";
import { hits, packOf, ruleYaml, run } from "./helpers.js";

const sentenceRule = (id: string, match: string) => packOf(ruleYaml(id, match));

function spans(text: string, match: string, id = "core.repetition.001"): string[] {
  return run(text, { packs: [sentenceRule(id, match)] }).diagnostics.all_findings.map((f) => f.span.text);
}

function docValue(text: string, metric: DocumentMetricMatch["metric"], minItemWords = 0): number | null {
  const m: DocumentMetricMatch = { kind: "document_metric", metric, above: 0, below: null, minSentences: 1, minItemWords };
  return documentMetricValue(m, new DocContext(analyse(text)));
}

const words = (n: number, w = "word"): string => Array.from({ length: n }, () => w).join(" ");

describe("sentence metrics", () => {
  it("word_count covers the whole sentence and merges a continuation piece into its head", () => {
    const m = "{ kind: sentence_metric, metric: word_count, above: 5 }";
    expect(spans("Short one here. This one has quite a few more words in it.", m)).toEqual(["This one has quite a few more words in it."]);
    // head "You said" (2 words) + continuation "and that is all." (4 words) = 6 words: one sentence, span = the head piece
    expect(spans('You said "this is a long quoted run of words" and that is all.', m)).toEqual(["You said"]);
    expect(spans('You said "this is a long quoted run of words" and that.', m)).toEqual([]);
    expect(spans("# A heading with quite a few words in it\n\nShort text.", m)).toEqual([]);
  });

  it("word_count below", () => {
    expect(spans("Yes. This one has a few words.", "{ kind: sentence_metric, metric: word_count, below: 3 }")).toEqual(["Yes."]);
  });

  it("comma_count ignores thousands separators and commas in code", () => {
    const m = "{ kind: sentence_metric, metric: comma_count, above: 2 }";
    expect(spans("We got a, b, c, and d.", m)).toEqual(["We got a, b, c, and d."]);
    expect(spans("We got 1,000,000 hits, no more.", m)).toEqual([]);
    expect(spans("We got `a, b, c, d` hits, no more.", m)).toEqual([]);
  });

  it("starts_with anchors the pattern at the first word of the sentence", () => {
    const starts = "{ kind: sentence_metric, metric: starts_with, pattern: 'however|but\\b', above: 0 }";
    expect(spans("However, it works. It works, however. But it fails.", starts)).toEqual(["However, it works.", "But it fails."]);
    expect(spans("**However**, it works. Notably, however, it fails.", starts)).toEqual(["**However**, it works."]);
    const not = "{ kind: sentence_metric, metric: starts_with, pattern: 'however', below: 1 }";
    expect(spans("However, it works. It fails.", not)).toEqual(["It fails."]);
  });
});

describe("similarity_to_prior", () => {
  const rep = "{ kind: sentence_metric, metric: similarity_to_prior, above: 0.7, min_words: 6 }";

  it("flags a later sentence that restates an earlier one (the 08 hit)", () => {
    expect(spans("The cache is per tenant. Each tenant has its own cache.", rep)).toEqual(["Each tenant has its own cache."]);
  });

  it("sentences that share only stop words are not similar", () => {
    expect(spans("The cache is per tenant. It is the one of the other that is not to be in it.", rep)).toEqual([]);
  });

  it("min_words applies to the later sentence only", () => {
    expect(spans("Cache per tenant. Each tenant has its own cache.", rep)).toEqual(["Each tenant has its own cache."]);
    expect(spans("The cache is per tenant. Tenant has own cache.", rep)).toEqual([]);
  });

  it("the threshold is strict and cosine is over term frequencies", () => {
    // {alpha:1, beta:1} vs {alpha:1, beta:1, gamma:1, delta:1}: cosine 0.7071 > 0.7, not > 0.71
    const text = "Alpha beta. Alpha beta gamma delta and the of it is.";
    expect(spans(text, "{ kind: sentence_metric, metric: similarity_to_prior, above: 0.7, min_words: 6 }")).toHaveLength(1);
    expect(spans(text, "{ kind: sentence_metric, metric: similarity_to_prior, above: 0.71, min_words: 6 }")).toEqual([]);
  });

  it("any earlier sentence counts, not only the previous one, and headings and code are not sentences", () => {
    const text = "The cache is per tenant.\n\nWe ship on Friday after lunch.\n\n```\nEach tenant has its own cache.\n```\n\nEach tenant has its own cache.";
    expect(spans(text, rep)).toEqual(["Each tenant has its own cache."]);
    expect(spans("# Each tenant has its own cache\n\nThe cache is per tenant.", rep)).toEqual([]);
  });

  it("a continuation piece is part of its sentence's bag", () => {
    const text = 'The cache is per tenant. You wrote "the quoted run of many words here" about the cache per tenant.';
    expect(spans(text, "{ kind: sentence_metric, metric: similarity_to_prior, above: 0.7, min_words: 3 }")).toEqual(["You wrote"]);
  });

  it("is skipped above 6,000 prose words and runs at 6,000", () => {
    const sentence = "The cache is per tenant today ok.";
    const make = (total: number): string => {
      const n = Math.floor(total / 7);
      const doc = Array.from({ length: n }, () => sentence).join(" ");
      return doc + (total % 7 === 0 ? "" : ` ${words(total % 7)}.`);
    };
    const small = make(5999);
    const exact = make(SIMILARITY_MAX_WORDS);
    const big = make(SIMILARITY_MAX_WORDS + 1);
    expect(analyse(exact).prose_words).toBe(SIMILARITY_MAX_WORDS);
    expect(analyse(big).prose_words).toBe(SIMILARITY_MAX_WORDS + 1);
    // counted on the candidates: the per-rule cap (50) limits the findings, not the matches
    const count = (t: string): number => run(t, { packs: [sentenceRule("core.repetition.001", rep)] }).diagnostics.candidates.length;
    expect(count(small)).toBeGreaterThan(100);
    expect(count(exact)).toBeGreaterThan(100);
    expect(count(big)).toBe(0);
  });

  it("the stop list is published, sorted and does not contain content words", () => {
    expect([...STOP_WORDS]).toEqual([...STOP_WORDS].sort());
    expect(new Set(STOP_WORDS).size).toBe(STOP_WORDS.length);
    expect(isStopWord("the")).toBe(true);
    expect(isStopWord("cache")).toBe(false);
    expect(isStopWord("per")).toBe(false);
  });

  it("agrees with a brute-force O(n^2) cosine on random corpora (inverted index and prefix filter are exact)", () => {
    const vocab = ["alpha", "beta", "gamma", "delta", "epsilon", "zeta", "eta", "theta", "iota", "kappa", "lambda", "mu"];
    const fillers = ["the", "of", "and", "it", "is", "to"];
    let seed = 99;
    const rand = (): number => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 2 ** 32;
    };
    const tok = /[a-z]+/g;
    const bag = (s: string): Map<string, number> => {
      const m = new Map<string, number>();
      for (const t of s.toLowerCase().match(tok) ?? []) if (!isStopWord(t)) m.set(t, (m.get(t) ?? 0) + 1);
      return m;
    };
    const cos = (a: Map<string, number>, b: Map<string, number>): number => {
      let dot = 0;
      let na = 0;
      let nb = 0;
      for (const [k, v] of a) {
        dot += v * (b.get(k) ?? 0);
        na += v * v;
      }
      for (const v of b.values()) nb += v * v;
      return na === 0 || nb === 0 ? 0 : dot / Math.sqrt(na * nb);
    };
    for (const above of [0.5, 0.7, 0.9]) {
      for (let round = 0; round < 25; round++) {
        const sentences: string[] = [];
        for (let i = 0; i < 25; i++) {
          const n = 3 + Math.floor(rand() * 8);
          const parts: string[] = [];
          for (let k = 0; k < n; k++) parts.push(rand() < 0.3 ? (fillers[Math.floor(rand() * fillers.length)] as string) : (vocab[Math.floor(rand() * (rand() < 0.5 ? 4 : vocab.length))] as string));
          sentences.push(`${parts.join(" ").replace(/^./, (c) => c.toUpperCase())}.`);
        }
        const expected = sentences.filter((s, i) => {
          if (i === 0 || s.split(" ").length < 6) return false;
          const b = bag(s);
          return sentences.slice(0, i).some((p) => cos(b, bag(p)) > above);
        });
        const got = spans(sentences.join(" "), `{ kind: sentence_metric, metric: similarity_to_prior, above: ${above}, min_words: 6 }`);
        expect(got).toEqual(expected);
      }
    }
  });
});

describe("document metrics (values)", () => {
  it("headers_per_100_words counts heading words in the denominator", () => {
    expect(docValue(`# Title here\n\n${words(98)}.`, "headers_per_100_words")).toBeCloseTo(1.0, 10);
    expect(docValue(`# One\n\n## Two\n\n${words(98)}.`, "headers_per_100_words")).toBeCloseTo(2.0, 10);
    expect(docValue(`${words(100)}.`, "headers_per_100_words")).toBe(0);
  });

  it("bullet_ratio is qualifying list items over all sentences (min_item_words)", () => {
    const text = ["Intro sentence here. Another one.", "", "- one two three four five six seven", "- one two three four five six", "- one two three four five six eight nine", "- one two three"].join("\n");
    expect(docValue(text, "bullet_ratio", 6)).toBeCloseTo(3 / 6, 10);
    expect(docValue(text, "bullet_ratio", 0)).toBeCloseTo(4 / 6, 10);
    expect(docValue(text, "bullet_ratio", 100)).toBe(0);
  });

  it("a list item cut by an attributed quote counts once", () => {
    const text = 'Intro here.\n\n- You said "this is a long quoted run of words" and that is all\n- Another item with enough words in it\n';
    expect(docValue(text, "bullet_ratio", 0)).toBeCloseTo(2 / 3, 10);
  });

  it("sentence_length_cv is the population standard deviation over the mean", () => {
    expect(docValue("One two. One two three four.", "sentence_length_cv")).toBeCloseTo(1 / 3, 10);
    expect(docValue("One two three. Four five six.", "sentence_length_cv")).toBe(0);
    // headings are not sentences
    expect(docValue("# A B C D E F\n\nOne two. One two three four.", "sentence_length_cv")).toBeCloseTo(1 / 3, 10);
  });

  it("bold_per_100_words counts bold spans over prose words", () => {
    expect(docValue(`**one** and **two** ${words(97)}.`, "bold_per_100_words")).toBeCloseTo(2.0, 10);
  });

  it("closing_similarity: first non-heading paragraph vs last non-heading block, headings skipped", () => {
    const a = "The deploy pipeline is slow because the tests are slow.";
    expect(docValue(`# Title\n\n${a}\n\nSomething else entirely about bananas and ships.\n\n${a}`, "closing_similarity")).toBeCloseTo(1, 10);
    expect(docValue(`${a}\n\nBananas sail on ships.\n\nThe weather is mild in spring.`, "closing_similarity")).toBe(0);
    // two blocks are not a closing (ADR-24: at least three non-heading blocks)
    expect(docValue(`${a}\n\n${a}`, "closing_similarity")).toBeNull();
    expect(docValue(`${a}\n\n# Heading last`, "closing_similarity")).toBeNull();
    expect(docValue(a, "closing_similarity")).toBeNull();
  });

  it("closing_similarity is skipped when the first non-heading paragraph lies within the last block (orchestrator note)", () => {
    const sentences = "The deploy pipeline is slow because the tests are slow. The deploy pipeline is slow because the tests are slow. Fixing the tests fixes the deploy. Nobody disputes that. Ship it on Friday. Then watch the dashboards.";
    const shapes: Record<string, string> = {
      "one-paragraph reply": sentences,
      "heading plus one list": `# Plan\n\n${["- The deploy pipeline is slow because the tests are slow.", "- Fixing the tests fixes the deploy pipeline.", "- Ship it on Friday and watch the dashboards closely."].join("\n")}`,
      "loose list, item 1 in the last block": ["- The deploy pipeline is slow because the tests are slow.", "", "- Fixing the tests fixes the deploy pipeline.", "", "- The deploy pipeline is slow because the tests are slow."].join("\n"),
      "one paragraph cut by a quote": 'You said "this is a long quoted run of words" and the deploy pipeline is slow because the tests are slow. The deploy pipeline is slow because the tests are slow.',
    };
    const rule = packOf(ruleYaml("core.structure.004", "{ kind: document_metric, metric: closing_similarity, above: 0.0, min_sentences: 1 }", "block"));
    for (const [name, text] of Object.entries(shapes)) {
      expect(docValue(text, "closing_similarity"), name).toBeNull();
      expect(hits(text, { packs: [rule] }), name).toEqual([]);
    }
    // the real rule on an ordinary single-paragraph reply with six or more sentences
    expect(hits(sentences).filter(([id]) => id === "core.structure.004")).toEqual([]);
  });

  it("closing_similarity merges the paragraphs of one list into one block", () => {
    const text = [
      "The deploy pipeline is slow because the tests are slow.",
      "",
      "Bananas sail on ships.",
      "",
      "- Tests are slow",
      "",
      "- The deploy pipeline is slow",
      "",
      "- Because the tests are slow",
    ].join("\n");
    const value = docValue(text, "closing_similarity") ?? 0;
    expect(value).toBeGreaterThan(0.6);
    // The last item alone would score lower than the merged list.
    const lastOnly = docValue("The deploy pipeline is slow because the tests are slow.\n\nBananas sail on ships.\n\nBecause the tests are slow", "closing_similarity") ?? 0;
    expect(lastOnly).not.toBeCloseTo(value, 3);
  });
});

describe("document metrics (rules)", () => {
  it("min_sentences gates the rule and the span is the first sentence of the document", () => {
    const m = (n: number): string => `{ kind: document_metric, metric: sentence_length_cv, below: 0.5, min_sentences: ${n} }`;
    const text = "# Heading\n\nOne two three. Four five six. Seven eight nine.";
    expect(spans(text, m(3), "core.structure.003")).toEqual(["One two three."]);
    expect(spans(text, m(4), "core.structure.003")).toEqual([]);
  });

  it("a document metric without min_sentences is refused at compile time", () => {
    expect(() => packOf(ruleYaml("core.structure.003", "{ kind: document_metric, metric: sentence_length_cv, below: 0.5 }"))).toThrow(/min_sentences/);
  });

  it("the document is not flagged when the metric is undefined for it", () => {
    expect(hits("Only one paragraph here, with some words in it today.", { packs: [packOf(ruleYaml("core.structure.004", "{ kind: document_metric, metric: closing_similarity, above: 0.1, min_sentences: 1 }"))] })).toEqual([]);
  });
});
