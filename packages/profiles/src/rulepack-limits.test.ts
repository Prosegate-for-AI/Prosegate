import { describe, expect, it } from "vitest";
import { BUNDLED_PACK_YAML } from "./bundled.js";
import { MAX_PATTERN_BYTES } from "./patterns.js";
import { MAX_RULES, isCorpusRef, parseRulePack, parseRulePackYaml } from "./rulepack.js";
import { bestCpuMs } from "./test-util.js";
import { MAX_PACK_BYTES, MAX_PACK_NODES, estimateNodes } from "./yaml.js";

type Obj = Record<string, unknown>;

const rule = (overrides: Obj = {}): Obj => ({
  id: "core.hedge.001",
  category: "hedge",
  severity: "block",
  match: { kind: "phrase", phrases: ["xx"] },
  instruction: { action: "remove", text: "Remove." },
  examples: { hit: ["a"], miss: ["b"] },
  ...overrides,
});
const pack = (rules: Obj[]): Obj => ({ schema: "prosegate.rulepack/1", id: "core", version: "0.1.0", findings_schema: 1, rules });
const paths = (input: unknown): string[] => {
  const r = parseRulePack(input);
  return r.ok ? [] : r.error.issues.map((i) => i.path);
};
const regex = (pattern: string) => paths(pack([rule({ match: { kind: "regex", pattern } })]));

describe("repetition lint: total work (cycle 2)", () => {
  it("rejects a pattern whose sequential repeat counts sum to more than 5000", () => {
    const eight = Array.from({ length: 8 }, () => "\\p{L}{1000}").join("");
    expect(eight.length).toBeLessThanOrEqual(500);
    expect(regex(eight)).toContain("rules[0].match.pattern");
  });

  it("accepts a sum of exactly 5000 and rejects 5001", () => {
    const five = Array.from({ length: 5 }, () => "\\p{L}{1000}").join("");
    expect(regex(five)).toEqual([]);
    expect(regex(`${five}a{1}`)).toContain("rules[0].match.pattern");
  });

  it("open upper bounds count as at least two, and nested repeats add as well as multiply", () => {
    expect(regex(Array.from({ length: 3 }, () => "a{1000,}").join(""))).toEqual([]); // 3 * 1000
    expect(regex(Array.from({ length: 6 }, () => "a{1000,}").join(""))).toContain("rules[0].match.pattern");
    expect(regex("(?:a{10}){100}")).toEqual([]); // product 1000, sum 110
  });

  it("the message names the cap", () => {
    const r = parseRulePack(pack([rule({ match: { kind: "regex", pattern: Array.from({ length: 8 }, () => "\\p{L}{1000}").join("") } })]));
    expect(!r.ok && r.error.issues[0]?.message).toBe("pattern repeat counts total more than 5000");
  });
});

describe("corpus-ref examples are a typed kind (cycle 2)", () => {
  it("isCorpusRef accepts exactly the documented form", () => {
    expect(isCorpusRef("<eval corpus ref: core/structure-002-hit-01>")).toBe(true);
    expect(isCorpusRef("<eval corpus ref: core/filler-004-miss-12>")).toBe(true);
    expect(isCorpusRef("<eval corpus ref: my-pack/vocab-010-hit-01>")).toBe(true);
    for (const bad of [
      "<eval corpus ref: core/structure-002-hit-1>",
      "<eval corpus ref: core/structure-02-hit-01>",
      "<eval corpus ref: core/structure-002-hit-01",
      "<eval corpus ref core/structure-002-hit-01>",
      "<eval corpus ref: core/structure-002-both-01>",
      "<eval corpus ref: core/style-002-hit-01>",
      "<eval corpus ref: Core/structure-002-hit-01>",
      " <eval corpus ref: core/structure-002-hit-01>",
      "<eval corpus ref: core/structure-002-hit-01> ",
      "It is fast, simple, and reliable.",
      "",
    ]) {
      expect(isCorpusRef(bad), bad).toBe(false);
    }
  });

  const structure = (hit: string, miss: string) =>
    pack([rule({ id: "core.structure.002", category: "structure", match: { kind: "document_metric", metric: "bullet_ratio", above: 0.6 }, examples: { hit: [hit], miss: [miss] } })]);

  it("a well-formed ref in the right list for the right rule is accepted", () => {
    expect(paths(structure("<eval corpus ref: core/structure-002-hit-01>", "<eval corpus ref: core/structure-002-miss-01>"))).toEqual([]);
  });

  it("a typo that starts like a ref is rejected, not read as a literal sentence", () => {
    for (const typo of ["<eval corpus ref: core/structure-002-hit-1>", "<eval corpus ref: core/structre-002-hit-01>", "<eval corpus ref: core/structure-002-hit-01"]) {
      expect(paths(structure(typo, "<eval corpus ref: core/structure-002-miss-01>")), typo).toContain("rules[0].examples.hit[0]");
    }
  });

  it("a ref must name this pack, this rule and this list", () => {
    const wrongRule = paths(structure("<eval corpus ref: core/structure-003-hit-01>", "<eval corpus ref: core/structure-002-miss-01>"));
    expect(wrongRule).toContain("rules[0].examples.hit[0]");
    const wrongList = paths(structure("<eval corpus ref: core/structure-002-miss-01>", "<eval corpus ref: core/structure-002-miss-01>"));
    expect(wrongList).toContain("rules[0].examples.hit[0]");
    const wrongPack = paths(structure("<eval corpus ref: other/structure-002-hit-01>", "<eval corpus ref: core/structure-002-miss-01>"));
    expect(wrongPack).toContain("rules[0].examples.hit[0]");
  });

  it("every rule of the real core pack, structure rules included, has at least one hit and one miss counting refs", () => {
    const r = parseRulePackYaml(BUNDLED_PACK_YAML["core@0.1.0"]);
    if (!r.ok) throw new Error(r.error.message);
    for (const rule of r.value.rules) {
      expect(rule.examples.hit.length, rule.id).toBeGreaterThanOrEqual(1);
      expect(rule.examples.miss.length, rule.id).toBeGreaterThanOrEqual(1);
    }
    for (const rule of r.value.rules.filter((x) => x.category === "structure")) {
      expect(rule.examples.hit.every(isCorpusRef), rule.id).toBe(true);
      expect(rule.examples.miss.every(isCorpusRef), rule.id).toBe(true);
    }
  });
});

describe("NFC is applied to free text and terms only (cycle 2)", () => {
  const nfd = "e\u{301}";
  const nfc = "\u{e9}";

  it("patterns and sentence_exclude keep their bytes", () => {
    const r = parseRulePack(pack([rule({ match: { kind: "regex", pattern: `${nfd}x`, sentence_exclude: `${nfd}y` } })]));
    expect(r.ok && r.value.rules[0]?.match).toMatchObject({ pattern: `${nfd}x`, sentence_exclude: `${nfd}y` });
    const starts = parseRulePack(pack([rule({ match: { kind: "sentence_metric", metric: "starts_with", above: 0, pattern: `^${nfd}` } })]));
    expect(starts.ok && starts.value.rules[0]?.match).toMatchObject({ pattern: `^${nfd}` });
  });

  it("examples keep their bytes", () => {
    const r = parseRulePack(pack([rule({ examples: { hit: [`caf${nfd}`], miss: [`caf${nfd}s`] } })]));
    expect(r.ok && r.value.rules[0]?.examples).toEqual({ hit: [`caf${nfd}`], miss: [`caf${nfd}s`] });
  });

  it("instruction text is still normalised", () => {
    const r = parseRulePack(pack([rule({ instruction: { action: "remove", text: `Caf${nfd}.` } })]));
    expect(r.ok && r.value.rules[0]?.instruction.text).toBe(`Caf${nfc}.`);
  });
});

describe("a pack at the schema maxima fits the node cap (cycle 2)", () => {
  const CATEGORIES = ["filler", "hedge", "vocab", "triad", "structure", "repetition"];
  /** One rule at full width in block style: MAX phrases, MAX hit and MAX miss examples. */
  function fullRule(i: number): string {
    const category = CATEGORIES[i % 6] as string;
    const id = `core.${category}.${String(Math.floor(i / 6)).padStart(3, "0")}`;
    const phrases = Array.from({ length: 40 }, (_, k) => `        - "ph${i}x${k}"`).join("\n");
    const examples = (kind: string) => `[${Array.from({ length: 10 }, (_, k) => `"${kind} ${k}"`).join(", ")}]`;
    return `  - id: ${id}
    category: ${category}
    severity: warn
    match:
      kind: phrase
      phrases:
${phrases}
    instruction: { action: remove, text: "Remove it." }
    examples:
      hit: ${examples("hit")}
      miss: ${examples("miss")}
`;
  }
  const packYaml = (n: number) => `schema: prosegate.rulepack/1\nid: core\nversion: 0.1.0\nfindings_schema: 1\nrules:\n${Array.from({ length: n }, (_, i) => fullRule(i)).join("")}`;

  it("150 full-width rules parse, within the byte and node caps", () => {
    const text = packYaml(MAX_RULES);
    const nodes = estimateNodes(text);
    expect(MAX_RULES).toBe(150);
    expect(text.length).toBeLessThan(MAX_PACK_BYTES);
    expect(nodes).toBeLessThan(MAX_PACK_NODES);
    // CPU time, best of 5 (a wall-clock budget fails on a loaded machine).
    const { ms, value: r } = bestCpuMs(() => parseRulePackYaml(text));
    expect(r.ok, !r.ok ? r.error.message : "").toBe(true);
    // measured: 18,761 estimated nodes, 179,479 bytes, 150-250 ms to parse and validate
    expect(ms).toBeLessThan(1500);
  });

  it("151 rules are refused by the rule cap, not by an unrelated limit", () => {
    const r = parseRulePackYaml(packYaml(MAX_RULES + 1));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.issues.map((i) => i.path)).toEqual(["rules"]);
  });

  it("the pattern byte cap is far above what the schema maxima can fill with phrases (patterns only)", () => {
    expect(MAX_PATTERN_BYTES).toBe(32768);
  });
});
