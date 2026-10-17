import { describe, expect, it } from "vitest";
import { parseProfile, parseProfileYaml } from "./profile.js";
import { parseRulePack } from "./rulepack.js";
import { sanitizeInput } from "./sanitize.js";
import { profileYaml } from "./test-util.js";

describe("sanitizeInput", () => {
  it("NFC-normalises strings at any depth and leaves other values alone", () => {
    const { value, issues } = sanitizeInput({ a: "e\u{301}", b: ["e\u{301}", 1, true, null], c: { d: "e\u{301}" } });
    expect(issues).toEqual([]);
    expect(value).toEqual({ a: "\u{e9}", b: ["\u{e9}", 1, true, null], c: { d: "\u{e9}" } });
  });

  it("reports an own __proto__ key (as JSON.parse creates it) instead of dropping it, and keeps the rest", () => {
    const input: unknown = JSON.parse('{"a":1,"__proto__":{"polluted":true},"nested":{"__proto__":1,"b":2}}');
    const { value, issues } = sanitizeInput(input);
    expect(issues.map((i) => i.path)).toEqual(["__proto__", "nested.__proto__"]);
    expect(issues.every((i) => i.message === "reserved key")).toBe(true);
    expect(value).toEqual({ a: 1, nested: { b: 2 } });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("rejects nesting deeper than 32 levels without overflowing the stack", () => {
    let deep: unknown = "x";
    for (let i = 0; i < 100_000; i++) deep = { a: deep };
    const { issues } = sanitizeInput(deep);
    expect(issues).toEqual([{ path: expect.stringMatching(/^a\.a/), message: "nested too deeply" }]);
    let arrays: unknown = "x";
    for (let i = 0; i < 100; i++) arrays = [arrays];
    expect(sanitizeInput(arrays).issues).toHaveLength(1);
  });

  it("does not mutate its input", () => {
    const input = { a: "e\u{301}", list: ["e\u{301}"] };
    sanitizeInput(input);
    expect(input).toEqual({ a: "e\u{301}", list: ["e\u{301}"] });
  });

  it("copes with hostile JS values: cycles are caught by the depth limit, functions and symbols pass through to the schema", () => {
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    expect(sanitizeInput(cycle).issues).toHaveLength(1);
    expect(parseProfile({ schema: "prosegate.profile/1", id: "a/b", version: 1, name: () => 1 }).ok).toBe(false);
  });
});

describe("a reserved key through each entry point", () => {
  it("YAML: a __proto__ key is rejected, never silently dropped", () => {
    const r = parseProfileYaml(profileYaml("a/b", "overrides:\n  categories:\n    __proto__: { severity: info }"));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.issues.some((i) => i.path.includes("__proto__"))).toBe(true);
    const top = parseProfileYaml(profileYaml("a/b", "__proto__: { x: 1 }"));
    expect(top.ok).toBe(false);
  });

  it("a rule pack: __proto__ inside a rule's match, from JSON", () => {
    const pack: unknown = JSON.parse(
      '{"schema":"prosegate.rulepack/1","id":"core","version":"0.1.0","findings_schema":1,"rules":[{"id":"core.hedge.001","category":"hedge","severity":"block","match":{"kind":"phrase","phrases":["ab"],"__proto__":{"a":1}},"instruction":{"action":"remove","text":"Remove."},"examples":{"hit":["a"],"miss":["b"]}}]}',
    );
    const r = parseRulePack(pack);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.issues.map((i) => i.path)).toContain("rules[0].match.__proto__");
  });
});
