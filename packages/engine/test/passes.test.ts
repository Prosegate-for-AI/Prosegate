import { describe, expect, it } from "vitest";
import { renderNotice } from "@prosegate/schema";
import { profile, review, run } from "./helpers.js";

const SEEN_TWICE = "It's worth noting that the cache is per tenant. The index is unique. It's worth noting that the index is unique.";

describe("pass 1", () => {
  it("reports block and warn, counts info in stats only", () => {
    const text = "Whether it's a startup or an enterprise, the plan is robust. It's worth noting that it works.";
    const r = run(text);
    expect(r.result.findings.map((f) => [f.rule_id, f.severity])).toEqual([
      ["core.vocab.003", "warn"],
      ["core.hedge.001", "block"],
    ]);
    expect(r.result.stats.findings_by_category).toEqual({ triad: 1, vocab: 1, hedge: 1 });
    expect(r.diagnostics.all_findings).toHaveLength(3);
    expect(r.result.verdict).toBe("revise");
    expect(r.result.cleared).toEqual([]);
    expect(r.result.pass).toBe(1);
  });

  it("verdict is pass with only warn findings, and with no findings", () => {
    expect(review("The plan is robust and the index is unique.").verdict).toBe("pass");
    expect(review("The index is unique and the cache is per tenant.").verdict).toBe("pass");
  });

  it("the stats follow the brief", () => {
    const text = "# Plan\n\nThe plan is robust.   It is fine. Done now.";
    const r = review(text);
    expect(r.stats.reviewer).toBeNull();
    expect(r.stats.rule_packs).toEqual([{ id: "core", version: "0.1.0" }]);
    expect(r.stats.sentence_count).toBe(3);
    expect(r.stats.prose_chars).toBe("Plan".length + "The plan is robust.".length + "It is fine.".length + "Done now.".length);
    expect(r.stats.rules_latency_ms).toBeGreaterThanOrEqual(0);
    expect(r.profile).toEqual({ id: "local/base", version: profile().version, resolved_from: ["local/base"] });
  });
});

describe("pass 2", () => {
  const text1 = "The plan is robust. It's worth noting that it works. It could potentially fail.";
  const p1 = review(text1);
  const priorIds = p1.findings.map((f) => f.id);

  it("pass 1 produced block and warn findings", () => {
    expect(p1.findings.map((f) => f.severity).sort()).toEqual(["block", "block", "warn"]);
  });

  it("reports only block findings whose id was reported on pass 1", () => {
    const r = review(text1, { pass: 2, prior: priorIds });
    expect(r.findings.map((f) => [f.rule_id, f.severity])).toEqual([
      ["core.hedge.001", "block"],
      ["core.hedge.004", "block"],
    ]);
    expect(r.pass).toBe(2);
    expect(r.cleared).toEqual([]);
    expect(r.verdict).toBe("revise");
  });

  it("a warn finding of pass 1 is not reported again on pass 2 (still present, so not cleared)", () => {
    const r = run(text1, { pass: 2, prior: priorIds });
    expect(r.result.findings.find((f) => f.rule_id === "core.vocab.003")).toBeUndefined();
    expect(r.diagnostics.all_findings.find((f) => f.rule_id === "core.vocab.003")?.severity).toBe("info");
    expect(r.result.cleared).not.toContain(p1.findings.find((f) => f.rule_id === "core.vocab.003")?.id);
  });

  it("new findings on pass 2 are demoted to info and counted in stats only", () => {
    const revised = "The plan is robust. It works. It could potentially fail. Truly, it may or may not help.";
    const r = run(revised, { pass: 2, prior: priorIds });
    expect(r.result.findings.map((f) => f.rule_id)).toEqual(["core.hedge.004"]);
    const demoted = r.diagnostics.all_findings.filter((f) => !r.result.findings.includes(f));
    expect(demoted.every((f) => f.severity === "info")).toBe(true);
    expect(demoted.map((f) => f.rule_id).sort()).toEqual(["core.hedge.004", "core.vocab.003", "core.vocab.004"]);
    expect(r.result.stats.findings_by_category).toEqual({ hedge: 2, vocab: 2 });
  });

  it("cleared lists the pass-1 ids with no occurrence left; a verdict of pass when all are gone", () => {
    const revised = "The plan holds. It works. It fails when the disk is full.";
    const r = review(revised, { pass: 2, prior: priorIds });
    expect(r.findings).toEqual([]);
    expect([...r.cleared].sort()).toEqual([...priorIds].sort());
    expect(r.verdict).toBe("pass");
    expect(r.feedback_text).toBe("");
  });

  it("a reworded span gets a new id and counts as cleared", () => {
    const revised = text1.replace("It's worth noting that it works.", "It is worth noting that it works.");
    const r = review(revised, { pass: 2, prior: priorIds });
    expect(r.findings.map((f) => f.rule_id)).toEqual(["core.hedge.004"]);
    expect(r.cleared).toContain(p1.findings.find((f) => f.rule_id === "core.hedge.001")?.id);
  });

  it("an unchanged span keeps its id across passes and across a move", () => {
    const moved = "It could potentially fail. The plan is robust. It's worth noting that it works.";
    const r = review(moved, { pass: 2, prior: priorIds });
    expect(r.findings.map((f) => f.id).sort()).toEqual(p1.findings.filter((f) => f.severity === "block").map((f) => f.id).sort());
  });

  it("an empty prior set demotes everything", () => {
    const r = run(text1, { pass: 2, prior: [] });
    expect(r.result.findings).toEqual([]);
    expect(r.result.verdict).toBe("pass");
    expect(r.diagnostics.all_findings).toHaveLength(3);
  });

  it("enforce: false never returns revise", () => {
    expect(review(text1, { pass: 2, prior: priorIds, enforce: false }).verdict).toBe("pass");
  });
});

describe("non-unique ids (ADR-17)", () => {
  const p1 = review(SEEN_TWICE);
  const id = p1.findings[0]?.id as string;

  it("two occurrences of one span share an id", () => {
    expect(p1.findings.map((f) => f.span.text)).toEqual(["It's worth noting that", "It's worth noting that"]);
    expect(p1.findings[1]?.id).toBe(id);
    expect(p1.findings[0]?.span.start).not.toBe(p1.findings[1]?.span.start);
  });

  it("an id counts as cleared only when no occurrence remains", () => {
    const one = review("The cache is per tenant. The index is unique. It's worth noting that the index is unique.", { pass: 2, prior: [id] });
    expect(one.cleared).toEqual([]);
    expect(one.findings).toHaveLength(1);
    expect(one.findings[0]?.id).toBe(id);
    const none = review("The cache is per tenant. The index is unique.", { pass: 2, prior: [id] });
    expect(none.cleared).toEqual([id]);
  });

  it("both occurrences are reported on pass 2 when both remain", () => {
    expect(review(SEEN_TWICE, { pass: 2, prior: [id] }).findings).toHaveLength(2);
  });

  it("duplicate prior ids are a set", () => {
    const none = review("The cache is per tenant. The index is unique.", { pass: 2, prior: [id, id] });
    expect(none.cleared).toEqual([id]);
  });
});

describe("capCheck (ADR-12)", () => {
  const text1 = "The plan is robust. It's worth noting that it works. It could potentially fail.";
  const prior = review(text1).findings.map((f) => f.id);

  it("returns verdict pass with skipped_reason pass_cap and keeps the survivors", () => {
    const r = review(text1, { pass: 2, prior, capCheck: true });
    expect(r.verdict).toBe("pass");
    expect(r.skipped_reason).toBe("pass_cap");
    expect(r.pass).toBe(2);
    expect(r.findings.map((f) => f.rule_id)).toEqual(["core.hedge.001", "core.hedge.004"]);
    expect(renderNotice(r, { mode: "enforce", render: "diff", firstNoticeOfSession: false, phase: "shipped" })).toBe(
      [
        "Prosegate · 2 findings remain after 2 passes · shipped as is",
        '  hedge   core.hedge.001  "It\'s worth noting that"',
        '  hedge   core.hedge.004  "could potentially"',
      ].join("\n"),
    );
  });

  it("with nothing left it is still a pass_cap pass and the shipped notice is silent", () => {
    const r = review("The plan holds. It fails when the disk is full.", { pass: 2, prior, capCheck: true });
    expect(r.verdict).toBe("pass");
    expect(r.skipped_reason).toBe("pass_cap");
    expect(r.findings).toEqual([]);
    expect(r.cleared.length).toBe(prior.length);
    expect(renderNotice(r, { mode: "enforce", render: "diff", firstNoticeOfSession: false, phase: "shipped" })).toBeNull();
  });

  it("filters like pass 2 even when the request still says pass 1", () => {
    const r = review(text1, { pass: 1, prior, capCheck: true });
    expect(r.pass).toBe(2);
    expect(r.findings.map((f) => f.rule_id)).toEqual(["core.hedge.001", "core.hedge.004"]);
  });
});

describe("determinism", () => {
  it("the same input gives the same result, ids included (rules_latency_ms aside)", () => {
    const text = "Great question! It's worth noting that the robust design could potentially delve in. It is fast, simple, and reliable.";
    const a = review(text);
    const b = review(text);
    expect({ ...a, stats: { ...a.stats, rules_latency_ms: 0 } }).toEqual({ ...b, stats: { ...b.stats, rules_latency_ms: 0 } });
    expect(a.findings.map((f) => f.id)).toEqual(b.findings.map((f) => f.id));
  });

});

describe("pass 2 reports a strict subset of pass 1, on randomised revisions", () => {
  const POOL = [
    "The cache is per tenant.",
    "It's worth noting that the index is unique.",
    "The plan is robust and the rollout is seamless.",
    "It could potentially break the build.",
    "Each tenant has its own cache, which is fast, simple, and reliable.",
    "We delve into the logs.",
    "Truly, this is a pivotal change.",
    "It depends.",
    "The query takes 400 ms.",
    "Great question! The answer is short.",
    "I hope this helps.",
    "Arguably, the retry is unnecessary.",
    "The job runs nightly at 02:00.",
    "A number of options exist.",
    "It is not just about speed, it is about trust.",
    "Tests cover the eviction path.",
    "The migration took three hours on staging.",
  ];
  const WORD_SWAPS: Array<[string, string]> = [
    ["robust", "sturdy"],
    ["seamless", "smooth"],
    ["worth noting", "worth saying"],
    ["potentially", "really"],
    ["delve", "look"],
    ["pivotal", "large"],
  ];

  function prng(seed: number): () => number {
    let s = seed >>> 0;
    return () => {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      return s / 2 ** 32;
    };
  }

  it("holds for 300 random documents and revisions", () => {
    const rand = prng(424242);
    let surviving = 0;
    let clearedSome = 0;
    const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)] as T;
    for (let round = 0; round < 300; round++) {
      const sentences = Array.from({ length: 3 + Math.floor(rand() * 10) }, () => pick(POOL));
      const doc1 = sentences.join(rand() < 0.3 ? "\n\n" : " ");
      const p1 = review(doc1);
      const reported = p1.findings.map((f) => f.id);
      const blockIds = new Set(p1.findings.filter((f) => f.severity === "block").map((f) => f.id));

      // revise: drop, swap words, insert, duplicate, shuffle
      let revised = [...sentences];
      for (let k = 0; k < 1 + Math.floor(rand() * 4); k++) {
        const op = Math.floor(rand() * 5);
        const i = Math.floor(rand() * Math.max(1, revised.length));
        if (op === 0) revised.splice(i, 1);
        else if (op === 1) {
          const [from, to] = pick(WORD_SWAPS);
          revised = revised.map((s) => s.replace(from, to));
        } else if (op === 2) revised.splice(i, 0, pick(POOL));
        else if (op === 3) revised.splice(i, 0, revised[i] ?? pick(POOL));
        else revised.reverse();
      }
      const doc2 = revised.join(rand() < 0.3 ? "\n\n" : " ");
      const p2 = run(doc2, { pass: 2, prior: reported });

      surviving += p2.result.findings.length > 0 ? 1 : 0;
      clearedSome += p2.result.cleared.length > 0 ? 1 : 0;
      for (const f of p2.result.findings) {
        expect(f.severity).toBe("block");
        expect(blockIds.has(f.id), `pass 2 reported ${f.rule_id} "${f.span.text}" that pass 1 did not\n${doc1}\n---\n${doc2}`).toBe(true);
      }
      const present = new Set(p2.diagnostics.all_findings.map((f) => f.id));
      for (const id of p2.result.cleared) {
        expect(reported).toContain(id);
        expect(present.has(id)).toBe(false);
      }
      for (const id of reported) expect(p2.result.cleared.includes(id) !== present.has(id)).toBe(true);
      expect(p2.result.verdict).toBe(p2.result.findings.length > 0 ? "revise" : "pass");
      expect(p2.result.stats.findings_by_category).toEqual(countBy(p2.diagnostics.all_findings.map((f) => f.category)));
    }
    // the property is not vacuous
    expect(surviving).toBeGreaterThan(100);
    expect(clearedSome).toBeGreaterThan(100);
  });
});

function countBy(xs: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const x of xs) out[x] = (out[x] ?? 0) + 1;
  return out;
}
