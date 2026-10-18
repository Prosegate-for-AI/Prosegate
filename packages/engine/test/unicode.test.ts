import { describe, expect, it } from "vitest";
import { hits, packOf, review, ruleYaml, run } from "./helpers.js";

const only = (text: string, ruleId: string): string[] =>
  hits(text)
    .filter(([id]) => id === ruleId)
    .map(([, t]) => t);

/** Every finding's span text must be the exact slice of the original text, in UTF-16 code units. */
function expectSlices(text: string, o: Parameters<typeof run>[1] = {}): void {
  for (const f of run(text, o).diagnostics.all_findings) {
    expect(text.slice(f.span.start, f.span.end)).toBe(f.span.text);
    expect(f.span.text.length).toBe(f.span.end - f.span.start);
  }
}

describe("typography is folded for matching, spans come from the original", () => {
  it("curly apostrophes (U+2019) match patterns written with '", () => {
    const text = "It’s worth noting that the index is unique.";
    const r = review(text);
    expect(r.findings.map((f) => f.span.text)).toEqual(["It’s worth noting that"]);
    expect(only("Let’s dive into the cache layer.", "core.filler.001")).toEqual(["Let’s dive into"]);
    expect(only("It’s not just about speed, it’s about trust.", "core.triad.002")).toEqual(["not just about speed, it’s about"]);
    expect(only("Today’s landscape of tools.", "core.vocab.002")).toEqual(["Today’s landscape"]);
  });

  it("curly quotes at the edges of a phrase (U+2018 / U+201C) do not stop a match", () => {
    expect(only("“Great question!” she said.", "core.filler.001")).toEqual(["Great question"]);
    expect(only("It is ‘robust’ now.", "core.vocab.003")).toEqual(["robust"]);
  });

  it("no-break spaces between words (U+00A0, U+202F, U+2009)", () => {
    expect(only("Fine. Let me know if you have any questions.", "core.filler.002")).toHaveLength(1);
    expect(only("Fine. I hope this helps.", "core.filler.002")).toHaveLength(1);
    expect(only("A paradigm shift.", "core.vocab.002")).toEqual(["paradigm shift"]);
  });

  it("U+2011 and U+2010 hyphens match a hyphenated phrase", () => {
    expect(only("A cutting‑edge idea.", "core.vocab.003")).toEqual(["cutting‑edge"]);
    expect(only("An ever‐evolving idea.", "core.vocab.003")).toEqual(["ever‐evolving"]);
    expect(only("A game‑changer.", "core.vocab.002")).toEqual(["game‑changer"]);
  });

  it("matches regardless of the case of the original, including non-ASCII neighbours", () => {
    expect(only("ROBUST and Robust and rObUsT.", "core.vocab.003")).toEqual(["ROBUST", "Robust", "rObUsT"]);
    expect(only("İstanbul is robust.", "core.vocab.003")).toEqual(["robust"]);
  });
});

describe("word boundaries are Unicode-aware", () => {
  it("a diaeresis does not make a word boundary: naive never yields ve", () => {
    const phrase = packOf(ruleYaml("core.vocab.001", '{ kind: phrase, phrases: ["ve"] }'));
    const regex = packOf(ruleYaml("core.vocab.002", "{ kind: regex, pattern: '\\bve\\b' }"));
    for (const pack of [phrase, regex]) {
      expect(hits("The naïve plan.", { packs: [pack] })).toEqual([]);
      expect(hits("The naïve plan and the ve plan.", { packs: [pack] })).toHaveLength(1);
    }
  });

  it("core.triad.001 does not start mid-word after a non-ASCII letter", () => {
    expect(only("The naïve, simple, and robust option.", "core.triad.001")).toEqual([]);
    expect(only("The naive, simple, and robust option.", "core.triad.001")).toEqual(["naive, simple, and robust"]);
  });

  it("accented neighbours, combining marks and other scripts are word characters", () => {
    expect(only("Les robustés.", "core.vocab.003")).toEqual([]);
    expect(only("érobust.", "core.vocab.003")).toEqual([]);
    expect(only("café robust.", "core.vocab.003")).toEqual(["robust"]);
    const pack = packOf(ruleYaml("core.vocab.001", '{ kind: phrase, phrases: ["cafe"] }'));
    expect(hits("a café here", { packs: [pack] })).toEqual([]); // decomposed: the mark is part of the word
    expect(hits("a cafe here", { packs: [pack] })).toEqual([["core.vocab.001", "cafe"]]);
    expect(only("робаrobust.", "core.vocab.003")).toEqual([]);
  });

  it("astral letters and emoji neighbours (two UTF-16 units)", () => {
    expect(only("A 𝒜robust.", "core.vocab.003")).toEqual([]); // MATHEMATICAL SCRIPT CAPITAL A is a letter
    expect(only("A robust𝒜.", "core.vocab.003")).toEqual([]);
    expect(only("A 🎉robust🎉.", "core.vocab.003")).toEqual(["robust"]); // emoji are not word characters
  });
});

describe("offsets are UTF-16 code units", () => {
  it("emoji before a span", () => {
    const text = "🎉🎉 It's worth noting that this is robust 🚀 and fine.";
    const r = review(text);
    expect(r.findings.map((f) => f.span.text)).toEqual(["It's worth noting that", "robust"]);
    const f = r.findings[0] as (typeof r.findings)[number];
    expect(f.span.start).toBe(text.indexOf("It's"));
    expect(f.span.start).toBe(5);
    expect(text.slice(f.span.start, f.span.end)).toBe("It's worth noting that");
    expectSlices(text);
  });

  it("a ZWJ emoji sequence and a flag before the span", () => {
    const text = "👩‍💻 🇺🇸 This is incredibly useful.";
    expect(review(text).findings.map((f) => [f.span.start, f.span.text])).toEqual([[text.indexOf("incredibly"), "incredibly"]]);
    expectSlices(text);
  });

  it("CRLF line endings", () => {
    const text = "A plan.\r\n\r\nIt is robust today.\r\nLet me know if you have\r\nany questions.\r\n";
    const r = review(text);
    expect(r.findings.map((f) => f.span.text)).toEqual(["robust", "Let me know if you have\r\nany questions"]);
    expectSlices(text);
    // identical findings (by rule and text) to the LF version
    const lf = review(text.replace(/\r\n/g, "\n"));
    expect(lf.findings.map((f) => f.rule_id)).toEqual(r.findings.map((f) => f.rule_id));
  });

  it("every finding of a messy text slices cleanly", () => {
    const text = [
      "﻿# Plan 🚀",
      "",
      "It’s worth noting that naïve, simple, and robust things are “great question” material.",
      "",
      "- A 🎉 seamless integration, truly.",
      "",
      "İstanbul: it depends.",
    ].join("\r\n");
    expectSlices(text);
    expect(run(text).diagnostics.all_findings.length).toBeGreaterThan(3);
  });
});
