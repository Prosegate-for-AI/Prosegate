import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { analyse } from "@prosegate/segmenter";
import { findingId } from "@prosegate/schema";
import {
  clearPackCache,
  compilePack,
  MAX_FINDINGS_PER_RULE,
  MAX_FINDINGS_PER_TURN,
  MAX_SIMILARITY_CANDIDATES,
  PackVersionError,
  reviewRulesDetailed,
  stagesFor,
  STOP_WORDS,
  STOP_WORDS_VERSION,
  WINDOW_CHARS,
  WINDOW_OVERLAP,
} from "../src/index.js";
import { CORE, CORE_COMPILED, hits, noFloor, packOf, profile, request, review, ruleYaml, run } from "./helpers.js";

const only = (text: string, ruleId: string, o: Parameters<typeof hits>[1] = {}): string[] =>
  hits(text, o)
    .filter(([id]) => id === ruleId)
    .map(([, t]) => t);

describe("alternatives survive the stripped \\b (adversarial S1)", () => {
  it("underscores followed by an (not a) fires vocab.001", () => {
    expect(only("This underscores an important point.", "core.vocab.001")).toEqual(["underscores"]);
    expect(only("This underscores a point. It underscored the risk.", "core.vocab.001")).toEqual(["underscores", "underscored"]);
    expect(only("Underscores and underscored things.", "core.vocab.001")).toEqual([]);
  });

  it("a lazy quantifier extends past a rejected trailing boundary (', but' inside 'butter')", () => {
    expect(only("It is not just about speed, butter notwithstanding, but about trust.", "core.triad.002")).toEqual([
      "not just about speed, butter notwithstanding, but",
    ]);
    expect(only("It is not just about speed, butter is nice.", "core.triad.002")).toEqual([]);
  });

  it("the Unicode check still applies after the retry", () => {
    expect(only("This underscores ané point.", "core.vocab.001")).toEqual([]);
  });
});

describe("line wraps and hyphens (adversarial S2/S4, ADR-24)", () => {
  it.each([
    ["It's worth\nnoting that the index is unique.", "core.hedge.001", "It's worth\nnoting that"],
    ["It is important\nto note that the index is unique.", "core.hedge.001", "It is important\nto note that"],
    ["This may or\nmay not work.", "core.hedge.004", "may or\nmay not"],
    ["This could\npotentially break.", "core.hedge.004", "could\npotentially"],
    ["It is fast, reliable and\nscalable.", "core.triad.001", "fast, reliable and\nscalable"],
    ["It’s worth\r\nnoting that the index is unique.", "core.hedge.001", "It’s worth\r\nnoting that"],
    ["It's\tworth noting that the index is unique.", "core.hedge.001", "It's\tworth noting that"],
    ["Fine.\nLet me know if you\nhave any questions.", "core.filler.002", "Let me know if you\nhave any questions"],
  ])("%j matches %s across the break", (text, rule, span) => {
    expect(only(text, rule)).toEqual([span]);
  });

  it("a hyphen between letters is word-internal: the triad spans the whole hyphenated word", () => {
    expect(only("It is well-tested, documented, and fast.", "core.triad.001")).toEqual(["well-tested, documented, and fast"]);
  });

  it("a phrase does not match inside a hyphenated word, but does beside a spaced dash", () => {
    expect(only("A non-robust and anti-seamless thing.", "core.vocab.003")).toEqual([]);
    expect(only("A robust-ish thing.", "core.vocab.003")).toEqual([]);
    expect(only("It is robust - and fast.", "core.vocab.003")).toEqual(["robust"]);
    expect(only("It is robust—and fast.", "core.vocab.003")).toEqual(["robust"]); // an em dash is not a hyphen
    expect(only("A cutting-edge idea.", "core.vocab.003")).toEqual(["cutting-edge"]);
  });
});

describe("recall variants of ADR-24", () => {
  it.each([
    ["That's a great question. Here is the answer.", "core.filler.001"],
    ["Good question! Here is the answer.", "core.filler.001"],
    ["Certainly. Here is the answer.", "core.filler.001"],
    ["Absolutely. Here is the answer.", "core.filler.001"],
    ["Done. Let me know if you have any other questions.", "core.filler.002"],
    ["Done. Let me know if you'd like the long version.", "core.filler.002"],
    ["It's also worth noting that the index is unique.", "core.hedge.001"],
    ["Please note that the index is unique.", "core.hedge.001"],
    ["We'll leverage the cache.", "core.vocab.001"],
    ["You'll leverage the cache.", "core.vocab.001"],
    ["They'll leverage the cache.", "core.vocab.001"],
    ["Then leverage the cache.", "core.vocab.001"],
    ["The digital security landscape is wide.", "core.vocab.002"],
    ["A wide array of options exists.", "core.vocab.005"],
    ["Numerous options exist.", "core.vocab.005"],
    ["It is not just about speed; it's about trust.", "core.triad.002"],
    ["It is not just about speed — it is about trust.", "core.triad.002"],
  ])("%j fires %s", (text, rule) => {
    expect(only(text, rule).length).toBeGreaterThan(0);
  });

  it("the filler.001 variants are sentence-initial only", () => {
    expect(only("The answer is good question marks.", "core.filler.001")).toEqual([]);
    expect(only("He said certainly. Then left.", "core.filler.001")).toEqual([]);
  });
});

describe("allow_terms inside a span (conformance #3)", () => {
  const allow = (...terms: string[]) => profile("local/base", (r) => ({ ...r, allow_terms: terms }));
  it("a term that equals the whole span (less a leading determiner) or the rule's key word exempts it (ADR-26)", () => {
    expect(only("The current landscape of tools.", "core.vocab.002", { profile: allow("landscape") })).toEqual([]); // the key word
    expect(only("The current landscape of tools.", "core.vocab.002", { profile: allow("current landscape") })).toEqual([]); // whole span, determiner ignored
    expect(only("The current landscape of tools.", "core.vocab.002", { profile: allow("the current landscape") })).toEqual([]);
    expect(only("A wide range of options.", "core.vocab.005", { profile: allow("wide range of") })).toEqual([]);
    expect(only("This is a paradigm shift.", "core.vocab.002", { profile: allow("paradigm shift") })).toEqual([]);
  });

  it("a word inside the span is not enough: security does not exempt the evolving security landscape, a does not exempt a number of", () => {
    expect(only("The evolving security landscape of tools.", "core.vocab.002", { profile: allow("security") })).toHaveLength(1);
    expect(only("The evolving security landscape of tools.", "core.vocab.002", { profile: allow("evolving") })).toHaveLength(1);
    expect(only("The evolving security landscape of tools.", "core.vocab.002", { profile: allow("landscape") })).toEqual([]);
    expect(only("There are a number of options.", "core.vocab.005", { profile: allow("a") })).toHaveLength(1);
    expect(only("There are a number of options.", "core.vocab.005", { profile: allow("number") })).toHaveLength(1);
    expect(only("The current landscape of tools.", "core.vocab.002", { profile: allow("current") })).toHaveLength(1);
  });

  it("a partial word, a different word or another order does not", () => {
    expect(only("The current landscape of tools.", "core.vocab.002", { profile: allow("land") })).toHaveLength(1);
    expect(only("The current landscape of tools.", "core.vocab.002", { profile: allow("landscaping") })).toHaveLength(1);
    expect(only("The current landscape of tools.", "core.vocab.002", { profile: allow("landscape current") })).toHaveLength(1);
    expect(only("A robustness test.", "core.vocab.003", { profile: allow("robust") })).toEqual([]); // not matched at all
    expect(only("A cutting-edge test.", "core.vocab.003", { profile: allow("cutting") })).toHaveLength(1);
    expect(only("A cutting-edge test.", "core.vocab.003", { profile: allow("cutting-edge") })).toEqual([]);
  });

  it("only vocab rules are exempted", () => {
    expect(only("Arguably, the retry is unnecessary.", "core.hedge.003", { profile: allow("arguably") })).toHaveLength(1);
  });
});

describe("skipped results", () => {
  const p1 = review("It's worth noting that the cache is per tenant. The plan is robust and the rollout is seamless.");
  const prior = p1.findings.map((f) => f.id);

  it("floors apply on pass 1 only (ADR-31): a short pass-2 revision is reviewed, and clears the prior ids it no longer holds", () => {
    const short = run("Short text.", { pass: 2, prior: [...prior, ...prior], keepFloor: true }).result;
    expect(short.skipped_reason).toBeUndefined();
    expect(short.verdict).toBe("pass");
    expect(short.cleared).toEqual(prior);
    const none = review("```\ncode\n```", { pass: 2, prior });
    expect(none.skipped_reason).toBeUndefined();
    expect(none.cleared).toEqual(prior);
    // Pass 1 still skips them.
    expect(review("Short text.", { pass: 1, keepFloor: true }).skipped_reason).toBe("below_floor");
    expect(review("```\ncode\n```", { pass: 1 }).skipped_reason).toBe("no_prose");
  });

  it("a pass-2 revision under the floor that keeps a block finding is still revised (the shipped-silently bug)", () => {
    const text1 =
      "It's worth noting that the cache is per tenant, and each tenant gets its own index in the store. The plan could potentially fail when the index is rebuilt during a deploy window of the service.";
    // Pass 1 runs with the floor bypassed (the text is short); the revisions keep the real 60-word floor, which used to skip them.
    const first = run(text1).result;
    const p = (t: string, over: Parameters<typeof run>[1]) => run(t, { keepFloor: true, ...over });
    expect(first.verdict).toBe("revise");
    const prior1 = first.findings.map((f) => f.id);
    // The revision drops the first hedge but keeps "could potentially"; it is far under the 60-word floor.
    const revised = "The cache is per tenant. The plan could potentially fail when the index is rebuilt.";
    const second = p(revised, { pass: 2, prior: prior1 }).result;
    expect(second.skipped_reason).toBeUndefined();
    expect(second.verdict).toBe("revise");
    expect(second.findings.map((f) => f.rule_id)).toEqual(["core.hedge.004"]);
    expect(second.cleared).toHaveLength(prior1.length - 1);
    const capped = p(revised, { pass: 2, prior: prior1, capCheck: true }).result;
    expect(capped.skipped_reason).toBe("pass_cap");
    expect(capped.findings.map((f) => f.rule_id)).toEqual(["core.hedge.004"]);
  });

  it("capCheck on text that is skipped is still verdict pass with pass_cap (ADR-12)", () => {
    for (const text of ["Short text.", "", "```\ncode\n```"]) {
      const r = review(text, { pass: 2, prior, capCheck: true, keepFloor: text === "Short text." });
      expect(r.verdict, text).toBe("pass");
      expect(r.skipped_reason, text).toBe("pass_cap");
      expect(r.findings, text).toEqual([]);
      expect(r.cleared, text).toEqual(prior);
      expect(r.pass, text).toBe(2);
    }
  });

  it("the stats of a skipped result are real", () => {
    const text = "Short text here.";
    const r = run(text, { keepFloor: true }).result;
    expect(r.verdict).toBe("skipped");
    expect(r.stats).toEqual({
      prose_chars: text.length,
      sentence_count: 1,
      findings_by_category: {},
      rule_packs: [{ id: "core", version: "0.1.0" }],
      reviewer: null,
      rules_latency_ms: 0,
    });
    expect(r.segments).toEqual([{ id: "s1", kind: "prose", start: 0, end: text.length }]);
    expect(r.feedback_text).toBe("");
  });

  it("prose_chars is the sum of the unit lengths, leading markup included", () => {
    const text = "**Note:** the plan is fine here today.";
    const u = analyse(text).units[0] as { start: number; end: number };
    expect(review(text).stats.prose_chars).toBe(u.end - u.start);
    expect(review(text).stats.prose_chars).toBe(text.length);
    const two = "# Title here\n\n- first item is here\n- second item is here";
    expect(review(two).stats.prose_chars).toBe(analyse(two).units.reduce((n, x) => n + x.end - x.start, 0));
  });
});

describe("stages", () => {
  const on = profile("local/base", (r) => ({ ...r, reviewer: { ...r.reviewer, enabled: true, categories: ["register"] }, thresholds: { ...r.thresholds, reviewer_floor_words: 100 } }));
  const words = (n: number): string => `${Array.from({ length: n }, () => "word").join(" ")}.`;

  it("stagesFor: reviewer floor inclusive, and needs enabled and categories", () => {
    expect(stagesFor(100, on)).toEqual(["rules", "reviewer"]);
    expect(stagesFor(99, on)).toEqual(["rules"]);
    expect(stagesFor(500, { ...on, reviewer: { ...on.reviewer, categories: [] } })).toEqual(["rules"]);
    expect(stagesFor(500, { ...on, reviewer: { ...on.reviewer, enabled: false } })).toEqual(["rules"]);
  });

  it("diagnostics.stages follows the text", () => {
    expect(run(words(99), { profile: on }).diagnostics.stages).toEqual(["rules"]);
    expect(run(words(100), { profile: on }).diagnostics.stages).toEqual(["rules", "reviewer"]);
    expect(run(words(100), { profile: { ...on, reviewer: { ...on.reviewer, enabled: false } } }).diagnostics.stages).toEqual(["rules"]);
    expect(run(words(100), { profile: { ...on, reviewer: { ...on.reviewer, categories: [] } } }).diagnostics.stages).toEqual(["rules"]);
  });

  it("a skipped review runs no stage", () => {
    expect(run("Short.", { keepFloor: true }).diagnostics.stages).toEqual([]);
  });
});

describe("the pack version pin (adversarial S8)", () => {
  it("refuses a compiled pack whose version differs from the pinned one", () => {
    const old = compilePack({ ...CORE, version: "0.0.9" });
    expect(() => run("It is robust.", { packs: [old] })).toThrow(PackVersionError);
    try {
      run("It is robust.", { packs: [old] });
    } catch (e) {
      expect((e as PackVersionError).message).toContain("0.1.0");
      expect((e as PackVersionError).packId).toBe("core");
      expect((e as PackVersionError).pinned).toBe("0.1.0");
      expect((e as PackVersionError).given).toBe("0.0.9");
    }
  });

  it("a pack the profile does not pin is ignored, whatever its version", () => {
    const other = compilePack({ ...CORE, id: "other", version: "9.9.9", rules: CORE.rules.map((r) => ({ ...r, id: r.id.replace("core.", "other.") })) });
    expect(run("It is robust.", { packs: [other] }).diagnostics.all_findings).toEqual([]);
  });
});

describe("diagnostics.candidates (the eval harness contract)", () => {
  const text = "Great question! It's worth noting that the plan is robust and truly seamless. Arguably it is fine.";
  const r = run(text);

  it("lists every match of every enabled rule with its effective severity, sorted by start then rule id", () => {
    expect(r.diagnostics.candidates.map((c) => [c.rule_id, c.severity, text.slice(c.start, c.end), c.scope])).toEqual([
      ["core.filler.001", "block", "Great question", "span"],
      ["core.hedge.001", "block", "It's worth noting that", "span"],
      ["core.vocab.003", "warn", "robust", "span"],
      ["core.vocab.004", "warn", "truly", "span"],
      ["core.vocab.003", "warn", "seamless", "span"],
      ["core.hedge.003", "warn", "Arguably", "span"],
    ]);
    for (const c of r.diagnostics.candidates) expect(Object.keys(c).sort()).toEqual(["category", "end", "rule_id", "scope", "severity", "start"]);
  });

  it("includes matches that overlap resolution drops, info severity, and document scope", () => {
    const pack = packOf(
      ruleYaml("core.hedge.001", '{ kind: phrase, phrases: ["it\'s worth noting that"] }', "block"),
      ruleYaml("core.vocab.001", '{ kind: phrase, phrases: ["worth noting"] }', "warn"),
      ruleYaml("core.vocab.002", '{ kind: phrase, phrases: ["plan"] }', "info"),
      ruleYaml("core.structure.003", "{ kind: document_metric, metric: sentence_length_cv, below: 5, min_sentences: 1 }", "warn"),
    );
    const d = run("It's worth noting that the plan works. Fine.", { packs: [pack] });
    expect(d.diagnostics.all_findings.map((f) => f.rule_id)).toEqual(["core.structure.003", "core.hedge.001", "core.vocab.002"]);
    expect(d.diagnostics.candidates.map((c) => [c.rule_id, c.severity, c.scope])).toEqual([
      ["core.hedge.001", "block", "span"],
      ["core.structure.003", "warn", "document"],
      ["core.vocab.001", "warn", "span"],
      ["core.vocab.002", "info", "span"],
    ]);
  });

  it("uses the effective severity under the profile, and omits disabled rules", () => {
    const d = run("It's worth noting that Arguably.", { profile: profile("local/design-doc") });
    expect(d.diagnostics.candidates.find((c) => c.rule_id === "core.hedge.003")?.severity).toBe("info");
    expect(run("A robust plan.", { profile: profile("local/base", (p) => ({ ...p, rules: { "core.vocab.003": { enabled: { value: false, origin: "local/base", layer: 0 } } } })) }).diagnostics.candidates).toEqual([]);
  });

  it("is not demoted on pass 2 and is taken before the caps", () => {
    const many = Array.from({ length: 60 }, () => "A robust plan.").join(" ");
    const p2 = run(many, { pass: 2, prior: [] });
    const robust = p2.diagnostics.candidates.filter((c) => c.rule_id === "core.vocab.003");
    expect(robust).toHaveLength(60);
    expect(robust.every((c) => c.severity === "warn")).toBe(true);
  });
});

describe("compile cache and frozen packs (nit N1)", () => {
  it("a pack mutated in place is recompiled, not served stale", () => {
    clearPackCache();
    const pack = JSON.parse(JSON.stringify(CORE)) as typeof CORE;
    const a = compilePack(pack);
    (pack.rules[11]?.match as { phrases?: string[] }).phrases?.push("zzzword");
    const b = compilePack(pack);
    expect(b).not.toBe(a);
    expect(compilePack(pack)).toBe(b);
    clearPackCache();
  });
});

describe("bounded work (ADR-24)", () => {
  it("constants", () => {
    expect([MAX_FINDINGS_PER_RULE, MAX_FINDINGS_PER_TURN, MAX_SIMILARITY_CANDIDATES]).toEqual([50, 200, 200]);
  });

  it("at most 50 findings per rule; the rest are counted in stats and diagnostics", () => {
    const text = Array.from({ length: 120 }, () => "A robust plan.").join(" ");
    const d = run(text);
    const robust = d.result.findings.filter((f) => f.rule_id === "core.vocab.003");
    expect(robust).toHaveLength(50);
    expect(robust[0]?.span.start).toBe(2); // the first ones are kept
    expect(d.diagnostics.candidates.filter((c) => c.rule_id === "core.vocab.003")).toHaveLength(120);
    expect(d.diagnostics.capped.per_rule["core.vocab.003"]).toBe(70);
    expect(d.result.stats.findings_by_category.vocab).toBe(120);
  });

  it("at most 200 findings per turn, block before warn", () => {
    const blocks = Array.from({ length: 30 }, () => "This could potentially fail.").join(" ");
    const warns = ["A robust plan.", "Truly fine.", "Arguably so.", "Various options.", "It depends."]
      .map((s) => Array.from({ length: 50 }, () => s).join(" "))
      .join(" ");
    const d = run(`${warns} ${blocks}`);
    expect(d.result.findings.length + d.diagnostics.all_findings.filter((f) => f.severity === "info").length).toBe(200);
    expect(d.result.findings.filter((f) => f.severity === "block")).toHaveLength(30);
    expect(d.diagnostics.capped.per_turn).toBe(280 - 200);
    expect(Object.values(d.result.stats.findings_by_category).reduce((a, b) => a + b, 0)).toBe(280);
  });

  it("the caps keep the result valid and its ids stable across passes", () => {
    const text = Array.from({ length: 120 }, () => "A robust plan. It could potentially fail.").join(" ");
    const p1 = run(text);
    const p2 = run(text, { pass: 2, prior: p1.result.findings.map((f) => f.id) });
    expect(p2.result.findings.every((f) => f.severity === "block")).toBe(true);
    expect(p2.result.findings.length).toBe(50);
  });

  it("similarity_to_prior compares a sentence with at most 200 earlier candidates (most recent first)", () => {
    const toks = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot"];
    const T = "Alpha bravo charlie delta echo foxtrot.";
    // every token appears in many later short sentences that are NOT similar to T (2 shared tokens of 4 words)
    const distractors = (n: number): string =>
      Array.from({ length: n }, (_, i) => `${toks[i % 6]} ${toks[(i + 3) % 6]} u${i}a u${i}b.`)
        .map((s) => s.replace(/^./, (c) => c.toUpperCase()))
        .join(" ");
    const rep = "{ kind: sentence_metric, metric: similarity_to_prior, above: 0.7, min_words: 6 }";
    const count = (n: number): number => run(`${T} ${distractors(n)} ${T}`, { packs: [packOf(ruleYaml("core.repetition.001", rep))] }).diagnostics.candidates.length;
    expect(count(60)).toBe(1); // few distractors: the old copy is within reach
    expect(count(900)).toBe(0); // more than 200 candidates in between: the old copy is not compared (ADR-24)
  });

  it("a unit longer than a window is searched in overlapping windows, once per match", () => {
    const filler = (n: number): string => (n <= 0 ? "" : `${"ab ".repeat(Math.ceil(n / 3)).slice(0, n - 1)} `);
    // Place phrases around the window edges (multiples of 1500) and inside the overlap, in one unit.
    const marks: Array<[number, string]> = [
      [WINDOW_CHARS - 6, "robust"], // ends exactly on the window edge
      [WINDOW_CHARS - 3, "robust"], // straddles it
      [WINDOW_CHARS, "robust"], // starts on it
      [WINDOW_CHARS + 100, "pivotal"], // inside the overlap of window 1
      [2 * WINDOW_CHARS - 10, "seamless"],
      [2 * WINDOW_CHARS + WINDOW_OVERLAP - 40, "crucial"], // far inside the next window's overlap
      [3 * WINDOW_CHARS + 7, "truly"],
    ];
    marks.sort((a, b) => a[0] - b[0]);
    let text = "";
    for (const [at, word] of marks) {
      if (at < text.length) {
        // overlapping placement: keep spacing sane by nudging after the previous word
        text += ` ${word} `;
      } else {
        text += `${filler(at - text.length)}${word} `;
      }
    }
    text += ` ${filler(WINDOW_CHARS)}.`;
    expect(analyse(text).units).toHaveLength(1);
    expect(text.length).toBeGreaterThan(3 * WINDOW_CHARS);
    const expected: Array<[string, number]> = [];
    for (const re of [/\brobust\b/g, /\bpivotal\b/g, /\bseamless\b/g, /\bcrucial\b/g, /\btruly\b/g]) {
      for (const m of text.matchAll(re)) expected.push([m[0], m.index as number]);
    }
    expected.sort((a, b) => a[1] - b[1]);
    const got = run(text).diagnostics.candidates.map((c) => [text.slice(c.start, c.end), c.start] as [string, number]);
    expect(got).toEqual(expected);
    expect(got.length).toBeGreaterThanOrEqual(6);
  });

  it("a window cut does not create a match: a phrase inside one window is found, not truncated copies", () => {
    const filler = (n: number): string => (n <= 0 ? "" : `${"ab ".repeat(Math.ceil(n / 3)).slice(0, n - 1)} `);
    const phrase = "there is a wide range of options";
    const text = `${filler(WINDOW_CHARS - 12)}${phrase} ${filler(3000)}.`;
    const c = run(text).diagnostics.candidates.filter((x) => x.rule_id === "core.vocab.005");
    expect(c.map((x) => text.slice(x.start, x.end))).toEqual(["a wide range of"]);
    expect(c[0]?.start).toBe(WINDOW_CHARS - 12 + "there is ".length);
  });

  it("the budget covers the whole review, analysis included", () => {
    let t = 0;
    const r = run("It is robust, arguably. Truly.", { now: () => (t += 120) });
    expect(r.diagnostics.budget_exceeded).toBe(true);
    expect(r.diagnostics.rules_unfinished).toHaveLength(23);
    expect(r.diagnostics.per_rule_ms).toEqual({});
    expect(r.result.findings).toEqual([]);
  });
});

describe("the stop list is pinned (witness X02)", () => {
  it("its content hash is tied to STOP_WORDS_VERSION: change the list, bump the version, update the hash", () => {
    const hash = createHash("sha256").update(STOP_WORDS.join(" ")).digest("hex");
    expect([STOP_WORDS_VERSION, hash]).toEqual([1, "eec4db99e5232f3ba65f1bb935b6dacaf747547963057221d726a49b3edec4af"]);
  });
});

describe("ids and the engine agree with the schema (ADR-23)", () => {
  it("a finding's id is findingId(category, rule_id, normalised span key), and '' for document scope", () => {
    const r = run("It's worth noting that the plan works.\n\n- a\n- b\n- c\n- d\n\nok", {
      packs: [CORE_COMPILED, packOf(ruleYaml("core.structure.003", "{ kind: document_metric, metric: sentence_length_cv, below: 9, min_sentences: 1 }"))],
    });
    for (const f of r.diagnostics.all_findings) {
      expect(f.id).toBe(findingId(f.category, f.rule_id, f.scope === "document" ? "" : f.span.text.toLowerCase().replace(/\s+/g, " ").trim()));
    }
    expect(r.diagnostics.all_findings.some((f) => f.scope === "document")).toBe(true);
  });
});

describe("misc contract details", () => {
  it("the request profile id does not matter; the resolved profile does", () => {
    const d = reviewRulesDetailed({ request: { ...request("It is robust."), profile_id: "local/email" }, resolved: noFloor(profile("local/base")), packs: [CORE_COMPILED], enforce: true });
    expect(d.result.profile.id).toBe("local/base");
  });
});
