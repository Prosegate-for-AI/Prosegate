// The budgets of docs/10 "Per-rule metrics and budgets" and the arithmetic that applies them. Pure: no
// I/O, no clock, so the gates are testable with synthetic counts.
//
// Every comparison is done on integer counts (`num * 100` against `pct * den`), never on a float rate,
// so a rule exactly at its budget passes and one hit over fails, whatever the binary rounding.

export type Severity = "block" | "warn" | "info";

/** A metric with fewer items than this is reported as `insufficient` and does not gate (docs/10, brief). */
export const MIN_ITEMS = 30;

/** False-positive rate budgets, percent of human-control documents (docs/10). */
export const FP_BUDGET_PCT: Readonly<Record<Severity, number>> = { block: 1, warn: 3, info: 10 };
/** Precision floors, percent of AI-corpus hits (docs/10). */
export const PRECISION_MIN_PCT: Readonly<Record<Severity, number>> = { block: 90, warn: 80, info: 60 };
/** Recall floors per category, percent of gold spans; `info` categories have no floor (docs/10). */
export const RECALL_MIN_PCT: Readonly<Record<Severity, number | null>> = { block: 70, warn: 60, info: null };
/** Pack total `rules_latency_ms` p95 on 2,000-word documents, ms (docs/10; ADR-10). */
export const LATENCY_GATE_MS = 200;
/** ADR-10's target, reported beside the gate. */
export const LATENCY_TARGET_MS = 50;
/** Fewer than this many AI documents of >= 2,000 words and latency falls back to the perf fixture. */
export const LATENCY_MIN_DOCS = 10;
export const LATENCY_DOC_WORDS = 2000;
/** A rule may lose at most this many precision points against the baseline. */
export const BASELINE_MAX_PRECISION_LOSS_POINTS = 5;

export type MetricStatus = "pass" | "fail" | "n/a" | "insufficient" | "ungated";

export interface MetricResult {
  /** numerator / denominator as a fraction, or null when the denominator is 0. */
  value: number | null;
  num: number;
  den: number;
  /** Items that decide sufficiency: documents for FP and precision, gold spans for recall. */
  items: number;
  status: MetricStatus;
  /** The budget applied, in percent, with its direction; null when nothing gates. */
  budget: { kind: "max" | "min"; pct: number } | null;
}

const STRICTNESS: Record<Severity, number> = { block: 2, warn: 1, info: 0 };

/** The strictest severity of a list (block > warn > info). */
export function strictest(severities: readonly Severity[]): Severity {
  let best: Severity = "info";
  for (const s of severities) if (STRICTNESS[s] > STRICTNESS[best]) best = s;
  return best;
}

function result(num: number, den: number, items: number, budget: MetricResult["budget"], ok: boolean): MetricResult {
  const value = den === 0 ? null : num / den;
  let status: MetricStatus;
  if (items === 0 || den === 0) status = "n/a"; // nothing was measured
  else if (items < MIN_ITEMS) status = "insufficient"; // shown, not gated
  else if (budget === null) status = "ungated";
  else status = ok ? "pass" : "fail";
  return { value, num, den, items, status, budget };
}

/** FP rate: documents with at least one finding of the rule / documents the rule ran on. */
export function gateFalsePositive(hitDocs: number, docs: number, severity: Severity): MetricResult {
  const pct = FP_BUDGET_PCT[severity];
  return result(hitDocs, docs, docs, { kind: "max", pct }, hitDocs * 100 <= pct * docs);
}

/** Precision: confirmed hits / hits, over `docs` AI documents (the sufficiency count). */
export function gatePrecision(confirmed: number, hits: number, docs: number, severity: Severity): MetricResult {
  const pct = PRECISION_MIN_PCT[severity];
  // No documents, or documents but no hits, is n/a: nothing was measured.
  return result(confirmed, hits, docs, { kind: "min", pct }, confirmed * 100 >= pct * hits);
}

/** Category recall: caught gold spans / gold spans of the category. */
export function gateRecall(caught: number, spans: number, severity: Severity): MetricResult {
  const pct = RECALL_MIN_PCT[severity];
  return result(caught, spans, spans, pct === null ? null : { kind: "min", pct }, pct === null || caught * 100 >= pct * spans);
}

/** Nearest-rank percentile of an unsorted sample. */
export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))] as number;
}

export function median(values: readonly number[]): number {
  return percentile(values, 0.5);
}

/** Half-open span overlap with at least one shared UTF-16 unit. */
export function spansOverlap(a: { start: number; end: number }, b: { start: number; end: number }): boolean {
  return a.start < b.end && b.start < a.end;
}

export interface BaselineRule {
  precision: number | null;
  fp_rate: number | null;
}

export interface Baseline {
  schema: "prosegate.eval-baseline/1";
  rules: Record<string, BaselineRule>;
}

export type RegressionVerdict =
  | { ok: true; note?: string }
  | { ok: false; message: string };

/**
 * Precision against the baseline: fail when the rule loses more than 5 points, or when the baseline
 * held a measured precision and this run could not measure one (a shrunk or deleted corpus must not
 * turn a regression check into a pass). A rule with no baseline entry, or a null one, is not compared.
 */
export function compareToBaseline(ruleId: string, base: BaselineRule | undefined, precision: MetricResult): RegressionVerdict {
  if (base === undefined) return { ok: true, note: `${ruleId}: not in the baseline (new rule)` };
  if (base.precision === null) return { ok: true };
  const measured = precision.status === "pass" || precision.status === "fail";
  if (!measured || precision.value === null) {
    return { ok: false, message: `${ruleId}: baseline precision ${(base.precision * 100).toFixed(1)}% was measured, this run has none (${precision.status}, ${precision.den} hits over ${precision.items} documents)` };
  }
  const lossPoints = (base.precision - precision.value) * 100;
  if (lossPoints > BASELINE_MAX_PRECISION_LOSS_POINTS + 1e-9) {
    return {
      ok: false,
      message: `${ruleId}: precision fell ${lossPoints.toFixed(1)} points against the baseline (${(base.precision * 100).toFixed(1)}% -> ${(precision.value * 100).toFixed(1)}%; limit ${BASELINE_MAX_PRECISION_LOSS_POINTS})`,
    };
  }
  return { ok: true };
}

export function fmtPct(value: number | null, digits = 1): string {
  return value === null ? "n/a" : `${(value * 100).toFixed(digits)}%`;
}
