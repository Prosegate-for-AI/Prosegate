import { z } from "zod";
import { reviewDraft, PROMPT_VERSION, WRITING_CHECK_IDS } from "@prosegate/reviewer";
import { FORK_TEXT, REVIEWER_CATEGORIES, REVIEWER_MODEL_BY_PROVIDER, type Finding } from "@prosegate/schema";
import { analyse } from "@prosegate/segmenter";
import { HarnessError, type GoldSpan } from "../runners/rules-corpus.js";
import { percentile } from "../runners/rules-gates.js";
import { agreement, qualified, readAnnotations } from "./annotations.js";
import { hash, profile, request, within } from "./common.js";
import { loadRubric, promptFor } from "./corpus.js";
import { apiKey, rawFindings, type Model, type Spend } from "./provider.js";

const Raw = z.strictObject({ findings: z.array(z.strictObject({
  span_text: z.string().min(1).max(240), category: z.enum(REVIEWER_CATEGORIES), severity: z.enum(["block", "warn"]),
  confidence: z.number().min(0).max(1), action: z.enum(["cite_or_soften_or_remove", "specify", "shorten", "restructure", "rephrase"]),
  instruction: z.string().max(160), evidence: z.string().max(500),
  check_id: z.enum(WRITING_CHECK_IDS).nullable(),
  exception_applies: z.boolean(),
})).max(6) });
export const ratio = (n: number, d: number): number | null => d ? n / d : null;
export type Gate = { value: number | null; target: number; status: "pass" | "fail" | "insufficient" };
export function gate(value: number | null, target: number, sufficient = true, upper = false): Gate {
  return { value, target, status: value === null || !sufficient ? "insufficient" : (upper ? value <= target : value >= target) ? "pass" : "fail" };
}
/** Maximum one-to-one bipartite match; duplicates cannot inflate precision or recall. */
export function matched(findings: Array<Pick<Finding, "category" | "span">>, gold: GoldSpan[]): number {
  const assigned = new Map<number, number>();
  const visit = (i: number, seen: Set<number>): boolean => {
    const f = findings[i];
    if (!f) return false;
    for (let j = 0; j < gold.length; j++) {
      const g = gold[j];
      if (!g) continue;
      if (g.category !== f.category || Math.max(0, Math.min(f.span.end, g.end) - Math.max(f.span.start, g.start)) < (f.span.end - f.span.start) / 2 || seen.has(j)) continue;
      seen.add(j);
      const old = assigned.get(j);
      if (old === undefined || visit(old, seen)) { assigned.set(j, i); return true; }
    }
    return false;
  };
  return findings.reduce((n, _, i) => n + Number(visit(i, new Set())), 0);
}
export function rawMetrics(response: unknown, provider: Model["provider"], text: string) {
  const raw = Raw.safeParse(rawFindings(response, provider));
  if (!raw.success) return { valid: false, spans: 0, found_once: 0, forks: 0, correct_forks: 0 };
  const a = analyse(text);
  let found = 0, forks = 0, correct = 0;
  for (const f of raw.data.findings) {
    let count = 0;
    for (const s of a.segments) {
      if (s.kind !== "prose") continue;
      for (let at = text.indexOf(f.span_text, s.start); at >= 0 && at + f.span_text.length <= s.end; at = text.indexOf(f.span_text, at + 1)) {
        if (!a.masks.some((m) => at < m.end && m.start < at + f.span_text.length)) count++;
      }
    }
    if (count === 1) found++;
    if (f.category === "unsupported_claim") { forks++; if (f.instruction === FORK_TEXT.unsupported_claim && f.action === "cite_or_soften_or_remove") correct++; }
  }
  return { valid: true, spans: raw.data.findings.length, found_once: found, forks, correct_forks: correct };
}
export async function evaluateReviewer(root: string, model: Model, spend: Spend) {
  const initialCost = spend.measured_usd;
  if (REVIEWER_MODEL_BY_PROVIDER[model.provider] !== model.id) throw new HarnessError("Reviewer evaluation must use the production candidate's exact model ID.");
  const docs = loadRubric(root);
  const prompts = new Map(docs.map((d) => [d.path, promptFor(root, d)]));
  const key = docs.length ? apiKey(model) : "";
  const paired = [];
  let adjudicated = 0;
  for (const d of docs) {
    const file = within(root, d.path);
    const a = readAnnotations(file);
    if (a.length === 2 && a[0] && a[1]) paired.push({ text: d.text, first: a[0].spans, second: a[1].spans });
    if (qualified(file, within(root, d.meta.prompt_file as string))) adjudicated++;
  }
  const agreementReport = agreement(paired);
  const counts = Object.fromEntries(REVIEWER_CATEGORIES.map((c) => [c, { predictions: 0, gold: 0, matched: 0 }]));
  let valid = 0, spans = 0, found = 0, forks = 0, rawCorrect = 0, enforcedForks = 0, enforcedCorrect = 0, words = 0;
  const latencies: number[] = [];
  const rows = [];
  for (const d of docs) {
    if (spend.exhausted) break;
    const resolved = profile(d.profile);
    const prompt = prompts.get(d.path);
    if (!prompt) throw new HarnessError("Missing rubric context.");
    const req = request(d.text, d.profile, prompt);
    const firstAttempt = spend.attempts.length;
    const start = performance.now();
    const out = await reviewDraft({ request: req, resolved, provider: model.provider, key, fetch: spend.fetch });
    const ms = performance.now() - start;
    const metrics = rawMetrics(spend.attempts[firstAttempt]?.response, model.provider, d.text);
    valid += Number(metrics.valid);
    spans += metrics.spans; found += metrics.found_once; forks += metrics.forks; rawCorrect += metrics.correct_forks;
    for (const f of out.findings) if (f.category === "unsupported_claim") {
      enforcedForks++;
      if (f.instruction.text === FORK_TEXT.unsupported_claim && f.instruction.action === "cite_or_soften_or_remove") enforcedCorrect++;
    }
    for (const c of REVIEWER_CATEGORIES) {
      const predictions = out.findings.filter((f) => f.category === c);
      const gold = d.gold.filter((g) => g.category === c);
      const n = counts[c];
      if (n) { n.predictions += predictions.length; n.gold += gold.length; n.matched += matched(predictions, gold); }
    }
    const size = analyse(d.text).prose_words;
    words += size;
    if (size >= 1350 && size <= 1650) latencies.push(ms);
    rows.push({ document: hash(d.path), sha256: hash(d.text), error: out.error, skipped: out.skipped, latency_ms: ms, first_try_schema_valid: metrics.valid, attempts: spend.attempts.length - firstAttempt });
  }
  const sufficient = docs.length >= 150 && rows.length === docs.length && adjudicated === docs.length && docs.filter((d) => d.kind === "human-control").length >= 30;
  const categories = Object.fromEntries(REVIEWER_CATEGORIES.map((c) => {
    const n = counts[c] ?? { predictions: 0, gold: 0, matched: 0 };
    const eligible = sufficient && agreementReport[c]?.gate_eligible === true;
    return [c, { ...n, agreement: agreementReport[c], precision: gate(ratio(n.matched, n.predictions), 0.75, eligible), recall: gate(ratio(n.matched, n.gold), 0.5, eligible) }];
  }));
  const gates = {
    schema_first_try: gate(ratio(valid, rows.length), 0.98, sufficient),
    span_find: gate(ratio(found, spans), 0.95, sufficient),
    raw_fork: gate(ratio(rawCorrect, forks), 0.9, sufficient),
    enforced_fork: gate(ratio(enforcedCorrect, enforcedForks), 1, sufficient),
    latency_p95_ms: gate(latencies.length ? percentile(latencies, 0.95) : null, 3000, sufficient && latencies.length >= 10, true),
  };
  const all = [...Object.values(gates), ...Object.values(categories).flatMap((c) => [c.precision, c.recall])];
  const result = all.some((g) => g.status === "fail") ? "fail" : all.every((g) => g.status === "pass") ? "pass" : "partial";
  return { result, supported: result === "pass", model: model.id, prompt_version: PROMPT_VERSION, rubric: { drafts: docs.length, adjudicated, paired: paired.length }, categories, gates, rows,
    run_cost_usd: spend.measured_usd - initialCost,
    cost_per_1000_words_usd: words ? (spend.measured_usd - initialCost) * 1000 / words : null, spend: spend.summary() };
}
