import { describe, expect, it } from "vitest";
import { findingId } from "@prosegate/schema";
import { packOf, review, ruleYaml, run } from "./helpers.js";

// ADR-23: ids are position-independent (the segment is not in the preimage), and a document-scope
// finding's id does not depend on its anchor text.

const BASE =
  "The cache is per tenant.\n\nIt's worth noting that the index is unique and writes go to one shard.\n\nReads fan out across replicas and never touch the primary.";

describe("pass 2 keeps a block tic block when a revision renumbers the segments (ADR-23)", () => {
  const p1 = review(BASE);
  const tic = p1.findings.find((f) => f.rule_id === "core.hedge.001");
  const prior = p1.findings.map((f) => f.id);

  it("pass 1 flagged the tic as a block", () => {
    expect(tic?.severity).toBe("block");
    expect(tic?.id).toBe(findingId("hedge", "core.hedge.001", "it's worth noting that"));
  });

  const REVISIONS: Array<[string, string]> = [
    ["a paragraph is prepended", `Here is a short introduction to the change.\n\n${BASE}`],
    ["a code block is inserted above", `\`\`\`sh\nmake test\n\`\`\`\n\n${BASE}`],
    ["two paragraphs above are merged", BASE.replace("The cache is per tenant.\n\n", "The cache is per tenant. ")],
    ["three paragraphs are prepended", `One.\n\nTwo is here.\n\nThree is here too.\n\n${BASE}`],
    ["a heading and a table are inserted above", `# Notes\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\n${BASE}`],
  ];

  for (const [name, revised] of REVISIONS) {
    it(`${name}: the tic stays block, is not cleared, and the verdict is revise`, () => {
      const p2 = review(revised, { pass: 2, prior });
      expect(p2.findings.map((f) => [f.rule_id, f.severity])).toEqual([["core.hedge.001", "block"]]);
      expect(p2.findings[0]?.id).toBe(tic?.id);
      expect(p2.cleared).not.toContain(tic?.id);
      expect(p2.verdict).toBe("revise");
      // and the final cap check still lists it
      expect(review(revised, { pass: 2, prior, capCheck: true }).findings).toHaveLength(1);
    });
  }

  it("the same span in a different segment has the same id", () => {
    const moved = review(`Intro.\n\n${BASE}`);
    expect(moved.findings.find((f) => f.rule_id === "core.hedge.001")?.id).toBe(tic?.id);
    expect(moved.findings.find((f) => f.rule_id === "core.hedge.001")?.span.segment_id).not.toBe(tic?.span.segment_id);
  });
});

describe("document-scope ids do not depend on the anchor text (ADR-23)", () => {
  const cv = packOf(ruleYaml("core.structure.003", "{ kind: document_metric, metric: sentence_length_cv, below: 0.5, min_sentences: 3 }"));
  const idOf = (text: string): string | undefined => run(text, { packs: [cv] }).result.findings[0]?.id;

  it("rewording the anchor sentence keeps the id; the rule still fires", () => {
    const a = idOf("One two three. Four five six. Seven eight nine.");
    const b = idOf("Completely different words here. Four five six. Seven eight nine.");
    expect(a).toBeDefined();
    expect(a).toBe(b);
    expect(a).toBe(findingId("structure", "core.structure.003", ""));
  });

  it("the finding clears when the rule stops firing", () => {
    const a = idOf("One two three. Four five six. Seven eight nine.") as string;
    const p2 = run("One. Four five six seven eight nine ten eleven twelve. Seven eight nine ten.", { packs: [cv], pass: 2, prior: [a] });
    expect(p2.result.cleared).toEqual([a]);
  });
});
