// Lenient consumer parser (03 "Versioning").
//
// A consumer built against prosegate.findings/1 must keep working when a newer producer adds an
// optional field, a skipped_reason or an Action (none of which bumps the schema id). So this parser:
//   - accepts any non-empty string as skipped_reason and as instruction.action;
//   - strips unknown fields (every field a later producer may add is optional by 03's rule);
//   - rejects the whole document for a missing or mistyped required field, a wrong `schema` id, and
//     an unknown value of an enum whose growth bumps the version (Category, severity, verdict,
//     source, segment kind, pass);
//   - drops, one at a time and reporting each in `issues`, any finding that breaks a per-finding
//     invariant (03: "consumers drop mismatches"): bad span, rule_id, fork or injection limit,
//     unknown or non-prose segment, wrong order, or a forbidden intersection. The rest is kept;
//   - never returns the producer's feedback_text: it is re-rendered from the findings that survive,
//     and effective_verdict says whether a revision is still warranted.

import { z } from 'zod';
import {
  CategorySchema,
  FindingIdSchema,
  OffsetSchema,
  PackIdSchema,
  PassSchema,
  ProfileIdFormatSchema,
  ProfileIdSchema,
  SegmentIdSchema,
  SegmentKindSchema,
  SeveritySchema,
  SourceSchema,
  VerdictSchema,
  categoryCountsSchema,
  documentProblems,
  emit,
  findingProblems,
  placementProblems,
  segmentIndex,
} from './schemas.js';
import type { PlacedFinding } from './schemas.js';
import { renderFeedbackText } from './render.js';
import { ACTIONS } from './types.js';
import type { Action, Finding, ReviewResult } from './types.js';

export type KnownOrUnknownAction = Action | (string & {});

export type LenientFinding = Omit<Finding, 'instruction'> & {
  instruction: { action: KnownOrUnknownAction; text: string };
};

export type LenientReviewResult = Omit<ReviewResult, 'skipped_reason' | 'findings'> & {
  skipped_reason?: string;
  findings: LenientFinding[];
};

const LenientSegmentSchema = z
  .object({ id: SegmentIdSchema, kind: SegmentKindSchema, start: OffsetSchema, end: OffsetSchema });

// Field-level checks only. Cross-field invariants run per finding afterwards so one bad finding
// does not take the document down.
const LenientFindingSchema = z.object({
  id: FindingIdSchema,
  span: z.object({ segment_id: SegmentIdSchema, start: OffsetSchema, end: OffsetSchema, text: z.string() }),
  category: CategorySchema,
  source: SourceSchema,
  rule_id: z.string().nullable(),
  severity: SeveritySchema,
  confidence: z.number().min(0).max(1),
  instruction: z.object({ action: z.string().min(1), text: z.string() }),
  evidence: z.string().nullable(),
  profile_origin: ProfileIdFormatSchema, // the id denylist runs per finding, in findingProblems
  // optional, so an unknown value from a newer producer is tolerated; only 'document' is special (ADR-24)
  scope: z.string().exactOptional(),
});

const LenientStatsSchema = z.object({
  prose_chars: z.number().int().nonnegative(),
  sentence_count: z.number().int().nonnegative(),
  findings_by_category: categoryCountsSchema(),
  rule_packs: z.array(z.object({ id: PackIdSchema, version: z.string() })),
  reviewer: z
    .object({
      model: z.string(),
      latency_ms: z.number().nonnegative(),
      input_tokens: z.number().int().nonnegative(),
      output_tokens: z.number().int().nonnegative(),
    })
    .nullable(),
  rules_latency_ms: z.number().nonnegative(),
});

const LenientDocumentSchema = z
  .object({
    schema: z.literal('prosegate.findings/1'),
    verdict: VerdictSchema,
    skipped_reason: z.string().min(1).exactOptional(),
    profile: z.object({ id: ProfileIdSchema, version: z.string(), resolved_from: z.array(ProfileIdSchema) }),
    pass: PassSchema,
    segments: z.array(LenientSegmentSchema),
    findings: z.array(LenientFindingSchema),
    cleared: z.array(FindingIdSchema),
    stats: LenientStatsSchema,
    feedback_text: z.string(),
  })
  .superRefine((r, ctx) => {
    emit(ctx, documentProblems(r));
  });

export interface LenientIssue {
  path: string;
  message: string;
}

export type LenientParseResult =
  | { ok: true; value: LenientReviewResult; effective_verdict: LenientReviewResult['verdict']; issues: LenientIssue[] }
  | { ok: false; error: string; issues: LenientIssue[] };

/**
 * Parses a prosegate.findings/1 document the way a long-lived consumer should. `json` is either
 * the raw JSON text or an already-parsed value. On success `issues` lists each finding that was
 * dropped (path `findings.<index in the input>`).
 */
export function parseReviewResultLenient(json: unknown): LenientParseResult {
  let value: unknown = json;
  if (typeof json === 'string') {
    try {
      value = JSON.parse(json);
    } catch (e) {
      const message = e instanceof Error ? e.message : 'invalid JSON';
      return { ok: false, error: `invalid JSON: ${message}`, issues: [{ path: '', message }] };
    }
  }
  const r = LenientDocumentSchema.safeParse(value);
  if (!r.success) {
    const issues = r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
    return { ok: false, error: issues.map((i) => `${i.path || '(root)'}: ${i.message}`).join('; '), issues };
  }
  const doc = r.data;
  const segs = segmentIndex(doc.segments);
  const kept: LenientFinding[] = [];
  const issues: LenientIssue[] = [];
  doc.findings.forEach((f, i) => {
    const problems = [...findingProblems(f), ...placementProblems(kept as PlacedFinding[], f, segs)];
    const first = problems[0];
    if (first) {
      issues.push({ path: `findings.${i}`, message: `dropped: ${first.path.join('.')}: ${first.message}` });
    } else {
      kept.push(f as LenientFinding);
    }
  });
  // feedback_text is producer text that goes to the model: never trust it. Discard the incoming
  // string and render it from the findings that survived.
  const result = { ...doc, findings: kept, feedback_text: '' } as LenientReviewResult;
  result.feedback_text = renderFeedbackText(result);
  // The producer verdict is left as sent. effective_verdict is what is consistent with what is
  // rendered: 'revise' needs a surviving block finding, and a poison finding can make the parser
  // drop every real one.
  const effective_verdict = result.verdict === 'revise' && !kept.some((f) => f.severity === 'block') ? 'pass' : result.verdict;
  return { ok: true, value: result, effective_verdict, issues };
}

export function isKnownAction(action: string): action is Action {
  return (ACTIONS as readonly string[]).includes(action);
}

/**
 * 03: "render unknown actions with instruction.text alone". The feedback template renders
 * instruction.text for every action, so known and unknown actions render identically; this is the
 * single place a consumer asks, so a later producer that adds an Action can never leak the raw
 * enum value into what the model or user reads.
 */
export function renderInstructionForConsumer(instruction: { action: string; text: string }): string {
  return instruction.text;
}
