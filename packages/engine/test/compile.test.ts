import { describe, expect, it } from "vitest";
import { RE2JS } from "re2js";
import { parseRulePackYaml, type RulePack } from "@prosegate/profiles";
import { clearPackCache, compilePack, PackCompileError } from "../src/index.js";
import { escapeRegex, stripOuterBoundaries } from "../src/compile.js";
import { CORE, hits, packOf, ruleYaml, run } from "./helpers.js";

const at = (p: RulePack, i: number): RulePack["rules"][number] => p.rules[i] as RulePack["rules"][number];

function mutate(pack: RulePack, fn: (p: RulePack) => void): RulePack {
  const copy = JSON.parse(JSON.stringify(pack)) as RulePack;
  fn(copy);
  return copy;
}

describe("compilePack", () => {
  it("literal phrase searches preserve RE2 offsets, alternative order and whitespace semantics", () => {
    const phrases = ["foo bar", "foo", "a+b", "a.b", "[x]", "(a+)+$", "\\path", "caf\u00e9", "\u{10428}word", "a|b"];
    const pack = packOf(ruleYaml("core.vocab.001", JSON.stringify({ kind: "phrase", phrases })));
    const match = pack.rules[0]?.match;
    if (match?.kind !== "search") throw new Error("expected search");
    const part = match.parts[0];
    if (part === undefined || part.phrases === null) throw new Error("expected phrases");
    const reference = RE2JS.compile(`(?:${part.phrases.map((p) => p.split(" ").map(escapeRegex).join("\\s+")).join("|")})`);
    const texts = [
      "foo barx foo bar foo", "a+b a.b [x] (a+)+$ \\path a|b", "caf\u00e9 \u{10428}word", "x\u{10428}word \u{10428}word",
      ...[" ", "  ", "\t", "\n", "\r\n", "\f", "\v", "\u00a0", "\u2028"].map((ws) => `foo${ws}bar`),
      `${"f".repeat(1900)}foo bar`, `${"a".repeat(1900)}!`, "",
    ];
    for (const text of texts) {
      expect(part.re.test(text)).toBe(reference.test(text));
      const actual = part.re.matcher(text);
      const expected = reference.matcher(text);
      // Repeated and out-of-order starts also detect leaked RegExp.lastIndex.
      const starts = text.length < 100 ? Array.from({ length: text.length + 1 }, (_, i) => i) : [0, 1, Math.floor(text.length / 2), text.length];
      for (const start of [...starts, 0]) {
        const found = expected.find(start);
        expect(actual.find(start), JSON.stringify({ text, start })).toBe(found);
        if (found) expect([actual.start(0), actual.end(0)]).toEqual([expected.start(0), expected.end(0)]);
      }
    }
  });

  it("compiles core once and caches by id@version", () => {
    clearPackCache();
    const a = compilePack(CORE);
    expect(compilePack(CORE)).toBe(a);
    expect(compilePack(mutate(CORE, () => undefined))).toBe(a); // same content, other object
    expect(a.rules).toHaveLength(23);
    expect(Object.isFrozen(a)).toBe(true);
    expect(Object.isFrozen(a.rules)).toBe(true);
    expect(Object.isFrozen(a.rules[0])).toBe(true);
  });

  it("recompiles when the same id@version carries different content", () => {
    const a = packOf(ruleYaml("core.vocab.001", '{ kind: phrase, phrases: ["foo"] }'));
    const b = packOf(ruleYaml("core.vocab.001", '{ kind: phrase, phrases: ["bar"] }'));
    expect(b).not.toBe(a);
    expect(hits("A foo and a bar.", { packs: [b] })).toEqual([["core.vocab.001", "bar"]]);
  });

  it("rejects a pattern that fails in re2js, naming the rule id", () => {
    for (const [what, edit] of [
      ["regex", (p: RulePack) => { (at(p, 5).match as { pattern: string }).pattern = "a(b"; }],
      ["lookbehind (the LOOKBEHINDS flag is never passed)", (p: RulePack) => { (at(p, 5).match as { pattern: string }).pattern = "(?<=a)b"; }],
      ["lookahead", (p: RulePack) => { (at(p, 5).match as { pattern: string }).pattern = "a(?=b)"; }],
      ["bad class", (p: RulePack) => { (at(p, 5).match as { pattern: string }).pattern = "[z-a]"; }],
      ["sentence_exclude", (p: RulePack) => { (at(p, 14).match as { sentence_exclude: string }).sentence_exclude = "(("; }],
    ] as const) {
      const bad = mutate(CORE, (p) => { p.version = "9.9.9"; edit(p); });
      const targetId = at(bad, what.startsWith("sentence") ? 14 : 5).id;
      try {
        compilePack(bad);
        expect.unreachable(`${what} compiled`);
      } catch (e) {
        expect(e, what).toBeInstanceOf(PackCompileError);
        expect((e as PackCompileError).ruleId, what).toBe(targetId);
        expect((e as Error).message, what).toContain(targetId);
      }
    }
  });

  it("rejects a starts_with pattern that fails, and a metric it does not implement", () => {
    const sm = parseRulePackYaml(
      ["schema: prosegate.rulepack/1", "id: core", "version: 0.1.0", "findings_schema: 1", "rules:", ruleYaml("core.structure.003", "{ kind: sentence_metric, metric: starts_with, pattern: 'x', above: 0 }")].join("\n"),
    );
    if (!sm.ok) throw new Error(sm.error.message);
    expect(() => compilePack(mutate(sm.value, (p) => { (at(p, 0).match as { pattern: string }).pattern = "(("; }))).toThrow(/core\.structure\.003/);
    expect(() => compilePack(mutate(sm.value, (p) => { (at(p, 0).match as { metric: string }).metric = "nope"; }))).toThrow(/not implemented/);
  });

  it("stripOuterBoundaries strips a leading and trailing \\b only when it is safe", () => {
    expect(stripOuterBoundaries("\\bfoo\\b")).toEqual({ source: "foo", lead: true, trail: true });
    expect(stripOuterBoundaries("\\b(?:a|b)\\b")).toEqual({ source: "(?:a|b)", lead: true, trail: true });
    expect(stripOuterBoundaries("\\bfoo")).toEqual({ source: "foo", lead: true, trail: false });
    expect(stripOuterBoundaries("foo\\\\b")).toEqual({ source: "foo\\\\b", lead: false, trail: false }); // escaped backslash then b
    expect(stripOuterBoundaries("\\ba\\b|\\bb\\b")).toEqual({ source: "\\ba\\b|\\bb\\b", lead: false, trail: false }); // top-level alternation
    expect(stripOuterBoundaries("[|]\\b")).toEqual({ source: "[|]", lead: false, trail: true });
  });
});

describe("budget guard", () => {
  it("stops between rules once 200 ms of rule time is spent and records it", () => {
    let t = 0;
    const clock = (): number => (t += 30); // every reading costs 30 ms
    const r = run("It is robust, arguably. Truly.", { now: clock });
    expect(r.diagnostics.budget_exceeded).toBe(true);
    expect(r.diagnostics.rules_unfinished.length).toBeGreaterThan(0);
    expect(Object.keys(r.diagnostics.per_rule_ms).length + r.diagnostics.rules_unfinished.length).toBeGreaterThanOrEqual(20);
    expect(r.result.verdict === "pass" || r.result.verdict === "revise").toBe(true); // a valid partial result (run() validated the schema)
  });

  it("a normal review is well inside the budget", () => {
    const r = run("It is robust, arguably. Truly.");
    expect(r.diagnostics.budget_exceeded).toBe(false);
    expect(r.diagnostics.rules_unfinished).toEqual([]);
    expect(Object.keys(r.diagnostics.per_rule_ms)).toHaveLength(23);
  });

  it("budgetMs overrides the default", () => {
    let t = 0;
    const r = run("It is robust.", { now: () => (t += 1), budgetMs: 5 });
    expect(r.diagnostics.budget_exceeded).toBe(true);
  });
});
