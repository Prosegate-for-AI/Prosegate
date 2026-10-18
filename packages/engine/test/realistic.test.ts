import { describe, expect, it } from "vitest";
import { profile, run } from "./helpers.js";
import { CLEAN } from "./fixtures/realistic/clean-corpus.js";
import { CLEAN2 } from "./fixtures/realistic/clean-corpus2.js";
import { CLEAN4 } from "./fixtures/realistic/clean-corpus4.js";
import { TICS } from "./fixtures/realistic/tics.js";

// ADR-24: the realistic false-positive and recall pass. 90 natural replies a careful editor would accept
// (PRs, commit messages, design notes, incident reviews, chat answers), and 20 replies dense with the tics
// of 08, from the adversarial review of the first engine. Floors are bypassed so every document runs.

const PROFILES = ["local/base", "local/pr-description", "local/design-doc", "local/email", "local/chat-reply"] as const;
const NATURAL = [...CLEAN, ...CLEAN2, ...CLEAN4];

/**
 * The block findings we accept on the natural set, with the reason. Everything else must be zero.
 *  - explain-08 opens "Note that the --force flag ...": a literal, useful sentence that core.hedge.001's
 *    sentence-initial "note that" (08, block) flags under every profile. ADR-24 puts "note that" at block on the
 *    at-risk watchlist; the human control set decides it in Phase 6. Not softened here.
 *  - email raises core.structure.001 (headings) to block by design (08 "Default profile membership"), so the
 *    natural replies with headings (design notes, PR templates, incident reviews) are flagged under email.
 */
const ACCEPTED_BLOCKS: Array<[profile: string, doc: string, rule: string]> = [
  ...PROFILES.map((p) => [p, "explain-08", "core.hedge.001"] as [string, string, string]),
  ...["design-01", "incident-01", "prl-01", "prl-02", "dsl-01", "dsl-02", "long-02"].map((d) => ["local/email", d, "core.structure.001"] as [string, string, string]),
];

function blocksFor(profileId: string): Array<[string, string, string]> {
  const resolved = profile(profileId);
  const out: Array<[string, string, string]> = [];
  for (const d of NATURAL) {
    for (const f of run(d.text, { profile: resolved }).result.findings) {
      if (f.severity === "block") out.push([profileId, d.id, f.rule_id ?? ""]);
    }
  }
  return out;
}

describe("natural clean replies (false positives)", () => {
  it("has 90 documents", () => {
    expect(NATURAL.length).toBe(90);
  });

  it("zero block findings under all five starter profiles, except the accepted ones", () => {
    const got = PROFILES.flatMap(blocksFor);
    const key = (t: [string, string, string]): string => t.join(" | ");
    expect(got.map(key).sort()).toEqual(ACCEPTED_BLOCKS.map(key).sort());
  });

  it("prints findings per rule per profile", () => {
    const rules = new Map<string, Map<string, number>>();
    const blocks = new Map<string, number>();
    for (const p of PROFILES) {
      const resolved = profile(p);
      for (const d of NATURAL) {
        for (const f of run(d.text, { profile: resolved }).result.findings) {
          const row = rules.get(f.rule_id ?? "") ?? new Map<string, number>();
          row.set(p, (row.get(p) ?? 0) + 1);
          rules.set(f.rule_id ?? "", row);
          if (f.severity === "block") blocks.set(p, (blocks.get(p) ?? 0) + 1);
        }
      }
    }
    const head = `rule${" ".repeat(20)}${PROFILES.map((p) => p.slice(6).padEnd(16)).join("")}`;
    const lines = [...rules.keys()].sort().map((r) => `${r.padEnd(24)}${PROFILES.map((p) => String(rules.get(r)?.get(p) ?? 0).padEnd(16)).join("")}`);
    console.log(`\nfindings (block + warn) over ${NATURAL.length} natural replies\n${head}\n${lines.join("\n")}\nblock findings: ${PROFILES.map((p) => `${p.slice(6)}=${blocks.get(p) ?? 0}`).join(" ")}\n`);
    expect(rules.size).toBeGreaterThan(3);
  });
});

// The tics a careful editor would cut that no rule of 08 (with ADR-24's variants) is shaped to catch.
const OUT_OF_SCOPE: Record<string, string> = {
  't03 "Leverage"': "imperative at the start of a bullet: core.vocab.001 wants a subject, modal or 'to' before 'leverage'",
  't03 "Note that"': "second sentence inside a list item: a list item is one unit, so 'note that' is not at a sentence start",
  't10 "I hope this email finds you well"': "no rule lists it (08 has 'i hope this helps')",
  't10 "remarkable"': "08 lists 'remarkably', not 'remarkable'",
  't11 "isn\'t just a performance optimization; it\'s"': "core.triad.002 is 'not just ...'; 'isn't just' is another shape",
  't13 "Importantly"': "not in 08",
  't14 "not just a tool, it\'s"': "core.triad.002 closes with 'but' / \"it's about\"; \"it's\" alone is another shape",
  't16 "It\'s important to note that"': "inside a blockquote, which is never linted",
  't19 "<bold density>"': "three sentences: under core.structure.005's min_sentences 6",
  't20 "Each tenant has its own cache, and entries expire after one hour"': "a paraphrase, below core.repetition.001's 0.7 cosine",
  't20 "Reads are served by the replica"': "a paraphrase, below core.repetition.001's 0.7 cosine",
  't20 "<closing restates opening>"': "a two-sentence recap, under core.structure.004's min_sentences 6",
};

describe("tic-dense replies (recall)", () => {
  const results = TICS.map((t) => {
    const r = run(t.text, { profile: profile(t.profile ?? "local/base") });
    const fs = r.diagnostics.all_findings;
    return t.want.map((w) => {
      let hit;
      if (w === "<bold density>") hit = fs.find((f) => f.rule_id === "core.structure.005");
      else if (w === "<closing restates opening>") hit = fs.find((f) => f.rule_id === "core.structure.004");
      else {
        const i = t.text.indexOf(w);
        hit = i < 0 ? undefined : fs.find((f) => f.scope !== "document" && f.span.start < i + w.length && i < f.span.end);
      }
      return { key: `${t.id} ${JSON.stringify(w)}`, hit: hit !== undefined };
    });
  }).flat();

  it("has 20 documents", () => {
    expect(TICS.length).toBe(20);
  });

  it("recall is at least 85% of the in-scope tics, and the misses are exactly the documented out-of-scope ones", () => {
    const missed = results.filter((r) => !r.hit).map((r) => r.key);
    const inScope = results.filter((r) => !(r.key in OUT_OF_SCOPE));
    const caught = inScope.filter((r) => r.hit).length;
    console.log(`\ntic recall: ${results.filter((r) => r.hit).length}/${results.length} overall; ${caught}/${inScope.length} in scope (${((caught / inScope.length) * 100).toFixed(0)}%)\nmissed (documented out of scope):\n${missed.map((m) => `  ${m}: ${OUT_OF_SCOPE[m] ?? "UNDOCUMENTED"}`).join("\n")}\n`);
    expect(caught / inScope.length).toBeGreaterThanOrEqual(0.85);
    expect(missed.sort()).toEqual(Object.keys(OUT_OF_SCOPE).sort());
  });

  it("overall recall is at least 85% too", () => {
    expect(results.filter((r) => r.hit).length / results.length).toBeGreaterThanOrEqual(0.85);
  });

  it("nearly every tic-dense reply is revised under its profile", () => {
    const revised = TICS.filter((t) => run(t.text, { profile: profile(t.profile ?? "local/base") }).result.verdict === "revise").length;
    expect(revised).toBeGreaterThanOrEqual(19);
  });
});
