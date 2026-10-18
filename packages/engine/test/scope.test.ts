import { describe, expect, it } from "vitest";
import { analyse } from "@prosegate/segmenter";
import { resolveOverlaps, type Resolvable } from "../src/index.js";
import { hits, packOf, profile, review, ruleYaml, run } from "./helpers.js";

// ADR-24: document-metric findings have scope 'document', are exempt from overlap resolution, and
// are anchored on the text their instruction names.

const doc = (id: string, match: string): ReturnType<typeof packOf> => packOf(ruleYaml(id, match));
const anchor = (text: string, id: string, match: string): { text: string; scope: string | undefined } | undefined => {
  const f = run(text, { packs: [doc(id, match)] }).result.findings[0];
  return f === undefined ? undefined : { text: f.span.text, scope: f.scope };
};

describe("document-scope findings are anchored where the instruction points", () => {
  it("headers_per_100_words: the first heading", () => {
    const text = "Intro sentence here, quite short.\n\n## Alpha\n\nBody text goes here.\n\n## Beta\n\nMore body.";
    expect(anchor(text, "core.structure.001", "{ kind: document_metric, metric: headers_per_100_words, above: 1, min_sentences: 1 }")).toEqual({ text: "Alpha", scope: "document" });
  });

  it("bullet_ratio: the first qualifying list item", () => {
    const text = "Intro here.\n\n- short one\n- this item has more than six words in it\n- another long item with plenty of words in it\n- tiny";
    const m = "{ kind: document_metric, metric: bullet_ratio, above: 0.3, min_sentences: 1, min_item_words: 6 }";
    expect(anchor(text, "core.structure.002", m)).toEqual({ text: "this item has more than six words in it", scope: "document" });
  });

  it("sentence_length_cv: the first sentence", () => {
    const text = "# Title\n\nOne two three. Four five six. Seven eight nine.";
    expect(anchor(text, "core.structure.003", "{ kind: document_metric, metric: sentence_length_cv, below: 0.5, min_sentences: 1 }")).toEqual({ text: "One two three.", scope: "document" });
  });

  it("closing_similarity: the first sentence of the closing block", () => {
    const a = "The deploy pipeline is slow because the tests are slow.";
    const text = `${a} It hurts.\n\nBananas sail on ships.\n\nNobody disputes that. ${a}`;
    expect(anchor(text, "core.structure.004", "{ kind: document_metric, metric: closing_similarity, above: 0.3, min_sentences: 1 }")).toEqual({ text: "Nobody disputes that.", scope: "document" });
  });

  it("bold_per_100_words: the first bold span, markers included", () => {
    const text = "Plain start here. Then **this part** is bold and **that part** too, in a sentence of words.";
    const f = run(text, { packs: [doc("core.structure.005", "{ kind: document_metric, metric: bold_per_100_words, above: 1, min_sentences: 1 }")] }).result.findings[0];
    expect(f?.span.text).toBe("**this part**");
    expect(f?.scope).toBe("document");
    expect(text.slice(f?.span.start, f?.span.end)).toBe("**this part**");
  });

  it("phrase findings carry no scope field", () => {
    const f = review("It is a robust plan, truly.").findings[0];
    expect(f).toBeDefined();
    expect("scope" in (f as object)).toBe(false);
  });
});

describe("document-scope findings are exempt from overlap resolution", () => {
  const f = (name: string, start: number, end: number, scope?: "document"): Resolvable & { name: string } => ({
    name,
    source: "rule",
    category: "structure",
    rule_id: `core.structure.00${name}`,
    severity: "warn",
    span: { start, end },
    scope,
  });

  it("neither wins nor loses against anything, and several coexist", () => {
    const out = resolveOverlaps([f("1", 0, 20, "document"), { ...f("2", 5, 10), category: "hedge", rule_id: "core.hedge.001", severity: "info" }, f("3", 8, 30, "document")]);
    expect(out.map((x) => x.name).sort()).toEqual(["1", "2", "3"]);
    expect(out.map((x) => x.span.start)).toEqual([0, 5, 8]);
  });

  it("does not drop a span finding it intersects, even one of lower severity", () => {
    const span = { ...f("2", 5, 10), category: "hedge" as const, rule_id: "core.hedge.001", severity: "info" as const };
    expect(resolveOverlaps([span, { ...f("1", 0, 20, "document"), severity: "block" as const }]).map((x) => x.name)).toContain("2");
  });
});

describe("the reviewer's swallow and overlap repros", () => {
  const SWALLOW = `Great question! The import fails on rows with an empty date field.

The parser treats an empty string as a date and throws. About 40 rows in the March export have no date. The rest of the file is fine. The error message does not name the row, which is why it took a while to find. I checked the April and May exports as well, and they have no empty dates.

Treat an empty date field in the import rows as null.`;

  it("a tic in the first sentence is reported beside any document finding, and survives pass 2 when the closing paragraph goes", () => {
    const p1 = run(SWALLOW);
    expect(p1.result.findings.map((f) => [f.rule_id, f.severity, f.span.text])).toContainEqual(["core.filler.001", "block", "Great question"]);
    const t2 = SWALLOW.slice(0, SWALLOW.lastIndexOf("\n\n"));
    const p2 = run(t2, { pass: 2, prior: p1.result.findings.map((f) => f.id) });
    expect(p2.result.verdict).toBe("revise");
    expect(p2.result.findings.map((f) => [f.rule_id, f.severity])).toContainEqual(["core.filler.001", "block"]);
    expect(p2.result.cleared).not.toContain(p1.result.findings.find((f) => f.rule_id === "core.filler.001")?.id);
  });

  const PR = `## Summary

Great question! This PR moves PDF rendering into a background job so large invoices stop timing out.

## Changes

- Enqueue a job from \`POST /invoices/:id/pdf\` and return 202 with the job ID.
- Report job status and a signed URL from \`GET /jobs/:id\` when the job finishes.
- Keep the synchronous endpoint behind a flag for one release for old integrations.
- Poll the job endpoint from the web app every two seconds until the PDF is ready.

## Testing

Unit tests cover the handler. The largest staging invoice renders in 8.7 seconds.`;

  it("template headings: the structure finding sits on the first heading and the tic is still a block", () => {
    const r = run(PR, { profile: profile("local/base") });
    const struct = r.result.findings.find((f) => f.rule_id === "core.structure.001");
    expect(struct?.scope).toBe("document");
    expect(struct?.span.text).toBe("Summary");
    const tic = r.result.findings.find((f) => f.rule_id === "core.filler.001");
    expect(tic?.severity).toBe("block");
    expect(r.result.verdict).toBe("revise");
  });

  it("under pr-description the headings are info and the tic is the only finding", () => {
    const r = run(PR, { profile: profile("local/pr-description") });
    expect(r.result.findings.map((f) => f.rule_id)).toEqual(["core.filler.001"]);
  });

  it("a warn tic in the first sentence and a firing structure rule both appear", () => {
    const text = PR.replace("Great question! This PR moves", "This PR moves").replace("background job", "robust background job").replace("Unit tests cover the handler.", "Unit tests cover the handler. Integration tests cover the poller.");
    const r = run(text, { profile: profile("local/base") });
    const rules = r.result.findings.map((f) => f.rule_id);
    expect(rules).toContain("core.vocab.003");
    expect(rules).toContain("core.structure.001");
    expect(analyse(text).units.length).toBeGreaterThan(5);
    expect(hits(text).map(([id]) => id)).toContain("core.vocab.003");
  });
});
