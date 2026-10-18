import { describe, expect, it } from "vitest";
import { hits, packOf, profile, review, ruleYaml, run, sources } from "./helpers.js";
import { resolveProfile } from "@prosegate/profiles";

const only = (text: string, ruleId: string, o: Parameters<typeof hits>[1] = {}): string[] =>
  hits(text, o)
    .filter(([id]) => id === ruleId)
    .map(([, t]) => t);

describe("word boundaries (ADR-15: only at word-character edges)", () => {
  it("matches phrases that end in punctuation", () => {
    expect(only("Certainly! Here is the fix.", "core.filler.001")).toEqual(["Certainly!"]);
    expect(only("Overall, the fix is safe.", "core.filler.004")).toEqual(["Overall,"]);
  });

  it("does not match inside a longer word, on either side", () => {
    expect(only("The robustness of it.", "core.vocab.003")).toEqual([]);
    expect(only("The unrobust thing.", "core.vocab.003")).toEqual([]);
    expect(only("The robust_value thing.", "core.vocab.003")).toEqual([]);
    expect(only("The robust-ish thing.", "core.vocab.003")).toEqual([]); // a hyphen between letters is word-internal (ADR-24)
    expect(only("The robust - ish thing.", "core.vocab.003")).toEqual(["robust"]);
    expect(only("It is robust.", "core.vocab.003")).toEqual(["robust"]);
    expect(only("It is (robust).", "core.vocab.003")).toEqual(["robust"]);
  });

  it("boundary: none matches inside words", () => {
    const pack = packOf(ruleYaml("core.vocab.001", '{ kind: phrase, phrases: ["bust"], boundary: none }'));
    expect(hits("It is robust.", { packs: [pack] })).toEqual([["core.vocab.001", "bust"]]);
  });

  it("resumes after a rejected candidate: a later valid match is still found", () => {
    expect(only("robustx robust", "core.vocab.003")).toEqual(["robust"]);
    expect(only("robusts and then robust", "core.vocab.003")).toEqual(["robust"]);
  });

  it("falls back to a shorter phrase when the longest one fails the trailing boundary", () => {
    const pack = packOf(ruleYaml("core.vocab.001", '{ kind: phrase, phrases: ["foo", "foo bar"] }'));
    expect(hits("foo barx and foo.", { packs: [pack] })).toEqual([
      ["core.vocab.001", "foo"],
      ["core.vocab.001", "foo"],
    ]);
  });

  it("lets a phrase span a line wrap (\\s+ between words)", () => {
    expect(only("Let me know if you\nhave any questions.", "core.filler.002")).toEqual(["Let me know if you\nhave any questions"]);
  });
});

describe("spans", () => {
  it("uses the named group span when the regex has one, else the whole match", () => {
    expect(only("The query is relatively slow.", "core.hedge.002")).toEqual(["relatively"]);
    expect(only("We can leverage the cache.", "core.vocab.001")).toEqual(["leverage"]);
    expect(only("It is not just about speed, it's about trust.", "core.triad.002")).toEqual(["not just about speed, it's about"]);
  });

  it("drops a match whose span group is empty", () => {
    const pack = packOf(ruleYaml("core.vocab.001", "{ kind: regex, pattern: 'foo(?P<span>x*)bar' }"));
    expect(hits("foobar and fooxbar.", { packs: [pack] })).toEqual([["core.vocab.001", "x"]]);
  });

  it("evaluates every part of an any rule", () => {
    expect(only("Note that it fails.", "core.hedge.001")).toEqual(["Note that"]);
    expect(only("It should be noted that it fails.", "core.hedge.001")).toEqual(["It should be noted that"]);
    expect(only("It is important to note, however, this.", "core.hedge.001")).toEqual(["It is important to note,"]);
    expect(only("We delve into it and leverage the realm.", "core.vocab.001")).toEqual(["delve"]);
    expect(only("We delve into it and leverage the realm.", "core.vocab.002")).toEqual(["realm"]);
  });

  it("finds all parts of an any rule at once", () => {
    const found = only("We delve in. Then we can leverage it. She underscores the point.", "core.vocab.001");
    expect(found).toEqual(["delve", "leverage", "underscores"]);
  });
});

describe("position", () => {
  it("sentence_start matches at the first word of a unit, past markup", () => {
    expect(only("**Great question!** Let's go.", "core.filler.001")).toEqual(["Great question"]);
    expect(only("(Note that this holds.)", "core.hedge.001")).toEqual(["Note that"]);
    expect(only("It works. Note that it fails.", "core.hedge.001")).toEqual(["Note that"]);
    expect(only("I think great question marks help.", "core.filler.001")).toEqual([]);
    expect(only("Please note that it fails.", "core.hedge.001")).toEqual(["Please note that"]); // ADR-24 variant
    expect(only("You should note that it fails.", "core.hedge.001")).toEqual([]);
  });

  it("sentence_start applies in a list item, not after a list marker's middle", () => {
    expect(only("- Great question about it\n- Fine", "core.filler.001")).toEqual(["Great question"]);
  });

  it("a continuation piece is not a sentence start", () => {
    const text = 'You said "this is a long quoted run of words" great question for later.';
    expect(only(text, "core.filler.001")).toEqual([]);
    expect(only('Great question about "this is a long quoted run of words" you said.', "core.filler.001")).toEqual(["Great question"]);
  });

  it("closing means the last two sentences, a continuation piece and its head counting as one", () => {
    const body = (n: number, lastLine: string): string => Array.from({ length: n }, (_, i) => `Step ${i + 1} is done.`).join(" ") + ` ${lastLine}`;
    expect(only(body(3, "Let me know if you have any questions."), "core.filler.002")).toHaveLength(1);
    expect(only(`Let me know if you have any questions. ${body(3, "Fine.")}`, "core.filler.002")).toEqual([]);
    expect(only("Step 0 is done. I hope this helps. Step 2 is done.", "core.filler.002")).toEqual(["I hope this helps"]);
    expect(only("I hope this helps. Step 1 is done. Step 2 is done.", "core.filler.002")).toEqual([]);
    expect(only("I hope this helps. Step 1 is done. Step 2 is done. Step 3 is done.", "core.filler.002")).toEqual([]);
    // The last sentence is cut by a quote: head + continuation are one sentence, so S3 is still one of the last two.
    const cut = 'Step 1 is done. I hope this helps. You said "this is a long quoted run of words" and that is all.';
    expect(only(cut, "core.filler.002")).toEqual(["I hope this helps"]);
    // A trailing heading is not a sentence.
    expect(only("Step 1 is done. I hope this helps. Step 2 is done.\n\n## Notes", "core.filler.002")).toEqual(["I hope this helps"]);
  });

  it("max_doc_words: inactive above the limit (filler.004: 399)", () => {
    const pack = packOf(ruleYaml("core.filler.004", '{ kind: phrase, phrases: ["in summary"], max_doc_words: 10 }'));
    const ten = "In summary, a b c d e f g h."; // 10 words
    expect(hits(ten, { packs: [pack] })).toHaveLength(1);
    expect(hits(`${ten} z`, { packs: [pack] })).toHaveLength(0);
  });

  it("sentence_max_words and sentence_exclude (triad.001)", () => {
    expect(only("It is fast, simple, and reliable.", "core.triad.001")).toEqual(["fast, simple, and reliable"]);
    expect(only("It is fast, simple, and reliable on 3 runners.", "core.triad.001")).toEqual([]);
    expect(only("Install git, node, and pnpm.", "core.triad.001")).toEqual(["git, node, and pnpm"]); // the known false positive of ADR-15
    const long = `${"word ".repeat(23)}is fast, simple, and reliable.`; // 28 words
    expect(only(long, "core.triad.001")).toEqual([]);
    const ok = `${"word ".repeat(18)}is fast, simple, and reliable.`; // 23 words
    expect(only(ok, "core.triad.001")).toEqual(["fast, simple, and reliable"]);
  });

  it("a rejected unit does not hide matches in the next unit", () => {
    expect(only("It is fast, simple, and reliable on 3 runners. It is lean, quick, and cheap.", "core.triad.001")).toEqual(["lean, quick, and cheap"]);
  });
});

describe("units and masks", () => {
  it("drops a match that crosses units", () => {
    expect(only("# Great\nquestion about it\n", "core.filler.001")).toEqual([]);
    expect(only("- one\n- let me know if you\n- have any questions\n", "core.filler.002")).toEqual([]);
  });

  it("is not fooled by a heading: a heading is a unit and matches inside it", () => {
    expect(only("## It is robust\n\nText here.", "core.vocab.003")).toEqual(["robust"]);
  });

  it("drops matches that intersect an inline code, URL, path, email or comment mask", () => {
    expect(only("Use `robust` here.", "core.vocab.003")).toEqual([]);
    expect(only("See https://example.com/robust/page for it.", "core.vocab.003")).toEqual([]);
    expect(only("Edit src/robust/index.ts now.", "core.vocab.003")).toEqual([]);
    expect(only("Mail robust@example.com today.", "core.vocab.003")).toEqual([]);
    expect(only("Text <!-- robust --> text.", "core.vocab.003")).toEqual([]);
    // a phrase partly inside code is dropped too, one outside is kept
    expect(only("Let me know if you have any `questions`.", "core.filler.002")).toEqual([]);
    expect(only("It is `x` and robust.", "core.vocab.003")).toEqual(["robust"]);
  });

  it("never matches in code blocks, tables, blockquotes or attributed quotes", () => {
    const text = [
      "A normal sentence here.",
      "",
      "```",
      "robust seamless pivotal",
      "```",
      "",
      "| a | b |",
      "| - | - |",
      "| robust | seamless |",
      "",
      "> The robust blockquote says pivotal things.",
      "",
      'You said "this is a robust and seamless quoted run of words" so noted.',
      "",
      "    indented robust code",
    ].join("\n");
    expect(hits(text)).toEqual([]);
  });
});

describe("allow_terms (vocab only)", () => {
  const design = profile("local/design-doc");
  it("drops a vocab match whose span is an allowed term", () => {
    expect(only("A comprehensive plan.", "core.vocab.003", { profile: design })).toEqual([]);
    expect(only("A Comprehensive plan.", "core.vocab.003", { profile: design })).toEqual([]);
    expect(only("A comprehensive plan, and a robust one.", "core.vocab.003", { profile: design })).toEqual(["robust"]);
  });

  it("matches after normalisation and ignores whitespace differences", () => {
    const p = profile("local/base", (r) => ({ ...r, allow_terms: ["cutting-edge", "paradigm shift"] }));
    expect(only("It is cutting‑edge tech.", "core.vocab.003", { profile: p })).toEqual([]);
    expect(only("A paradigm\n shift.", "core.vocab.002", { profile: p })).toEqual([]);
  });

  it("does not exempt other categories", () => {
    const p = profile("local/base", (r) => ({ ...r, allow_terms: ["arguably"] }));
    expect(only("Arguably, it is fine.", "core.hedge.003", { profile: p })).toEqual(["Arguably"]);
  });
});

describe("severity, enabled and origin come from the resolved profile", () => {
  const custom = (overrides: string): ReturnType<typeof profile> =>
    resolveProfile(
      "local/custom",
      {
        profiles: {
          ...sources.profiles,
          "local/custom": {
            yaml: `schema: prosegate.profile/1\nid: local/custom\nversion: 1\nname: Custom\nextends: local/base\n${overrides}\n`,
            signed: false,
            origin: "bundled",
          },
        },
        packs: sources.packs,
      },
    );

  it("a disabled rule does not run", () => {
    const p = custom("overrides:\n  rules:\n    core.vocab.003: { enabled: false }");
    const r = run("A robust plan, arguably.", { profile: p });
    expect(r.diagnostics.all_findings.map((f) => f.rule_id)).toEqual(["core.hedge.003"]);
    expect("core.vocab.003" in r.diagnostics.per_rule_ms).toBe(false);
  });

  it("uses the effective severity and reports the profile that set it", () => {
    const p = custom("overrides:\n  categories:\n    vocab: { severity: block }\n    hedge: { severity: info }");
    const r = run("A robust plan, arguably.", { profile: p });
    const vocab = r.result.findings.find((f) => f.rule_id === "core.vocab.003");
    expect(vocab?.severity).toBe("block");
    expect(vocab?.profile_origin).toBe("local/custom");
    expect(r.result.verdict).toBe("revise");
    // info: not in findings, counted in stats
    expect(r.result.findings.find((f) => f.rule_id === "core.hedge.003")).toBeUndefined();
    expect(r.diagnostics.all_findings.find((f) => f.rule_id === "core.hedge.003")?.severity).toBe("info");
    expect(r.result.stats.findings_by_category).toEqual({ vocab: 1, hedge: 1 });
  });

  it("a rule the profile does not pin is ignored", () => {
    const pack = packOf(ruleYaml("core.vocab.001", '{ kind: phrase, phrases: ["foo"] }'));
    const p = profile("local/base", (r) => ({ ...r, packs: [] }));
    expect(run("A foo.", { packs: [pack], profile: p }).diagnostics.all_findings).toEqual([]);
  });

  it("the starter profiles: design-doc lowers hedge.003, email lowers filler.002", () => {
    const r = run("Arguably, it is fine.", { profile: profile("local/design-doc") });
    expect(r.result.findings).toEqual([]);
    expect(r.diagnostics.all_findings[0]?.severity).toBe("info");
    const e = run("Fine. Let me know if you have any questions.", { profile: profile("local/email") });
    expect(e.result.findings).toEqual([]);
    expect(e.result.verdict).toBe("pass");
  });
});

describe("stage order", () => {
  it("non-English text and text with no prose are skipped as no_prose", () => {
    expect(review("```\nconst a = 1;\n```\n").skipped_reason).toBe("no_prose");
    expect(review("").skipped_reason).toBe("no_prose");
    const german =
      "Das ist ein sehr langer deutscher Satz, der nicht auf Englisch geschrieben wurde, und er enthält genug Wörter, damit die Sprache sicher erkannt wird. " +
      "Wir haben auch noch einen zweiten Satz hinzugefügt, damit der Text lang genug ist und nicht mehr als unbekannt gilt, weil er so viele Wörter hat.";
    const r = review(german);
    expect(r.verdict).toBe("skipped");
    expect(r.skipped_reason).toBe("no_prose");
    expect(r.findings).toEqual([]);
  });

  it("text under the token floor is skipped as below_floor and no rule runs", () => {
    const r = run("It is robust, arguably.", { keepFloor: true });
    expect(r.result.verdict).toBe("skipped");
    expect(r.result.skipped_reason).toBe("below_floor");
    expect(r.diagnostics.per_rule_ms).toEqual({});
    expect(r.result.feedback_text).toBe("");
  });

  it("the profile's own floor applies, and 0 bypasses it", () => {
    const p = profile("local/base", (r) => ({ ...r, thresholds: { ...r.thresholds, token_floor_words: 5 } }));
    expect(run("It is robust.", { profile: p, keepFloor: true }).result.skipped_reason).toBe("below_floor");
    expect(run("It is robust today, truly.", { profile: p, keepFloor: true }).result.skipped_reason).toBeUndefined();
  });

  it("enforce: false reports block findings but never asks for a revision", () => {
    const r = review("It's worth noting that it works.", { enforce: false });
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0]?.severity).toBe("block");
    expect(r.verdict).toBe("pass");
  });
});
