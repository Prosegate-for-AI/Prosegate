import { describe, expect, it } from "vitest";
import { bundledPackSources, bundledProfileSources, resolveProfile, BUNDLED_PACK_YAML, parseRulePackYaml } from "@prosegate/profiles";
import { compilePack, reviewRulesDetailed } from "@prosegate/engine";
import { WRITING_CHECK_IDS, type ReviewerOutcome } from "@prosegate/reviewer";
import { ReviewRequestSchema, type Finding } from "@prosegate/schema";
import { writingCases, writingRequest, writingSummary, type WritingRow } from "./writing-eval.js";

const outcome = (extra: Partial<ReviewerOutcome> = {}): ReviewerOutcome => ({ findings: [], stats: null, span_misses: 0, error: null, skipped: null, ...extra });
const base = writingCases()[0];
if (!base) throw new Error("Missing writing fixtures");
const row = (extra: Partial<WritingRow> = {}): WritingRow => ({ ...base, local: [], raw: [], outcome: outcome(), ...extra });
const resolved = resolveProfile("local/writing-review", { profiles: bundledProfileSources(), packs: bundledPackSources() });
const packs = resolved.packs.map((pin) => {
  const yaml = BUNDLED_PACK_YAML[`${pin.id}@${pin.version}`];
  if (!yaml) throw new Error("Missing pack");
  const parsed = parseRulePackYaml(yaml); if (!parsed.ok) throw new Error("Invalid pack");
  return compilePack(parsed.value);
});
// A valid local finding provides an actual span/category for scoring tests.
const positive = writingCases().find((c) => c.id === "verbal-padding/positive");
if (!positive) throw new Error("Missing positive fixture");
const local = reviewRulesDetailed({ request: writingRequest(positive), resolved, packs, enforce: false }).result.findings[0];
if (!local) throw new Error("Missing expected local finding");
const retained: Finding = { ...local, source: "reviewer", rule_id: null, category: "register", instruction: { action: "rephrase", text: "Remove the unnecessary padding." } };

describe("writing evaluation fixtures and metrics (offline)", () => {
  it("covers every catalog check with valid requests and keeps fresh probes selectable", () => {
    expect(new Set(writingCases().map((c) => c.check))).toEqual(new Set(WRITING_CHECK_IDS));
    for (const c of writingCases()) expect(ReviewRequestSchema.safeParse(writingRequest(c)).success).toBe(true);
    expect(writingCases("holdout").every((c) => c.id.startsWith("holdout/"))).toBe(true);
  });
  it.each(writingCases("exceptions"))("local rules preserve $id", (c) => {
    const result = reviewRulesDetailed({ request: writingRequest(c), resolved, packs, enforce: false, budgetMs: 2000 });
    expect(result.diagnostics.budget_exceeded).toBe(false);
    expect(result.result.findings).toEqual([]);
  });
  it("does not turn errors or skipped reviews into clean exceptions", () => {
    const summary = writingSummary([row(), row({ outcome: outcome({ error: "reviewer_timeout" }) }), row({ outcome: outcome({ skipped: "disabled" }) })]);
    expect(summary.completed).toBe(1);
    expect(summary.exceptions).toEqual({ completed: 1, accepted: 1, flagged: [] });
    expect(summary.errors).toHaveLength(1);
    expect(summary.skipped).toHaveLength(1);
  });
  it("counts local warnings on exception cases as false positives", () => {
    expect(writingSummary([row({ local: [local] })]).exceptions).toMatchObject({ accepted: 0, flagged: [base.id] });
  });
  it("does not count discarded raw findings or an unrelated retained check as target detection", () => {
    const raw = [{ findings: [{ span_text: retained.span.text, category: "register", check_id: "verbal-padding" }] }];
    const rows = [row({ expected: "flag", check: "verbal-padding", raw }), row({ expected: "flag", check: "missing-actor", raw, outcome: outcome({ findings: [retained] }) })];
    expect(writingSummary(rows).positives).toMatchObject({ completed: 2, with_any_finding: 1, with_target_check: 0 });
    expect(writingSummary([row({ expected: "flag", check: "verbal-padding", raw, outcome: outcome({ findings: [retained] }) })]).positives.with_target_check).toBe(1);
  });
  it("counts matching local rules even when the reviewer suppresses duplicates", () => {
    expect(writingSummary([row({ expected: "flag", check: "verbal-padding", local: [local] })]).positives.with_target_check).toBe(1);
    expect(writingSummary([]).exceptions).toEqual({ completed: 0, accepted: 0, flagged: [] });
  });
  it("distinguishes a genuinely empty response from an exception accepted only after filtering", () => {
    const raw = [{ findings: [{ span_text: retained.span.text, category: "register", check_id: "verbal-padding" }] }];
    const summary = writingSummary([
      row({ id: "clean", raw: [{ findings: [] }] }),
      row({ id: "filtered", raw }),
      row({ id: "unavailable", raw: [null] }),
      row({ id: "timeout", raw, outcome: outcome({ error: "reviewer_timeout" }) }),
    ]);
    expect(summary.raw_exceptions).toEqual({ empty: 1, nonempty: ["filtered"], unavailable: ["unavailable"], accepted_after_filtering: ["filtered"] });
    expect(summary.exceptions.accepted).toBe(3);
    expect(summary.errors).toHaveLength(1);
  });
  it("keeps both original failures and their opposite-context controls in the focused set", () => {
    const cases = writingCases("support-actors");
    expect(cases.map((c) => c.id)).toEqual(expect.arrayContaining(["grounded-significance/exception", "missing-actor/positive", "support/scope-expanded", "actors/external-antecedent"]));
    expect(cases.filter((c) => c.expected === "accept")).toHaveLength(8);
    expect(cases.filter((c) => c.expected === "flag")).toHaveLength(6);
  });
});
