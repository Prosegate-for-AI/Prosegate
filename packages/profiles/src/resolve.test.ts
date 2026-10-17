import { describe, expect, it } from "vitest";
import { DEFAULT_THRESHOLDS } from "@prosegate/schema";
import { ResolutionError } from "./errors.js";
import {
  effectiveRule,
  resolveProfile,
  type LocalOverlay,
  type ResolveOptions,
} from "./resolve.js";
import { CORE_PIN, makeSources, profileYaml } from "./test-util.js";

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

describe("merge rules (04 'Inheritance and resolution')", () => {
  describe("rule_packs", () => {
    it("union by id", () => {
      const r = pair(
        "",
        'rule_packs:\n  - { id: eng-docs, version: "0.1.x" }',
        { core: ["0.1.0"], "eng-docs": ["0.1.4"] },
      );
      expect(r.packs.map((p) => [p.id, p.version, p.pinned_by])).toEqual([
        ["core", "0.1.0", "t/parent"],
        ["eng-docs", "0.1.4", "t/child"],
      ]);
    });

    it("on conflict the child's range wins, and that range is the child's own, not the intersection", () => {
      const r = pair("", 'rule_packs:\n  - { id: core, version: "0.1.x" }', { core: ["0.1.0", "0.1.7", "0.2.0", "0.9.0"] });
      expect(r.packs).toEqual([{ id: "core", range: "0.1.x", version: "0.1.7", pinned_by: "t/child", signed: true, origin: "synced" }]);
      // a child range wider than the parent's still wins, as long as the two overlap
      const wide = pair('rule_packs:\n  - { id: eng, version: "<0.5.0" }', 'rule_packs:\n  - { id: eng, version: ">=0.1.0" }', { core: ["0.1.0"], eng: ["0.4.0", "0.9.0"] });
      expect(wide.packs.find((p) => p.id === "eng")).toMatchObject({ range: ">=0.1.0", version: "0.9.0", pinned_by: "t/child" });
    });

    it("the parent's pin stands when the child does not mention the pack", () => {
      const r = pair("", "", { core: ["0.1.0", "0.2.0"] });
      expect(r.packs[0]).toMatchObject({ range: ">=0.1.0 <1.0.0", version: "0.2.0", pinned_by: "t/parent" });
    });

    it("packs are listed sorted by id whatever the order in the YAML", () => {
      const r = pair('rule_packs:\n  - { id: zeta, version: "*" }\n  - { id: alpha, version: "*" }', "", {
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
        triad: { severity: "info", origin: "t/parent" },
        structure: { severity: "warn", origin: "t/child" },
        hedge: { severity: "info", origin: "t/child" },
      });
    });
  });

  describe("overrides.rules", () => {
    it("deep merge: child wins per key", () => {
      const r = pair(
        "overrides:\n  rules:\n    core.hedge.003: { severity: info }\n    core.vocab.003: { enabled: false }",
        "overrides:\n  rules:\n    core.hedge.003: { severity: block }",
      );
      expect(r.rules["core.hedge.003"]).toEqual({ severity: { value: "block", origin: "t/child" } });
      expect(r.rules["core.vocab.003"]).toEqual({ enabled: { value: false, origin: "t/parent" } });
    });

    it("deep merge goes inside a rule: enabled and severity merge separately, each keeping its own origin", () => {
      const r = pair(
        "overrides:\n  rules:\n    core.hedge.003: { enabled: false, severity: info }",
        "overrides:\n  rules:\n    core.hedge.003: { enabled: true }",
      );
      expect(r.rules["core.hedge.003"]).toEqual({
        enabled: { value: true, origin: "t/child" },
        severity: { value: "info", origin: "t/parent" },
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

    it("an unset key falls back to the default, a set key (even 0) is kept", () => {
      expect(pair("overrides:\n  thresholds:\n    token_floor_words: 0", "").thresholds).toEqual({ token_floor_words: 0, reviewer_floor_words: 150 });
    });
  });

  describe("overrides.allow_terms", () => {
    it("union, de-duplicated and sorted", () => {
      const r = pair('overrides:\n  allow_terms: ["robust", "idempotent"]', 'overrides:\n  allow_terms: ["idempotent", "comprehensive"]');
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

    it("categories: an empty child list replaces the parent's", () => {
      expect(pair(parentReviewer, "reviewer:\n  categories: []").reviewer.categories).toEqual([]);
    });

    it("categories are de-duplicated and put in a fixed order, so equal sets hash equal", () => {
      const a = pair("", "reviewer:\n  categories: [register, vague_claim, register]");
      const b = pair("", "reviewer:\n  categories: [vague_claim, register]");
      expect(a.reviewer.categories).toEqual(["vague_claim", "register"]);
      expect(a.version).toBe(b.version);
    });

    it("with no profile saying anything, the reviewer is off with no categories", () => {
      expect(pair("", "").reviewer).toEqual({ enabled: false, categories: [], register: {} });
    });
  });

  describe("enforcement and trigger", () => {
    it("enforcement.*: each key replaced when present, inherited when not", () => {
      const r = pair(
        "enforcement:\n  mode: advisory\n  pass_cap: 1\n  render: summary",
        "enforcement:\n  mode: enforce",
      );
      expect(r.enforcement).toEqual({ mode: "enforce", pass_cap: 1, render: "summary", required: false });
    });

    it("enforcement defaults: enforce, pass_cap 2, render diff", () => {
      expect(pair("", "").enforcement).toEqual({ mode: "enforce", pass_cap: 2, render: "diff", required: false });
    });

    it("trigger.*: each key replaced when present (a list replaces, it is not unioned)", () => {
      const r = pair(
        'trigger:\n  description: "Parent."\n  patterns: [a, b]\n  harness_hints: [h1]\n  sticky: false',
        'trigger:\n  patterns: [c]\n  sticky: true',
      );
      expect(r.trigger).toEqual({ description: "Parent.", patterns: ["c"], harness_hints: ["h1"], sticky: true });
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

  it("a very long chain stops at a hard walk limit with depth_exceeded", () => {
    const ids = Array.from({ length: 40 }, (_, i) => `t/p${i}`);
    const sources = makeSources(Object.fromEntries(ids.map((id, i) => [id, profileYaml(id, "", i + 1 < ids.length ? { extends: ids[i + 1] as string } : {})])));
    const e = failure(() => resolveProfile("t/p0", sources));
    expect(e.code).toBe("depth_exceeded");
    expect(e.message).toContain("limit is 3");
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

describe("pack range and version selection", () => {
  it("range_conflict: names both profiles and both ranges", () => {
    const e = failure(() =>
      pair('rule_packs:\n  - { id: eng, version: "<0.5.0" }', 'rule_packs:\n  - { id: eng, version: ">=1.0.0" }', { core: ["0.1.0"], eng: ["0.4.0", "1.2.0"] }),
    );
    expect(e.code).toBe("range_conflict");
    expect(e.message).toContain("'eng'");
    expect(e.message).toContain("'t/parent' requires '<0.5.0'");
    expect(e.message).toContain("'t/child' requires '>=1.0.0'");
    expect(e.ids).toEqual(["t/parent", "t/child", "eng"]);
  });

  it("range_conflict is raised even when versions exist for the child's range", () => {
    const e = failure(() => pair("", 'rule_packs:\n  - { id: core, version: ">=1.0.0" }', { core: ["0.1.0", "1.5.0"] }));
    expect(e.code).toBe("range_conflict");
  });

  it("a range that overlaps only at its edge is not a conflict", () => {
    const r = pair('rule_packs:\n  - { id: eng, version: "<=0.5.0" }', 'rule_packs:\n  - { id: eng, version: ">=0.5.0" }', { core: ["0.1.0"], eng: ["0.5.0", "0.6.0"] });
    expect(r.packs.find((p) => p.id === "eng")?.version).toBe("0.6.0");
  });

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

  it("prereleases are not chosen unless the range asks for them", () => {
    expect(pair("", "", { core: ["0.1.0", "0.2.0-beta.1"] }).packs[0]?.version).toBe("0.1.0");
  });

  it("records whether the chosen pack version is signed", () => {
    const sources = makeSources({ "t/a": profileYaml("t/a", CORE_PIN) });
    const r = resolveProfile("t/a", { ...sources, packs: { core: [{ version: "0.1.0", signed: false }] } });
    expect(r.packs[0]?.signed).toBe(false);
  });

  it("a non-semver version in the source list is invalid_pack", () => {
    const e = failure(() => pair("", "", { core: ["0.1.0", "latest"] }));
    expect(e.code).toBe("invalid_pack");
  });
});

describe("local overlay (04 'Versioning, pinning and caching')", () => {
  const synced = {
    "o/base": profileYaml("o/base", `${CORE_PIN}\noverrides:\n  categories:\n    triad: { severity: info }\n  allow_terms: [robust]`, { version: 7 }),
    "o/pr": profileYaml("o/pr", "overrides:\n  categories:\n    structure: { severity: block }", { version: 4, extends: "o/base" }),
  };

  it("a local profile with a synced id merges as a child of it, local wins", () => {
    const local: LocalOverlay = {
      profiles: { "o/pr": { yaml: profileYaml("o/pr", "overrides:\n  categories:\n    structure: { severity: info }\n  allow_terms: [mine]", { version: 1, extends: "o/base" }) } },
    };
    const r = resolveProfile("o/pr", makeSources(synced), { local });
    expect(r.categories.structure).toEqual({ severity: "info", origin: "o/pr" });
    expect(r.categories.triad).toEqual({ severity: "info", origin: "o/base" });
    expect(r.allow_terms).toEqual(["mine", "robust"]);
  });

  it("is one chain entry, and is recorded: resolved_from lists the id once, sources lists both documents", () => {
    const local: LocalOverlay = { profiles: { "o/pr": { yaml: profileYaml("o/pr", "", { version: 2 }) } } };
    const r = resolveProfile("o/pr", makeSources(synced), { local });
    expect(r.resolved_from).toEqual(["o/base", "o/pr"]);
    expect(r.sources).toEqual([
      { id: "o/base", version: 7, signed: true, origin: "synced" },
      { id: "o/pr", version: 4, signed: true, origin: "synced" },
      { id: "o/pr", version: 2, signed: false, origin: "local" },
    ]);
    // the leaf's version in the snapshot is the version of the document that has the last word
    expect(r.version).toMatch(/^2\+/);
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
        "t/b": { yaml: profileYaml("t/b", "") },
        "t/a": { yaml: profileYaml("t/a", "") },
      },
    };
    const r = resolveProfile("t/a", sources, { local });
    expect(r.resolved_from).toEqual(["t/c", "t/b", "t/a"]);
    expect(r.sources).toHaveLength(6);
  });

  it("an overlay can carry its own extends; the overlay's wins over the synced document's", () => {
    const sources = makeSources({
      ...synced,
      "o/other": profileYaml("o/other", "overrides:\n  allow_terms: [other]"),
    });
    const local: LocalOverlay = { profiles: { "o/pr": { yaml: profileYaml("o/pr", "", { extends: "o/other" }) } } };
    const r = resolveProfile("o/pr", sources, { local });
    expect(r.resolved_from).toEqual(["o/other", "o/pr"]);
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

  it("a local pack with a synced pack's id is rejected, naming both", () => {
    const local: LocalOverlay = { packs: { core: ["0.1.0", "9.9.9"] } };
    const e = failure(() => resolveProfile("o/pr", makeSources(synced, { core: ["0.1.0", "0.2.0"] }), { local }));
    expect(e.code).toBe("pack_conflict_local_synced");
    expect(e.message).toContain("Local rule pack 'core' (versions: 0.1.0, 9.9.9)");
    expect(e.message).toContain("synced rule pack 'core' (versions: 0.1.0, 0.2.0)");
    expect(e.ids).toEqual(["core"]);
  });

  it("the conflict is raised even when no profile in the chain uses that pack", () => {
    const e = failure(() => resolveProfile("o/base", makeSources(synced, { core: ["0.1.0"], other: ["1.0.0"] }), { local: { packs: { other: ["2.0.0"] } } }));
    expect(e.code).toBe("pack_conflict_local_synced");
  });

  it("a local-only pack is usable and is recorded as local and unsigned", () => {
    const sources = makeSources({ "o/base": profileYaml("o/base", 'rule_packs:\n  - { id: mine, version: "^1.0.0" }') }, {});
    const r = resolveProfile("o/base", sources, { local: { packs: { mine: ["1.2.0", "1.3.0"] } } });
    expect(r.packs).toEqual([{ id: "mine", range: "^1.0.0", version: "1.3.0", pinned_by: "o/base", signed: false, origin: "local" }]);
  });
});

describe("org policy (06 /orgs/{id}/policy)", () => {
  it("without a policy, resolved.policy is null and required is false", () => {
    const r = pair("", "");
    expect(r.policy).toBeNull();
    expect(r.enforcement.required).toBe(false);
  });

  it("required beats a child's advisory, and sets enforcement.required", () => {
    const r = pair("", "enforcement:\n  mode: advisory", undefined, { policy: { org: "acme", enforcement_default: "required" } });
    expect(r.enforcement.mode).toBe("enforce");
    expect(r.enforcement.required).toBe(true);
  });

  it("required beats advisory set anywhere in the chain", () => {
    const r = pair("enforcement:\n  mode: advisory", "");
    expect(r.enforcement.mode).toBe("advisory");
    const forced = pair("enforcement:\n  mode: advisory", "", undefined, { policy: { org: "acme", enforcement_default: "required" } });
    expect(forced.enforcement).toMatchObject({ mode: "enforce", required: true });
  });

  it("required forces enforce when no profile says anything either", () => {
    const r = pair("", "", undefined, { policy: { org: "acme", enforcement_default: "required" } });
    expect(r.enforcement).toMatchObject({ mode: "enforce", required: true });
  });

  it("enforce|advisory only fill a gap: a profile that set a mode keeps it", () => {
    const policy = (d: "enforce" | "advisory") => ({ policy: { org: "acme", enforcement_default: d } });
    expect(pair("", "", undefined, policy("advisory")).enforcement).toMatchObject({ mode: "advisory", required: false });
    expect(pair("", "", undefined, policy("enforce")).enforcement).toMatchObject({ mode: "enforce", required: false });
    expect(pair("", "enforcement:\n  mode: enforce", undefined, policy("advisory")).enforcement.mode).toBe("enforce");
    expect(pair("", "enforcement:\n  mode: advisory", undefined, policy("enforce")).enforcement.mode).toBe("advisory");
    // set in the parent counts as "a profile in the chain set one"
    expect(pair("enforcement:\n  mode: enforce", "", undefined, policy("advisory")).enforcement.mode).toBe("enforce");
  });

  it("copies byok_required, allowed_providers and sharing_allowed into resolved.policy", () => {
    const r = pair("", "", undefined, {
      policy: { org: "acme", enforcement_default: "required", byok_required: true, allowed_providers: ["openai", "anthropic", "openai"], sharing_allowed: false },
    });
    expect(r.policy).toEqual({
      org: "acme",
      enforcement_default: "required",
      byok_required: true,
      allowed_providers: ["anthropic", "openai"],
      sharing_allowed: false,
    });
  });

  it("fields the policy leaves out stay out of resolved.policy", () => {
    expect(pair("", "", undefined, { policy: { org: "acme" } }).policy).toEqual({ org: "acme" });
  });

  it("policy changes the snapshot hash", () => {
    const base = pair("", "").version;
    expect(pair("", "", undefined, { policy: { org: "acme", byok_required: true } }).version).not.toBe(base);
  });

  it("an invalid policy is rejected", () => {
    const e = failure(() => pair("", "", undefined, { policy: { org: "acme", enforcement_default: "always" } as never }));
    expect(e.code).toBe("invalid_profile");
    expect(e.message).toContain("Org policy is invalid");
    const e2 = failure(() => pair("", "", undefined, { policy: { org: "acme", extra: 1 } as never }));
    expect(e2.issues).toContainEqual({ path: "extra", message: "unknown field" });
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
  const rule = (id: string, severity: "block" | "warn" | "info") => ({ id, category: id.split(".")[1] as never, severity });

  it("records the winning profile for every category and rule override", () => {
    expect(r.categories).toEqual({
      structure: { severity: "warn", origin: "t/domain" },
      triad: { severity: "block", origin: "t/domain" },
    });
    expect(r.rules["core.hedge.003"]).toEqual({ severity: { value: "block", origin: "t/project" } });
    expect(r.rules["core.filler.002"]).toEqual({ enabled: { value: true, origin: "t/project" } });
    expect(r.rules["core.vocab.003"]).toEqual({ enabled: { value: true, origin: "t/base" } });
  });

  it("records which profile pinned each pack", () => {
    expect(r.packs[0]).toMatchObject({ id: "core", pinned_by: "t/base" });
  });

  it("effectiveRule: no override anywhere falls back to the pack's severity, origin is the pack's pinner", () => {
    expect(effectiveRule(r, rule("core.hedge.001", "block"))).toEqual({ enabled: true, severity: "block", origin: "t/base" });
  });

  it("effectiveRule: a category override beats the pack severity, origin is that profile", () => {
    expect(effectiveRule(r, rule("core.triad.001", "warn"))).toEqual({ enabled: true, severity: "block", origin: "t/domain" });
    // the child's category value beat the base's for the same category
    expect(effectiveRule(r, rule("core.structure.002", "warn"))).toEqual({ enabled: true, severity: "warn", origin: "t/domain" });
  });

  it("effectiveRule: a rule override beats the category override, origin is the rule's profile", () => {
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
    expect(rv.categories.register).toEqual({ severity: "info", origin: "t/a" });
  });
});
