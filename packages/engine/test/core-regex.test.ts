import { describe, expect, it } from "vitest";
import { RE2JS } from "re2js";
import { isNativeCorePattern, nativeCoreSearch } from "../src/core-regex.js";
import { stripOuterBoundaries, whitespaceRuns } from "../src/compile.js";
import { CORE } from "./helpers.js";

const patterns = CORE.rules.flatMap((rule) => {
  const parts = rule.match.kind === "any" ? rule.match.parts : [rule.match];
  return parts.flatMap((part) => part.kind === "regex" ? [{ pattern: part.pattern, examples: [...rule.examples.hit, ...rule.examples.miss] }] : []);
});

describe("audited native core expressions", () => {
  it("only selects exact audited core patterns", () => {
    expect(patterns).toHaveLength(12);
    for (const { pattern } of patterns) {
      expect(isNativeCorePattern("core", pattern)).toBe(true);
      expect(isNativeCorePattern("local", pattern)).toBe(false);
      expect(isNativeCorePattern("core", `${pattern}|(a+)+$`)).toBe(false);
    }
    for (const pattern of ["(a+)+$", "(?<=a)b", "a(b", "a.*a.*a.*a"]) expect(isNativeCorePattern("core", pattern)).toBe(false);
  });

  it.each(patterns)("preserves RE2 matches, captures and retry offsets: $pattern", ({ pattern, examples }) => {
    const source = stripOuterBoundaries(whitespaceRuns(pattern)).source;
    const samples = [
      "", "\u{10428}somewhat useful", "somewhat useful\u{10428}",
      "not only a\rb\u2028c\u2029d but also", "not just a\r\u2028\u2029, but",
      ...examples.flatMap((s) => [s, s.toLowerCase(), `\u{10428}${s.toLowerCase()}x`, `${s.toLowerCase()} ${s.toLowerCase()}`]),
      ...[" ", "  ", "\t", "\n", "\r\n", "\f", "\v", "\u00a0", "\u2028"].map((ws) => examples.join(" ").toLowerCase().replaceAll(" ", ws)),
      "a".repeat(1900), `not only ${"a ".repeat(900)}!`, `the ${"word ".repeat(350)}landscapex`,
    ];
    for (const expression of [source, `(?:${source})\\b`]) {
      const reference = RE2JS.compile(expression);
      const native = nativeCoreSearch(expression);
      for (const [name, index] of Object.entries(reference.namedGroups())) {
        expect(["span", "key"]).toContain(name);
        expect(index).toBe(1);
      }
      for (const text of samples) {
        expect(native.test(text), JSON.stringify({ expression, text })).toBe(reference.test(text));
        const actual = native.matcher(text), expected = reference.matcher(text);
        const starts = text.length < 70 ? Array.from({ length: text.length + 1 }, (_, i) => i) : [0, 1, 2, Math.floor(text.length / 2), text.length];
        for (const start of [...starts, 0]) {
          const found = expected.find(start);
          expect(actual.find(start), JSON.stringify({ expression, text, start })).toBe(found);
          if (found) for (let group = 0; group <= reference.groupCount(); group++) {
            expect([actual.start(group), actual.end(group)]).toEqual([expected.start(group), expected.end(group)]);
          }
        }
      }
    }
  });
});
