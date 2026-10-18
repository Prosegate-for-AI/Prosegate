// The fake reviewer stage (test builds only, ADR-29). The real reviewer is Phase 4, so the fake-harness
// goldens (09 mock 2, a pass cap with two `unsupported_claim` findings) need a stand-in that returns them. It is
// reached only through withFakeReviewer, whose first line returns early unless this is a test build; the build
// constant is false in the release bundle, so the bundler drops the rest (the golden test greps the bundle).

import type { Ctx } from "./ctx.js";
import {
  FORK_TEXT,
  findingId,
  renderFeedbackText,
  type Category,
  type Finding,
  type ReviewResult,
} from "@prosegate/schema";

/** Same key as the engine's (ASCII-lowercased, whitespace collapsed), so a re-typed claim keeps its id (ADR-26). */
function spanKey(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

/** Replaced by tsup (`define`): `false` in the release bundle, so the folded test below drops the seam. See ctx.ts. */
declare const __PROSEGATE_TEST__: boolean | string | undefined;

/** The one call hooks.ts makes. In a release bundle this is `return result`: nothing of the seam survives the build. */
export function withFakeReviewer(result: ReviewResult, ctx: Ctx, input: Omit<FakeReviewInput, "spans">): ReviewResult {
  // One conditional expression, which the bundler folds to `result`; an early return would leave the dead code behind.
  return typeof __PROSEGATE_TEST__ === "string" && ctx.testHooks.fakeUnsupportedClaims !== undefined
    ? applyFakeReviewer(result, { ...input, spans: ctx.testHooks.fakeUnsupportedClaims })
    : result;
}

export interface FakeReviewInput {
  /** Spans the fake reviewer calls unsupported claims wherever they occur in the text. */
  spans: readonly string[];
  text: string;
  pass: 1 | 2;
  capCheck: boolean;
  enforce: boolean;
  priorIds: readonly string[];
  profileId: string;
}

/** Merges the fake reviewer's findings into a rules-stage result with the engine's own pass semantics (03). */
export function applyFakeReviewer(base: ReviewResult, input: FakeReviewInput): ReviewResult {
  if (base.verdict === "skipped" && !input.capCheck) return base;
  const prose = base.segments.find((s) => s.kind === "prose");
  if (prose === undefined) return base;
  const prior = new Set(input.pass === 2 ? input.priorIds : []);
  const fake: Finding[] = [];
  for (const span of input.spans) {
    const start = input.text.indexOf(span);
    if (start === -1) continue;
    const id = findingId("unsupported_claim", null, spanKey(span));
    fake.push({
      id,
      span: { segment_id: prose.id, start, end: start + span.length, text: span },
      category: "unsupported_claim",
      source: "reviewer",
      rule_id: null,
      // Pass 2 keeps `block` only for findings reported on pass 1 (03).
      severity: input.pass === 2 && !prior.has(id) ? "info" : "block",
      confidence: 0.9,
      instruction: { action: "cite_or_soften_or_remove", text: FORK_TEXT.unsupported_claim },
      evidence: "The turn gives no basis for this claim.",
      profile_origin: input.profileId,
    });
  }
  const fakeIds = new Set(fake.map((f) => f.id));
  const visible = [...base.findings, ...fake.filter((f) => f.severity !== "info")].sort((a, b) => a.span.start - b.span.start || b.span.end - a.span.end);
  const counts: Partial<Record<Category, number>> = {};
  for (const f of visible) counts[f.category] = (counts[f.category] ?? 0) + 1;
  const revise = !input.capCheck && input.enforce && visible.some((f) => f.severity === "block");
  const merged: ReviewResult = {
    ...base,
    verdict: input.capCheck ? "pass" : revise ? "revise" : "pass",
    findings: visible,
    // The engine already cleared what the rules no longer find; a fake finding still present is not cleared.
    cleared: base.cleared.filter((id) => !fakeIds.has(id)),
    stats: { ...base.stats, findings_by_category: counts },
    feedback_text: "",
  };
  merged.feedback_text = renderFeedbackText(merged);
  return merged;
}
