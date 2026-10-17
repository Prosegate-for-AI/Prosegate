import { describe, expect, it } from "vitest";
import { BUNDLED_PROFILE_YAML, bundledProfileSources } from "./bundled.js";
import { parseProfileYaml } from "./profile.js";
import { effectiveRule, resolveProfile } from "./resolve.js";
import { parseRulePackYaml } from "./rulepack.js";
import { CORE_FIXTURE_YAML } from "./test-util.js";

const pack = (() => {
  const r = parseRulePackYaml(CORE_FIXTURE_YAML);
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
})();

const sources = { profiles: bundledProfileSources(), packs: { core: [{ version: "0.1.0", signed: true }] } };

type Sev = "block" | "warn" | "info";

// Pack defaults of the fixture rules (08), then each starter's 08 "Default profile membership" cell.
const DEFAULTS: Record<string, Sev> = {
  "core.filler.001": "block",
  "core.filler.002": "block",
  "core.hedge.001": "block",
  "core.hedge.002": "warn",
  "core.hedge.003": "warn",
  "core.vocab.003": "warn",
  "core.triad.001": "warn",
  "core.structure.001": "warn",
  "core.structure.002": "warn",
  "core.structure.004": "block",
  "core.structure.005": "warn",
  "core.repetition.001": "warn",
};

const EXPECTED: Record<string, { changes: Record<string, Sev>; allow: string[]; maxWords: number }> = {
  "local/base": { changes: {}, allow: [], maxWords: 600 },
  "local/pr-description": {
    changes: {
      "core.triad.001": "info", // triad -> info
      "core.structure.001": "block", // structure -> block (category)
      "core.structure.002": "block",
      "core.structure.004": "block",
      "core.structure.005": "block",
    },
    allow: [],
    maxWords: 300,
  },
  "local/design-doc": {
    changes: { "core.hedge.003": "info", "core.structure.001": "info", "core.structure.002": "info" },
    allow: ["comprehensive"],
    maxWords: 2500,
  },
  "local/email": { changes: { "core.filler.002": "info", "core.structure.001": "block" }, allow: [], maxWords: 200 },
  "local/chat-reply": { changes: { "core.structure.005": "block" }, allow: [], maxWords: 250 },
};

describe("bundled starter profiles", () => {
  it("are exactly the five from 08, all in the local namespace", () => {
    expect(Object.keys(BUNDLED_PROFILE_YAML).sort()).toEqual(Object.keys(EXPECTED).sort());
    for (const id of Object.keys(BUNDLED_PROFILE_YAML)) expect(id.startsWith("local/")).toBe(true);
  });

  it("each parses, declares the id it is keyed by, and (but base) extends local/base", () => {
    for (const [id, yaml] of Object.entries(BUNDLED_PROFILE_YAML)) {
      const r = parseProfileYaml(yaml);
      expect(r.ok, id).toBe(true);
      if (r.ok) {
        expect(r.value.id).toBe(id);
        expect(r.value.extends, id).toBe(id === "local/base" ? undefined : "local/base");
      }
    }
  });

  it("base pins core at >=0.1.0 <1.0.0, enables the reviewer for all three categories, enforces with pass_cap 2 and diff", () => {
    const r = resolveProfile("local/base", sources);
    expect(r.packs).toEqual([{ id: "core", range: ">=0.1.0 <1.0.0", version: "0.1.0", pinned_by: "local/base", signed: true, origin: "synced" }]);
    expect(r.reviewer.enabled).toBe(true);
    expect(r.reviewer.categories).toEqual(["vague_claim", "unsupported_claim", "register"]);
    expect(r.enforcement).toEqual({ mode: "enforce", pass_cap: 2, render: "diff", required: false });
    expect(r.categories).toEqual({});
    expect(r.rules).toEqual({});
  });

  it("the bundled sources are marked unsigned (they carry no service signature)", () => {
    const r = resolveProfile("local/pr-description", sources);
    expect(r.sources.map((s) => [s.id, s.signed, s.origin])).toEqual([
      ["local/base", false, "synced"],
      ["local/pr-description", false, "synced"],
    ]);
  });

  for (const [id, want] of Object.entries(EXPECTED)) {
    describe(id, () => {
      const r = resolveProfile(id, sources);

      it("resolves against the fixture core 0.1.0 pack", () => {
        expect(r.id).toBe(id);
        expect(r.resolved_from).toEqual(id === "local/base" ? ["local/base"] : ["local/base", id]);
        expect(r.packs[0]).toMatchObject({ id: "core", version: "0.1.0" });
      });

      it("has the 08 effective severities for every fixture rule, all enabled", () => {
        for (const rule of pack.rules) {
          const eff = effectiveRule(r, rule);
          expect(eff.enabled, rule.id).toBe(true);
          expect(eff.severity, `${id} ${rule.id}`).toBe(want.changes[rule.id] ?? DEFAULTS[rule.id]);
        }
      });

      it("names this profile as the origin of every rule it touches (rule override or category override), and base for the rest", () => {
        for (const rule of pack.rules) {
          // `changes` lists every rule the profile touches; structure.004 is touched by pr-description's
          // category override even though block is also its pack default
          expect(effectiveRule(r, rule).origin, `${id} ${rule.id}`).toBe(rule.id in want.changes ? id : "local/base");
        }
      });

      it("has the 08 register.max_words and its own tone and format", () => {
        expect(r.reviewer.register.max_words).toBe(want.maxWords);
        expect(r.reviewer.register.tone).toBeTruthy();
        expect(r.reviewer.register.format).toBeTruthy();
      });

      it("allow_terms", () => {
        expect(r.allow_terms).toEqual(want.allow);
      });

      it("keeps base's reviewer settings and enforcement", () => {
        expect(r.reviewer.enabled).toBe(true);
        expect(r.reviewer.categories).toEqual(["vague_claim", "unsupported_claim", "register"]);
        expect(r.enforcement).toEqual({ mode: "enforce", pass_cap: 2, render: "diff", required: false });
      });
    });
  }

  it("register text reads as house style: ASCII, one short sentence each, no emoji, no markup", () => {
    for (const id of Object.keys(EXPECTED)) {
      const { tone, format } = resolveProfile(id, sources).reviewer.register;
      for (const text of [tone, format]) {
        expect(text, id).toBeDefined();
        expect(text, id).toMatch(/^[\x20-\x7e]+$/); // printable ASCII only
        expect(text, id).toMatch(/^[A-Z][^.!?]*\.$/); // one sentence, ends with a period
        expect((text ?? "").length, id).toBeLessThanOrEqual(110);
      }
    }
  });

  it("trigger.description is one sentence each", () => {
    for (const id of Object.keys(EXPECTED)) {
      const d = resolveProfile(id, sources).trigger.description ?? "";
      expect(d, id).toMatch(/^[A-Z][^.!?]*\.$/);
      expect(d.length, id).toBeLessThanOrEqual(200);
    }
  });

  it("pr-description takes 04's trigger example", () => {
    const t = resolveProfile("local/pr-description", sources).trigger;
    expect(t.patterns).toEqual(["pull request", "PR description", "commit message", "changelog"]);
    expect(t.harness_hints).toEqual(["git_commit", "gh_pr_create"]);
    expect(t.description).toContain("pull request title or description, a commit message, or a changelog entry");
  });
});
