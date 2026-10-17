// Lenient consumer parser (03 "Versioning").
//
// A consumer built against prosegate.findings/1 must keep working when a newer producer adds an
// optional field, a skipped_reason or an Action (none of which bumps the schema id). So this parser:
//   - accepts any non-empty string as skipped_reason and as instruction.action;
//   - strips unknown fields (every field a later producer may add is optional by 03's rule);
//   - still rejects a missing required field, a wrong `schema` id, and unknown values of the enums
//     whose growth DOES bump the version (Category, severity, verdict, segment kind, source).
// It applies the same per-finding and per-result invariants as the strict validator.

import { z } from 'zod';
import {
  CategorySchema,
  FindingIdSchema,
  OffsetSchema,
  PassSchema,
  SegmentIdSchema,
  SegmentKindSchema,
  SeveritySchema,
  SourceSchema,
  VerdictSchema,
  checkFinding,
  checkResult,
} from './schemas.js';
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
  .object({ id: SegmentIdSchema, kind: SegmentKindSchema, start: OffsetSchema, end: OffsetSchema })
  .superRefine((s, ctx) => {
    if (s.start > s.end) ctx.addIssue({ code: 'custom', path: ['end'], message: 'start must be <= end' });
  });

const LenientFindingSchema = z
  .object({
    id: FindingIdSchema,
    span: z.object({ segment_id: SegmentIdSchema, start: OffsetSchema, end: OffsetSchema, text: z.string() }),
    category: CategorySchema,
    source: SourceSchema,
    rule_id: z.string().nullable(),
    severity: SeveritySchema,
    confidence: z.number().min(0).max(1),
    instruction: z.object({ action: z.string().min(1), text: z.string() }),
    evidence: z.string().nullable(),
    profile_origin: z.string(),
  })
  .superRefine(checkFinding);

const LenientStatsSchema = z.object({
  prose_chars: z.number().int().nonnegative(),
  sentence_count: z.number().int().nonnegative(),
  findings_by_category: z.partialRecord(CategorySchema, z.number().int().nonnegative()),
  rule_packs: z.array(z.object({ id: z.string(), version: z.string() })),
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

const LenientReviewResultSchema = z
  .object({
    schema: z.literal('prosegate.findings/1'),
    verdict: VerdictSchema,
    skipped_reason: z.string().min(1).exactOptional(),
    profile: z.object({ id: z.string(), version: z.string(), resolved_from: z.array(z.string()) }),
    pass: PassSchema,
    segments: z.array(LenientSegmentSchema),
    findings: z.array(LenientFindingSchema),
    cleared: z.array(FindingIdSchema),
    stats: LenientStatsSchema,
    feedback_text: z.string(),
  })
  .superRefine(checkResult);

export type LenientParseResult =
  | { ok: true; value: LenientReviewResult }
  | { ok: false; error: string; issues: Array<{ path: string; message: string }> };

/**
 * Parses a prosegate.findings/1 document the way a long-lived consumer should. `json` is either
 * the raw JSON text or an already-parsed value.
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
  const r = LenientReviewResultSchema.safeParse(value);
  if (r.success) return { ok: true, value: r.data as LenientReviewResult };
  const issues = r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
  return { ok: false, error: issues.map((i) => `${i.path || '(root)'}: ${i.message}`).join('; '), issues };
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
