import { describe, expect, it } from "vitest";
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

function paths(input: unknown): string[] {
  return errorOf(input).issues.map((i) => i.path);
}

describe("rule pack schema: accepts", () => {
  it("the fixture core pack (a subset of 08)", () => {
    const r = parseRulePackYaml(CORE_FIXTURE_YAML);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.rules).toHaveLength(12);
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
      rule({ id: "core.hedge.001", match: { kind: "phrase", phrases: ["a"], boundary: "none", case_insensitive: false, position: "closing", max_doc_words: 400 } }),
      rule({ id: "core.hedge.002", match: { kind: "regex", pattern: "\\bx\\b", flags: "i" } }),
      rule({ id: "core.hedge.003", match: { kind: "sentence_metric", metric: "word_count", above: 40 } }),
      rule({ id: "core.hedge.004", match: { kind: "sentence_metric", metric: "starts_with", above: 0, pattern: "^However" } }),
      rule({ id: "core.hedge.005", match: { kind: "document_metric", metric: "bullet_ratio", below: 0.1, min_sentences: 8 } }),
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

  it("an empty rule list", () => {
    expect(paths(pack([]))).toContain("rules");
  });

  it("unsupported findings_schema with its own code, even when the pack has fields this build does not know", () => {
    const e = errorOf({ ...pack(), findings_schema: 2, future_field: true });
    expect(e.code).toBe("unsupported_findings_schema");
    expect(e.message).toMatch(/findings_schema 2/);
    expect(e.message).toMatch(/supports 1/);
    expect(errorOf(pack([rule()], { findings_schema: 0 })).code).toBe("unsupported_findings_schema");
  });

  it("a non-integer or missing findings_schema as invalid_pack", () => {
    expect(errorOf(pack([rule()], { findings_schema: "1" })).code).toBe("invalid_pack");
    expect(errorOf(pack([rule()], { findings_schema: 1.5 })).code).toBe("invalid_pack");
    const without = pack();
    delete without.findings_schema;
    expect(errorOf(without).code).toBe("invalid_pack");
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

  it("phrase: empty list, empty phrase, 81-char phrase, bad enums, non-positive max_doc_words", () => {
    const phrase = (m: Obj) => paths(pack([rule({ match: { kind: "phrase", phrases: ["x"], ...m } })]));
    expect(phrase({ phrases: [] })).toContain("rules[0].match.phrases");
    expect(phrase({ phrases: [""] })).toContain("rules[0].match.phrases[0]");
    expect(parseRulePack(pack([rule({ match: { kind: "phrase", phrases: ["x".repeat(80)] } })])).ok).toBe(true);
    expect(phrase({ phrases: ["x".repeat(81)] })).toContain("rules[0].match.phrases[0]");
    expect(phrase({ boundary: "sentence" })).toContain("rules[0].match.boundary");
    expect(phrase({ position: "middle" })).toContain("rules[0].match.position");
    expect(phrase({ max_doc_words: 0 })).toContain("rules[0].match.max_doc_words");
    expect(phrase({ case_insensitive: "yes" })).toContain("rules[0].match.case_insensitive");
  });

  it("regex: 500-char limit, empty pattern, flags other than a single i", () => {
    const regex = (m: Obj) => paths(pack([rule({ match: { kind: "regex", pattern: "x", ...m } })]));
    expect(parseRulePack(pack([rule({ match: { kind: "regex", pattern: "x".repeat(500) } })])).ok).toBe(true);
    expect(regex({ pattern: "x".repeat(501) })).toContain("rules[0].match.pattern");
    expect(regex({ pattern: "" })).toContain("rules[0].match.pattern");
    expect(regex({ flags: "g" })).toContain("rules[0].match.flags");
    expect(regex({ flags: "ii" })).toContain("rules[0].match.flags");
    expect(regex({ flags: "im" })).toContain("rules[0].match.flags");
  });

  it("sentence_metric: exactly one of above/below, pattern iff starts_with", () => {
    const m = (x: Obj) => errorOf(pack([rule({ match: { kind: "sentence_metric", ...x } })]));
    expect(m({ metric: "word_count" }).issues.map((i) => i.message)).toContain("exactly one of above or below is required");
    expect(m({ metric: "word_count", above: 1, below: 2 }).issues.map((i) => i.message)).toContain("exactly one of above or below is required");
    expect(m({ metric: "starts_with", above: 0 }).issues.map((i) => i.path)).toContain("rules[0].match.pattern");
    expect(m({ metric: "word_count", above: 1, pattern: "x" }).issues.map((i) => i.path)).toContain("rules[0].match.pattern");
    expect(m({ metric: "word_count", above: -1 }).issues.map((i) => i.path)).toContain("rules[0].match.above");
    expect(m({ metric: "word_count", above: Number.POSITIVE_INFINITY }).issues.map((i) => i.path)).toContain("rules[0].match.above");
  });

  it("document_metric: exactly one of above/below, positive integer min_sentences", () => {
    const m = (x: Obj) => errorOf(pack([rule({ match: { kind: "document_metric", metric: "bullet_ratio", ...x } })]));
    expect(m({}).issues.map((i) => i.message)).toContain("exactly one of above or below is required");
    expect(m({ above: 1, below: 2 }).issues.map((i) => i.message)).toContain("exactly one of above or below is required");
    expect(m({ above: 1, min_sentences: 0 }).issues.map((i) => i.path)).toContain("rules[0].match.min_sentences");
    expect(m({ above: 1, min_sentences: 2.5 }).issues.map((i) => i.path)).toContain("rules[0].match.min_sentences");
  });

  it("a metric the engine does not implement (04: rejected at load)", () => {
    expect(paths(pack([rule({ match: { kind: "sentence_metric", metric: "syllable_count", above: 1 } })]))).toContain("rules[0].match.metric");
    expect(paths(pack([rule({ match: { kind: "document_metric", metric: "word_count", above: 1 } })]))).toContain("rules[0].match.metric");
    // a sentence metric is not a document metric and vice versa
    expect(paths(pack([rule({ match: { kind: "sentence_metric", metric: "bullet_ratio", above: 1 } })]))).toContain("rules[0].match.metric");
  });

  it("an unknown match kind, or none", () => {
    const unknown = errorOf(pack([rule({ match: { kind: "semantic", phrases: ["x"] } })]));
    expect(unknown.issues).toEqual([
      { path: "rules[0].match.kind", message: "Invalid discriminator value. Expected 'phrase' | 'regex' | 'sentence_metric' | 'document_metric'" },
    ]);
    expect(paths(pack([rule({ match: { phrases: ["x"] } })]))).toContain("rules[0].match.kind");
  });

  it("an unknown field at every level", () => {
    const at = (input: unknown, path: string) => {
      const issues = errorOf(input).issues;
      expect(issues).toContainEqual({ path, message: "unknown field" });
    };
    at({ ...pack(), publisher: "x" }, "publisher");
    at(pack([rule({ priority: 1 })]), "rules[0].priority");
    at(pack([rule({ match: { kind: "phrase", phrases: ["x"], stem: true } })]), "rules[0].match.stem");
    at(pack([rule({ match: { kind: "regex", pattern: "x", multiline: true } })]), "rules[0].match.multiline");
    at(pack([rule({ match: { kind: "sentence_metric", metric: "word_count", above: 1, min_sentences: 3 } })]), "rules[0].match.min_sentences");
    at(pack([rule({ match: { kind: "document_metric", metric: "bullet_ratio", above: 1, pattern: "x" } })]), "rules[0].match.pattern");
    at(pack([rule({ instruction: { action: "remove", text: "x", severity: "block" } })]), "rules[0].instruction.severity");
    at(pack([rule({ examples: { hit: ["a"], miss: ["b"], note: "c" } })]), "rules[0].examples.note");
  });

  it("an action outside the fixed enum", () => {
    expect(paths(pack([rule({ instruction: { action: "delete", text: "x" } })]))).toContain("rules[0].instruction.action");
    expect(paths(pack([rule({ instruction: { text: "x" } })]))).toContain("rules[0].instruction.action");
  });

  it("every action in the enum is accepted", () => {
    for (const action of ["remove", "replace", "shorten", "specify", "merge", "restructure", "rephrase", "cite_or_soften_or_remove"]) {
      expect(parseRulePack(pack([rule({ instruction: { action, text: "x" } })])).ok, action).toBe(true);
    }
  });

  it("examples: both hit and miss, each with at least one non-empty string", () => {
    expect(paths(pack([rule({ examples: { hit: ["a"] } })]))).toContain("rules[0].examples.miss");
    expect(paths(pack([rule({ examples: { miss: ["a"] } })]))).toContain("rules[0].examples.hit");
    expect(paths(pack([rule({ examples: { hit: [], miss: ["a"] } })]))).toContain("rules[0].examples.hit");
    expect(paths(pack([rule({ examples: { hit: [""], miss: ["a"] } })]))).toContain("rules[0].examples.hit[0]");
    expect(paths(pack([rule({ examples: undefined })]))).toContain("rules[0].examples");
  });
});

describe("rule pack YAML", () => {
  it("rejects anchors, aliases, tags, duplicate keys and multiple documents", () => {
    const base = packYaml();
    const cases: Array<[string, string, RegExp]> = [
      ["anchor", base.replace("id: core\n", "id: &p core\n"), /anchors are not allowed/],
      ["alias", base.replace("severity: block", "severity: &s block").replace('action: remove', 'action: *s'), /(anchors|aliases) are not allowed/],
      ["tag", base.replace("version: 0.1.0", "version: !!str 0.1.0"), /tags are not allowed/],
      ["custom tag", base.replace("id: core\n", "id: !custom core\n"), /tags are not allowed/],
      ["duplicate key", base.replace("id: core\n", "id: core\nid: other\n"), /DUPLICATE_KEY/],
      ["two documents", `${base}---\nschema: prosegate.rulepack/1\n`, /MULTIPLE_DOCS/],
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
      const r = parseRulePackYaml(text);
      expect(r.ok, text).toBe(false);
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
    const wide = `${packYaml()}#${"€".repeat(90_000)}\n`;
    expect(wide.length).toBeLessThan(limit);
    expect(parseRulePackYaml(wide).ok).toBe(false);
  });
});
