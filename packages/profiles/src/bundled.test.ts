import { describe, expect, it } from "vitest";
import { BUNDLED_PACK_YAML, BUNDLED_PROFILE_YAML, bundledPackSources, bundledProfileSources } from "./bundled.js";
import { parseProfileYaml } from "./profile.js";
import { effectiveRule, resolveProfile } from "./resolve.js";
import { parseRulePackYaml, type RulePack } from "./rulepack.js";

type Sev = "block" | "warn" | "info";

const sources = { profiles: bundledProfileSources(), packs: bundledPackSources() };

const pack: RulePack = (() => {
  const r = parseRulePackYaml(BUNDLED_PACK_YAML["core@0.1.0"]);
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
})();

// docs/08, transcribed: id, severity, instruction text. 23 rules.
const DOC08: Array<[string, Sev, string]> = [
  ["core.filler.001", "block", "Remove. Start with the answer."],
  ["core.filler.002", "block", "Remove. End on the last substantive point."],
  ["core.filler.003", "block", "Remove the meta-commentary; state the content directly."],
  ["core.filler.004", "warn", "Remove; a reply this short needs no summary."],
  ["core.hedge.001", "block", "Remove the preamble; keep the clause after it."],
  ["core.hedge.002", "warn", "Replace the qualifier with the measurement or the plain adjective."],
  ["core.hedge.003", "warn", "Remove the hedge or state who argues it and why."],
  ["core.hedge.004", "block", "Pick one: say whether it does, and under what condition."],
  ["core.hedge.005", "warn", "Say what it depends on, in the same sentence."],
  ["core.vocab.001", "warn", "Use the plain verb (use, build, support, speed up)."],
  ["core.vocab.002", "warn", "Name the concrete thing instead of the abstraction."],
  ["core.vocab.003", "warn", "Replace with the property that makes it so, or remove."],
  ["core.vocab.004", "warn", "Remove the intensifier."],
  ["core.vocab.005", "warn", "Give the count or the items."],
  ["core.triad.001", "warn", "Keep the one that matters, or give evidence for each."],
  ["core.triad.002", "warn", "State the point directly without the contrast."],
  ["core.triad.003", "info", "Name the actual case instead of the range."],
  ["core.structure.001", "warn", "Remove headings; this is short enough to read as prose."],
  ["core.structure.002", "warn", "Rewrite as prose; keep a list only where the items are parallel."],
  ["core.structure.003", "warn", "Vary sentence length; combine or split so the rhythm is uneven."],
  ["core.structure.004", "block", "Remove the closing paragraph; it restates the opening."],
  ["core.structure.005", "warn", "Remove bold except for the one thing a reader must not miss."],
  ["core.repetition.001", "warn", "Remove this sentence or merge it with the earlier one that says the same thing."],
];

describe("the bundled core 0.1.0 pack", () => {
  it("parses under the strict schema and has exactly the 23 rules of docs/08", () => {
    expect(pack.id).toBe("core");
    expect(pack.version).toBe("0.1.0");
    expect(pack.findings_schema).toBe(1);
    expect(pack.rules.map((r) => r.id)).toEqual(DOC08.map(([id]) => id));
  });

  it("matches 08 on severity and instruction text for every rule", () => {
    for (const [id, severity, text] of DOC08) {
      const rule = pack.rules.find((r) => r.id === id);
      expect(rule?.severity, id).toBe(severity);
      expect(rule?.instruction.text, id).toBe(text);
    }
  });

  it("matches 08 on actions", () => {
    const actions: Record<string, string> = {
      "core.filler.001": "remove", "core.filler.002": "remove", "core.filler.003": "remove", "core.filler.004": "remove",
      "core.hedge.001": "remove", "core.hedge.002": "specify", "core.hedge.003": "remove", "core.hedge.004": "replace", "core.hedge.005": "specify",
      "core.vocab.001": "replace", "core.vocab.002": "replace", "core.vocab.003": "specify", "core.vocab.004": "remove", "core.vocab.005": "specify",
      "core.triad.001": "shorten", "core.triad.002": "rephrase", "core.triad.003": "rephrase",
      "core.structure.001": "restructure", "core.structure.002": "restructure", "core.structure.003": "rephrase", "core.structure.004": "remove", "core.structure.005": "remove",
      "core.repetition.001": "merge",
    };
    for (const rule of pack.rules) expect(rule.instruction.action, rule.id).toBe(actions[rule.id]);
  });

  it("every rule has a hit and a miss, and the category in the id is the category", () => {
    for (const rule of pack.rules) {
      expect(rule.examples.hit.length, rule.id).toBeGreaterThan(0);
      expect(rule.examples.miss.length, rule.id).toBeGreaterThan(0);
      expect(rule.id.split(".")[1], rule.id).toBe(rule.category);
    }
  });

  it("uses the ADR-15 match kinds: any for the composite rules, metrics for structure and repetition", () => {
    const kind = (id: string) => pack.rules.find((r) => r.id === id)?.match.kind;
    for (const id of ["core.hedge.001", "core.vocab.001", "core.vocab.002", "core.vocab.004", "core.triad.003"]) expect(kind(id), id).toBe("any");
    for (const id of ["core.structure.001", "core.structure.002", "core.structure.003", "core.structure.004", "core.structure.005"]) expect(kind(id), id).toBe("document_metric");
    expect(kind("core.repetition.001")).toBe("sentence_metric");
    const triad = pack.rules.find((r) => r.id === "core.triad.001")?.match;
    expect(triad).toMatchObject({ kind: "regex", sentence_exclude: "\\d", sentence_max_words: 25 });
    expect(pack.rules.find((r) => r.id === "core.filler.004")?.match).toMatchObject({ position: "sentence_start", max_doc_words: 399 });
    expect(pack.rules.find((r) => r.id === "core.structure.002")?.match).toMatchObject({ metric: "bullet_ratio", min_item_words: 6, min_sentences: 8 });
    expect(pack.rules.find((r) => r.id === "core.repetition.001")?.match).toMatchObject({ metric: "similarity_to_prior", above: 0.7, min_words: 6 });
  });

  it("long and descriptive examples are corpus references of the form <eval corpus ref: core/<rule>-<nnn>-hit|miss-01>", () => {
    const refs = pack.rules.flatMap((r) => [...r.examples.hit, ...r.examples.miss].filter((e) => e.startsWith("<eval corpus ref:")));
    expect(refs).toHaveLength(12); // 5 structure rules x (hit, miss), the filler.004 miss, the repetition.001 miss
    for (const ref of refs) expect(ref).toMatch(/^<eval corpus ref: core\/[a-z]+-\d{3}-(hit|miss)-\d{2}>$/);
    for (const id of ["core.structure.001", "core.structure.002", "core.structure.003", "core.structure.004", "core.structure.005"]) {
      const rule = pack.rules.find((r) => r.id === id);
      expect(rule?.examples.hit[0], id).toMatch(/^<eval corpus ref:/);
      expect(rule?.examples.miss[0], id).toMatch(/^<eval corpus ref:/);
    }
    expect(pack.rules.find((r) => r.id === "core.filler.004")?.examples.miss[0]).toBe("<eval corpus ref: core/filler-004-miss-01>");
  });

  it("is available as the bundled core 0.1.0 source", () => {
    expect(bundledPackSources()).toEqual({ core: [{ version: "0.1.0", signed: false, origin: "bundled" }] });
  });
});

// 08 "Default profile membership", as the categories and rules each starter must carry. Every
// entry is [layer index in the chain, origin]; base is layer 0 and the starter is layer 1.
const EXPECTED_OVERRIDES: Record<string, { categories: Record<string, Sev>; rules: Record<string, Sev>; allow: string[]; maxWords: number }> = {
  "local/base": { categories: {}, rules: {}, allow: [], maxWords: 600 },
  "local/pr-description": { categories: { triad: "info", structure: "block" }, rules: {}, allow: [], maxWords: 300 },
  "local/design-doc": {
    categories: {},
    rules: { "core.hedge.003": "info", "core.structure.001": "info", "core.structure.002": "info" },
    allow: ["comprehensive"],
    maxWords: 2500,
  },
  "local/email": { categories: {}, rules: { "core.filler.002": "info", "core.structure.001": "block" }, allow: [], maxWords: 200 },
  "local/chat-reply": { categories: {}, rules: { "core.structure.005": "block" }, allow: [], maxWords: 250 },
};

/** Effective severity per 08: a starter's rule cell beats its category cell beats the pack default. */
function expectedSeverity(starter: string, id: string): Sev {
  const want = EXPECTED_OVERRIDES[starter];
  const rule = want?.rules[id];
  if (rule !== undefined) return rule;
  const category = want?.categories[id.split(".")[1] as string];
  if (category !== undefined) return category;
  return DOC08.find(([ruleId]) => ruleId === id)?.[1] as Sev;
}

describe("bundled starter profiles", () => {
  it("are exactly the five from 08, all in the local namespace, all bundled", () => {
    expect(Object.keys(BUNDLED_PROFILE_YAML).sort()).toEqual(Object.keys(EXPECTED_OVERRIDES).sort());
    for (const id of Object.keys(BUNDLED_PROFILE_YAML)) expect(id.startsWith("local/")).toBe(true);
    for (const source of Object.values(bundledProfileSources())) expect(source).toMatchObject({ origin: "bundled", signed: false });
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
    expect(r.packs).toEqual([{ id: "core", range: ">=0.1.0 <1.0.0", version: "0.1.0", pinned_by: "local/base", signed: false, origin: "bundled" }]);
    expect(r.reviewer.enabled).toBe(true);
    expect(r.reviewer.categories).toEqual(["vague_claim", "unsupported_claim", "register"]);
    expect(r.enforcement).toEqual({ mode: "enforce", pass_cap: 2, render: "diff", required: false });
    expect(r.categories).toEqual({});
    expect(r.rules).toEqual({});
  });

  it("the bundled sources are marked bundled and unsigned", () => {
    const r = resolveProfile("local/pr-description", sources);
    expect(r.sources.map((s) => [s.id, s.signed, s.origin])).toEqual([
      ["local/base", false, "bundled"],
      ["local/pr-description", false, "bundled"],
    ]);
  });

  for (const [id, want] of Object.entries(EXPECTED_OVERRIDES)) {
    describe(id, () => {
      const r = resolveProfile(id, sources);
      const layer = id === "local/base" ? 0 : 1;

      it("resolves against the real core 0.1.0 pack", () => {
        expect(r.id).toBe(id);
        expect(r.resolved_from).toEqual(id === "local/base" ? ["local/base"] : ["local/base", id]);
        expect(r.packs[0]).toMatchObject({ id: "core", version: "0.1.0", origin: "bundled" });
      });

      it("carries exactly the 08 category overrides, and no others", () => {
        const expected = Object.fromEntries(Object.entries(want.categories).map(([c, severity]) => [c, { severity, origin: id, layer }]));
        expect(r.categories).toEqual(expected);
      });

      it("carries exactly the 08 rule overrides, and no others", () => {
        const expected = Object.fromEntries(Object.entries(want.rules).map(([ruleId, value]) => [ruleId, { severity: { value, origin: id, layer } }]));
        expect(r.rules).toEqual(expected);
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
        expect(r.reviewer.origins.enabled).toBe("local/base");
        expect(r.enforcement).toEqual({ mode: "enforce", pass_cap: 2, render: "diff", required: false });
      });

      it("has the 08 effective severity for all 23 rules, all enabled", () => {
        for (const rule of pack.rules) {
          const eff = effectiveRule(r, rule);
          expect(eff.enabled, `${id} ${rule.id}`).toBe(true);
          expect(eff.severity, `${id} ${rule.id}`).toBe(expectedSeverity(id, rule.id));
        }
      });

      it("names this profile as the origin of every rule it touches, and base for the rest", () => {
        for (const rule of pack.rules) {
          const touched = rule.id in want.rules || rule.category in want.categories;
          expect(effectiveRule(r, rule).origin, `${id} ${rule.id}`).toBe(touched ? id : "local/base");
        }
      });
    });
  }

  it("a table of all 23 rules by 5 starters", () => {
    const rows = DOC08.map(([ruleId]) =>
      Object.keys(EXPECTED_OVERRIDES).map((starter) => {
        const r = resolveProfile(starter, sources);
        const rule = pack.rules.find((x) => x.id === ruleId);
        return rule === undefined ? "missing" : effectiveRule(r, rule).severity;
      }),
    );
    const starters = Object.keys(EXPECTED_OVERRIDES);
    expect(starters).toEqual(["local/base", "local/pr-description", "local/design-doc", "local/email", "local/chat-reply"]);
    // [base, pr-description, design-doc, email, chat-reply] per rule, written out from 08
    expect(rows).toEqual([
      ["block", "block", "block", "block", "block"], // filler.001
      ["block", "block", "block", "info", "block"], // filler.002 (email: sign-offs allowed)
      ["block", "block", "block", "block", "block"], // filler.003
      ["warn", "warn", "warn", "warn", "warn"], // filler.004
      ["block", "block", "block", "block", "block"], // hedge.001
      ["warn", "warn", "warn", "warn", "warn"], // hedge.002
      ["warn", "warn", "info", "warn", "warn"], // hedge.003 (design-doc: positions argued)
      ["block", "block", "block", "block", "block"], // hedge.004
      ["warn", "warn", "warn", "warn", "warn"], // hedge.005
      ["warn", "warn", "warn", "warn", "warn"], // vocab.001
      ["warn", "warn", "warn", "warn", "warn"], // vocab.002
      ["warn", "warn", "warn", "warn", "warn"], // vocab.003
      ["warn", "warn", "warn", "warn", "warn"], // vocab.004
      ["warn", "warn", "warn", "warn", "warn"], // vocab.005
      ["warn", "info", "warn", "warn", "warn"], // triad.001 (pr-description: triad -> info)
      ["warn", "info", "warn", "warn", "warn"], // triad.002
      ["info", "info", "info", "info", "info"], // triad.003 (pack default is info already)
      ["warn", "block", "info", "block", "warn"], // structure.001
      ["warn", "block", "info", "warn", "warn"], // structure.002
      ["warn", "block", "warn", "warn", "warn"], // structure.003
      ["block", "block", "block", "block", "block"], // structure.004
      ["warn", "block", "warn", "warn", "block"], // structure.005
      ["warn", "warn", "warn", "warn", "warn"], // repetition.001
    ]);
  });

  it("design-doc allows the term comprehensive, which is a vocab.003 phrase", () => {
    const r = resolveProfile("local/design-doc", sources);
    expect(r.allow_terms).toContain("comprehensive");
    const phrases = pack.rules.find((x) => x.id === "core.vocab.003")?.match;
    expect(phrases?.kind === "phrase" && phrases.phrases.includes("comprehensive")).toBe(true);
  });

  it("register text reads as house style: ASCII, one short sentence each, no emoji, no markup", () => {
    for (const id of Object.keys(EXPECTED_OVERRIDES)) {
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
    for (const id of Object.keys(EXPECTED_OVERRIDES)) {
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
