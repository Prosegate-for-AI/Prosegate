import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { FORK_TEXT, REVIEWER_MODEL_BY_PROVIDER } from "@prosegate/schema";
import { annotate, adjudicate, agreement, annotationDir, kappa, marks, qualified, readAnnotations } from "./annotations.js";
import { hash, within, writeNew } from "./common.js";
import { corpusAudit, loadRubric } from "./corpus.js";
import { GenerationPlan, generate } from "./generate.js";
import { Spend, complete, completionText, rawFindings, type Model } from "./provider.js";
import { evaluateReviewer, gate, matched, rawMetrics } from "./reviewer-eval.js";
import { evaluateE2e, fabricationCandidates, humanSample, scoreE2e, type E2eEvidence } from "./e2e.js";
import { importCorpus } from "./import.js";

const temp = () => mkdtempSync(join(tmpdir(), "prosegate-eval6-"));
const model = (over: Partial<Model> = {}): Model => ({
  id: REVIEWER_MODEL_BY_PROVIDER.openai, provider: "openai", family: "test-family", generation: "test-generation",
  input_usd_per_million: 1, output_usd_per_million: 2, pricing_checked_on: new Date().toISOString().slice(0, 10), max_output_tokens: 2048, ...over,
});
const response = (text: string) => ({ status: "completed", output: [{ type: "message", content: [{ type: "output_text", text }] }], usage: { input_tokens: 20, output_tokens: 10 } });
const raw = (over = {}) => ({ span_text: "It always works.", category: "unsupported_claim", severity: "block", confidence: 0.9,
  action: "cite_or_soften_or_remove", instruction: FORK_TEXT.unsupported_claim, evidence: "No supporting evidence.", ...over });
const prompt = { id: "cache", profile: "base", system: "Write a factual explanation.", user: "Explain cache eviction.", style_constraints: "" };
const text = `It always works. ${"The cache retains entries until the next request. ".repeat(35)}`;
const gold = [{ category: "unsupported_claim" as const, start: 0, end: 16 }];
function document(root: string, content = text) {
  const file = join(root, "item.md");
  writeFileSync(file, content);
  return file;
}
function qualify(file: string, context?: string) {
  annotate(file, "alice", gold, context);
  annotate(file, "bob", gold, context);
  adjudicate(file, "casey", gold, "Both marks agree with the guideline.");
}
function rubricFixture(root: string) {
  const path = "ai/base/item.md";
  mkdirSync(join(root, "ai/base"), { recursive: true });
  const file = join(root, path);
  writeFileSync(file, text);
  writeNew(join(root, "ai/base/item.meta.json"), { model: "test-family", model_version: model().id, generation: "test-generation", prompt_file: ".prompts/cache.json", generated_at: new Date().toISOString() });
  writeNew(join(root, ".prompts/cache.json"), prompt);
  qualify(file, join(root, ".prompts/cache.json"));
  writeNew(join(root, "rubric.json"), { schema: "prosegate.rubric/1", items: [{ path, profile: "base", origin: "ai", prompt_file: ".prompts/cache.json" }] });
  return file;
}

describe("annotation and corpus integrity", () => {
  it("requires independent annotators and preserves immutable, hash-bound gold", () => {
    const file = document(temp());
    annotate(file, "alice", gold);
    expect(() => adjudicate(file, "casey", gold, "agreed")).toThrow(/two independent/);
    annotate(file, "bob", gold);
    expect(() => adjudicate(file, "alice", gold, "agreed")).toThrow(/third/);
    adjudicate(file, "casey", gold, "Agreed.");
    expect(qualified(file)).toBe(true);
    expect(readAnnotations(file)).toHaveLength(2);
    expect(() => annotate(file, "alice", gold)).toThrow();
    writeFileSync(file, `${text} changed`);
    expect(() => qualified(file)).toThrow(/changed/);
  });
  it("detects changed gold and forged adjudication references", () => {
    const file = document(temp());
    qualify(file);
    writeFileSync(file.replace(".md", ".gold.json"), "[]");
    expect(() => qualified(file)).toThrow(/no longer matches/);
  });
  it("rejects unsafe IDs, mismatched categories, bad spans and duplicate marks", () => {
    const file = document(temp());
    expect(() => annotate(file, "../escape", gold)).toThrow();
    expect(() => marks([{ category: "filler", start: 0, end: 1 }], "😀 text")).toThrow();
    expect(() => marks([{ category: "filler", start: 0, end: 2, rule_id: "core.hedge.001" }], "text")).toThrow();
    expect(() => marks([...gold, ...gold], text)).toThrow();
    expect(() => within(temp(), "../escape")).toThrow();
  });
  it("counts clean annotations as completed while reporting undefined kappa honestly", () => {
    const file = document(temp());
    annotate(file, "alice", []);
    annotate(file, "bob", []);
    adjudicate(file, "casey", [], "No issues.");
    expect(qualified(file)).toBe(true);
    expect(kappa({ both: 0, first_only: 0, second_only: 0, neither: 20 })).toBeNull();
    expect(kappa({ both: 4, first_only: 1, second_only: 1, neither: 4 })).toBeCloseTo(0.6);
  });
  it("computes fixed-token agreement per category including true negatives", () => {
    const a = agreement([{ text: "bad clean next", first: [{ category: "filler", start: 0, end: 3 }], second: [{ category: "filler", start: 0, end: 3 }] }]);
    expect(a.filler).toMatchObject({ both: 1, neither: 2, kappa: 1, gate_eligible: true });
    expect(a.register).toMatchObject({ kappa: null, gate_eligible: false });
  });
  it("keeps an empty corpus partial and accepts a qualified rubric without claiming readiness", () => {
    const root = temp();
    expect(corpusAudit(root).result).toBe("partial");
    const file = rubricFixture(root);
    expect(loadRubric(root)).toHaveLength(1);
    expect(corpusAudit(root)).toMatchObject({ result: "partial", rubric: { drafts: 1, adjudicated: 1 } });
    expect(existsSync(join(annotationDir(file), "adjudication.json"))).toBe(true);
  });
  it("rejects a missing saved prompt and duplicate documents", () => {
    const root = temp();
    rubricFixture(root);
    writeFileSync(join(root, ".prompts/cache.json"), JSON.stringify({ ...prompt, profile: "email" }));
    expect(() => corpusAudit(root)).toThrow(/profile differ/);
  });
  it("binds both independent annotations to unchanged request context", () => {
    const root = temp();
    const file = rubricFixture(root);
    expect(qualified(file, join(root, ".prompts/cache.json"))).toBe(true);
    writeFileSync(join(root, ".prompts/cache.json"), JSON.stringify({ ...prompt, user: "A different request." }));
    expect(() => qualified(file)).toThrow(/context has changed/);
  });
  it("imports only qualified AI data and refuses duplicates without overwriting", () => {
    const root = temp(), target = temp();
    rubricFixture(root);
    expect(importCorpus(root, target, false)).toMatchObject({ documents: 1, result: "pass" });
    expect(qualified(join(target, "ai/base/item.md"), join(target, ".prompts/cache.json"))).toBe(true);
    expect(() => importCorpus(root, target, false)).toThrow(/Duplicate/);
  });
  it("requires explicit redistribution evidence for public human imports", () => {
    const root = temp(), target = temp();
    mkdirSync(join(root, "human-control/base"), { recursive: true });
    writeFileSync(join(root, "human-control/base/item.md"), text);
    writeNew(join(root, "human-control/base/item.meta.json"), { source: "Consented private writing", licence: "Private consent", date: "2019" });
    expect(() => importCorpus(root, target, false)).toThrow(/redistribution/);
    expect(importCorpus(root, target, true).documents).toBe(1);
  });
});

describe("paid request containment", () => {
  it("reserves before calling, retains reservations, and refuses the next request over cap", async () => {
    const ledger = join(temp(), "spend.jsonl");
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => {
      expect(readFileSync(ledger, "utf8")).toContain('"event":"reserve"');
      return new Response(JSON.stringify(response("A draft.")));
    });
    const spend = new Spend(0.02, [model()], ledger, fetcher);
    expect(await complete(model(), "", [{ role: "user", content: "hi" }], spend, "dummy-key")).toBe("A draft.");
    expect(spend.reserved_usd).toBeGreaterThan(spend.measured_usd);
    await expect(complete(model(), "", [{ role: "user", content: "hi" }], spend, "dummy-key")).rejects.toThrow(/cap/);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(readFileSync(ledger, "utf8").trim().split("\n").map((l) => JSON.parse(l) as unknown)).toHaveLength(3);
  });
  it("retains a failed reservation and never logs provider errors or keys", async () => {
    const ledger = join(temp(), "spend.jsonl");
    const spend = new Spend(1, [model()], ledger, vi.fn<typeof fetch>().mockResolvedValue(new Response("dummy-key secret response", { status: 500 })));
    await expect(complete(model(), "", [{ role: "user", content: "hi" }], spend, "dummy-key")).rejects.toThrow(/discarded/);
    expect(spend.reserved_usd).toBeGreaterThan(0);
    expect(readFileSync(ledger, "utf8")).not.toContain("dummy-key");
    expect(spend.attempts[0]?.response).toBeNull();
  });
  it("fails closed on missing usage and oversized output without persisting model text", async () => {
    const spend = new Spend(1, [model()], join(temp(), "spend.jsonl"), vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ ...response("A draft"), usage: {} }))));
    await expect(complete(model(), "", [{ role: "user", content: "hi" }], spend, "dummy-key")).rejects.toThrow(/validation/);
    expect(spend.measured_usd).toBe(0);
  });
  it("stops when actual usage exceeds the reservation", async () => {
    const spend = new Spend(1, [model()], join(temp(), "spend.jsonl"), vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ ...response("A draft"), usage: { input_tokens: 999999, output_tokens: 10 } }))));
    await expect(complete(model(), "", [{ role: "user", content: "hi" }], spend, "dummy-key")).rejects.toThrow(/exceeded/);
    expect(spend.exhausted).toBe(true);
  });
  it("requires recent positive prices and exclusive new ledger paths", () => {
    const file = join(temp(), "spend.jsonl");
    expect(() => new Spend(0, [model()], file)).toThrow(/cap/);
    expect(() => new Spend(1, [model({ pricing_checked_on: "2020-01-01" })], file)).toThrow(/prices/);
    new Spend(1, [model()], file);
    expect(() => new Spend(1, [model()], file)).toThrow();
  });
  it("rejects unknown models and non-provider endpoints before transmission", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const spend = new Spend(1, [model()], join(temp(), "spend.jsonl"), fetcher);
    await expect(spend.fetch("https://example.com", { body: JSON.stringify({ model: model().id, max_output_tokens: 2048 }) })).rejects.toThrow(/priced/);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("accepts Anthropic text but rejects truncated and multi-part responses", () => {
    expect(completionText({ stop_reason: "end_turn", content: [{ type: "text", text: "draft" }] }, "anthropic")).toBe("draft");
    expect(() => completionText({ ...response("draft"), status: "incomplete" }, "openai")).toThrow();
    expect(rawFindings({ stop_reason: "tool_use", content: [{ type: "tool_use", name: "report_findings", input: { findings: [] } }] }, "anthropic")).toEqual({ findings: [] });
  });
  it("generates staging items and saved prompts without creating unannotated gold", async () => {
    const root = temp();
    const output = join(root, "staging");
    vi.stubEnv("OPENAI_API_KEY", "dummy-key");
    try {
      const plan = GenerationPlan.parse({ schema: "prosegate.generation-plan/1", models: [model()], prompts: [prompt], samples_per_prompt: 1 });
      const spend = new Spend(1, [model()], join(root, "spend.jsonl"), vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(response("Generated prose.")))));
      const result = await generate(plan, output, spend);
      expect(result).toMatchObject({ documents: 1, annotation_status: "pending" });
      const stem = `cache-${hash(model().id).slice(0, 12)}-1`;
      expect(existsSync(join(output, "ai/base", `${stem}.md`))).toBe(true);
      expect(existsSync(join(output, "ai/base", `${stem}.gold.json`))).toBe(false);
      expect(existsSync(join(output, ".prompts/cache.json"))).toBe(true);
    } finally { vi.unstubAllEnvs(); }
  });
});

describe("reviewer measurements", () => {
  it("uses one-to-one span matching and finds a maximum assignment", () => {
    const f = (start: number, end: number) => ({ category: "filler" as const, span: { start, end, text: "", segment_id: "s0" } });
    expect(matched([f(0, 4), f(0, 4)], [{ category: "filler", start: 0, end: 4 }])).toBe(1);
    expect(matched([f(0, 4), f(0, 2)], [{ category: "filler", start: 0, end: 2 }, { category: "filler", start: 2, end: 4 }])).toBe(2);
    expect(gate(null, 0.75).status).toBe("insufficient");
  });
  it("measures raw schema, unique prose occurrence and fork before enforcement", () => {
    const envelope = response(JSON.stringify({ findings: [raw()] }));
    expect(rawMetrics(envelope, "openai", text)).toMatchObject({ valid: true, found_once: 1, correct_forks: 1 });
    expect(rawMetrics(envelope, "openai", "It always works. It always works.")).toMatchObject({ found_once: 0 });
    expect(rawMetrics(envelope, "openai", "```\nIt always works.\n```")).toMatchObject({ found_once: 0 });
    expect(rawMetrics(response(JSON.stringify({ findings: [raw({ extra: "bad" })] })), "openai", text).valid).toBe(false);
  });
  it("runs the production reviewer with counted schema retries and stays partial on a tiny corpus", async () => {
    const root = temp();
    rubricFixture(root);
    vi.stubEnv("OPENAI_API_KEY", "dummy-key");
    try {
      const fetcher = vi.fn<typeof fetch>()
        .mockResolvedValueOnce(new Response(JSON.stringify(response("not JSON"))))
        .mockResolvedValueOnce(new Response(JSON.stringify(response(JSON.stringify({ findings: [raw()] })))));
      const spend = new Spend(1, [model()], join(root, "spend.jsonl"), fetcher);
      const report = await evaluateReviewer(root, model(), spend);
      expect(report).toMatchObject({ result: "partial", supported: false, gates: { schema_first_try: { value: 0 } } });
      expect(report.rows[0]?.attempts).toBe(2);
      expect(report.categories.unsupported_claim?.matched).toBe(1);
    } finally { vi.unstubAllEnvs(); }
  });
  it("never calls a provider on an empty rubric", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const spend = new Spend(1, [model()], join(temp(), "spend.jsonl"), fetcher);
    expect((await evaluateReviewer(temp(), model(), spend)).result).toBe("partial");
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe("rewrite evidence and human sample", () => {
  const evidence = (): E2eEvidence => {
    const rows = [{ id: "one", model: "test", profile: "base", original: "Original draft.", revision: "Revised draft.", context: "user context", revision_sha256: hash("Revised draft."), blocks: 1, remaining: 0, introduced: 0, length_change: 0, judge: { meaning_preserved: true, fabricated: false, explanation: "Same facts." }, fabrication_candidates: [], error: null }];
    return { model: "test", judge_model: "judge", stages: "rules", seed: "test", selected: 1, eligible_by_profile: { base: 1 }, rows, human_sample: humanSample(rows, "test") };
  };
  it("flags added numbers/citations but not ones already in context", () => {
    expect(fabricationCandidates("Takes 10 ms, https://example.com/test.", "Takes 11 ms [2].")).toEqual(["11", "[2]"]);
    expect(fabricationCandidates("Takes 10 ms.", "Takes 10 ms.")).toEqual([]);
  });
  it("requires a hash-bound 10% human sample and cannot qualify a tiny run", () => {
    const e = evidence();
    expect(scoreE2e(e)).toMatchObject({ result: "partial", human_sample_complete: false });
    const human = { schema: "prosegate.e2e-human/1", evidence_sha256: hash(JSON.stringify(e)), reviewer: "reviewer", items: [{ id: "one", revision_sha256: hash("Revised draft."), meaning_preserved: true, fabricated: false, note: "Checked all facts." }] };
    expect(scoreE2e(e, human)).toMatchObject({ result: "partial", human_sample_complete: true });
    expect(() => scoreE2e(e, { ...human, evidence_sha256: "wrong" })).toThrow(/match/);
    expect(() => scoreE2e({ ...e, human_sample: [] })).toThrow(/selection/);
  });
  it("fails any fabrication even on small samples and queues the case for the rubric", () => {
    const e = evidence();
    const row = e.rows[0];
    if (row) row.fabrication_candidates = ["42"];
    expect(scoreE2e(e)).toMatchObject({ result: "fail", rubric_candidates: ["one"] });
  });
  it("does not call providers for an empty corpus", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const spend = new Spend(1, [model()], join(temp(), "spend.jsonl"), fetcher);
    expect((await evaluateE2e(temp(), model(), model(), spend, "test")).result).toBe("partial");
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("does not count a prose-less rewrite as cleared", async () => {
    const root = temp();
    const file = rubricFixture(root);
    // E2e uses AI gold for corpus validity but no annotation qualification claims in a smoke run.
    writeFileSync(file, `Great question! ${text}`);
    writeFileSync(file.replace(".md", ".gold.json"), "[]");
    vi.stubEnv("OPENAI_API_KEY", "dummy-key");
    try {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(response("```\nA removed answer.\n```"))));
      const spend = new Spend(1, [model()], join(root, "spend.jsonl"), fetcher);
      const result = await evaluateE2e(root, [model()], model(), spend, "test");
      expect(result.evidence.model).toBe("mixed");
      expect(result.evidence.rows[0]?.model).toBe(model().id);
      expect(result.evidence.rows[0]?.error).toMatch(/no longer contains/);
      expect(result.remaining).toBe(result.blocks);
      expect(result.result).toBe("partial");
    } finally { vi.unstubAllEnvs(); }
  });
  it("refuses missing generator pricing before any mixed-model request", async () => {
    const root = temp();
    rubricFixture(root);
    const fetcher = vi.fn<typeof fetch>();
    const spend = new Spend(1, [model()], join(root, "spend.jsonl"), fetcher);
    await expect(evaluateE2e(root, [model({ id: "another-model" })], model(), spend, "test")).rejects.toThrow(/every generating model/);
    expect(fetcher).not.toHaveBeenCalled();
  });
});
