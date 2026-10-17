import { describe, expect, it } from "vitest";
import { parseProfileYaml, type Profile } from "./profile.js";
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

const FULL = `schema: prosegate.profile/1
id: org-default/pr-description
version: 4
name: PR description
extends: org-default/base

trigger:
  description: "Writing a pull request title or description, a commit message, or a changelog entry"
  patterns: ["pull request", "PR description", "commit message", "changelog"]
  harness_hints: ["git_commit", "gh_pr_create"]
  sticky: true

rule_packs:
  - { id: core, version: ">=0.3.0 <1.0.0" }
  - { id: engineering-docs, version: "0.1.x" }

overrides:
  categories:
    triad:     { severity: info }
    structure: { severity: block }
  rules:
    core.vocab.004: { enabled: false }
  allow_terms: ["robust", "idempotent"]
  thresholds:
    token_floor_words: 40
    reviewer_floor_words: 120

reviewer:
  enabled: true
  categories: [unsupported_claim, vague_claim, register]
  register:
    max_words: 300
    tone: "terse, imperative, no pleasantries"
    format: "title line, blank line, body; a bulleted list only for the list of changes"

enforcement:
  mode: enforce
  pass_cap: 2
  render: diff
`;

describe("profile schema: accepts", () => {
  it("the 04 example, verbatim", () => {
    const p = ok(FULL);
    expect(p.id).toBe("org-default/pr-description");
    expect(p.rule_packs).toHaveLength(2);
    expect(p.overrides?.rules?.["core.vocab.004"]).toEqual({ enabled: false });
  });

  it("a profile that says almost nothing: only schema, id, version, name", () => {
    expect(ok(profileYaml("a/b")).extends).toBeUndefined();
  });

  it("rule-level severity as well as enabled (08 starter profiles need it)", () => {
    const p = ok(profileYaml("a/b", "overrides:\n  rules:\n    core.hedge.003: { severity: info }\n    core.vocab.004: { enabled: false, severity: warn }"));
    expect(p.overrides?.rules?.["core.hedge.003"]).toEqual({ severity: "info" });
    expect(p.overrides?.rules?.["core.vocab.004"]).toEqual({ enabled: false, severity: "warn" });
  });

  it("category overrides on reviewer categories as well", () => {
    expect(ok(profileYaml("a/b", "overrides:\n  categories:\n    register: { severity: warn }")).overrides?.categories?.register).toEqual({ severity: "warn" });
  });

  it("empty lists and an empty register", () => {
    ok(profileYaml("a/b", "reviewer:\n  categories: []\n  register: {}\ntrigger:\n  patterns: []"));
  });
});

describe("profile schema: rejects", () => {
  const cases: Array<[string, string, string]> = [
    ["a bad profile id (no namespace)", profileYaml("base"), "id"],
    ["a bad profile id (uppercase)", profileYaml("Org/base"), "id"],
    ["a bad profile id (three segments)", profileYaml("a/b/c"), "id"],
    ["a bad profile id (underscore)", profileYaml("a/b_c"), "id"],
    ["version 0", profileYaml("a/b", "", { version: 0 }), "version"],
    ["a negative version", profileYaml("a/b", "", { version: -1 }), "version"],
    ["a fractional version", profileYaml("a/b").replace("version: 1", "version: 1.5"), "version"],
    ["a string version", profileYaml("a/b").replace("version: 1", 'version: "1"'), "version"],
    ["a wrong schema marker", profileYaml("a/b").replace("profile/1", "profile/2"), "schema"],
    ["a list in extends", profileYaml("a/b", "", { extends: "[a/c, a/d]" }), "extends"],
    ["extends with a bad id", profileYaml("a/b", "", { extends: "base" }), "extends"],
    ["extends itself", profileYaml("a/b", "", { extends: "a/b" }), "extends"],
    ["a pack with a bad id", profileYaml("a/b", 'rule_packs:\n  - { id: Core, version: "*" }'), "rule_packs[0].id"],
    ["a pack with a non-range version", profileYaml("a/b", 'rule_packs:\n  - { id: core, version: "latest" }'), "rule_packs[0].version"],
    ["a pack with a numeric version", profileYaml("a/b", "rule_packs:\n  - { id: core, version: 1 }"), "rule_packs[0].version"],
    ["a pack listed twice", profileYaml("a/b", 'rule_packs:\n  - { id: core, version: "*" }\n  - { id: core, version: "0.1.x" }'), "rule_packs[1].id"],
    ["an unknown category override", profileYaml("a/b", "overrides:\n  categories:\n    style: { severity: info }"), "overrides.categories.style"],
    ["an unknown severity", profileYaml("a/b", "overrides:\n  categories:\n    triad: { severity: error }"), "overrides.categories.triad.severity"],
    ["a category override with no severity", profileYaml("a/b", "overrides:\n  categories:\n    triad: {}"), "overrides.categories.triad.severity"],
    ["a rule override with neither field", profileYaml("a/b", "overrides:\n  rules:\n    core.hedge.003: {}"), "overrides.rules[\"core.hedge.003\"]"],
    ["a malformed rule id", profileYaml("a/b", "overrides:\n  rules:\n    hedge-3: { enabled: false }"), "overrides.rules[\"hedge-3\"]"],
    ["a negative threshold", profileYaml("a/b", "overrides:\n  thresholds:\n    token_floor_words: -1"), "overrides.thresholds.token_floor_words"],
    ["a fractional threshold", profileYaml("a/b", "overrides:\n  thresholds:\n    reviewer_floor_words: 1.5"), "overrides.thresholds.reviewer_floor_words"],
    ["an empty allow term", profileYaml("a/b", 'overrides:\n  allow_terms: [""]'), "overrides.allow_terms[0]"],
    ["a deterministic category in reviewer.categories", profileYaml("a/b", "reviewer:\n  categories: [hedge]"), "reviewer.categories[0]"],
    ["an unknown reviewer category", profileYaml("a/b", "reviewer:\n  categories: [tone]"), "reviewer.categories[0]"],
    ["a non-boolean reviewer.enabled", profileYaml("a/b", 'reviewer:\n  enabled: "yes"'), "reviewer.enabled"],
    ["max_words 0", profileYaml("a/b", "reviewer:\n  register:\n    max_words: 0"), "reviewer.register.max_words"],
    ["an unknown enforcement mode", profileYaml("a/b", "enforcement:\n  mode: required"), "enforcement.mode"],
    ["pass_cap 3", profileYaml("a/b", "enforcement:\n  pass_cap: 3"), "enforcement.pass_cap"],
    ["pass_cap 0", profileYaml("a/b", "enforcement:\n  pass_cap: 0"), "enforcement.pass_cap"],
    ["an unknown render", profileYaml("a/b", "enforcement:\n  render: full"), "enforcement.render"],
    ["a 201-character trigger description", profileYaml("a/b", `trigger:\n  description: "${"x".repeat(201)}"`), "trigger.description"],
    ["a non-boolean sticky", profileYaml("a/b", "trigger:\n  sticky: 1"), "trigger.sticky"],
  ];
  for (const [label, yaml, path] of cases) {
    it(label, () => {
      expect(issues(yaml).map((i) => i.path), label).toContain(path);
    });
  }

  it("accepts a 200-character trigger description", () => {
    ok(profileYaml("a/b", `trigger:\n  description: "${"x".repeat(200)}"`));
  });

  it("an unknown field at every level, naming the field's path", () => {
    const unknown: Array<[string, string]> = [
      [profileYaml("a/b").replace("name:", "owner: me\nname:"), "owner"],
      [profileYaml("a/b", "trigger:\n  priority: 1"), "trigger.priority"],
      [profileYaml("a/b", 'rule_packs:\n  - { id: core, version: "*", pinned: true }'), "rule_packs[0].pinned"],
      [profileYaml("a/b", "overrides:\n  words: []"), "overrides.words"],
      [profileYaml("a/b", "overrides:\n  categories:\n    triad: { severity: info, why: x }"), "overrides.categories.triad.why"],
      [profileYaml("a/b", "overrides:\n  rules:\n    core.hedge.003: { enabled: false, why: x }"), "overrides.rules[\"core.hedge.003\"].why"],
      [profileYaml("a/b", "overrides:\n  thresholds:\n    min_words: 5"), "overrides.thresholds.min_words"],
      [profileYaml("a/b", "reviewer:\n  model: gpt"), "reviewer.model"],
      [profileYaml("a/b", "reviewer:\n  register:\n    voice: calm"), "reviewer.register.voice"],
      [profileYaml("a/b", "enforcement:\n  required: true"), "enforcement.required"],
    ];
    for (const [yaml, path] of unknown) {
      expect(issues(yaml), path).toContainEqual({ path, message: "unknown field" });
    }
  });

  it("rejects YAML anchors, aliases, tags and merge keys", () => {
    expect(issues(profileYaml("a/b", "trigger:\n  patterns: &p [x]\n  harness_hints: *p"))[0]?.message).toMatch(/anchors? are not allowed|aliases are not allowed/);
    expect(issues(profileYaml("a/b").replace("name: a/b", "name: !!str a"))[0]?.message).toMatch(/tags are not allowed/);
    expect(issues(profileYaml("a/b").replace("name: a/b", "name: !ruby/object:Foo a"))[0]?.message).toMatch(/tags are not allowed/);
    expect(issues(`${profileYaml("a/b")}x: &a {k: v}\ny:\n  <<: *a\n`)[0]?.message).toMatch(/not allowed/);
  });

  it("rejects duplicate keys and a second document", () => {
    expect(issues(profileYaml("a/b", "reviewer:\n  enabled: true\nreviewer:\n  enabled: false"))[0]?.message).toMatch(/DUPLICATE_KEY/);
    expect(issues(`${profileYaml("a/b")}---\nid: a/c\n`)[0]?.message).toMatch(/MULTIPLE_DOCS/);
  });

  it("enforces the 64 KB size limit in bytes, before parsing", () => {
    const limit = 64 * 1024;
    const base = profileYaml("a/b");
    const padded = (bytes: number) => base + "#".repeat(bytes - base.length - 1) + "\n";
    ok(padded(limit));
    const over = issues(padded(limit + 1));
    expect(over).toEqual([{ path: "", message: "document is larger than the 65536-byte limit" }]);
    // 3-byte characters: 30,000 of them is under the limit in characters, over it in bytes
    expect(issues(`${base}#${"€".repeat(30_000)}\n`)[0]?.message).toMatch(/larger than/);
    // four-byte characters count as four
    expect(issues(`${base}#${"\u{1f600}".repeat(20_000)}\n`)[0]?.message).toMatch(/larger than/);
  });

  it("does not echo document content in messages", () => {
    const secret = "SENTINEL-must-not-be-echoed-0123456789";
    for (const yaml of [
      profileYaml("a/b").replace("version: 1", `version: ${secret}`),
      profileYaml("a/b", `trigger:\n  sticky: ${secret}`),
      profileYaml("a/b", `enforcement:\n  mode: ${secret}`),
      `${profileYaml("a/b")}foo: [${secret}\n`,
    ]) {
      const r = parseProfileYaml(yaml);
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error.message).not.toContain(secret);
        expect(JSON.stringify(r.error.issues)).not.toContain(secret);
      }
    }
  });
});
