import { describe, expect, it } from "vitest";
import { parseProfile, parseProfileYaml, type Profile } from "./profile.js";
import { profileYaml } from "./test-util.js";

function ok(yaml: string): Profile {
  const r = parseProfileYaml(yaml);
  if (!r.ok) throw new Error(`expected a valid profile: ${r.error.message}`);
  return r.value;
}

function issues(yaml: string) {
  const r = parseProfileYaml(yaml);
  if (r.ok) throw new Error("expected the profile to be rejected");
  expect(r.error.code).toBe("invalid_profile");
  return r.error.issues;
}

const paths = (yaml: string) => issues(yaml).map((i) => i.path);

describe("profile ids and names (ADR-17, ADR-19)", () => {
  const slug31 = "a".repeat(31);

  it("namespace and slug are each [a-z0-9-]{1,31}: 31 passes, 32 and 0 do not", () => {
    expect(ok(profileYaml(`${slug31}/${slug31}`)).id).toBe(`${slug31}/${slug31}`);
    expect(paths(profileYaml(`${"a".repeat(32)}/b`))).toContain("id");
    expect(paths(profileYaml(`a/${"b".repeat(32)}`))).toContain("id");
    expect(paths(profileYaml("/b"))).toContain("id");
    expect(paths(profileYaml("a/"))).toContain("id");
    expect(paths(profileYaml("a/b", "", { extends: `${"c".repeat(32)}/d` }))).toContain("extends");
  });

  it("pack ids in rule_packs follow the same rule", () => {
    ok(profileYaml("a/b", `rule_packs:\n  - { id: ${"p".repeat(31)}, version: ">=1.0.0" }`));
    expect(paths(profileYaml("a/b", `rule_packs:\n  - { id: ${"p".repeat(32)}, version: ">=1.0.0" }`))).toContain("rule_packs[0].id");
  });

  it("parse errors carry the document id in ids once the id parsed", () => {
    const r = parseProfileYaml(profileYaml("a/b", "enforcement:\n  pass_cap: 5"));
    expect(!r.ok && r.error.ids).toEqual(["a/b"]);
    const bad = parseProfileYaml(profileYaml("A/B", "enforcement:\n  pass_cap: 5"));
    expect(!bad.ok && bad.error.ids).toEqual([]);
  });

  it("name is 1-100 characters", () => {
    ok(profileYaml("a/b", "", { name: JSON.stringify("n".repeat(100)) }));
    expect(paths(profileYaml("a/b", "", { name: JSON.stringify("n".repeat(101)) }))).toContain("name");
    expect(paths(profileYaml("a/b", "", { name: '""' }))).toContain("name");
    expect(paths(profileYaml("a/b", "", { name: '"   "' }))).toContain("name");
  });
});

describe("version ranges (04, normalised on the way in)", () => {
  const range = (r: string) => parseProfileYaml(profileYaml("a/b", `rule_packs:\n  - { id: core, version: ${JSON.stringify(r)} }`));
  const stored = (r: string) => {
    const parsed = range(r);
    return parsed.ok ? parsed.value.rule_packs?.[0]?.version : undefined;
  };

  it("are stored as semver.validRange output", () => {
    expect(stored("0.1.x")).toBe(">=0.1.0 <0.2.0-0");
    expect(stored("^1.2.3")).toBe(">=1.2.3 <2.0.0-0");
    expect(stored("1.x || 3.x")).toBe(">=1.0.0 <2.0.0-0||>=3.0.0 <4.0.0-0");
  });

  it("two spellings of one range store the same string", () => {
    expect(stored("0.1.x")).toBe(stored("~0.1.0"));
    expect(stored("0.1.x")).toBe(stored(">=0.1.0 <0.2.0-0"));
  });

  it("rejects empty, whitespace-only and wildcard ranges", () => {
    for (const bad of ["", "   ", "*", "x", "X", "||", " || ", ">=0.0.0", "^1.0.0 || *", "latest", "not a range"]) {
      const r = range(bad);
      expect(r.ok, JSON.stringify(bad)).toBe(false);
      if (!r.ok) expect(r.error.issues.map((i) => i.path)).toContain("rule_packs[0].version");
    }
  });

  it("accepts a range that names a prerelease", () => {
    expect(range(">=1.0.0-beta.1 <1.0.0").ok).toBe(true);
  });
});

describe("overrides: constraints from 08 and normalisation", () => {
  it("rejects a block category override for register (08 caps it at warn); info and warn pass", () => {
    expect(issues(profileYaml("a/b", "overrides:\n  categories:\n    register: { severity: block }"))).toContainEqual({
      path: "overrides.categories.register.severity",
      message: "register findings are capped at warn",
    });
    ok(profileYaml("a/b", "overrides:\n  categories:\n    register: { severity: warn }"));
    ok(profileYaml("a/b", "overrides:\n  categories:\n    register: { severity: info }"));
    ok(profileYaml("a/b", "overrides:\n  categories:\n    vague_claim: { severity: block }"));
  });

  it("lowercases allow_terms", () => {
    expect(ok(profileYaml("a/b", 'overrides:\n  allow_terms: ["Robust", "IDEMPOTENT"]')).overrides?.allow_terms).toEqual(["robust", "idempotent"]);
  });

  it("limits: 500 allow_terms pass, 501 fail; 80 characters pass, 81 fail; 50 packs pass, 51 fail", () => {
    const terms = (n: number) => `overrides:\n  allow_terms: [${Array.from({ length: n }, (_, i) => `t${i}`).join(", ")}]`;
    ok(profileYaml("a/b", terms(500)));
    expect(paths(profileYaml("a/b", terms(501)))).toContain("overrides.allow_terms");
    ok(profileYaml("a/b", `overrides:\n  allow_terms: ["${"t".repeat(80)}"]`));
    expect(paths(profileYaml("a/b", `overrides:\n  allow_terms: ["${"t".repeat(81)}"]`))).toContain("overrides.allow_terms[0]");
    const packs = (n: number) => `rule_packs:\n${Array.from({ length: n }, (_, i) => `  - { id: p${i}, version: ">=1.0.0" }`).join("\n")}`;
    ok(profileYaml("a/b", packs(50)));
    expect(paths(profileYaml("a/b", packs(51)))).toContain("rule_packs");
  });

  it("limits: patterns and harness_hints 50 pass / 51 fail; elements 100 and 64 characters pass / one over fails", () => {
    const list = (key: string, n: number, len = 3) => `trigger:\n  ${key}: [${Array.from({ length: n }, () => `"${"p".repeat(len)}"`).join(", ")}]`;
    ok(profileYaml("a/b", list("patterns", 50)));
    expect(paths(profileYaml("a/b", list("patterns", 51)))).toContain("trigger.patterns");
    ok(profileYaml("a/b", list("harness_hints", 50)));
    expect(paths(profileYaml("a/b", list("harness_hints", 51)))).toContain("trigger.harness_hints");
    ok(profileYaml("a/b", list("patterns", 1, 100)));
    expect(paths(profileYaml("a/b", list("patterns", 1, 101)))).toContain("trigger.patterns[0]");
    ok(profileYaml("a/b", list("harness_hints", 1, 64)));
    expect(paths(profileYaml("a/b", list("harness_hints", 1, 65)))).toContain("trigger.harness_hints[0]");
  });

  it("limits: max_words 100000 passes, 100001 fails; tone 200 and format 300 pass", () => {
    ok(profileYaml("a/b", "reviewer:\n  register:\n    max_words: 100000"));
    expect(paths(profileYaml("a/b", "reviewer:\n  register:\n    max_words: 100001"))).toContain("reviewer.register.max_words");
    ok(profileYaml("a/b", `reviewer:\n  register:\n    tone: "${"t".repeat(200)}"\n    format: "${"f".repeat(300)}"`));
  });

  it("limits: reviewer.categories has at most three entries", () => {
    expect(paths(profileYaml("a/b", "reviewer:\n  categories: [register, register, register, register]"))).toContain("reviewer.categories");
  });

  it("NFC-normalises strings: NFC and NFD spellings of a term parse alike", () => {
    const nfd = ok(profileYaml("a/b", 'overrides:\n  allow_terms: ["cafe\\u0301"]')).overrides?.allow_terms;
    const nfc = ok(profileYaml("a/b", 'overrides:\n  allow_terms: ["caf\\u00e9"]')).overrides?.allow_terms;
    expect(nfd).toEqual(nfc);
  });
});

describe("__proto__ and hostile keys in records (zod's records drop an own __proto__)", () => {
  it("rejects an own __proto__ key in overrides.categories and overrides.rules, from JSON input", () => {
    const base = { schema: "prosegate.profile/1", id: "a/b", version: 1, name: "x" };
    const inputs: unknown[] = [
      JSON.parse('{"schema":"prosegate.profile/1","id":"a/b","version":1,"name":"x","overrides":{"categories":{"__proto__":{"severity":"info"}}}}'),
      JSON.parse('{"schema":"prosegate.profile/1","id":"a/b","version":1,"name":"x","overrides":{"rules":{"__proto__":{"enabled":false}}}}'),
      JSON.parse('{"__proto__":{"x":1},"schema":"prosegate.profile/1","id":"a/b","version":1,"name":"x"}'),
      { ...base, overrides: { categories: { triad: { severity: "info" } }, rules: JSON.parse('{"__proto__":{"enabled":true},"core.hedge.001":{"enabled":false}}') as object } },
    ];
    for (const input of inputs) {
      const r = parseProfile(input);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.issues.some((i) => i.message === "reserved key" && i.path.includes("__proto__"))).toBe(true);
    }
  });

  it("a record key outside the allowed set is rejected, not dropped", () => {
    expect(paths(profileYaml("a/b", "overrides:\n  categories:\n    constructor: { severity: info }"))).toContain("overrides.categories.constructor");
    expect(paths(profileYaml("a/b", "overrides:\n  rules:\n    constructor: { enabled: false }"))).toContain("overrides.rules.constructor");
  });
});
