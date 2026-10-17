import { describe, expect, it } from "vitest";
import { BUNDLED_PACK_YAML } from "./bundled.js";
import { parseRulePack, parseRulePackYaml } from "./rulepack.js";
import { CORE_FIXTURE_YAML, packYaml } from "./test-util.js";

type Obj = Record<string, unknown>;

function rule(overrides: Obj = {}): Obj {
  return {
    id: "core.hedge.001",
    category: "hedge",
    severity: "block",
    match: { kind: "phrase", phrases: ["it is worth noting"] },
    instruction: { action: "remove", text: "Remove." },
    examples: { hit: ["It is worth noting x."], miss: ["x."] },
    ...overrides,
  };
}

function pack(rules: Obj[] = [rule()], head: Obj = {}): Obj {
  return { schema: "prosegate.rulepack/1", id: "core", version: "0.1.0", findings_schema: 1, rules, ...head };
}

function errorOf(input: unknown) {
  const r = parseRulePack(input);
  if (r.ok) throw new Error("expected the pack to be rejected");
  return r.error;
}

/** Issue paths of a rejected pack; [] when the pack is accepted. */
function paths(input: unknown): string[] {
  const r = parseRulePack(input);
  return r.ok ? [] : r.error.issues.map((i) => i.path);
}

/** A pack of `n` single-regex rules, each with a distinct id. */
function regexRules(n: number, pattern = "x+"): Obj[] {
  return Array.from({ length: n }, (_, i) => {
    const category = (["filler", "hedge", "vocab", "triad", "structure", "repetition"] as const)[i % 6] as string;
    return rule({ id: `core.${category}.${String(Math.floor(i / 6)).padStart(3, "0")}`, category, match: { kind: "regex", pattern } });
  });
}

const regexRule = (pattern: string, extra: Obj = {}) => rule({ match: { kind: "regex", pattern, ...extra } });

describe("rule pack schema: accepts", () => {
  it("the fixture pack and the real core pack", () => {
    const fixture = parseRulePackYaml(CORE_FIXTURE_YAML);
    expect(fixture.ok).toBe(true);
    if (fixture.ok) expect(fixture.value.rules).toHaveLength(12);
    const real = parseRulePackYaml(BUNDLED_PACK_YAML["core@0.1.0"]);
    expect(real.ok).toBe(true);
  });

  it("fills phrase defaults: boundary word, case_insensitive true, position any", () => {
    const r = parseRulePack(pack());
    expect(r.ok).toBe(true);
    if (r.ok) {
      const m = r.value.rules[0]?.match;
      expect(m).toMatchObject({ kind: "phrase", boundary: "word", case_insensitive: true, position: "any" });
    }
  });

  it("every match kind from the 04 table", () => {
    const rules = [
      rule({ id: "core.hedge.001", match: { kind: "phrase", phrases: ["ab"], boundary: "none", case_insensitive: true, position: "closing", max_doc_words: 400, sentence_max_words: 25, sentence_exclude: "\\d" } }),
      rule({ id: "core.hedge.002", match: { kind: "regex", pattern: "\\bx\\b", position: "sentence_start", max_doc_words: 400, sentence_max_words: 25, sentence_exclude: "\\d" } }),
      rule({ id: "core.hedge.003", match: { kind: "any", parts: [{ kind: "phrase", phrases: ["ab"], position: "sentence_start" }, { kind: "regex", pattern: "(?P<span>ab)c", max_doc_words: 10 }] } }),
      rule({ id: "core.hedge.004", match: { kind: "sentence_metric", metric: "word_count", above: 40 } }),
      rule({ id: "core.hedge.005", match: { kind: "sentence_metric", metric: "starts_with", above: 0, pattern: "^however" } }),
      rule({ id: "core.hedge.006", match: { kind: "sentence_metric", metric: "similarity_to_prior", above: 0.7, min_words: 6 } }),
      rule({ id: "core.hedge.007", match: { kind: "document_metric", metric: "bullet_ratio", above: 0.6, min_sentences: 8, min_item_words: 6 } }),
    ];
    expect(parseRulePack(pack(rules)).ok).toBe(true);
  });

  it("all v0 metrics", () => {
    const sentence = ["word_count", "comma_count", "similarity_to_prior"].map((metric, i) =>
      rule({ id: `core.hedge.00${i + 1}`, match: { kind: "sentence_metric", metric, above: 1 } }),
    );
    const doc = ["bullet_ratio", "headers_per_100_words", "sentence_length_cv", "closing_similarity", "bold_per_100_words"].map((metric, i) =>
      rule({ id: `core.hedge.00${i + 4}`, match: { kind: "document_metric", metric, above: 1 } }),
    );
    expect(parseRulePack(pack([...sentence, ...doc])).ok).toBe(true);
  });
});

describe("rule pack schema: rejects", () => {
  it("a bad pack id, version or schema marker", () => {
    expect(paths(pack([rule()], { id: "Core" }))).toContain("id");
    expect(paths(pack([rule()], { id: "my_pack" }))).toContain("id");
    expect(paths(pack([rule()], { version: "1.0" }))).toContain("version");
    expect(paths(pack([rule()], { version: "v1.0.0" }))).toContain("version");
    expect(paths(pack([rule()], { schema: "prosegate.rulepack/2" }))).toContain("schema");
  });

  it("pack ids are [a-z0-9-]{1,31} (ADR-17): 31 characters pass, 32 and 0 do not", () => {
    const id31 = "a".repeat(31);
    const withId = (id: string) => pack([rule({ id: `${id}.hedge.001` })], { id });
    expect(parseRulePack(withId(id31)).ok).toBe(true);
    expect(paths(withId("a".repeat(32)))).toContain("id");
    expect(paths(withId(""))).toContain("id");
  });

  it("an empty rule list", () => {
    expect(paths(pack([]))).toContain("rules");
  });

  it("unsupported findings_schema with its own code, even when the pack has fields this build does not know", () => {
    const e = errorOf({ ...pack(), findings_schema: 2, future_field: true });
    expect(e.code).toBe("unsupported_findings_schema");
    expect(e.message).toMatch(/findings_schema 2/);
    expect(e.message).toMatch(/supports 1/);
    expect(e.ids).toEqual(["core"]);
    expect(errorOf(pack([rule()], { findings_schema: 0 })).code).toBe("unsupported_findings_schema");
  });

  it("a non-integer or missing findings_schema as invalid_pack", () => {
    expect(errorOf(pack([rule()], { findings_schema: "1" })).code).toBe("invalid_pack");
    expect(errorOf(pack([rule()], { findings_schema: 1.5 })).code).toBe("invalid_pack");
    const without = pack();
    delete without.findings_schema;
    expect(errorOf(without).code).toBe("invalid_pack");
  });

  it("carries the document id in ids once the id parsed", () => {
    expect(errorOf(pack([rule({ severity: "error" })])).ids).toEqual(["core"]);
    expect(errorOf(pack([rule({ severity: "error" })], { id: "Bad Id" })).ids).toEqual([]);
  });

  it("a rule id that is malformed, wrong-pack, wrong-category or duplicated", () => {
    expect(paths(pack([rule({ id: "core.hedge.1" })]))).toContain("rules[0].id");
    expect(paths(pack([rule({ id: "core.hedge.0001" })]))).toContain("rules[0].id");
    expect(paths(pack([rule({ id: "core.nonsense.001" })]))).toContain("rules[0].id");
    const other = errorOf(pack([rule({ id: "other.hedge.001" })]));
    expect(other.issues.some((i) => i.path === "rules[0].id" && i.message.includes("pack id 'core.'"))).toBe(true);
    const cat = errorOf(pack([rule({ id: "core.vocab.001" })]));
    expect(cat.issues.some((i) => i.path === "rules[0].id" && i.message.includes("category segment"))).toBe(true);
    const dup = errorOf(pack([rule(), rule()]));
    expect(dup.issues.some((i) => i.path === "rules[1].id" && i.message.includes("duplicate"))).toBe(true);
  });

  it("a reviewer category on a deterministic rule", () => {
    expect(paths(pack([rule({ id: "core.register.001", category: "register" })]))).toContain("rules[0].category");
  });

  it("an unknown severity", () => {
    expect(paths(pack([rule({ severity: "error" })]))).toContain("rules[0].severity");
  });

  it("an unknown field at every level", () => {
    const at = (input: unknown, path: string) => {
      const issues = errorOf(input).issues;
      expect(issues).toContainEqual({ path, message: "unknown field" });
    };
    at({ ...pack(), publisher: "x" }, "publisher");
    at(pack([rule({ priority: 1 })]), "rules[0].priority");
    at(pack([rule({ match: { kind: "phrase", phrases: ["ab"], stem: true } })]), "rules[0].match.stem");
    at(pack([rule({ match: { kind: "regex", pattern: "x", multiline: true } })]), "rules[0].match.multiline");
    at(pack([rule({ match: { kind: "regex", pattern: "x", flags: "i" } })]), "rules[0].match.flags");
    at(pack([rule({ match: { kind: "sentence_metric", metric: "word_count", above: 1, min_sentences: 3 } })]), "rules[0].match.min_sentences");
    at(pack([rule({ match: { kind: "document_metric", metric: "bullet_ratio", above: 1, pattern: "x" } })]), "rules[0].match.pattern");
    at(pack([rule({ match: { kind: "any", parts: [{ kind: "phrase", phrases: ["ab"], extra: 1 }] } })]), "rules[0].match.parts[0].extra");
    at(pack([rule({ match: { kind: "any", parts: [{ kind: "phrase", phrases: ["ab"] }], position: "any" } })]), "rules[0].match.position");
    at(pack([rule({ instruction: { action: "remove", text: "x", severity: "block" } })]), "rules[0].instruction.severity");
    at(pack([rule({ examples: { hit: ["a"], miss: ["b"], note: "c" } })]), "rules[0].examples.note");
  });

  it("examples: both hit and miss, each with at least one non-empty string", () => {
    expect(paths(pack([rule({ examples: { hit: ["a"] } })]))).toContain("rules[0].examples.miss");
    expect(paths(pack([rule({ examples: { miss: ["a"] } })]))).toContain("rules[0].examples.hit");
    expect(paths(pack([rule({ examples: { hit: [], miss: ["a"] } })]))).toContain("rules[0].examples.hit");
    expect(paths(pack([rule({ examples: { hit: [""], miss: ["a"] } })]))).toContain("rules[0].examples.hit[0]");
    expect(paths(pack([rule({ examples: undefined })]))).toContain("rules[0].examples");
  });
});

describe("phrase match (ADR-15)", () => {
  const phrase = (m: Obj) => paths(pack([rule({ match: { kind: "phrase", phrases: ["ab"], ...m } })]));

  it("case_insensitive must be true: false is rejected (ADR-15; v0 matches case-insensitively only)", () => {
    expect(phrase({ case_insensitive: false })).toContain("rules[0].match.case_insensitive");
    expect(phrase({ case_insensitive: "yes" })).toContain("rules[0].match.case_insensitive");
    expect(phrase({ case_insensitive: true })).toEqual([]);
  });

  it("phrases: non-empty list, each 2-80 characters", () => {
    expect(phrase({ phrases: [] })).toContain("rules[0].match.phrases");
    expect(phrase({ phrases: [""] })).toContain("rules[0].match.phrases[0]");
    expect(phrase({ phrases: ["a"] })).toContain("rules[0].match.phrases[0]");
    expect(parseRulePack(pack([rule({ match: { kind: "phrase", phrases: ["ab"] } })])).ok).toBe(true);
    expect(parseRulePack(pack([rule({ match: { kind: "phrase", phrases: ["x".repeat(80)] } })])).ok).toBe(true);
    expect(phrase({ phrases: ["x".repeat(81)] })).toContain("rules[0].match.phrases[0]");
    expect(parseRulePack(pack([rule({ match: { kind: "phrase", phrases: Array.from({ length: 40 }, (_, i) => `ph${i}`) } })])).ok).toBe(true);
    expect(phrase({ phrases: Array.from({ length: 41 }, (_, i) => `ph${i}`) })).toContain("rules[0].match.phrases");
  });

  it("a phrase must contain a letter: whitespace-only and punctuation-only are rejected", () => {
    expect(phrase({ phrases: ["  "] })).toContain("rules[0].match.phrases[0]");
    expect(phrase({ phrases: ["\t\t"] })).toContain("rules[0].match.phrases[0]");
    expect(phrase({ phrases: ["!!"] })).toContain("rules[0].match.phrases[0]");
    expect(phrase({ phrases: ["12"] })).toContain("rules[0].match.phrases[0]");
    expect(phrase({ phrases: ["overall,"] })).toEqual([]);
    expect(phrase({ phrases: ["certainly!"] })).toEqual([]);
  });

  it("a phrase must be lowercase", () => {
    expect(phrase({ phrases: ["Overall"] })).toContain("rules[0].match.phrases[0]");
    expect(phrase({ phrases: ["in Summary"] })).toContain("rules[0].match.phrases[0]");
  });

  it("a phrase must not contain a character the segmenter folds", () => {
    for (const bad of ["don\u{2019}t", "\u{2018}no\u{2019}", "say \u{201c}hi\u{201d}", "a\u{a0}b", "a\u{2007}b", "a\u{202f}b", "a\u{3000}b", "game\u{2010}changer", "game\u{2011}changer"]) {
      expect(phrase({ phrases: [bad] }), JSON.stringify(bad)).toContain("rules[0].match.phrases[0]");
    }
    expect(phrase({ phrases: ["don't", "game-changer"] })).toEqual([]);
  });

  it("boundary, position and filters", () => {
    expect(phrase({ boundary: "sentence" })).toContain("rules[0].match.boundary");
    expect(phrase({ position: "middle" })).toContain("rules[0].match.position");
    expect(phrase({ max_doc_words: 0 })).toContain("rules[0].match.max_doc_words");
    expect(phrase({ sentence_max_words: 0 })).toContain("rules[0].match.sentence_max_words");
    expect(phrase({ sentence_max_words: 2.5 })).toContain("rules[0].match.sentence_max_words");
    expect(phrase({ sentence_exclude: "" })).toContain("rules[0].match.sentence_exclude");
    expect(phrase({ sentence_exclude: "\\d", sentence_max_words: 25 })).toEqual([]);
  });
});

describe("regex match (ADR-15)", () => {
  const regex = (pattern: string, extra: Obj = {}) => paths(pack([regexRule(pattern, extra)]));

  it("pattern: 1-500 characters", () => {
    expect(parseRulePack(pack([regexRule("x".repeat(500))])).ok).toBe(true);
    expect(regex("x".repeat(501))).toContain("rules[0].match.pattern");
    expect(regex("")).toContain("rules[0].match.pattern");
  });

  it("flags are gone: a regex is always case-insensitive", () => {
    expect(regex("x", { flags: "i" })).toContain("rules[0].match.flags");
    expect(regex("x", { flags: "" })).toContain("rules[0].match.flags");
  });

  it("takes position, max_doc_words, sentence_max_words and sentence_exclude", () => {
    expect(regex("x", { position: "closing", max_doc_words: 5, sentence_max_words: 9, sentence_exclude: "\\d" })).toEqual([]);
    expect(regex("x", { position: "end" })).toContain("rules[0].match.position");
    expect(regex("x", { sentence_exclude: "\\|" })).toContain("rules[0].match.sentence_exclude");
  });

  it("patterns must be lowercase outside escapes", () => {
    expect(regex("Foo")).toContain("rules[0].match.pattern");
    expect(regex("\\bfoO\\b")).toContain("rules[0].match.pattern");
    expect(regex("a[A-Z]")).toContain("rules[0].match.pattern");
    // uppercase is fine inside escapes and named-group syntax
    expect(regex("\\S+\\D\\W\\B\\p{Lu}\\P{L}(?P<span>x)\\x{1F}")).toEqual([]);
  });

  it("patterns must not contain characters the segmenter folds", () => {
    for (const bad of ["it\u{2019}s", "a\u{a0}b", "a\u{2010}b", "\u{201c}hi\u{201d}"]) {
      expect(regex(bad), JSON.stringify(bad)).toContain("rules[0].match.pattern");
    }
  });

  it("rejects the markdown escapes \\| and \\\\b (they compile but never match)", () => {
    expect(regex("a\\|b")).toContain("rules[0].match.pattern");
    expect(regex("\\\\bword\\\\b")).toContain("rules[0].match.pattern");
    expect(regex("a|b")).toEqual([]);
    expect(regex("\\bword\\b")).toEqual([]);
  });

  it("rejects lookaround, syntactically", () => {
    for (const bad of ["a(?=b)", "a(?!b)", "(?<=a)b", "(?<!a)b", "x(?:y(?=z))"]) {
      expect(regex(bad), bad).toContain("rules[0].match.pattern");
    }
    expect(regex("a(?:b)")).toEqual([]);
    // lookalikes that are not lookaround
    expect(regex("[(?=]")).toEqual([]);
    expect(regex("\\(?=")).toEqual([]);
  });

  it("rejects backreferences \\1-\\9 but not an escaped backslash followed by a digit", () => {
    for (const n of ["1", "2", "3", "4", "5", "6", "7", "8", "9"]) {
      expect(regex(`(a)\\${n}`), n).toContain("rules[0].match.pattern");
    }
    expect(regex("\\\\1")).toEqual([]);
  });

  it("(?P<span>) at most once per pattern", () => {
    expect(regex("(?P<span>a) (?P<span>b)")).toContain("rules[0].match.pattern");
    expect(regex("(?P<span>a) b")).toEqual([]);
    expect(regex("(?P<first>a) (?P<second>b)")).toEqual([]);
  });

  it("rejects nested counted repetition whose product exceeds 1000, and any single count over 1000", () => {
    expect(regex("(?:a{40}){40}")).toContain("rules[0].match.pattern");
    expect(regex("(?:a{2,40}){2,30}")).toContain("rules[0].match.pattern");
    expect(regex("(?:(?:a{10}){10}){11}")).toContain("rules[0].match.pattern");
    expect(regex("(?:a{1,}){1000}")).toContain("rules[0].match.pattern");
    expect(regex("a{1001}")).toContain("rules[0].match.pattern");
    expect(regex("a{1,1001}")).toContain("rules[0].match.pattern");
    expect(regex("(?:a{10}){100}")).toEqual([]); // exactly 1000
    expect(regex("(?:a{10}){101}")).toContain("rules[0].match.pattern");
    expect(regex("a{1000}")).toEqual([]);
    expect(regex("a{40}b{40}")).toEqual([]); // sequential, not nested
    expect(regex("x{foo}")).toEqual([]); // not a repetition
    expect(regex(".{3,80}?")).toEqual([]);
  });
});

describe("any match (ADR-15)", () => {
  const any = (parts: unknown) => paths(pack([rule({ match: { kind: "any", parts } })]));

  it("holds phrase and regex parts, each with its own filters", () => {
    expect(any([{ kind: "phrase", phrases: ["ab"], position: "sentence_start" }, { kind: "regex", pattern: "x+", max_doc_words: 20 }])).toEqual([]);
  });

  it("allows no nesting", () => {
    expect(any([{ kind: "any", parts: [{ kind: "phrase", phrases: ["ab"] }] }])).toContain("rules[0].match.parts[0].kind");
    expect(any([{ kind: "sentence_metric", metric: "word_count", above: 1 }])).toContain("rules[0].match.parts[0].kind");
  });

  it("needs 1-8 parts", () => {
    expect(any([])).toContain("rules[0].match.parts");
    expect(any(Array.from({ length: 8 }, () => ({ kind: "phrase", phrases: ["ab"] })))).toEqual([]);
    expect(any(Array.from({ length: 9 }, () => ({ kind: "phrase", phrases: ["ab"] })))).toContain("rules[0].match.parts");
  });

  it("applies the phrase and pattern lints to every part", () => {
    expect(any([{ kind: "phrase", phrases: ["Ab"] }])).toContain("rules[0].match.parts[0].phrases[0]");
    expect(any([{ kind: "phrase", phrases: ["ab"] }, { kind: "regex", pattern: "a(?=b)" }])).toContain("rules[0].match.parts[1].pattern");
  });

  it("case_insensitive: false is rejected inside a part too", () => {
    expect(any([{ kind: "phrase", phrases: ["ab"], case_insensitive: false }])).toContain("rules[0].match.parts[0].case_insensitive");
  });
});

describe("metrics (04, ADR-15)", () => {
  const sentence = (m: Obj) => paths(pack([rule({ match: { kind: "sentence_metric", ...m } })]));
  const doc = (m: Obj) => paths(pack([rule({ match: { kind: "document_metric", metric: "bullet_ratio", ...m } })]));

  it("sentence_metric: exactly one of above/below, pattern iff starts_with", () => {
    const messages = (x: Obj) => errorOfMatch("sentence_metric", x);
    expect(messages({ metric: "word_count" })).toContain("exactly one of above or below is required");
    expect(messages({ metric: "word_count", above: 1, below: 2 })).toContain("exactly one of above or below is required");
    expect(sentence({ metric: "starts_with", above: 0 })).toContain("rules[0].match.pattern");
    expect(sentence({ metric: "word_count", above: 1, pattern: "x" })).toContain("rules[0].match.pattern");
    expect(sentence({ metric: "word_count", above: -1 })).toContain("rules[0].match.above");
    expect(sentence({ metric: "word_count", above: Number.POSITIVE_INFINITY })).toContain("rules[0].match.above");
    expect(sentence({ metric: "starts_with", above: 0, pattern: "a(?=b)" })).toContain("rules[0].match.pattern");
    expect(sentence({ metric: "starts_with", above: 0, pattern: "Upper" })).toContain("rules[0].match.pattern");
  });

  it("similarity_to_prior: min_words allowed, and rejected on other metrics", () => {
    expect(sentence({ metric: "similarity_to_prior", above: 0.7, min_words: 6 })).toEqual([]);
    expect(sentence({ metric: "similarity_to_prior", above: 0.7, min_words: 0 })).toContain("rules[0].match.min_words");
    expect(sentence({ metric: "word_count", above: 7, min_words: 6 })).toContain("rules[0].match.min_words");
    expect(sentence({ metric: "comma_count", above: 7, min_words: 6 })).toContain("rules[0].match.min_words");
  });

  it("bullet_ratio: min_item_words allowed, and rejected on other metrics", () => {
    expect(doc({ above: 0.6, min_item_words: 6 })).toEqual([]);
    expect(doc({ above: 0.6, min_item_words: 0 })).toContain("rules[0].match.min_item_words");
    for (const metric of ["headers_per_100_words", "sentence_length_cv", "closing_similarity", "bold_per_100_words"]) {
      expect(doc({ metric, above: 0.5, min_item_words: 6 }), metric).toContain("rules[0].match.min_item_words");
    }
  });

  it("bounded metrics: a cosine, a ratio and closing_similarity must be at most 1", () => {
    expect(sentence({ metric: "similarity_to_prior", above: 1 })).toEqual([]);
    expect(sentence({ metric: "similarity_to_prior", above: 1.01 })).toContain("rules[0].match.above");
    expect(sentence({ metric: "similarity_to_prior", below: 2 })).toContain("rules[0].match.below");
    expect(doc({ above: 1 })).toEqual([]);
    expect(doc({ above: 1.01 })).toContain("rules[0].match.above");
    expect(doc({ metric: "closing_similarity", above: 1.5 })).toContain("rules[0].match.above");
    expect(doc({ metric: "closing_similarity", below: 1 })).toEqual([]);
    // unbounded metrics may exceed 1
    expect(doc({ metric: "headers_per_100_words", above: 3 })).toEqual([]);
    expect(doc({ metric: "bold_per_100_words", above: 3 })).toEqual([]);
    expect(doc({ metric: "sentence_length_cv", below: 2 })).toEqual([]);
    expect(sentence({ metric: "word_count", above: 50 })).toEqual([]);
  });

  it("document_metric: exactly one of above/below, positive integer min_sentences", () => {
    expect(doc({})).toContain("rules[0].match");
    expect(doc({ above: 0.5, below: 0.2 })).toContain("rules[0].match");
    expect(doc({ above: 0.5, min_sentences: 0 })).toContain("rules[0].match.min_sentences");
    expect(doc({ above: 0.5, min_sentences: 2.5 })).toContain("rules[0].match.min_sentences");
  });

  it("a metric the engine does not implement (04: rejected at load)", () => {
    expect(sentence({ metric: "syllable_count", above: 1 })).toContain("rules[0].match.metric");
    expect(paths(pack([rule({ match: { kind: "document_metric", metric: "word_count", above: 1 } })]))).toContain("rules[0].match.metric");
    expect(sentence({ metric: "bullet_ratio", above: 1 })).toContain("rules[0].match.metric");
  });

  it("an unknown match kind, or none", () => {
    const unknown = errorOf(pack([rule({ match: { kind: "semantic", phrases: ["xx"] } })]));
    expect(unknown.issues).toEqual([
      { path: "rules[0].match.kind", message: "Invalid discriminator value. Expected 'phrase' | 'regex' | 'any' | 'sentence_metric' | 'document_metric'" },
    ]);
    expect(paths(pack([rule({ match: { phrases: ["xx"] } })]))).toContain("rules[0].match.kind");
  });

  function errorOfMatch(kind: string, x: Obj): string[] {
    return errorOf(pack([rule({ match: { kind, ...x } })])).issues.map((i) => i.message);
  }
});

describe("pack work caps (ADR-19): at the limit passes, one over fails", () => {
  it("100 regex rules pass; 101 fail", () => {
    expect(parseRulePack(pack(regexRules(100))).ok).toBe(true);
    const e = errorOf(pack(regexRules(101)));
    expect(e.issues.map((i) => i.path)).toContain("rules");
    expect(e.issues[0]?.message).toMatch(/more than 100 compiled patterns/);
  });

  it("regex parts of an any match count toward the 100", () => {
    const anyRule = (i: number, parts: number) =>
      rule({
        id: `core.hedge.${String(i).padStart(3, "0")}`,
        match: { kind: "any", parts: Array.from({ length: parts }, () => ({ kind: "regex", pattern: "x+" })) },
      });
    const ok = Array.from({ length: 12 }, (_, i) => anyRule(i + 1, 8)).concat([anyRule(13, 4)]); // 12*8 + 4 = 100
    expect(parseRulePack(pack(ok)).ok).toBe(true);
    expect(paths(pack([...ok, rule({ id: "core.hedge.014", match: { kind: "regex", pattern: "x+" } })]))).toContain("rules");
  });

  it("plain phrase rules and document metrics do not count toward the cap", () => {
    const phrases = Array.from({ length: 50 }, (_, i) => rule({ id: `core.hedge.${String(i).padStart(3, "0")}` }));
    const regexes = regexRules(100).map((r, i) => ({ ...r, id: `core.vocab.${String(i).padStart(3, "0")}`, category: "vocab" }));
    expect(parseRulePack(pack([...phrases, ...regexes])).ok).toBe(true); // 150 rules, 100 compiled patterns
  });

  describe("sentence_exclude and starts_with patterns are compiled too, so they count", () => {
    const phraseWithExclude = (i: number, extra: Obj = {}) =>
      rule({ id: `core.hedge.${String(i).padStart(3, "0")}`, match: { kind: "phrase", phrases: ["xx"], sentence_exclude: "\\d", ...extra } });
    const withExcludes = (n: number) => Array.from({ length: n }, (_, i) => phraseWithExclude(i));

    it("100 phrase rules each with a sentence_exclude pass; 101 fail", () => {
      expect(parseRulePack(pack(withExcludes(100))).ok).toBe(true);
      expect(paths(pack(withExcludes(101)))).toContain("rules");
      expect(errorOf(pack(withExcludes(101))).issues[0]?.message).toMatch(/more than 100 compiled patterns/);
    });

    it("every rule of a full pack carrying a sentence_exclude is rejected", () => {
      // 150 rules is the most a pack may hold; 150 compiled sentence_exclude patterns is 50 too many
      const e = errorOf(pack(withExcludes(150)));
      expect(e.issues[0]?.message).toMatch(/more than 100 compiled patterns/);
    });

    it("a regex with a sentence_exclude counts as two", () => {
      const rules = Array.from({ length: 50 }, () => regexRule("x+", { sentence_exclude: "\\d" })).map((r, i) => ({ ...r, id: `core.vocab.${String(i).padStart(3, "0")}`, category: "vocab" }));
      expect(parseRulePack(pack(rules)).ok).toBe(true);
      expect(paths(pack([...rules, { ...rules[0], id: "core.vocab.900" }]))).toContain("rules");
    });

    it("sentence_exclude on a part of an any match counts", () => {
      const anyRule = rule({ match: { kind: "any", parts: Array.from({ length: 8 }, () => ({ kind: "phrase", phrases: ["xx"], sentence_exclude: "\\d" })) } });
      const others = withExcludes(93).map((r, i) => ({ ...r, id: `core.vocab.${String(i).padStart(3, "0")}`, category: "vocab" }));
      expect(parseRulePack(pack([anyRule, ...others])).ok).toBe(false); // 8 + 93 = 101
      expect(parseRulePack(pack([anyRule, ...others.slice(1)])).ok).toBe(true); // 8 + 92 = 100
    });

    it("a starts_with pattern counts", () => {
      const starts = (i: number) =>
        rule({ id: `core.vocab.${String(i).padStart(3, "0")}`, category: "vocab", match: { kind: "sentence_metric", metric: "starts_with", above: 0, pattern: "^however" } });
      expect(parseRulePack(pack(Array.from({ length: 100 }, (_, i) => starts(i)))).ok).toBe(true);
      expect(paths(pack(Array.from({ length: 101 }, (_, i) => starts(i))))).toContain("rules");
    });
  });

  it("pattern bytes: 32768 pass; 32769 fail (counted in UTF-8 bytes, across regex, starts_with and sentence_exclude)", () => {
    // 100 patterns of 327 bytes + one of 68 = 32768
    const rules = regexRules(65, "x".repeat(500)); // 65 * 500 = 32500
    const filler = regexRule("y".repeat(268));
    const atLimit = [...rules, { ...filler, id: "core.vocab.900", category: "vocab" }];
    expect(parseRulePack(pack(atLimit)).ok).toBe(true);
    const over = [...rules, { ...regexRule("y".repeat(269)), id: "core.vocab.900", category: "vocab" }];
    expect(errorOf(pack(over)).issues).toContainEqual({ path: "rules", message: "patterns total more than 32768 bytes" });
    // multi-byte: 2-byte characters count twice
    const wide = [...rules, { ...regexRule("\u{e9}".repeat(135)), id: "core.vocab.900", category: "vocab" }]; // 270 bytes
    expect(paths(pack(wide))).toContain("rules");
    // sentence_exclude and starts_with patterns count too
    const withExclude = [...rules, { ...regexRule("y", { sentence_exclude: "z".repeat(269) }), id: "core.vocab.900", category: "vocab" }];
    expect(paths(pack(withExclude))).toContain("rules");
    const starts = [...rules, rule({ id: "core.vocab.900", category: "vocab", match: { kind: "sentence_metric", metric: "starts_with", above: 0, pattern: "z".repeat(269) } })];
    expect(paths(pack(starts))).toContain("rules");
  });

  it("150 rules pass; 151 fail", () => {
    const phrases = (n: number) =>
      Array.from({ length: n }, (_, i) => rule({ id: `core.${(["filler", "hedge", "vocab", "triad", "structure", "repetition"] as const)[i % 6]}.${String(Math.floor(i / 6)).padStart(3, "0")}`, category: (["filler", "hedge", "vocab", "triad", "structure", "repetition"] as const)[i % 6] }));
    expect(parseRulePack(pack(phrases(150))).ok).toBe(true);
    expect(paths(pack(phrases(151)))).toContain("rules");
  });

  it("examples: 10 per list pass; 11 fail; 4000 characters pass; 4001 fail", () => {
    const examples = (n: number, len = 3) => ({ hit: Array.from({ length: n }, () => "x".repeat(len)), miss: ["y"] });
    expect(parseRulePack(pack([rule({ examples: examples(10) })])).ok).toBe(true);
    expect(paths(pack([rule({ examples: examples(11) })]))).toContain("rules[0].examples.hit");
    expect(parseRulePack(pack([rule({ examples: examples(1, 4000) })])).ok).toBe(true);
    expect(paths(pack([rule({ examples: examples(1, 4001) })]))).toContain("rules[0].examples.hit[0]");
  });

  it("instruction text: 200 characters pass; 201 fail", () => {
    expect(parseRulePack(pack([rule({ instruction: { action: "remove", text: "a".repeat(200) } })])).ok).toBe(true);
    expect(paths(pack([rule({ instruction: { action: "remove", text: "a".repeat(201) } })]))).toContain("rules[0].instruction.text");
  });
});

describe("__proto__ and other hostile keys (zod's records drop an own __proto__ silently)", () => {
  it("rejects an own __proto__ key anywhere in a JSON-parsed pack", () => {
    const base = JSON.stringify(pack());
    const polluted = [
      base.replace("{", '{"__proto__":{"x":1},'),
      JSON.stringify(pack([rule({ match: JSON.parse('{"kind":"phrase","phrases":["ab"],"__proto__":{"a":1}}') as Obj })])),
      JSON.stringify(pack([rule({ instruction: JSON.parse('{"action":"remove","text":"x","__proto__":{}}') as Obj })])),
    ];
    for (const text of polluted) {
      const input: unknown = JSON.parse(text);
      const r = parseRulePack(input);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.issues.some((i) => i.message === "reserved key")).toBe(true);
    }
  });
});

describe("NFC normalisation", () => {
  it("NFC and NFD spellings of a field parse to the same value", () => {
    const nfd = "re\u{301}sume\u{301}";
    const nfc = "r\u{e9}sum\u{e9}";
    const a = parseRulePack(pack([rule({ match: { kind: "phrase", phrases: [nfd] } })]));
    const b = parseRulePack(pack([rule({ match: { kind: "phrase", phrases: [nfc] } })]));
    expect(a.ok && b.ok).toBe(true);
    if (a.ok && b.ok) expect(a.value).toEqual(b.value);
  });
});

describe("rule pack YAML", () => {
  it("rejects anchors, aliases, tags, directives, duplicate keys and multiple documents", () => {
    const base = packYaml();
    const cases: Array<[string, string, RegExp]> = [
      ["anchor", base.replace("id: core\n", "id: &p core\n"), /anchors are not allowed/],
      ["alias", base.replace("severity: block", "severity: &s block").replace("action: remove", "action: *s"), /(anchors|aliases) are not allowed/],
      ["tag", base.replace("version: 0.1.0", "version: !!str 0.1.0"), /tags are not allowed/],
      ["custom tag", base.replace("id: core\n", "id: !custom core\n"), /tags are not allowed/],
      ["duplicate key", base.replace("id: core\n", "id: core\nid: other\n"), /duplicate map key/],
      ["two documents", `${base}---\nschema: prosegate.rulepack/1\n`, /MULTIPLE_DOCS/],
      ["a %YAML directive", `%YAML 1.1\n---\n${base}`, /directives/],
      ["a %TAG directive", `%TAG ! tag:example.com,2000:\n---\n${base}`, /directives/],
      ["an inline merge key", base.replace("severity: block", "<<: {severity: warn}"), /./],
    ];
    for (const [label, text, message] of cases) {
      const r = parseRulePackYaml(text);
      expect(r.ok, label).toBe(false);
      if (!r.ok) {
        expect(r.error.code, label).toBe("invalid_pack");
        expect(r.error.message, label).toMatch(message);
      }
    }
  });

  it("rejects a scalar or list at the top level, and syntax errors, without echoing the document", () => {
    for (const text of ["just a string", "- a\n- b\n", "", "rules: [unclosed\n"]) {
      expect(parseRulePackYaml(text).ok, text).toBe(false);
    }
    const secret = "SENTINEL-must-not-be-echoed-0123456789";
    const r = parseRulePackYaml(`id: ${secret}\n  bad: [\n`);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(JSON.stringify(r.error.issues)).not.toContain(secret);
  });

  it("does not echo a rejected value in an issue message", () => {
    const secret = "TOPSECRET-value-9f8e7d";
    const r = parseRulePackYaml(packYaml().replace("severity: block", `severity: ${secret}`));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.message).not.toContain(secret);
      expect(r.error.issues.map((i) => i.path)).toContain("rules[0].severity");
    }
  });

  it("enforces the 256 KB size limit in bytes, before parsing", () => {
    const limit = 256 * 1024;
    const padded = (bytes: number) => {
      const text = packYaml();
      return text + "#".repeat(bytes - text.length - 1) + "\n"; // packYaml() is ASCII: one byte per character
    };
    expect(parseRulePackYaml(padded(limit)).ok).toBe(true);
    const over = parseRulePackYaml(padded(limit + 1));
    expect(over.ok).toBe(false);
    if (!over.ok) {
      expect(over.error.code).toBe("invalid_pack");
      expect(over.error.message).toMatch(/larger than the 262144-byte limit/);
    }
    // three bytes per character: under the limit in characters, over it in bytes
    const wide = `${packYaml()}#${"\u{20ac}".repeat(90_000)}\n`;
    expect(wide.length).toBeLessThan(limit);
    expect(parseRulePackYaml(wide).ok).toBe(false);
  });

  it("a non-string input is rejected, not thrown on", () => {
    for (const bad of [undefined, null, 42, {}, ["x"]]) expect(parseRulePackYaml(bad).ok).toBe(false);
  });
});
