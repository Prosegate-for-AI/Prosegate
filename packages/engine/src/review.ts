import { effectiveRule, type ResolvedProfile } from "@prosegate/profiles";
import {
  findingId,
  renderFeedbackText,
  spanMatches,
  type Category,
  type Finding,
  type ReviewRequest,
  type ReviewResult,
  type ReviewStats,
  type Severity,
  type SkippedReason,
} from "@prosegate/schema";
import { analyse, normalizeForMatching } from "@prosegate/segmenter";
import type { CompiledPack, CompiledRule } from "./compile.js";
import { DocContext } from "./context.js";
import { runDocumentMetric, runSentenceMetric } from "./metrics.js";
import { resolveOverlaps } from "./overlap.js";
import { runSearchRule, type Candidate, type RunEnv } from "./search.js";
import { squashSpace } from "./text.js";

/** ADR-10 / plan 11: one review may spend this long executing rules before the engine gives up. */
export const RULES_BUDGET_MS = 200;

export interface ReviewRulesInput {
  request: ReviewRequest;
  resolved: ResolvedProfile;
  /** Compiled packs; a pack the resolved profile does not pin is ignored. */
  packs: readonly CompiledPack[];
  /** Enforcement mode: false reports findings but never returns verdict `revise`. */
  enforce: boolean;
  /**
   * The `turn-end` call after pass 2 (ADR-12): pass-2 filtering on the final text, verdict `pass`
   * with `skipped_reason: 'pass_cap'`, surviving findings kept so a "shipped as is" notice can list them.
   */
  capCheck?: boolean | undefined;
  /** A millisecond clock (default performance.now); tests inject one. */
  now?: (() => number) | undefined;
  /** Override of RULES_BUDGET_MS (tests). */
  budgetMs?: number | undefined;
}

export interface RulesDiagnostics {
  /** True when the rules budget ran out; the result holds what was found until then. The adapter maps this to an error code. */
  budget_exceeded: boolean;
  /** Rules that did not run (or did not finish) because the budget ran out. */
  rules_unfinished: string[];
  /** Wall time per rule that ran, in ms. */
  per_rule_ms: Record<string, number>;
  /** Time spent in the segmenter, outside `stats.rules_latency_ms`. */
  analyse_ms: number;
  /** `rules`, plus `reviewer` when the profile enables it and the text reaches its floor (03 "Thresholds"). */
  stages: Array<"rules" | "reviewer">;
  /** Every finding after overlap resolution, `info` ones included (they are not in `result.findings`). */
  all_findings: Finding[];
  /** Findings dropped by the output self-check (a span that does not equal its slice); expected 0. */
  invalid_findings_dropped: number;
}

export interface DetailedReview {
  result: ReviewResult;
  diagnostics: RulesDiagnostics;
}

/** The stages a review of a text with this many prose words runs (03 "Thresholds"). */
export function stagesFor(proseWords: number, resolved: ResolvedProfile): Array<"rules" | "reviewer"> {
  const stages: Array<"rules" | "reviewer"> = ["rules"];
  if (resolved.reviewer.enabled && resolved.reviewer.categories.length > 0 && proseWords >= resolved.thresholds.reviewer_floor_words) {
    stages.push("reviewer");
  }
  return stages;
}

interface Raw {
  rule: CompiledRule;
  severity: Severity;
  origin: string;
  cand: Candidate;
  id: string | null;
  // Resolvable
  source: "rule";
  category: Category;
  rule_id: string;
  span: { start: number; end: number };
}

function defaultNow(): number {
  return performance.now();
}

/** Runs the deterministic rule pack(s) over `request.text` and returns the ReviewResult (03). */
export function reviewRules(input: ReviewRulesInput): ReviewResult {
  return reviewRulesDetailed(input).result;
}

/** reviewRules plus what the adapter and the eval harness need besides the result. */
export function reviewRulesDetailed(input: ReviewRulesInput): DetailedReview {
  const { request, resolved, packs, enforce } = input;
  const capCheck = input.capCheck === true;
  const now = input.now ?? defaultNow;
  const budget = input.budgetMs ?? RULES_BUDGET_MS;
  const pass: 1 | 2 = capCheck ? 2 : request.pass;

  const analyseStart = now();
  const analysis = analyse(request.text);
  const analyseMs = now() - analyseStart;
  const doc = new DocContext(analysis);

  const base = {
    schema: "prosegate.findings/1" as const,
    profile: { id: resolved.id, version: resolved.version, resolved_from: [...resolved.resolved_from] },
    pass,
    segments: analysis.segments,
  };
  const stats = (findings: readonly Finding[], rulesMs: number): ReviewStats => {
    const counts: Partial<Record<Category, number>> = {};
    for (const f of findings) counts[f.category] = (counts[f.category] ?? 0) + 1;
    let proseChars = 0;
    for (const u of analysis.units) proseChars += u.end - u.start;
    return {
      prose_chars: proseChars,
      sentence_count: doc.sentences.length,
      findings_by_category: counts,
      rule_packs: resolved.packs.map((p) => ({ id: p.id, version: p.version })),
      reviewer: null,
      rules_latency_ms: rulesMs,
    };
  };
  const diagnostics: RulesDiagnostics = {
    budget_exceeded: false,
    rules_unfinished: [],
    per_rule_ms: {},
    analyse_ms: analyseMs,
    stages: stagesFor(analysis.prose_words, resolved),
    all_findings: [],
    invalid_findings_dropped: 0,
  };
  const skipped = (reason: SkippedReason): DetailedReview => ({
    result: {
      ...base,
      verdict: "skipped",
      skipped_reason: reason,
      findings: [],
      cleared: [],
      stats: stats([], 0),
      feedback_text: "",
    },
    diagnostics: { ...diagnostics, stages: [] },
  });

  // Stage order (brief): non-English or nothing to lint -> no_prose; below the floor -> below_floor; else run.
  if (analysis.language === "non_en" || analysis.units.length === 0) return skipped("no_prose");
  if (analysis.prose_words < resolved.thresholds.token_floor_words) return skipped("below_floor");

  // ---- run the rules ---------------------------------------------------------------------------------
  const started = now();
  const env: RunEnv = {
    doc,
    allowTerms: new Set(resolved.allow_terms.map((t) => squashSpace(normalizeForMatching(t).toLowerCase()))),
    clock: now,
    deadline: started + budget,
    timedOut: false,
  };
  const pinned = new Set(resolved.packs.map((p) => p.id));
  const prior = new Set(pass === 2 ? request.prior_findings : []);
  const raws: Raw[] = [];

  for (const pack of packs) {
    if (!pinned.has(pack.id)) continue;
    for (const rule of pack.rules) {
      const eff = effectiveRule(resolved, rule);
      if (!eff.enabled) continue;
      if (env.timedOut || now() > env.deadline) {
        env.timedOut = true;
        diagnostics.rules_unfinished.push(rule.id);
        continue;
      }
      const t = now();
      const found = runRule(rule, doc, env);
      diagnostics.per_rule_ms[rule.id] = now() - t;
      if (env.timedOut) diagnostics.rules_unfinished.push(rule.id);
      for (const cand of found) {
        const segmentId = (doc.units[cand.unit] as { segment_id: string }).segment_id;
        let severity = eff.severity;
        let id: string | null = null;
        if (pass === 2) {
          // Pass 2 (03): only block findings already reported on pass 1 keep their severity.
          id = findingId(rule.category, rule.id, request.text.slice(cand.start, cand.end), segmentId);
          severity = severity === "block" && prior.has(id) ? "block" : "info";
        }
        raws.push({
          rule,
          severity,
          origin: eff.origin,
          cand,
          id,
          source: "rule",
          category: rule.category,
          rule_id: rule.id,
          span: { start: cand.start, end: cand.end },
        });
      }
    }
  }
  diagnostics.budget_exceeded = env.timedOut;

  const kept = resolveOverlaps(raws);
  const all: Finding[] = kept.map((r) => {
    const text = request.text.slice(r.span.start, r.span.end);
    const segmentId = (doc.units[r.cand.unit] as { segment_id: string }).segment_id;
    return {
      id: r.id ?? findingId(r.category, r.rule_id, text, segmentId),
      span: { segment_id: segmentId, start: r.span.start, end: r.span.end, text },
      category: r.category,
      source: "rule",
      rule_id: r.rule_id,
      severity: r.severity,
      confidence: 1,
      instruction: { action: r.rule.instruction.action, text: r.rule.instruction.text },
      evidence: null,
      profile_origin: r.origin,
    };
  });
  const rulesMs = now() - started;

  // Cheap output self-check (03: a span's text must equal its slice).
  const sound = all.filter((f) => spanMatches(request.text, f));
  diagnostics.invalid_findings_dropped = all.length - sound.length;
  diagnostics.all_findings = sound;

  const visible = sound.filter((f) => f.severity !== "info");
  let cleared: string[] = [];
  if (pass === 2) {
    const present = new Set(sound.map((f) => f.id));
    cleared = [...new Set(request.prior_findings)].filter((id) => !present.has(id));
  }
  const revise = !capCheck && enforce && visible.some((f) => f.severity === "block");
  const result: ReviewResult = {
    ...base,
    verdict: revise ? "revise" : "pass",
    ...(capCheck ? { skipped_reason: "pass_cap" as const } : {}),
    findings: visible,
    cleared,
    stats: stats(sound, rulesMs),
    feedback_text: "",
  };
  result.feedback_text = renderFeedbackText(result);
  return { result, diagnostics };
}

function runRule(rule: CompiledRule, doc: DocContext, env: RunEnv): Candidate[] {
  const m = rule.match;
  switch (m.kind) {
    case "search":
      return runSearchRule(m, rule.category === "vocab", env);
    case "sentence_metric":
      return runSentenceMetric(m, doc);
    case "document_metric":
      return runDocumentMetric(m, doc);
  }
}
