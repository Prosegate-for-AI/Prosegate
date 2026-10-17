import { describe, expect, it } from "vitest";
import { DEFAULT_THRESHOLDS } from "@prosegate/schema";
import { bundledPackSources, bundledProfileSources } from "./bundled.js";
import { ResolutionError } from "./errors.js";
import {
  effectiveReviewer,
  effectiveRule,
  resolveProfile,
  type LocalOverlay,
  type ResolutionSources,
  type ResolveOptions,
} from "./resolve.js";
import { CORE_PIN, makeSources, orgPolicy, profileYaml } from "./test-util.js";

/** A parent/child pair; the parent pins core. Returns the child's resolution. */
function pair(parentBody: string, childBody: string, packs?: Record<string, string[]>, opts?: ResolveOptions) {
  const sources = makeSources(
    {
      // a parent body that declares its own rule_packs replaces the default core pin
      "t/parent": profileYaml("t/parent", parentBody.includes("rule_packs:") ? parentBody : `${CORE_PIN}\n${parentBody}`),
      "t/child": profileYaml("t/child", childBody, { extends: "t/parent" }),
    },
    packs,
  );
  return resolveProfile("t/child", sources, opts);
}

function failure(fn: () => unknown): ResolutionError {
  try {
    fn();
  } catch (e) {
    if (e instanceof ResolutionError) return e;
    throw e;
  }
  throw new Error("expected a ResolutionError");
}

const rule = (id: string, severity: "block" | "warn" | "info" = "warn") => ({ id, category: id.split(".")[1] as never, severity });

describe("merge rules (04 'Inheritance and resolution')", () => {
  describe("rule_packs", () => {
    it("union by id", () => {
      const r = pair("", 'rule_packs:\n  - { id: eng-docs, version: "0.1.x" }', { core: ["0.1.0"], "eng-docs": ["0.1.4"] });
      expect(r.packs.map((p) => [p.id, p.version, p.pinned_by])).toEqual([
        ["core", "0.1.0", "t/parent"],
        ["eng-docs", "0.1.4", "t/child"],
      ]);
    });

    it("on conflict the child's range wins, and that range is the child's own (normalised), not the intersection", () => {
      const r = pair("", 'rule_packs:\n  - { id: core, version: "0.1.x" }', { core: ["0.1.0", "0.1.7", "0.2.0", "0.9.0"] });
      expect(r.packs).toEqual([{ id: "core", range: ">=0.1.0 <0.2.0-0", version: "0.1.7", pinned_by: "t/child", signed: false, origin: "bundled" }]);
      // a child range wider than the parent's still wins, as long as the two overlap
      const wide = pair('rule_packs:\n  - { id: eng, version: "<0.5.0" }', 'rule_packs:\n  - { id: eng, version: ">=0.1.0" }', { core: ["0.1.0"], eng: ["0.4.0", "0.9.0"] });
      expect(wide.packs.find((p) => p.id === "eng")).toMatchObject({ range: ">=0.1.0", version: "0.9.0", pinned_by: "t/child" });
    });

    it("the parent's pin stands when the child does not mention the pack", () => {
      const r = pair("", "", { core: ["0.1.0", "0.2.0"] });
      expect(r.packs[0]).toMatchObject({ range: ">=0.1.0 <1.0.0", version: "0.2.0", pinned_by: "t/parent" });
    });

    it("packs are listed sorted by id whatever the order in the YAML", () => {
      const r = pair('rule_packs:\n  - { id: zeta, version: ">=1.0.0" }\n  - { id: alpha, version: ">=1.0.0" }', "", {
        core: ["0.1.0"],
        zeta: ["1.0.0"],
        alpha: ["1.0.0"],
      });
      expect(r.packs.map((p) => p.id)).toEqual(["alpha", "zeta"]);
    });
  });

  describe("overrides.categories", () => {
    it("deep merge: child wins per key, parent keys it does not touch survive", () => {
      const r = pair(
        "overrides:\n  categories:\n    triad: { severity: info }\n    structure: { severity: block }",
        "overrides:\n  categories:\n    structure: { severity: warn }\n    hedge: { severity: info }",
      );
      expect(r.categories).toEqual({
        triad: { severity: "info", origin: "t/parent", layer: 0 },
        structure: { severity: "warn", origin: "t/child", layer: 1 },
        hedge: { severity: "info", origin: "t/child", layer: 1 },
      });
    });
  });

  describe("overrides.rules", () => {
    it("deep merge: child wins per key", () => {
      const r = pair(
        "overrides:\n  rules:\n    core.hedge.003: { severity: info }\n    core.vocab.003: { enabled: false }",
        "overrides:\n  rules:\n    core.hedge.003: { severity: block }",
      );
      expect(r.rules["core.hedge.003"]).toEqual({ severity: { value: "block", origin: "t/child", layer: 1 } });
      expect(r.rules["core.vocab.003"]).toEqual({ enabled: { value: false, origin: "t/parent", layer: 0 } });
    });

    it("deep merge goes inside a rule: enabled and severity merge separately, each keeping its own origin", () => {
      const r = pair(
        "overrides:\n  rules:\n    core.hedge.003: { enabled: false, severity: info }",
        "overrides:\n  rules:\n    core.hedge.003: { enabled: true }",
      );
      expect(r.rules["core.hedge.003"]).toEqual({
        enabled: { value: true, origin: "t/child", layer: 1 },
        severity: { value: "info", origin: "t/parent", layer: 0 },
      });
    });
  });

  describe("overrides.thresholds", () => {
    it("defaults to the 03 values when no profile sets them", () => {
      expect(pair("", "").thresholds).toEqual({ token_floor_words: 60, reviewer_floor_words: 150 });
      expect(pair("", "").thresholds).toEqual(DEFAULT_THRESHOLDS);
    });

    it("deep merge: child wins per key", () => {
      const r = pair(
        "overrides:\n  thresholds:\n    token_floor_words: 40\n    reviewer_floor_words: 120",
        "overrides:\n  thresholds:\n    reviewer_floor_words: 200",
      );
      expect(r.thresholds).toEqual({ token_floor_words: 40, reviewer_floor_words: 200 });
    });

    it("a child overrides token_floor_words; the parent's other key survives", () => {
      const r = pair(
        "overrides:\n  thresholds:\n    token_floor_words: 40\n    reviewer_floor_words: 120",
        "overrides:\n  thresholds:\n    token_floor_words: 10",
      );
      expect(r.thresholds).toEqual({ token_floor_words: 10, reviewer_floor_words: 120 });
    });

    it("an unset key falls back to the default, a set key (even 0) is kept", () => {
      expect(pair("overrides:\n  thresholds:\n    token_floor_words: 0", "").thresholds).toEqual({ token_floor_words: 0, reviewer_floor_words: 150 });
    });
  });

  describe("overrides.allow_terms", () => {
    it("union, lowercased, de-duplicated and sorted", () => {
      const r = pair('overrides:\n  allow_terms: ["robust", "idempotent"]', 'overrides:\n  allow_terms: ["Idempotent", "comprehensive", "ROBUST"]');
      expect(r.allow_terms).toEqual(["comprehensive", "idempotent", "robust"]);
    });
  });

  describe("reviewer", () => {
    const parentReviewer =
      "reviewer:\n  enabled: true\n  categories: [unsupported_claim, vague_claim, register]\n  register:\n    max_words: 600\n    tone: parent tone\n    format: parent format";

    it("register: the child replaces the whole object, so keys it omits do not survive", () => {
      const r = pair(parentReviewer, "reviewer:\n  register:\n    max_words: 300");
      expect(r.reviewer.register).toEqual({ max_words: 300 });
    });

    it("register: inherited whole when the child has none", () => {
      expect(pair(parentReviewer, "").reviewer.register).toEqual({ max_words: 600, tone: "parent tone", format: "parent format" });
    });

    it("register: an explicitly empty child register replaces too", () => {
      expect(pair(parentReviewer, "reviewer:\n  register: {}").reviewer.register).toEqual({});
    });

    it("enabled and categories: replaced when present, inherited when not", () => {
      const r = pair(parentReviewer, "reviewer:\n  categories: [register]");
      expect(r.reviewer.enabled).toBe(true);
      expect(r.reviewer.categories).toEqual(["register"]);
      const off = pair(parentReviewer, "reviewer:\n  enabled: false");
      expect(off.reviewer.enabled).toBe(false);
      expect(off.reviewer.categories).toEqual(["vague_claim", "unsupported_claim", "register"]);
    });

    it("enabled: true with no categories means all three categories (ADR-18)", () => {
      const r = pair("", "reviewer:\n  enabled: true");
      expect(r.reviewer.enabled).toBe(true);
      expect(r.reviewer.categories).toEqual(["vague_claim", "unsupported_claim", "register"]);
    });

    it("an explicit empty categories list means the reviewer is off, wherever enabled came from", () => {
      const r = pair(parentReviewer, "reviewer:\n  categories: []");
      expect(r.reviewer.enabled).toBe(false);
      expect(r.reviewer.categories).toEqual([]);
      // a child listing categories under an enabled parent keeps the reviewer on
      expect(pair(parentReviewer, "reviewer:\n  categories: [register]").reviewer.enabled).toBe(true);
    });

    it("categories are de-duplicated and put in a fixed order, so equal sets hash equal", () => {
      const a = pair("", "reviewer:\n  enabled: true\n  categories: [register, vague_claim, register]");
      const b = pair("", "reviewer:\n  enabled: true\n  categories: [vague_claim, register]");
      expect(a.reviewer.categories).toEqual(["vague_claim", "register"]);
      expect(a.version).toBe(b.version);
    });

    it("with no profile saying anything, the reviewer is off with no categories", () => {
      expect(pair("", "").reviewer).toEqual({
        enabled: false,
        categories: [],
        register: {},
        origins: { enabled: null, categories: null, register: null },
      });
    });

    it("tracks which profile set enabled, categories and register", () => {
      const r = pair(
        "reviewer:\n  enabled: true\n  categories: [register]\n  register:\n    max_words: 600",
        "reviewer:\n  categories: [vague_claim, register]\n  register:\n    max_words: 300",
      );
      expect(r.reviewer.origins).toEqual({ enabled: "t/parent", categories: "t/child", register: "t/child" });
    });
  });

  describe("effectiveReviewer", () => {
    it("returns the settings with the profile that set each, and the leaf id for defaults", () => {
      const r = pair("reviewer:\n  enabled: true\n  register:\n    max_words: 600", "reviewer:\n  categories: [register]");
      expect(effectiveReviewer(r)).toEqual({
        enabled: true,
        categories: ["register"],
        register: { max_words: 600 },
        origin: { enabled: "t/parent", categories: "t/child", register: "t/parent" },
      });
      const none = effectiveReviewer(pair("", ""));
      expect(none.origin).toEqual({ enabled: "t/child", categories: "t/child", register: "t/child" });
      expect(none.enabled).toBe(false);
    });
  });

  describe("enforcement and trigger", () => {
    it("enforcement.*: each key replaced when present, inherited when not", () => {
      const r = pair("enforcement:\n  mode: advisory\n  pass_cap: 1\n  render: summary", "enforcement:\n  mode: enforce");
      expect(r.enforcement).toEqual({ mode: "enforce", pass_cap: 1, render: "summary", required: false });
    });

    it("a child overrides render and pass_cap; the parent's mode survives", () => {
      const r = pair("enforcement:\n  mode: advisory\n  pass_cap: 1\n  render: summary", "enforcement:\n  render: none\n  pass_cap: 2");
      expect(r.enforcement).toEqual({ mode: "advisory", pass_cap: 2, render: "none", required: false });
    });

    it("enforcement defaults: enforce, pass_cap 2, render diff", () => {
      expect(pair("", "").enforcement).toEqual({ mode: "enforce", pass_cap: 2, render: "diff", required: false });
    });

    it("trigger.*: each key replaced when present (a list replaces, it is not unioned)", () => {
      const r = pair(
        'trigger:\n  description: "Parent."\n  patterns: [a, b]\n  harness_hints: [h1]\n  sticky: false',
        "trigger:\n  patterns: [c]\n  sticky: true",
      );
      expect(r.trigger).toEqual({ description: "Parent.", patterns: ["c"], harness_hints: ["h1"], sticky: true });
    });

    it("harness_hints replace the parent's list; omitted keys are inherited, including sticky", () => {
      const r = pair('trigger:\n  patterns: [a]\n  harness_hints: [h1, h2]\n  sticky: false', "trigger:\n  harness_hints: [h3]");
      expect(r.trigger.harness_hints).toEqual(["h3"]);
      expect(r.trigger.patterns).toEqual(["a"]);
      expect(r.trigger.sticky).toBe(false);
    });

    it("trigger defaults: no description, empty lists, sticky", () => {
      expect(pair("", "").trigger).toEqual({ description: null, patterns: [], harness_hints: [], sticky: true });
    });
  });

  it("name is the leaf's; id is the leaf id; resolved_from is root first", () => {
    const r = pair("", "");
    expect(r.id).toBe("t/child");
    expect(r.name).toBe("t/child");
    expect(r.resolved_from).toEqual(["t/parent", "t/child"]);
  });

  it("a single profile with no parent resolves", () => {
    const r = resolveProfile("t/solo", makeSources({ "t/solo": profileYaml("t/solo", CORE_PIN) }));
    expect(r.resolved_from).toEqual(["t/solo"]);
    expect(r.version).toMatch(/^1\+[0-9a-f]{8}$/);
    expect(r.overlays_ignored).toBe(false);
  });
});

describe("chain errors", () => {
  it("cycle: names the loop", () => {
    const sources = makeSources({
      "t/a": profileYaml("t/a", "", { extends: "t/b" }),
      "t/b": profileYaml("t/b", "", { extends: "t/c" }),
      "t/c": profileYaml("t/c", "", { extends: "t/a" }),
    });
    const e = failure(() => resolveProfile("t/a", sources));
    expect(e.code).toBe("cycle");
    expect(e.message).toContain("t/a -> t/b -> t/c -> t/a");
  });

  it("cycle: a two-profile loop entered from outside it", () => {
    const sources = makeSources({
      "t/leaf": profileYaml("t/leaf", "", { extends: "t/a" }),
      "t/a": profileYaml("t/a", "", { extends: "t/b" }),
      "t/b": profileYaml("t/b", "", { extends: "t/a" }),
    });
    const e = failure(() => resolveProfile("t/leaf", sources));
    expect(e.code).toBe("cycle");
    expect(e.message).toContain("t/leaf -> t/a -> t/b -> t/a");
  });

  it("cycle: a longer loop is still reported as a cycle, not as depth", () => {
    const names = ["t/a", "t/b", "t/c", "t/d"];
    const sources = makeSources(Object.fromEntries(names.map((n, i) => [n, profileYaml(n, "", { extends: names[(i + 1) % 4] as string })])));
    expect(failure(() => resolveProfile("t/a", sources)).code).toBe("cycle");
  });

  it("depth 3 resolves; depth 4 is depth_exceeded and names the chain", () => {
    const three = makeSources({
      "t/c": profileYaml("t/c", CORE_PIN),
      "t/b": profileYaml("t/b", "", { extends: "t/c" }),
      "t/a": profileYaml("t/a", "", { extends: "t/b" }),
    });
    expect(resolveProfile("t/a", three).resolved_from).toEqual(["t/c", "t/b", "t/a"]);

    const four = makeSources({
      "t/d": profileYaml("t/d", CORE_PIN),
      "t/c": profileYaml("t/c", "", { extends: "t/d" }),
      "t/b": profileYaml("t/b", "", { extends: "t/c" }),
      "t/a": profileYaml("t/a", "", { extends: "t/b" }),
    });
    const e = failure(() => resolveProfile("t/a", four));
    expect(e.code).toBe("depth_exceeded");
    expect(e.message).toContain("t/a -> t/b -> t/c -> t/d");
  });

  it("the walk guard stops a long chain before it reaches a missing parent", () => {
    // 40 profiles, the last extends one that does not exist. Without the walk limit the error would
    // be missing_parent; with it, the walk stops at 32 profiles with depth_exceeded.
    const ids = Array.from({ length: 40 }, (_, i) => `t/p${i}`);
    const profiles = Object.fromEntries(ids.map((id, i) => [id, profileYaml(id, "", { extends: i + 1 < ids.length ? (ids[i + 1] as string) : "t/gone" })]));
    const e = failure(() => resolveProfile("t/p0", makeSources(profiles)));
    expect(e.code).toBe("depth_exceeded");
    expect(e.message).toContain("longer than 32");
    expect(e.ids).toEqual(["t/p0"]);
  });

  it("missing parent: names the child and the parent", () => {
    const e = failure(() => resolveProfile("t/a", makeSources({ "t/a": profileYaml("t/a", "", { extends: "t/gone" }) })));
    expect(e.code).toBe("missing_parent");
    expect(e.message).toContain("'t/a' extends 't/gone'");
    expect(e.ids).toEqual(["t/a", "t/gone"]);
  });

  it("missing leaf is also missing_parent, with its own wording", () => {
    const e = failure(() => resolveProfile("t/none", makeSources({})));
    expect(e.code).toBe("missing_parent");
    expect(e.message).toContain("'t/none' was not found");
  });

  it("an invalid profile in the chain is invalid_profile, naming it and the field", () => {
    const sources = makeSources({
      "t/a": profileYaml("t/a", "", { extends: "t/b" }),
      "t/b": profileYaml("t/b", "enforcement:\n  pass_cap: 5"),
    });
    const e = failure(() => resolveProfile("t/a", sources));
    expect(e.code).toBe("invalid_profile");
    expect(e.message).toContain("'t/b'");
    expect(e.message).toContain("enforcement.pass_cap");
    expect(e.ids).toEqual(["t/b"]);
  });

  it("a profile stored under a different id than it declares is rejected", () => {
    const e = failure(() => resolveProfile("t/a", makeSources({ "t/a": profileYaml("t/other", CORE_PIN) })));
    expect(e.code).toBe("invalid_profile");
    expect(e.message).toContain("stored as 't/a' declares id 't/other'");
  });
});

describe("pack ranges (04: every pair, and all together, must intersect)", () => {
  const chain3 = (base: string, domain: string, project: string, packs = { core: ["0.1.0", "0.7.0", "1.2.0", "1.6.0"] }) =>
    resolveProfile(
      "t/project",
      makeSources(
        {
          "t/base": profileYaml("t/base", `rule_packs:\n  - { id: core, version: ${JSON.stringify(base)} }`),
          "t/domain": profileYaml("t/domain", `rule_packs:\n  - { id: core, version: ${JSON.stringify(domain)} }`, { extends: "t/base" }),
          "t/project": profileYaml("t/project", `rule_packs:\n  - { id: core, version: ${JSON.stringify(project)} }`, { extends: "t/domain" }),
        },
        packs,
      ),
    );

  it("range_conflict: names both profiles and both ranges", () => {
    const e = failure(() => pair('rule_packs:\n  - { id: eng, version: "<0.5.0" }', 'rule_packs:\n  - { id: eng, version: ">=1.0.0" }', { eng: ["0.4.0", "1.2.0"] }));
    expect(e.code).toBe("range_conflict");
    expect(e.message).toContain("'eng'");
    expect(e.message).toContain("'t/parent' requires '<0.5.0'");
    expect(e.message).toContain("'t/child' requires '>=1.0.0'");
    expect(e.ids).toEqual(["t/parent", "t/child", "eng"]);
  });

  it("probe 1: base <1.0.0 / domain >=0.5.0 <2.0.0 / project >=1.5.0 is an error naming base and project", () => {
    const e = failure(() => chain3("<1.0.0", ">=0.5.0 <2.0.0", ">=1.5.0"));
    expect(e.code).toBe("range_conflict");
    expect(e.message).toContain("'t/base' requires '<1.0.0'");
    expect(e.message).toContain("'t/project' requires '>=1.5.0'");
    expect(e.ids).toEqual(["t/base", "t/project", "core"]);
  });

  it("probe 2: <0.5.0 / <0.8.0 / >=0.6.0 is an error naming base and project", () => {
    const e = failure(() => chain3("<0.5.0", "<0.8.0", ">=0.6.0"));
    expect(e.code).toBe("range_conflict");
    expect(e.message).toContain("'t/base' requires '<0.5.0'");
    expect(e.message).toContain("'t/project' requires '>=0.6.0'");
  });

  it("a middle layer that is disjoint from the base is named too", () => {
    const e = failure(() => chain3(">=1.0.0", "<0.5.0", ">=0.1.0"));
    expect(e.message).toContain("'t/base' requires '>=1.0.0'");
    expect(e.message).toContain("'t/domain' requires '<0.5.0'");
  });

  it("pairwise-compatible ranges with no version in common are an error naming all of them (|| unions)", () => {
    const e = failure(() => chain3("1.x || 2.x", "2.x || 3.x", "1.x || 3.x", { core: ["1.1.0", "2.1.0", "3.1.0"] }));
    expect(e.code).toBe("range_conflict");
    expect(e.message).toContain("no version in common");
    expect(e.message).toContain("'t/base'");
    expect(e.message).toContain("'t/domain'");
    expect(e.message).toContain("'t/project'");
  });

  it("three overlapping ranges resolve, with the child's range stored normalised", () => {
    const r = chain3("<2.0.0", ">=0.5.0 <1.9.0", "1.x", { core: ["0.7.0", "1.2.0", "1.6.0", "1.9.5"] });
    expect(r.packs[0]).toMatchObject({ range: ">=1.0.0 <2.0.0-0", version: "1.9.5", pinned_by: "t/project" });
  });

  it("a range that overlaps only at its edge is not a conflict", () => {
    const r = pair('rule_packs:\n  - { id: eng, version: "<=0.5.0" }', 'rule_packs:\n  - { id: eng, version: ">=0.5.0" }', { eng: ["0.5.0", "0.6.0"] });
    expect(r.packs.find((p) => p.id === "eng")?.version).toBe("0.6.0");
  });

  it("a conflict between a synced profile and its own local overlay names the id once", () => {
    const sources = makeSources({ "a/a": profileYaml("a/a", 'rule_packs:\n  - { id: core, version: ">=1.0.0" }') }, { core: ["1.0.0"] });
    const local: LocalOverlay = { profiles: { "a/a": { yaml: profileYaml("a/a", 'rule_packs:\n  - { id: core, version: "<0.5.0" }') } } };
    const e = failure(() => resolveProfile("a/a", sources, { local }));
    expect(e.code).toBe("range_conflict");
    expect(e.ids).toEqual(["a/a", "core"]);
    expect(e.message).toContain("'a/a' requires '>=1.0.0'");
    expect(e.message).toContain("'a/a (local overlay)' requires '<0.5.0'");
  });

  it("wildcard and empty ranges are an invalid_profile at resolution", () => {
    for (const bad of ["*", "x", "", "  ", "||"]) {
      const e = failure(() => resolveProfile("t/a", makeSources({ "t/a": profileYaml("t/a", `rule_packs:\n  - { id: core, version: ${JSON.stringify(bad)} }`) })));
      expect(e.code, JSON.stringify(bad)).toBe("invalid_profile");
    }
  });
});

describe("pack version selection", () => {
  it("no_pack_version: names the profile, the pack, the range and what was available", () => {
    const e = failure(() => pair("", "", { core: ["1.0.0", "2.0.0"] }));
    expect(e.code).toBe("no_pack_version");
    expect(e.message).toContain("'t/parent' pins rule pack 'core' at '>=0.1.0 <1.0.0'");
    expect(e.message).toContain("1.0.0, 2.0.0");
  });

  it("no_pack_version: a pack with no versions at all", () => {
    const e = failure(() => pair("", "", {}));
    expect(e.code).toBe("no_pack_version");
    expect(e.message).toContain("available: none");
  });

  it("picks the highest available version in range, whatever order they are listed in", () => {
    const r = pair("", "", { core: ["0.2.0", "0.10.0", "0.9.9", "1.0.0", "0.1.0", "1.1.0-beta.1"] });
    expect(r.packs[0]?.version).toBe("0.10.0");
  });

  it("prereleases are never chosen unless the winning range names one", () => {
    expect(pair("", "", { core: ["0.1.0", "0.2.0-beta.1", "0.1.5-rc.1"] }).packs[0]?.version).toBe("0.1.0");
    const onlyPre = failure(() => pair("", "", { core: ["0.2.0-beta.1"] }));
    expect(onlyPre.code).toBe("no_pack_version");
    expect(onlyPre.message).toContain("prerelease versions are only considered when the range names one");
    const named = pair("", 'rule_packs:\n  - { id: core, version: ">=0.2.0-beta.0 <0.3.0" }', { core: ["0.1.0", "0.2.0-beta.1"] });
    expect(named.packs[0]?.version).toBe("0.2.0-beta.1");
  });

  it("a non-semver version in the source list is invalid_pack", () => {
    const e = failure(() => pair("", "", { core: ["0.1.0", "latest"] }));
    expect(e.code).toBe("invalid_pack");
  });
});

describe("signed and bundled sources (ADR-19)", () => {

  it("synced content must be signed: an unsigned synced profile or pack version is rejected", () => {
    const sources: ResolutionSources = {
      profiles: { "t/a": { yaml: profileYaml("t/a", CORE_PIN), signed: false, origin: "synced" } },
      packs: { core: [{ version: "0.1.0", signed: true, origin: "synced" }] },
    };
    expect(failure(() => resolveProfile("t/a", sources)).code).toBe("invalid_profile");
    const badPack: ResolutionSources = {
      profiles: { "t/a": { yaml: profileYaml("t/a", CORE_PIN), signed: true, origin: "synced" } },
      packs: { core: [{ version: "0.1.0", signed: false, origin: "synced" }] },
    };
    expect(failure(() => resolveProfile("t/a", badPack)).code).toBe("invalid_pack");
  });

  it("bundled content may be unsigned, and is recorded as bundled", () => {
    const r = resolveProfile("local/pr-description", { profiles: bundledProfileSources(), packs: bundledPackSources() });
    expect(r.sources.map((s) => [s.id, s.signed, s.origin])).toEqual([
      ["local/base", false, "bundled"],
      ["local/pr-description", false, "bundled"],
    ]);
    expect(r.packs[0]).toMatchObject({ id: "core", version: "0.1.0", signed: false, origin: "bundled" });
  });

  it("a pin from a signed layer does not resolve to a local (unsigned) pack version", () => {
    const sources = makeSources({ "t/a": profileYaml("t/a", 'rule_packs:\n  - { id: mine, version: ">=1.0.0" }') }, {});
    const local: LocalOverlay = { packs: { mine: ["1.2.0"] } };
    const e = failure(() => resolveProfile("t/a", sources, { local }));
    expect(e.code).toBe("no_pack_version");
    expect(e.message).toContain("only accepts signed or bundled versions");
  });

  it("a pin from a local (unsigned) layer may resolve to a local pack version", () => {
    const sources = makeSources({}, {});
    const local: LocalOverlay = {
      profiles: { "me/mine": { yaml: profileYaml("me/mine", 'rule_packs:\n  - { id: mine, version: ">=1.0.0" }') } },
      packs: { mine: ["1.2.0"] },
    };
    const r = resolveProfile("me/mine", sources, { local });
    expect(r.packs[0]).toMatchObject({ version: "1.2.0", origin: "local", signed: false });
  });

  it("a pin from a signed layer may resolve to a bundled version (offline use)", () => {
    const sources: ResolutionSources = {
      profiles: makeSources({ "t/a": profileYaml("t/a", CORE_PIN) }).profiles,
      packs: bundledPackSources(),
    };
    expect(resolveProfile("t/a", sources).packs[0]).toMatchObject({ version: "0.1.0", origin: "bundled" });
  });

  it("with duplicate pack versions, the signed one wins whatever the input order", () => {
    const synced = { version: "0.1.0", signed: true, origin: "synced" as const };
    const bundled = { version: "0.1.0", signed: false, origin: "bundled" as const };
    const profiles = makeSources({ "t/a": profileYaml("t/a", 'rule_packs:\n  - { id: eng, version: ">=0.1.0 <1.0.0" }') }).profiles;
    for (const list of [[synced, bundled], [bundled, synced]]) {
      const r = resolveProfile("t/a", { profiles, packs: { eng: list } });
      expect(r.packs[0]).toMatchObject({ signed: true, origin: "synced" });
    }
  });

  it("the chain can mix bundled and synced profiles", () => {
    const r = resolveProfile("t/org", {
      profiles: { ...bundledProfileSources(), ...makeSources({ "t/org": profileYaml("t/org", "", { extends: "local/base" }) }).profiles },
      packs: bundledPackSources(),
    });
    expect(r.packs[0]).toMatchObject({ origin: "bundled", pinned_by: "local/base" });
    expect(r.sources.map((s) => s.origin)).toEqual(["bundled", "synced"]);
  });
});

describe("strict source shape (cycle 2)", () => {
  const goodProfile = { yaml: profileYaml("t/a", CORE_PIN), signed: true, origin: "synced" };
  const run = (profiles: unknown, packs: unknown = { core: [{ version: "0.1.0", signed: false, origin: "bundled" }] }) =>
    failure(() => resolveProfile("t/a", { profiles, packs } as never));

  it("a good source resolves", () => {
    expect(resolveProfile("t/a", { profiles: { "t/a": goodProfile }, packs: { core: [{ version: "0.1.0", signed: false, origin: "bundled" }] } } as never).id).toBe("t/a");
  });

  it("profile origin must be exactly synced or bundled", () => {
    for (const origin of ["network", "cdn", "local", "SYNCED", "", undefined, null, 1]) {
      const e = run({ "t/a": { ...goodProfile, origin } });
      expect(e.code, String(origin)).toBe("invalid_profile");
      expect(e.issues.map((i) => i.path), String(origin)).toContain("origin");
    }
  });

  it("signed must be a boolean: the string 'false' and other truthy values are rejected", () => {
    for (const signed of ["false", "true", "", 0, 1, null, undefined]) {
      const e = run({ "t/a": { ...goodProfile, signed } });
      expect(e.code, String(signed)).toBe("invalid_profile");
      expect(e.issues.map((i) => i.path), String(signed)).toContain("signed");
    }
  });

  it("synced requires signed === true", () => {
    const e = run({ "t/a": { ...goodProfile, signed: false } });
    expect(e.code).toBe("invalid_profile");
    expect(e.issues).toContainEqual({ path: "signed", message: "synced content must be signed; unsigned network content is refused" });
    // bundled may be unsigned
    expect(resolveProfile("t/a", { profiles: { "t/a": { ...goodProfile, origin: "bundled", signed: false } }, packs: { core: [{ version: "0.1.0", signed: false, origin: "bundled" }] } } as never).id).toBe("t/a");
  });

  it("unknown fields and a missing yaml are rejected", () => {
    expect(run({ "t/a": { ...goodProfile, extra: 1 } }).issues).toContainEqual({ path: "extra", message: "unknown field" });
    expect(run({ "t/a": { signed: true, origin: "synced" } }).issues.map((i) => i.path)).toContain("yaml");
    expect(run({ "t/a": "yaml text" }).code).toBe("invalid_profile");
    expect(run({ "t/a": null }).code).toBe("invalid_profile");
  });

  it("pack version origin must be exactly synced or bundled; cdn and network are rejected", () => {
    for (const origin of ["cdn", "network", "local", undefined, 5]) {
      const e = run({ "t/a": goodProfile }, { core: [{ version: "0.1.0", signed: true, origin }] });
      expect(e.code, String(origin)).toBe("invalid_pack");
      expect(e.issues.map((i) => i.path), String(origin)).toContain("[0].origin");
    }
  });

  it("pack version signed must be a boolean, and synced needs true", () => {
    for (const signed of ["false", "true", 0, 1, null]) {
      expect(run({ "t/a": goodProfile }, { core: [{ version: "0.1.0", signed, origin: "synced" }] }).code, String(signed)).toBe("invalid_pack");
    }
    expect(run({ "t/a": goodProfile }, { core: [{ version: "0.1.0", signed: false, origin: "synced" }] }).code).toBe("invalid_pack");
    expect(run({ "t/a": goodProfile }, { core: [{ version: "0.1.0", signed: true, origin: "synced", extra: 1 }] }).code).toBe("invalid_pack");
    expect(run({ "t/a": goodProfile }, { core: [{ signed: true, origin: "synced" }] }).code).toBe("invalid_pack");
    expect(run({ "t/a": goodProfile }, { core: "0.1.0" }).code).toBe("invalid_pack");
  });

  it("bad profile and pack ids as keys, and non-record sources, are rejected", () => {
    expect(run({ "Bad Id": goodProfile }).code).toBe("invalid_profile");
    expect(run({ "t/a": goodProfile }, { "Bad Pack": [] }).code).toBe("invalid_pack");
    expect(failure(() => resolveProfile("t/a", { profiles: new Map(), packs: {} } as never)).code).toBe("invalid_profile");
    expect(failure(() => resolveProfile("t/a", { profiles: [], packs: {} } as never)).code).toBe("invalid_profile");
    expect(failure(() => resolveProfile("t/a", null as never)).code).toBe("invalid_profile");
  });

  it("local overlays keep their own path: no origin or signed field, shape only", () => {
    const sources = makeSources({ "t/a": profileYaml("t/a", CORE_PIN) });
    const overlay = (yaml: unknown) => ({ profiles: { "t/a": yaml } } as never);
    expect(resolveProfile("t/a", sources, { local: overlay({ yaml: profileYaml("t/a", "") }) }).sources.at(-1)).toMatchObject({ origin: "local", signed: false });
    expect(failure(() => resolveProfile("t/a", sources, { local: overlay({ yaml: profileYaml("t/a", ""), signed: true, origin: "synced" }) })).code).toBe("invalid_profile");
    expect(failure(() => resolveProfile("t/a", sources, { local: overlay("text") })).code).toBe("invalid_profile");
    expect(failure(() => resolveProfile("t/a", sources, { local: { packs: { mine: "1.0.0" } } as never })).code).toBe("invalid_pack");
  });
});

describe("local overlay containers are plain records (cycle 2)", () => {
  const sources = makeSources({ "acme/a": profileYaml("acme/a", CORE_PIN) });
  const required = orgPolicy({ enforcement_default: "required" });

  it("a Map for local.profiles or local.packs is rejected, so overlays_ignored cannot be dodged", () => {
    const mapProfiles = new Map([["acme/a", { yaml: profileYaml("acme/a", "") }]]);
    const e = failure(() => resolveProfile("acme/a", sources, { policy: required, local: { profiles: mapProfiles as never } }));
    expect(e.code).toBe("invalid_profile");
    expect(e.message).toContain("a Map is not accepted");
    const e2 = failure(() => resolveProfile("acme/a", sources, { policy: required, local: { packs: new Map([["x", ["1.0.0"]]]) as never } }));
    expect(e2.code).toBe("invalid_pack");
    // and without a policy as well
    expect(failure(() => resolveProfile("acme/a", sources, { local: { profiles: mapProfiles as never } })).code).toBe("invalid_profile");
  });

  it("a record under required sets overlays_ignored; a null-prototype record counts as a record", () => {
    const record = Object.assign(Object.create(null) as object, { "acme/a": { yaml: profileYaml("acme/a", "") } });
    expect(resolveProfile("acme/a", sources, { policy: required, local: { profiles: record as never } }).overlays_ignored).toBe(true);
    expect(resolveProfile("acme/a", sources, { policy: required, local: { profiles: { "acme/a": { yaml: profileYaml("acme/a", "") } } } }).overlays_ignored).toBe(true);
  });

  it("an array or an unknown key in local is rejected", () => {
    expect(failure(() => resolveProfile("acme/a", sources, { local: { profiles: [] as never } })).code).toBe("invalid_profile");
    expect(failure(() => resolveProfile("acme/a", sources, { local: { extra: {} } as never })).code).toBe("invalid_profile");
  });
});

describe("reserved namespaces (cycle 2)", () => {
  it("refuses synced profiles in local, prosegate and core, naming the profile", () => {
    for (const ns of ["local", "prosegate", "core"]) {
      const sources = makeSources({ [`${ns}/base`]: profileYaml(`${ns}/base`, CORE_PIN) });
      const e = failure(() => resolveProfile(`${ns}/base`, sources));
      expect(e.code, ns).toBe("invalid_profile");
      expect(e.message).toContain(`reserved namespace '${ns}'`);
      expect(e.ids).toEqual([`${ns}/base`]);
    }
  });

  it("refuses it even when the reserved profile is only a parent", () => {
    const sources = makeSources({
      "t/a": profileYaml("t/a", "", { extends: "local/base" }),
      "local/base": profileYaml("local/base", CORE_PIN),
    });
    expect(failure(() => resolveProfile("t/a", sources)).code).toBe("invalid_profile");
  });

  it("bundled profiles live in local", () => {
    expect(resolveProfile("local/base", { profiles: bundledProfileSources(), packs: bundledPackSources() }).id).toBe("local/base");
  });

  it("a synced profile in local cannot shadow a starter: the sources are rejected before anything resolves", () => {
    const profiles = { ...bundledProfileSources(), "local/base": { yaml: profileYaml("local/base", CORE_PIN), signed: true, origin: "synced" as const } };
    expect(failure(() => resolveProfile("local/pr-description", { profiles, packs: bundledPackSources() })).code).toBe("invalid_profile");
  });

  it("a local overlay may overlay a bundled starter", () => {
    const local: LocalOverlay = { profiles: { "local/base": { yaml: profileYaml("local/base", "overrides:\n  allow_terms: [mine]") } } };
    expect(resolveProfile("local/base", { profiles: bundledProfileSources(), packs: bundledPackSources() }, { local }).allow_terms).toEqual(["mine"]);
  });
});

describe("core is bundled-only in v0 (ADR-21, cycle 2)", () => {
  // 04 says a pack id is "unique per publisher"; there is no publisher namespace yet, so `core` is
  // reserved for the bundled pack and a synced `core` (signed or not) is not used.
  const profiles = makeSources({ "t/a": profileYaml("t/a", CORE_PIN) }).profiles;
  const bundled = { version: "0.1.0", signed: false, origin: "bundled" as const };
  const syncedCore = { version: "0.9.0", signed: true, origin: "synced" as const };

  it("a synced signed core 0.9.0 is refused and the bundled 0.1.0 is used", () => {
    for (const list of [[bundled, syncedCore], [syncedCore, bundled]]) {
      const r = resolveProfile("t/a", { profiles, packs: { core: list } });
      expect(r.packs[0]).toMatchObject({ id: "core", version: "0.1.0", origin: "bundled", signed: false });
    }
  });

  it("a pin only the synced core could satisfy is a no_pack_version, not a silent upgrade", () => {
    const sources = { profiles: makeSources({ "t/a": profileYaml("t/a", 'rule_packs:\n  - { id: core, version: ">=0.5.0 <1.0.0" }') }).profiles, packs: { core: [bundled, syncedCore] } };
    const e = failure(() => resolveProfile("t/a", sources));
    expect(e.code).toBe("no_pack_version");
    expect(e.message).toContain("available: 0.1.0;");
    expect(e.message).not.toContain("0.9.0");
  });

  it("with no bundled core at all, a synced core is not used", () => {
    expect(failure(() => resolveProfile("t/a", { profiles, packs: { core: [syncedCore] } })).code).toBe("no_pack_version");
  });

  it("other pack ids may be synced", () => {
    const sources = { profiles: makeSources({ "t/a": profileYaml("t/a", 'rule_packs:\n  - { id: eng, version: ">=0.5.0" }') }).profiles, packs: { eng: [syncedCore] } };
    expect(resolveProfile("t/a", sources).packs[0]).toMatchObject({ id: "eng", version: "0.9.0", origin: "synced" });
  });

  it("a signed pin may resolve to the bundled core (ADR-21)", () => {
    expect(resolveProfile("t/a", { profiles, packs: { core: [bundled] } }).packs[0]?.origin).toBe("bundled");
  });
});

describe("the whole chain under required (cycle 2)", () => {
  const required = orgPolicy({ enforcement_default: "required" });
  const packs = { core: [{ version: "0.1.0", signed: false, origin: "bundled" as const }] };
  const sources = (profiles: Record<string, string>) => ({ profiles: makeSources(profiles).profiles, packs });

  it("acme/x extending alice/lax is refused with policy_requires_org_profile", () => {
    const s = sources({
      "acme/x": profileYaml("acme/x", "", { extends: "alice/lax" }),
      "alice/lax": profileYaml("alice/lax", `${CORE_PIN}\noverrides:\n  categories:\n    structure: { severity: info }`),
    });
    const e = failure(() => resolveProfile("acme/x", s, { policy: required }));
    expect(e.code).toBe("policy_requires_org_profile");
    expect(e.message).toBe("Enforcement is required by Acme; ask an admin, or uninstall.");
    expect(e.ids).toEqual(["acme/x", "alice/lax"]);
  });

  it("a stranger in the middle of the chain is refused too", () => {
    const s = sources({
      "acme/a": profileYaml("acme/a", "", { extends: "bob/mid" }),
      "bob/mid": profileYaml("bob/mid", "", { extends: "acme/base" }),
      "acme/base": profileYaml("acme/base", CORE_PIN),
    });
    expect(failure(() => resolveProfile("acme/a", s, { policy: required })).code).toBe("policy_requires_org_profile");
  });

  it("an org chain entirely in the org's namespace resolves", () => {
    const s = sources({
      "acme/a": profileYaml("acme/a", "", { extends: "acme/base" }),
      "acme/base": profileYaml("acme/base", CORE_PIN),
    });
    expect(resolveProfile("acme/a", s, { policy: required }).resolved_from).toEqual(["acme/base", "acme/a"]);
  });

  it("a bundled parent is allowed (the starters ship with the signed adapter)", () => {
    const s = { profiles: { ...bundledProfileSources(), ...makeSources({ "acme/x": profileYaml("acme/x", "", { extends: "local/base" }) }).profiles }, packs };
    const r = resolveProfile("acme/x", s, { policy: required });
    expect(r.resolved_from).toEqual(["local/base", "acme/x"]);
    expect(r.enforcement.required).toBe(true);
  });

  it("without required, the same chain resolves", () => {
    const s = sources({
      "acme/x": profileYaml("acme/x", "", { extends: "alice/lax" }),
      "alice/lax": profileYaml("alice/lax", CORE_PIN),
    });
    expect(resolveProfile("acme/x", s, { policy: orgPolicy({ enforcement_default: "advisory" }) }).resolved_from).toEqual(["alice/lax", "acme/x"]);
  });
});

describe("local overlay (04 'Versioning, pinning and caching', ADR-18)", () => {
  const synced = {
    "o/base": profileYaml("o/base", `${CORE_PIN}\noverrides:\n  categories:\n    triad: { severity: info }\n  allow_terms: [robust]`, { version: 7 }),
    "o/pr": profileYaml("o/pr", "overrides:\n  categories:\n    structure: { severity: block }", { version: 4, extends: "o/base" }),
  };

  it("a local profile with a synced id merges as a child of it, local wins", () => {
    const local: LocalOverlay = {
      profiles: { "o/pr": { yaml: profileYaml("o/pr", "overrides:\n  categories:\n    structure: { severity: info }\n  allow_terms: [mine]", { version: 1, extends: "o/base" }) } },
    };
    const r = resolveProfile("o/pr", makeSources(synced), { local });
    expect(r.categories.structure).toMatchObject({ severity: "info", origin: "o/pr" });
    expect(r.categories.triad).toMatchObject({ severity: "info", origin: "o/base" });
    expect(r.allow_terms).toEqual(["mine", "robust"]);
  });

  it("is one chain entry, and is recorded: resolved_from lists the id once, sources lists both documents", () => {
    const local: LocalOverlay = { profiles: { "o/pr": { yaml: profileYaml("o/pr", "", { version: 2, extends: "o/base" }) } } };
    const r = resolveProfile("o/pr", makeSources(synced), { local });
    expect(r.resolved_from).toEqual(["o/base", "o/pr"]);
    expect(r.sources).toEqual([
      { id: "o/base", version: 7, signed: true, origin: "synced" },
      { id: "o/pr", version: 4, signed: true, origin: "synced" },
      { id: "o/pr", version: 2, signed: false, origin: "local" },
    ]);
  });

  it("the snapshot integer is the synced leaf's version; the hash covers the overlay (ADR-18)", () => {
    const sources = makeSources(synced);
    const plain = resolveProfile("o/pr", sources);
    const overlay = (severity: string): LocalOverlay => ({
      profiles: { "o/pr": { yaml: profileYaml("o/pr", `overrides:\n  categories:\n    structure: { severity: ${severity} }`, { version: 99, extends: "o/base" }) } },
    });
    const a = resolveProfile("o/pr", sources, { local: overlay("info") });
    const b = resolveProfile("o/pr", sources, { local: overlay("warn") });
    expect(plain.version.startsWith("4+")).toBe(true);
    expect(a.version.startsWith("4+")).toBe(true);
    expect(b.version.startsWith("4+")).toBe(true);
    expect(new Set([plain.version, a.version, b.version]).size).toBe(3);
  });

  it("a local-only leaf uses its own version", () => {
    const local: LocalOverlay = { profiles: { "me/mine": { yaml: profileYaml("me/mine", "", { extends: "o/base", version: 5 }) } } };
    expect(resolveProfile("me/mine", makeSources(synced), { local }).version.startsWith("5+")).toBe(true);
  });

  it("an overlay must keep the synced profile's extends: a different parent, or dropping it, is rejected", () => {
    const other = makeSources({ ...synced, "o/other": profileYaml("o/other", "") });
    const different: LocalOverlay = { profiles: { "o/pr": { yaml: profileYaml("o/pr", "", { extends: "o/other" }) } } };
    const e = failure(() => resolveProfile("o/pr", other, { local: different }));
    expect(e.code).toBe("invalid_profile");
    expect(e.message).toContain("must keep the synced profile's extends (o/base)");
    expect(e.ids).toEqual(["o/pr"]);
    const dropped: LocalOverlay = { profiles: { "o/pr": { yaml: profileYaml("o/pr", "") } } };
    expect(failure(() => resolveProfile("o/pr", other, { local: dropped })).code).toBe("invalid_profile");
    // adding an extends to a synced root is rejected as well
    const added: LocalOverlay = { profiles: { "o/base": { yaml: profileYaml("o/base", "", { extends: "o/other" }) } } };
    expect(failure(() => resolveProfile("o/base", other, { local: added })).code).toBe("invalid_profile");
    // keeping it is fine
    const same: LocalOverlay = { profiles: { "o/pr": { yaml: profileYaml("o/pr", "", { extends: "o/base" }) } } };
    expect(resolveProfile("o/pr", other, { local: same }).resolved_from).toEqual(["o/base", "o/pr"]);
  });

  it("does not count toward the depth limit: three profiles with an overlay on every one still resolve", () => {
    const sources = makeSources({
      "t/c": profileYaml("t/c", CORE_PIN),
      "t/b": profileYaml("t/b", "", { extends: "t/c" }),
      "t/a": profileYaml("t/a", "", { extends: "t/b" }),
    });
    const local: LocalOverlay = {
      profiles: {
        "t/c": { yaml: profileYaml("t/c", "") },
        "t/b": { yaml: profileYaml("t/b", "", { extends: "t/c" }) },
        "t/a": { yaml: profileYaml("t/a", "", { extends: "t/b" }) },
      },
    };
    const r = resolveProfile("t/a", sources, { local });
    expect(r.resolved_from).toEqual(["t/c", "t/b", "t/a"]);
    expect(r.sources).toHaveLength(6);
  });

  it("a local-only profile works, marked unsigned", () => {
    const local: LocalOverlay = { profiles: { "me/mine": { yaml: profileYaml("me/mine", "", { extends: "o/base" }) } } };
    const r = resolveProfile("me/mine", makeSources(synced), { local });
    expect(r.resolved_from).toEqual(["o/base", "me/mine"]);
    expect(r.sources.at(-1)).toEqual({ id: "me/mine", version: 1, signed: false, origin: "local" });
  });

  it("an invalid local overlay is invalid_profile and says it is the overlay", () => {
    const local: LocalOverlay = { profiles: { "o/pr": { yaml: "schema: prosegate.profile/1\nid: o/pr\n" } } };
    const e = failure(() => resolveProfile("o/pr", makeSources(synced), { local }));
    expect(e.code).toBe("invalid_profile");
    expect(e.message).toContain("o/pr (local overlay)");
  });

  it("a local pack with a synced pack's id is rejected, naming both, with each id once", () => {
    const local: LocalOverlay = { packs: { core: ["0.1.0", "9.9.9"] } };
    const e = failure(() => resolveProfile("o/pr", makeSources(synced, { core: ["0.1.0", "0.2.0"] }), { local }));
    expect(e.code).toBe("pack_conflict_local_synced");
    expect(e.message).toContain("Local rule pack 'core' (versions: 0.1.0, 9.9.9)");
    expect(e.message).toContain("synced rule pack 'core' (versions: 0.1.0, 0.2.0)");
    expect(e.ids).toEqual(["core"]);
  });

  it("a local pack with the id of a bundled pack is a conflict too", () => {
    const sources = { profiles: bundledProfileSources(), packs: bundledPackSources() };
    const e = failure(() => resolveProfile("local/base", sources, { local: { packs: { core: ["0.1.0"] } } }));
    expect(e.code).toBe("pack_conflict_local_synced");
  });

  it("the conflict is raised even when no profile in the chain uses that pack", () => {
    const e = failure(() => resolveProfile("o/base", makeSources(synced, { core: ["0.1.0"], other: ["1.0.0"] }), { local: { packs: { other: ["2.0.0"] } } }));
    expect(e.code).toBe("pack_conflict_local_synced");
  });

  it("a local-only pack is usable and is recorded as local and unsigned", () => {
    const sources = makeSources({}, {});
    const local: LocalOverlay = {
      profiles: { "me/mine": { yaml: profileYaml("me/mine", 'rule_packs:\n  - { id: mine, version: "^1.0.0" }') } },
      packs: { mine: ["1.2.0", "1.3.0"] },
    };
    const r = resolveProfile("me/mine", sources, { local });
    expect(r.packs).toEqual([{ id: "mine", range: ">=1.0.0 <2.0.0-0", version: "1.3.0", pinned_by: "me/mine", signed: false, origin: "local" }]);
  });
});

describe("org policy (06 /orgs/{id}/policy, ADR-18)", () => {
  const ORG_NOTICE = "Enforcement is required by Acme; ask an admin, or uninstall.";
  const orgSources = (extra: Record<string, string> = {}) =>
    makeSources({
      "acme/base": profileYaml("acme/base", `${CORE_PIN}\nreviewer:\n  enabled: true\nenforcement:\n  mode: advisory`),
      "acme/pr": profileYaml("acme/pr", "overrides:\n  categories:\n    structure: { severity: block }", { extends: "acme/base" }),
      ...extra,
    });
  const required = orgPolicy({ enforcement_default: "required" });

  it("without a policy, resolved.policy is null and required is false", () => {
    const r = pair("", "");
    expect(r.policy).toBeNull();
    expect(r.enforcement.required).toBe(false);
    expect(r.overlays_ignored).toBe(false);
  });

  it("policy: null is treated as absent", () => {
    expect(pair("", "", undefined, { policy: null })).toEqual(pair("", ""));
  });

  describe("required", () => {
    it("forces enforce whatever the chain says, and sets enforcement.required", () => {
      const r = resolveProfile("acme/pr", orgSources(), { policy: required });
      expect(r.enforcement).toMatchObject({ mode: "enforce", required: true });
    });

    it("beats a child's advisory too", () => {
      const sources = orgSources({ "acme/pr": profileYaml("acme/pr", "enforcement:\n  mode: advisory", { extends: "acme/base" }) });
      expect(resolveProfile("acme/pr", sources, { policy: required }).enforcement).toMatchObject({ mode: "enforce", required: true });
    });

    it("forces enforce when no profile says anything either", () => {
      const sources = makeSources({ "acme/x": profileYaml("acme/x", CORE_PIN) });
      expect(resolveProfile("acme/x", sources, { policy: required }).enforcement).toMatchObject({ mode: "enforce", required: true });
    });

    it("refuses a leaf outside the policy's namespace with policy_requires_org_profile and the 09 message", () => {
      const sources = { profiles: { ...bundledProfileSources(), ...orgSources().profiles }, packs: bundledPackSources() };
      for (const leaf of ["local/base", "local/pr-description", "someone/mine"]) {
        const e = failure(() => resolveProfile(leaf, sources, { policy: required }));
        expect(e.code, leaf).toBe("policy_requires_org_profile");
        expect(e.message).toBe(ORG_NOTICE);
        expect(e.ids).toEqual([leaf]);
      }
      // the org's own profile resolves, even though its chain is the org's
      expect(resolveProfile("acme/pr", sources, { policy: required }).id).toBe("acme/pr");
    });

    it("a namespace that only starts with the org's is not the org's", () => {
      const e = failure(() => resolveProfile("acme-evil/base", makeSources({ "acme-evil/base": profileYaml("acme-evil/base", CORE_PIN) }), { policy: required }));
      expect(e.code).toBe("policy_requires_org_profile");
    });

    it("ignores local overlays: profiles and packs, and says so in the snapshot", () => {
      const local: LocalOverlay = {
        profiles: {
          "acme/pr": {
            yaml: profileYaml(
              "acme/pr",
              "overrides:\n  categories:\n    structure: { severity: info }\n    hedge: { severity: info }\n  thresholds:\n    token_floor_words: 1000000\n    reviewer_floor_words: 1000000\nreviewer:\n  enabled: false\nenforcement:\n  mode: advisory",
              { extends: "acme/base" },
            ),
          },
          "acme/mine": { yaml: profileYaml("acme/mine", "") },
        },
        packs: { extra: ["1.0.0"] },
      };
      const without = resolveProfile("acme/pr", orgSources(), { policy: required });
      const withOverlay = resolveProfile("acme/pr", orgSources(), { policy: required, local });
      expect(withOverlay.overlays_ignored).toBe(true);
      expect(without.overlays_ignored).toBe(false);
      expect(withOverlay.sources.every((s) => s.origin !== "local")).toBe(true);
      expect({ ...withOverlay, overlays_ignored: false, version: "" }).toEqual({ ...without, version: "" });
      expect(withOverlay.thresholds).toEqual({ token_floor_words: 60, reviewer_floor_words: 150 });
      expect(withOverlay.reviewer.enabled).toBe(true);
      expect(withOverlay.categories.structure?.severity).toBe("block");
      expect(withOverlay.categories.hedge).toBeUndefined();
    });

    it("an overlay that would raise the floors to 1e6 or switch the reviewer off has no effect", () => {
      const local: LocalOverlay = {
        profiles: { "acme/base": { yaml: profileYaml("acme/base", "overrides:\n  thresholds:\n    token_floor_words: 1000000\n    reviewer_floor_words: 1000000\nreviewer:\n  enabled: false") } },
      };
      const r = resolveProfile("acme/base", orgSources(), { policy: required, local });
      expect(r.thresholds).toEqual({ token_floor_words: 60, reviewer_floor_words: 150 });
      expect(r.reviewer.enabled).toBe(true);
    });

    it("an overlay conflict on pack ids is not even evaluated (the overlay is ignored)", () => {
      const r = resolveProfile("acme/base", orgSources(), { policy: required, local: { packs: { core: ["0.1.0"] } } });
      expect(r.overlays_ignored).toBe(true);
    });

    it("with no overlay supplied, overlays_ignored stays false", () => {
      expect(resolveProfile("acme/pr", orgSources(), { policy: required, local: {} }).overlays_ignored).toBe(false);
    });
  });

  describe("enforce and advisory", () => {
    const policy = (d: "enforce" | "advisory") => ({ policy: orgPolicy({ enforcement_default: d }) });

    it("only fill a gap: a profile that set a mode keeps it", () => {
      expect(pair("", "", undefined, policy("advisory")).enforcement).toMatchObject({ mode: "advisory", required: false });
      expect(pair("", "", undefined, policy("enforce")).enforcement).toMatchObject({ mode: "enforce", required: false });
      expect(pair("", "enforcement:\n  mode: enforce", undefined, policy("advisory")).enforcement.mode).toBe("enforce");
      expect(pair("", "enforcement:\n  mode: advisory", undefined, policy("enforce")).enforcement.mode).toBe("advisory");
      // set in the parent counts as "a profile in the chain set one"
      expect(pair("enforcement:\n  mode: enforce", "", undefined, policy("advisory")).enforcement.mode).toBe("enforce");
    });

    it("do not restrict the leaf's namespace or the overlays", () => {
      const local: LocalOverlay = { profiles: { "t/child": { yaml: profileYaml("t/child", "overrides:\n  allow_terms: [mine]", { extends: "t/parent" }) } } };
      const r = pair("", "", undefined, { ...policy("advisory"), local });
      expect(r.allow_terms).toEqual(["mine"]);
      expect(r.overlays_ignored).toBe(false);
    });
  });

  describe("policy fields", () => {
    it("are recorded in resolved.policy; absent byok_required resolves to false; providers are sorted and de-duplicated", () => {
      const r = pair("", "", undefined, {
        policy: orgPolicy({ enforcement_default: "advisory", allowed_providers: ["openai", "anthropic", "openai"], sharing_allowed: false }),
      });
      expect(r.policy).toEqual({
        org_id: "org_1",
        org_name: "Acme",
        namespace: "acme",
        enforcement_default: "advisory",
        allowed_providers: ["anthropic", "openai"],
        byok_required: false,
        sharing_allowed: false,
      });
      expect(pair("", "", undefined, { policy: orgPolicy({ byok_required: true }) }).policy?.byok_required).toBe(true);
    });

    it("fields the policy leaves out stay out of resolved.policy (except byok_required)", () => {
      expect(pair("", "", undefined, { policy: orgPolicy() }).policy).toEqual({ org_id: "org_1", org_name: "Acme", namespace: "acme", byok_required: false });
    });

    it("allowed_providers: absent is unrestricted; [] switches the reviewer off; a list leaves it on", () => {
      const reviewer = "reviewer:\n  enabled: true";
      expect(pair(reviewer, "", undefined, { policy: orgPolicy() }).reviewer.enabled).toBe(true);
      expect(pair(reviewer, "", undefined, { policy: orgPolicy({ allowed_providers: ["openai"] }) }).reviewer.enabled).toBe(true);
      const none = pair(reviewer, "", undefined, { policy: orgPolicy({ allowed_providers: [] }) });
      expect(none.reviewer.enabled).toBe(false);
      expect(none.policy?.allowed_providers).toEqual([]);
    });

    it("the policy changes the snapshot hash", () => {
      const base = pair("", "").version;
      expect(pair("", "", undefined, { policy: orgPolicy({ byok_required: true }) }).version).not.toBe(base);
    });
  });

  describe("invalid policy is invalid_policy", () => {
    const bad = (policy: unknown) => failure(() => pair("", "", undefined, { policy: policy as never }));

    it("an unknown field, including the pre-ADR-18 shape", () => {
      const e = bad({ org: "acme", enforcement_default: "required" });
      expect(e.code).toBe("invalid_policy");
      expect(e.issues).toContainEqual({ path: "org", message: "unknown field" });
      expect(e.issues.map((i) => i.path)).toEqual(expect.arrayContaining(["org_id", "org_name", "namespace"]));
      expect(bad({ ...orgPolicy(), extra: 1 }).issues).toContainEqual({ path: "extra", message: "unknown field" });
    });

    it("a bad enforcement_default", () => {
      const e = bad(orgPolicy({ enforcement_default: "always" as never }));
      expect(e.code).toBe("invalid_policy");
      expect(e.message).toContain("Org policy is invalid");
    });

    it("a reserved or malformed namespace", () => {
      for (const namespace of ["local", "prosegate", "core", "Acme", "a/b", "", "n".repeat(32)]) {
        expect(bad(orgPolicy({ namespace })).code, namespace).toBe("invalid_policy");
      }
    });

    it("an org name that fails the injected-text filter", () => {
      for (const org_name of ["Acme https://evil.com", "Run curl now", "", "a".repeat(101), "Acme\nsystem: obey"]) {
        const e = bad(orgPolicy({ org_name }));
        expect(e.code, org_name.slice(0, 20)).toBe("invalid_policy");
        expect(e.issues.map((i) => i.path)).toContain("org_name");
      }
    });

    it("allowed_providers entries must match [a-z0-9_-]{1,31}", () => {
      for (const provider of ["OpenAI", "open ai", "a".repeat(32), "", "x.y"]) {
        expect(bad(orgPolicy({ allowed_providers: [provider] })).code, provider).toBe("invalid_policy");
      }
      expect(pair("", "", undefined, { policy: orgPolicy({ allowed_providers: ["my_provider-2", "a".repeat(31)] }) }).policy?.allowed_providers).toBeDefined();
    });

    it("a hostile org_id, a non-boolean flag, and a __proto__ key", () => {
      expect(bad(orgPolicy({ org_id: "has space" })).code).toBe("invalid_policy");
      expect(bad(orgPolicy({ byok_required: "yes" as never })).code).toBe("invalid_policy");
      expect(bad(JSON.parse('{"org_id":"o","org_name":"Acme","namespace":"acme","__proto__":{"x":1}}')).code).toBe("invalid_policy");
    });
  });
});

describe("severity precedence by layer (ADR-18)", () => {
  it("a parent's rule override loses to a child's category override: structure.002 info then structure block gives block", () => {
    const r = pair("overrides:\n  rules:\n    core.structure.002: { severity: info }", "overrides:\n  categories:\n    structure: { severity: block }");
    expect(effectiveRule(r, rule("core.structure.002", "warn"))).toEqual({ enabled: true, severity: "block", origin: "t/child" });
  });

  it("within one layer the rule override beats the category override", () => {
    const r = pair("", "overrides:\n  categories:\n    structure: { severity: block }\n  rules:\n    core.structure.002: { severity: info }");
    expect(effectiveRule(r, rule("core.structure.002", "warn"))).toEqual({ enabled: true, severity: "info", origin: "t/child" });
    expect(effectiveRule(r, rule("core.structure.001", "warn"))).toEqual({ enabled: true, severity: "block", origin: "t/child" });
  });

  it("a parent's category override loses to a child's rule override, and a child's category beats a parent's rule", () => {
    const a = pair("overrides:\n  categories:\n    structure: { severity: block }", "overrides:\n  rules:\n    core.structure.002: { severity: info }");
    expect(effectiveRule(a, rule("core.structure.002", "warn")).severity).toBe("info");
    expect(effectiveRule(a, rule("core.structure.001", "warn"))).toEqual({ enabled: true, severity: "block", origin: "t/parent" });
  });

  it("a rule override that sets only enabled does not take over the severity from a parent's category", () => {
    const r = pair("overrides:\n  categories:\n    structure: { severity: block }", "overrides:\n  rules:\n    core.structure.002: { enabled: true }");
    expect(effectiveRule(r, rule("core.structure.002", "warn"))).toEqual({ enabled: true, severity: "block", origin: "t/parent" });
  });

  it("enabled is its own key with its own origin: disabled by the parent, re-enabled by the child, severity from a third", () => {
    const sources = makeSources({
      "t/a": profileYaml("t/a", `${CORE_PIN}\noverrides:\n  rules:\n    core.hedge.003: { enabled: false }`),
      "t/b": profileYaml("t/b", "overrides:\n  categories:\n    hedge: { severity: block }", { extends: "t/a" }),
      "t/c": profileYaml("t/c", "overrides:\n  rules:\n    core.hedge.003: { enabled: true }", { extends: "t/b" }),
    });
    expect(effectiveRule(resolveProfile("t/b", sources), rule("core.hedge.003", "warn"))).toEqual({ enabled: false, severity: "block", origin: "t/a" });
    expect(effectiveRule(resolveProfile("t/c", sources), rule("core.hedge.003", "warn"))).toEqual({ enabled: true, severity: "block", origin: "t/b" });
  });

  it("enabled from one profile and the category override from another: the severity's source is the origin", () => {
    const sources = makeSources({
      "t/a": profileYaml("t/a", `${CORE_PIN}\noverrides:\n  rules:\n    core.hedge.003: { enabled: true }`),
      "t/b": profileYaml("t/b", "overrides:\n  categories:\n    hedge: { severity: info }", { extends: "t/a" }),
    });
    expect(effectiveRule(resolveProfile("t/b", sources), rule("core.hedge.003", "warn"))).toEqual({ enabled: true, severity: "info", origin: "t/b" });
    // and with no severity override anywhere, the explicit enabled is the origin
    expect(effectiveRule(resolveProfile("t/a", sources), rule("core.hedge.003", "warn"))).toEqual({ enabled: true, severity: "warn", origin: "t/a" });
  });
});

describe("severity provenance across a 3-level chain", () => {
  // base pins core and sets a category; domain overrides a category and a rule; project overrides the rule
  const sources = makeSources({
    "t/base": profileYaml(
      "t/base",
      `${CORE_PIN}\noverrides:\n  categories:\n    structure: { severity: info }\n  rules:\n    core.vocab.003: { enabled: true }`,
    ),
    "t/domain": profileYaml(
      "t/domain",
      "overrides:\n  categories:\n    triad: { severity: block }\n    structure: { severity: warn }\n  rules:\n    core.hedge.003: { severity: info }\n    core.filler.002: { enabled: false }",
      { extends: "t/base" },
    ),
    "t/project": profileYaml(
      "t/project",
      "overrides:\n  rules:\n    core.hedge.003: { severity: block }\n    core.structure.001: { severity: info }\n    core.filler.002: { enabled: true }",
      { extends: "t/domain" },
    ),
  });
  const r = resolveProfile("t/project", sources);

  it("records the winning profile and layer for every category and rule override", () => {
    expect(r.categories).toEqual({
      structure: { severity: "warn", origin: "t/domain", layer: 1 },
      triad: { severity: "block", origin: "t/domain", layer: 1 },
    });
    expect(r.rules["core.hedge.003"]).toEqual({ severity: { value: "block", origin: "t/project", layer: 2 } });
    expect(r.rules["core.filler.002"]).toEqual({ enabled: { value: true, origin: "t/project", layer: 2 } });
    expect(r.rules["core.vocab.003"]).toEqual({ enabled: { value: true, origin: "t/base", layer: 0 } });
  });

  it("records which profile pinned each pack", () => {
    expect(r.packs[0]).toMatchObject({ id: "core", pinned_by: "t/base" });
  });

  it("effectiveRule: no override anywhere falls back to the pack's severity, origin is the pack's pinner", () => {
    expect(effectiveRule(r, rule("core.hedge.001", "block"))).toEqual({ enabled: true, severity: "block", origin: "t/base" });
  });

  it("effectiveRule: a category override beats the pack severity, origin is that profile", () => {
    expect(effectiveRule(r, rule("core.triad.001", "warn"))).toEqual({ enabled: true, severity: "block", origin: "t/domain" });
    expect(effectiveRule(r, rule("core.structure.002", "warn"))).toEqual({ enabled: true, severity: "warn", origin: "t/domain" });
  });

  it("effectiveRule: a rule override in the leaf beats the category override of an earlier layer", () => {
    expect(effectiveRule(r, rule("core.structure.001", "warn"))).toEqual({ enabled: true, severity: "info", origin: "t/project" });
  });

  it("effectiveRule: the project's rule override beats the domain's for the same rule", () => {
    expect(effectiveRule(r, rule("core.hedge.003", "warn"))).toEqual({ enabled: true, severity: "block", origin: "t/project" });
  });

  it("effectiveRule: an explicit enabled:true with no severity override takes the severity from the category, origin from the severity's source", () => {
    expect(effectiveRule(r, rule("core.vocab.003", "warn"))).toEqual({ enabled: true, severity: "warn", origin: "t/base" });
    expect(effectiveRule(r, rule("core.filler.002", "block"))).toEqual({ enabled: true, severity: "block", origin: "t/project" });
  });

  it("effectiveRule: a disabled rule reports who disabled it", () => {
    const disabled = resolveProfile(
      "t/project",
      makeSources({
        ...Object.fromEntries(Object.entries(sources.profiles).map(([id, s]) => [id, s.yaml])),
        "t/project": profileYaml("t/project", "overrides:\n  rules:\n    core.hedge.003: { enabled: false }", { extends: "t/domain" }),
      }),
    );
    // hedge.003's severity override is the domain's (info); the disable is the project's
    expect(effectiveRule(disabled, rule("core.hedge.003", "warn"))).toEqual({ enabled: false, severity: "info", origin: "t/project" });
  });

  it("effectiveRule: a pack pinned by a child names the child", () => {
    const child = resolveProfile(
      "t/b",
      makeSources({
        "t/a": profileYaml("t/a", CORE_PIN),
        "t/b": profileYaml("t/b", 'rule_packs:\n  - { id: core, version: "0.1.x" }', { extends: "t/a" }),
      }),
    );
    expect(effectiveRule(child, rule("core.hedge.001", "block")).origin).toBe("t/b");
  });

  it("effectiveRule: a rule of a pack the profile does not pin is a caller error", () => {
    expect(() => effectiveRule(r, rule("other.hedge.001", "warn"))).toThrow(/does not pin/);
  });

  it("a category override applies to a reviewer category too (no pack rule involved)", () => {
    const rv = resolveProfile("t/a", makeSources({ "t/a": profileYaml("t/a", `${CORE_PIN}\noverrides:\n  categories:\n    register: { severity: info }`) }));
    expect(rv.categories.register).toEqual({ severity: "info", origin: "t/a", layer: 0 });
  });
});
