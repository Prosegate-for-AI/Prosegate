import { effectiveReviewer, type ResolvedProfile } from "@prosegate/profiles";
import { FindingSchema, FORK_TEXT, REVIEWER_MODEL_BY_PROVIDER, findingId, findKeyShapedStrings, injectedTextViolation, type Finding, type ReviewRequest, type ReviewStats, type ReviewerProvider } from "@prosegate/schema";
import { analyse, countWords, normalizeForMatching, type Analysis } from "@prosegate/segmenter";
import { buildPrompt } from "./prompt.js";
import { callProvider, object, ReviewerError, type ReviewerFailure } from "./provider.js";

export interface ReviewerOutcome {
  findings: Finding[];
  stats: ReviewStats["reviewer"];
  span_misses: number;
  error: ReviewerFailure | null;
  skipped: "disabled" | "below_floor" | "no_prose" | "provider_not_allowed" | "too_long" | null;
}
export interface ReviewDraftInput {
  request: ReviewRequest;
  resolved: ResolvedProfile;
  provider: ReviewerProvider;
  key: string | null;
  /** BYOK and vended credentials share the exact request path; policy can disallow vending. */
  keySource?: "byok" | "vended";
  timeoutMs?: number;
  fetch?: typeof fetch;
}
const empty = (): ReviewerOutcome => ({ findings: [], stats: null, span_misses: 0, error: null, skipped: null });

export function reviewerEligibility(request: ReviewRequest, resolved: ResolvedProfile, provider: ReviewerProvider, keySource: "byok" | "vended" = "byok"): ReviewerOutcome["skipped"] {
  if (!request.stages.includes("reviewer") || !resolved.reviewer.enabled || resolved.reviewer.categories.length === 0) return "disabled";
  if ((resolved.policy?.allowed_providers && !resolved.policy.allowed_providers.includes(provider)) || (resolved.policy?.byok_required && keySource !== "byok")) return "provider_not_allowed";
  if (request.text.length > 100 * 1024) return "too_long";
  const a = analyse(request.text);
  if (a.prose_words === 0 || a.language === "non_en") return "no_prose";
  if (request.pass === 1 && a.prose_words < Math.max(resolved.thresholds.token_floor_words, resolved.thresholds.reviewer_floor_words)) return "below_floor";
  return null;
}

function refind(text: string, span: string, a: Analysis): Finding["span"] | null {
  // First eligible prose occurrence, never code/quotes/tables or a span crossing an inline mask.
  for (const s of a.segments) {
    if (s.kind !== "prose") continue;
    let start = text.indexOf(span, s.start);
    while (start !== -1 && start + span.length <= s.end) {
      const end = start + span.length;
      if (!a.masks.some((m) => start < m.end && m.start < end)) return { segment_id: s.id, start, end, text: span };
      start = text.indexOf(span, start + 1);
    }
  }
  return null;
}

function enforce(raw: unknown, input: ReviewDraftInput, a: Analysis): { findings: Finding[]; misses: number } {
  const envelope = object(raw);
  if (!envelope || Object.keys(envelope).some((k) => k !== "findings") || !Array.isArray(envelope["findings"]) || envelope["findings"].length > 64) throw new ReviewerError("reviewer_schema_invalid", true);
  const findings: Finding[] = [];
  let misses = 0;
  const prior = new Set(input.request.prior_findings);
  const effective = effectiveReviewer(input.resolved);
  for (const item of envelope["findings"] as unknown[]) {
    const r = object(item);
    if (!r) throw new ReviewerError("reviewer_schema_invalid", true);
    if (typeof r["span_text"] !== "string" || typeof r["category"] !== "string" || typeof r["confidence"] !== "number" || typeof r["instruction"] !== "string" || typeof r["evidence"] !== "string" || typeof r["action"] !== "string") throw new ReviewerError("reviewer_schema_invalid", true);
    const { span_text: spanText, category, confidence, instruction, evidence } = r;
    if (category !== "unsupported_claim" && category !== "vague_claim" && category !== "register") continue;
    if (!effective.categories.includes(category) || confidence < 0.6 || confidence > 1 || !Number.isFinite(confidence)) continue;
    if (!spanText || [...spanText].length > 240 || (r["severity"] !== "block" && r["severity"] !== "warn")) continue;
    if (findKeyShapedStrings(item).length || (input.key && JSON.stringify(item).includes(input.key))) continue;
    if (countWords(evidence) > 25 || evidence.length > 500 || /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(evidence)) continue;
    const span = refind(input.request.text, spanText, a);
    if (!span) { misses++; continue; }
    const id = findingId(category, null, normalizeForMatching(spanText).replace(/\s+/g, " ").trim());
    const override = input.resolved.categories[category];
    let severity = override?.severity ?? r["severity"];
    if (category === "register" && severity === "block") severity = "warn";
    if (input.request.pass === 2 && !(severity === "block" && prior.has(id))) severity = "info";
    const action = category === "unsupported_claim" ? "cite_or_soften_or_remove" : category === "vague_claim" ? "specify" : r["action"];
    if (category === "register" && !["shorten", "restructure", "rephrase"].includes(action)) continue;
    const text = category === "unsupported_claim" ? FORK_TEXT.unsupported_claim : instruction;
    if ([...text].length > 160 || injectedTextViolation(text, 160) !== null) continue;
    const parsed = FindingSchema.safeParse({ id, span, category, source: "reviewer", rule_id: null, severity, confidence, instruction: { action, text }, evidence, profile_origin: override?.origin ?? effective.origin.categories });
    if (parsed.success && !findings.some((f) => f.id === id && f.span.start === span.start)) findings.push(parsed.data);
    if (findings.length === 6) break;
  }
  return { findings, misses };
}

/** One shared deadline across transport, response body and one retry. No provider exception escapes. */
export async function reviewDraft(input: ReviewDraftInput): Promise<ReviewerOutcome> {
  const outcome = empty();
  outcome.skipped = reviewerEligibility(input.request, input.resolved, input.provider, input.keySource);
  if (outcome.skipped) return outcome;
  if (!input.key || input.key.length > 1000 || !/^[\x21-\x7e]+$/.test(input.key)) return { ...outcome, error: "reviewer_key_missing" };
  const budget = Math.min(4000, Math.max(0, input.timeoutMs ?? 4000));
  if (!Number.isFinite(budget) || budget <= 0) return { ...outcome, error: "reviewer_timeout" };
  const start = performance.now();
  const analysis = analyse(input.request.text);
  const prompt = buildPrompt(input.request, input.resolved, analysis);
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new ReviewerError("reviewer_timeout")); }, Math.max(0, budget - (performance.now() - start))); });
  const execute = async (): Promise<ReviewerOutcome> => {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        if (controller.signal.aborted || performance.now() - start >= budget) throw new ReviewerError("reviewer_timeout");
        const answer = await callProvider(input.provider, input.key as string, prompt, controller.signal, input.fetch ?? fetch, attempt > 0);
        const filtered = enforce(answer.raw, input, analysis);
        if (performance.now() - start >= budget) throw new ReviewerError("reviewer_timeout");
        return { ...outcome, findings: filtered.findings, span_misses: filtered.misses, stats: { model: REVIEWER_MODEL_BY_PROVIDER[input.provider], latency_ms: performance.now() - start, input_tokens: answer.input_tokens, output_tokens: answer.output_tokens } };
      } catch (e) {
        if (!(e instanceof ReviewerError) || !e.retryable || attempt > 0 || controller.signal.aborted) throw e;
      }
    }
    throw new ReviewerError("reviewer_schema_invalid");
  };
  try { return await Promise.race([execute(), deadline]); }
  catch (e) { return { ...outcome, error: controller.signal.aborted ? "reviewer_timeout" : e instanceof ReviewerError ? e.code : "reviewer_schema_invalid" }; }
  finally { clearTimeout(timer); controller.abort(); }
}
