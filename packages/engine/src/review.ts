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
import { overBudget, runSearchRule, type Candidate, type RunEnv } from "./search.js";
import { makeAllowTerm } from "./text.js";

/** ADR-10 / plan 11: one review may spend this long before the engine gives up (analysis, rules and resolution). */
export const RULES_BUDGET_MS = 200;
/** ADR-24: at most this many findings per rule and per turn; further matches are counted in stats only. */
export const MAX_FINDINGS_PER_RULE = 50;
export const MAX_FINDINGS_PER_TURN = 200;

export interface ReviewRulesInput {
  request: ReviewRequest;
  resolved: ResolvedProfile;
  /**
   * Compiled packs; a pack the resolved profile does not pin is ignored, and one whose version is not
   * the pinned one is refused with a PackVersionError (ADR-24).
   */
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

/** A compiled pack's version differs from the one the resolved profile pinned. */
export class PackVersionError extends Error {
  override readonly name = "PackVersionError";
  constructor(
    readonly packId: string,
    readonly pinned: string,
    readonly given: string,
  ) {
    super(`Pack '${packId}' is pinned at ${pinned} by the resolved profile, but ${given} was supplied`);
  }
}

/** Every match of every enabled rule, before overlap resolution and before the caps (the eval harness counts false positives from these). */
export interface RuleCandidate {
  rule_id: string;
  category: Category;
  /** The effective severity under the resolved profile (not demoted for pass 2). */
  severity: Severity;
  start: number;
  end: number;
  scope: "span" | "document";
}

export interface RulesDiagnostics {
  /** True when the review budget ran out; the result holds what was found until then. The adapter maps this to an error code. */
  budget_exceeded: boolean;
  /** Rules that did not run (or did not finish) because the budget ran out. */
  rules_unfinished: string[];
  /** Wall time per rule that ran, in ms. */
  per_rule_ms: Record<string, number>;
  /** Time spent in the segmenter, outside `stats.rules_latency_ms`. */
  analyse_ms: number;
  /** `rules`, plus `reviewer` when the profile enables it and the text reaches its floor (03 "Thresholds"). */
  stages: Array<"rules" | "reviewer">;
  /** Every finding after overlap resolution and the caps, `info` ones included (they are not in `result.findings`). */
  all_findings: Finding[];
  /** Matches of every enabled rule before overlap resolution and the caps, sorted by start then rule id. */
  candidates: RuleCandidate[];
  /** Matches dropped by the caps (ADR-24): per rule (more than 50) and for the turn (more than 200 after resolution). */
  capped: { per_rule: Record<string, number>; per_turn: number };
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
  scope: "span" | "document";
}

const SEVERITY_ORDER: Record<Severity, number> = { block: 0, warn: 1, info: 2 };

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
  const reviewStart = now();

  for (const pack of packs) {
    const pin = resolved.packs.find((p) => p.id === pack.id);
    if (pin !== undefined && pin.version !== pack.version) throw new PackVersionError(pack.id, pin.version, pack.version);
  }

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
  const stats = (findings: readonly Finding[], rulesMs: number, extra: Partial<Record<Category, number>> = {}): ReviewStats => {
    const counts: Partial<Record<Category, number>> = { ...extra };
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
    candidates: [],
    capped: { per_rule: {}, per_turn: 0 },
    invalid_findings_dropped: 0,
  };
  const uniquePrior = [...new Set(request.prior_findings)];
  const skipped = (reason: SkippedReason): DetailedReview => ({
    result: {
      ...base,
      // After pass 2 (capCheck) the turn ships whatever it holds (ADR-12): pass_cap, whatever the text.
      verdict: capCheck ? "pass" : "skipped",
      skipped_reason: capCheck ? "pass_cap" : reason,
      findings: [],
      // Nothing is left of the pass-1 findings in a text with nothing to lint, so every one is cleared.
      cleared: pass === 2 ? uniquePrior : [],
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
    allowTerms: resolved.allow_terms.map((t) => makeAllowTerm(normalizeForMatching(t))),
    clock: now,
    deadline: reviewStart + budget,
    timedOut: false,
  };
  const pinned = new Set(resolved.packs.map((p) => p.id));
  const prior = new Set(pass === 2 ? request.prior_findings : []);
  const raws: Raw[] = [];
  const overflow: Partial<Record<Category, number>> = {};
  const addOverflow = (category: Category, n: number): void => {
    overflow[category] = (overflow[category] ?? 0) + n;
  };

  for (const pack of packs) {
    if (!pinned.has(pack.id)) continue;
    for (const rule of pack.rules) {
      const eff = effectiveRule(resolved, rule);
      if (!eff.enabled) continue;
      if (overBudget(env)) {
        diagnostics.rules_unfinished.push(rule.id);
        continue;
      }
      const t = now();
      let found = runRule(rule, doc, env);
      diagnostics.per_rule_ms[rule.id] = now() - t;
      if (env.timedOut) diagnostics.rules_unfinished.push(rule.id);
      for (const cand of found) {
        diagnostics.candidates.push({
          rule_id: rule.id,
          category: rule.category,
          severity: eff.severity,
          start: cand.start,
          end: cand.end,
          scope: cand.scope ?? "span",
        });
      }
      if (found.length > MAX_FINDINGS_PER_RULE) {
        found = [...found].sort((a, b) => a.start - b.start || a.end - b.end);
        const dropped = found.length - MAX_FINDINGS_PER_RULE;
        diagnostics.capped.per_rule[rule.id] = dropped;
        addOverflow(rule.category, dropped);
        found = found.slice(0, MAX_FINDINGS_PER_RULE);
      }
      for (const cand of found) {
        const scope = cand.scope ?? "span";
        let severity = eff.severity;
        let id: string | null = null;
        if (pass === 2) {
          // Pass 2 (03): only block findings already reported on pass 1 keep their severity.
          id = findingId(rule.category, rule.id, scope === "document" ? "" : request.text.slice(cand.start, cand.end));
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
          scope,
        });
      }
    }
  }
  diagnostics.budget_exceeded = env.timedOut;
  diagnostics.candidates.sort((a, b) => a.start - b.start || (a.rule_id < b.rule_id ? -1 : a.rule_id > b.rule_id ? 1 : 0));

  let kept = resolveOverlaps(raws);
  if (kept.length > MAX_FINDINGS_PER_TURN) {
    // Keep the most severe, then the earliest; the rest are counted in stats only.
    const ranked = [...kept].sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || a.span.start - b.span.start);
    const keep = new Set(ranked.slice(0, MAX_FINDINGS_PER_TURN));
    for (const r of ranked.slice(MAX_FINDINGS_PER_TURN)) addOverflow(r.category, 1);
    diagnostics.capped.per_turn = kept.length - MAX_FINDINGS_PER_TURN;
    kept = kept.filter((r) => keep.has(r));
  }
  const all: Finding[] = kept.map((r) => {
    const text = request.text.slice(r.span.start, r.span.end);
    const segmentId = r.cand.segment ?? (doc.units[r.cand.unit] as { segment_id: string }).segment_id;
    const finding: Finding = {
      id: r.id ?? findingId(r.category, r.rule_id, r.scope === "document" ? "" : text),
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
    if (r.scope === "document") finding.scope = "document";
    return finding;
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
    cleared = uniquePrior.filter((id) => !present.has(id));
  }
  const revise = !capCheck && enforce && visible.some((f) => f.severity === "block");
  const result: ReviewResult = {
    ...base,
    verdict: revise ? "revise" : "pass",
    ...(capCheck ? { skipped_reason: "pass_cap" as const } : {}),
    findings: visible,
    cleared,
    stats: stats(sound, rulesMs, overflow),
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
      return runSentenceMetric(m, doc, env);
    case "document_metric":
      return runDocumentMetric(m, doc);
  }
}
