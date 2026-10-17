import { describe, expect, it } from "vitest";
import { parseProfileYaml } from "./profile.js";
import { profileYaml } from "./test-util.js";
import { MAX_PROFILE_BYTES, MAX_PROFILE_NODES, estimateNodes } from "./yaml.js";

const CATEGORIES = ["filler", "hedge", "vocab", "triad", "structure", "repetition"];
const ruleId = (i: number) => `core.${CATEGORIES[i % 6]}.${String(Math.floor(i / 6)).padStart(3, "0")}`;

function maxProfile(ruleOverrides: number): string {
  return profileYaml(
    "a/b",
    [
      "trigger:",
      `  patterns: [${Array.from({ length: 50 }, (_, i) => `"pattern number ${i} for the user message"`).join(", ")}]`,
      `  harness_hints: [${Array.from({ length: 50 }, (_, i) => `"tool_name_${i}"`).join(", ")}]`,
      "rule_packs:",
      ...Array.from({ length: 50 }, (_, i) => `  - { id: pack-${i}, version: ">=1.0.0 <2.0.0" }`),
      "overrides:",
      "  rules:",
      ...Array.from({ length: ruleOverrides }, (_, i) => `    ${ruleId(i)}: { enabled: false, severity: info }`),
      "  allow_terms:",
      ...Array.from({ length: 500 }, (_, i) => `    - term${i}`),
    ].join("\n"),
  );
}

describe("a profile at the schema maxima fits the node cap (cycle 2)", () => {
  it("50 patterns, 50 hints, 50 packs, 400 rule overrides and 500 allow_terms parse, under 5,000 estimated nodes", () => {
    const text = maxProfile(400);
    const nodes = estimateNodes(text);
    expect(text.length).toBeLessThan(MAX_PROFILE_BYTES);
    expect(nodes).toBeLessThan(MAX_PROFILE_NODES);
    const started = Date.now();
    const r = parseProfileYaml(text);
    const ms = Date.now() - started;
    expect(r.ok, !r.ok ? r.error.message : "").toBe(true);
    expect(ms).toBeLessThan(500);
  });

  it("401 rule overrides are refused by the schema cap", () => {
    const r = parseProfileYaml(maxProfile(401));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.issues.map((i) => i.message)).toContain("at most 400 rule overrides");
  });
});

describe("free-text fields must not start with a combining mark (cycle 2)", () => {
  const COMBINING = "\u{301}";

  it("rejects a leading combining mark in name, description, tone and format", () => {
    const cases: Array<[string, string]> = [
      ["name", profileYaml("a/b", "", { name: JSON.stringify(`${COMBINING}Name`) })],
      ["trigger.description", profileYaml("a/b", `trigger:\n  description: ${JSON.stringify(`${COMBINING}Writing`)}`)],
      ["reviewer.register.tone", profileYaml("a/b", `reviewer:\n  register:\n    tone: ${JSON.stringify(`${COMBINING}Terse`)}`)],
      ["reviewer.register.format", profileYaml("a/b", `reviewer:\n  register:\n    format: ${JSON.stringify(`${COMBINING}Plain`)}`)],
    ];
    for (const [path, yaml] of cases) {
      const r = parseProfileYaml(yaml);
      expect(r.ok, path).toBe(false);
      if (!r.ok) expect(r.error.issues).toContainEqual({ path, message: "text must not start with a combining mark" });
    }
  });

  it("accepts a combining mark after a base letter", () => {
    expect(parseProfileYaml(profileYaml("a/b", "", { name: JSON.stringify("Cafe\u{301} notes") })).ok).toBe(true);
  });
});
