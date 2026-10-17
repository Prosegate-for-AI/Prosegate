// Strict (producer-side) zod validators for prosegate.review/1 and prosegate.findings/1.
// The normative types live in ./types.ts; schemas.test.ts proves each z.infer<> equals the
// corresponding type exactly. Unknown fields and unknown enum values are rejected here.
// Consumers that must survive newer producers use ./lenient.ts instead.

import { z } from 'zod';
import { ACTIONS, CATEGORIES, REVIEWER_CATEGORIES, RULE_CATEGORIES, SKIPPED_REASONS } from './types.js';
import type { Category } from './types.js';

// ---- shared leaf schemas ------------------------------------------------------------------

export const CategorySchema = z.enum(CATEGORIES);
export const ActionSchema = z.enum(ACTIONS);
export const SkippedReasonSchema = z.enum(SKIPPED_REASONS);
export const SegmentKindSchema = z.enum(['prose', 'code', 'table', 'tool_output', 'quote']);
export const SeveritySchema = z.enum(['block', 'warn', 'info']);
export const SourceSchema = z.enum(['rule', 'reviewer']);
export const PassSchema = z.union([z.literal(1), z.literal(2)]);
export const VerdictSchema = z.enum(['pass', 'revise', 'skipped']);

/** '<pack>.<category>.<nnn>' (03). Only deterministic categories appear in a rule id. */
export const RULE_ID_RE = new RegExp(`^[a-z0-9-]+\\.(${RULE_CATEGORIES.join('|')})\\.\\d{3}$`);
export const FINDING_ID_RE = /^[0-9a-f]{10}$/;
export const SEGMENT_ID_RE = /^s[0-9]+$/;

export const FindingIdSchema = z.string().regex(FINDING_ID_RE, 'finding id must be 10 lowercase hex characters');
export const SegmentIdSchema = z.string().regex(SEGMENT_ID_RE, "segment id must look like 's1', 's2', …");
export const OffsetSchema = z.number().int().nonnegative();

// ---- cross-field checks, shared with the lenient parser -----------------------------------

type CheckCtx = z.core.$RefinementCtx;

export interface FindingShape {
  category: Category;
  source: 'rule' | 'reviewer';
  rule_id: string | null;
  confidence: number;
  evidence: string | null;
  span: { start: number; end: number; text: string };
}

/** What 03 states about a single finding that a field-level schema cannot express. */
export function checkFinding(f: FindingShape, ctx: CheckCtx): void {
  const add = (path: (string | number)[], message: string): void => {
    ctx.addIssue({ code: 'custom', path, message });
  };
  if (f.span.start > f.span.end) add(['span', 'end'], 'span.start must be <= span.end');
  // Offsets are UTF-16 code units, so a faithful slice has length end - start.
  if (f.span.text.length !== f.span.end - f.span.start) {
    add(['span', 'text'], 'span.text length (UTF-16 code units) must equal span.end - span.start');
  }
  if (f.source === 'rule') {
    if (f.confidence !== 1) add(['confidence'], "confidence must be exactly 1 when source is 'rule'");
    if (f.evidence !== null) add(['evidence'], "evidence must be null when source is 'rule'");
    if (f.rule_id === null) {
      add(['rule_id'], "rule_id is required when source is 'rule'");
    } else if (!RULE_ID_RE.test(f.rule_id)) {
      add(['rule_id'], 'rule_id must match <pack>.<category>.<nnn>');
    } else if (f.rule_id.split('.')[1] !== f.category) {
      add(['rule_id'], 'the category segment of rule_id must equal the finding category');
    }
    if (!(RULE_CATEGORIES as readonly string[]).includes(f.category)) {
      add(['category'], "source 'rule' requires a deterministic category");
    }
  } else {
    if (f.rule_id !== null) add(['rule_id'], "rule_id must be null when source is 'reviewer'");
    if (!(REVIEWER_CATEGORIES as readonly string[]).includes(f.category)) {
      add(['category'], "source 'reviewer' requires a reviewer category");
    }
  }
}

export interface ResultShape {
  pass: 1 | 2;
  cleared: string[];
  segments: { id: string; kind: string; start: number; end: number }[];
  findings: { id: string; span: { segment_id: string; start: number; end: number } }[];
}

/** Result-level invariants from 03: segment references, ordering, non-overlap, pass-2-only fields. */
export function checkResult(r: ResultShape, ctx: CheckCtx): void {
  const add = (path: (string | number)[], message: string): void => {
    ctx.addIssue({ code: 'custom', path, message });
  };
  if (r.pass === 1 && r.cleared.length > 0) add(['cleared'], 'cleared is pass 2 only');
  const segById = new Map<string, ResultShape['segments'][number]>();
  r.segments.forEach((s, i) => {
    if (s.start > s.end) add(['segments', i, 'end'], 'segment start must be <= end');
    if (segById.has(s.id)) add(['segments', i, 'id'], `duplicate segment id ${s.id}`);
    segById.set(s.id, s);
  });
  const seen = new Set<string>();
  let prevEnd = -1;
  let prevStart = -1;
  r.findings.forEach((f, i) => {
    if (seen.has(f.id)) add(['findings', i, 'id'], `duplicate finding id ${f.id}`);
    seen.add(f.id);
    const seg = segById.get(f.span.segment_id);
    if (!seg) {
      add(['findings', i, 'span', 'segment_id'], `unknown segment ${f.span.segment_id}`);
    } else {
      if (seg.kind !== 'prose') add(['findings', i, 'span', 'segment_id'], 'only prose segments are linted');
      if (f.span.start < seg.start || f.span.end > seg.end) {
        add(['findings', i, 'span'], 'span must lie inside its segment');
      }
    }
    if (f.span.start < prevStart) add(['findings', i, 'span', 'start'], 'findings must be sorted by span.start');
    else if (f.span.start < prevEnd) add(['findings', i, 'span', 'start'], 'findings must not overlap');
    prevStart = f.span.start;
    prevEnd = Math.max(prevEnd, f.span.end);
  });
}

// ---- strict schemas -----------------------------------------------------------------------

export const SegmentSchema = z
  .strictObject({
    id: SegmentIdSchema,
    kind: SegmentKindSchema,
    start: OffsetSchema,
    end: OffsetSchema,
  })
  .superRefine((s, ctx) => {
    if (s.start > s.end) ctx.addIssue({ code: 'custom', path: ['end'], message: 'start must be <= end' });
  });

export const FindingSchema = z
  .strictObject({
    id: FindingIdSchema,
    span: z.strictObject({
      segment_id: SegmentIdSchema,
      start: OffsetSchema,
      end: OffsetSchema,
      text: z.string(),
    }),
    category: CategorySchema,
    source: SourceSchema,
    rule_id: z.string().nullable(),
    severity: SeveritySchema,
    confidence: z.number().min(0).max(1),
    instruction: z.strictObject({ action: ActionSchema, text: z.string() }),
    evidence: z.string().nullable(),
    profile_origin: z.string(),
  })
  .superRefine(checkFinding);

export const ReviewStatsSchema = z.strictObject({
  prose_chars: z.number().int().nonnegative(),
  sentence_count: z.number().int().nonnegative(),
  findings_by_category: z.partialRecord(CategorySchema, z.number().int().nonnegative()),
  rule_packs: z.array(z.strictObject({ id: z.string(), version: z.string() })),
  reviewer: z
    .strictObject({
      model: z.string(),
      latency_ms: z.number().nonnegative(),
      input_tokens: z.number().int().nonnegative(),
      output_tokens: z.number().int().nonnegative(),
    })
    .nullable(),
  rules_latency_ms: z.number().nonnegative(),
});

export const ReviewResultSchema = z
  .strictObject({
    schema: z.literal('prosegate.findings/1'),
    verdict: VerdictSchema,
    skipped_reason: SkippedReasonSchema.exactOptional(),
    profile: z.strictObject({ id: z.string(), version: z.string(), resolved_from: z.array(z.string()) }),
    pass: PassSchema,
    segments: z.array(SegmentSchema),
    findings: z.array(FindingSchema),
    cleared: z.array(FindingIdSchema),
    stats: ReviewStatsSchema,
    feedback_text: z.string(),
  })
  .superRefine(checkResult);

export const ReviewRequestSchema = z
  .strictObject({
    schema: z.literal('prosegate.review/1'),
    text: z.string(),
    context: z.strictObject({
      user_message: z.string().max(2000),
      style_constraints: z.string().max(1500),
      mode: z.enum(['interactive', 'headless']),
    }),
    profile_id: z.string(),
    pass: PassSchema,
    stages: z.array(z.enum(['rules', 'reviewer'])),
    session_id: z.string(),
    turn_id: z.string(),
    prior_findings: z.array(FindingIdSchema),
  })
  .superRefine((r, ctx) => {
    if (r.pass === 1 && r.prior_findings.length > 0) {
      ctx.addIssue({ code: 'custom', path: ['prior_findings'], message: 'prior_findings must be empty on pass 1' });
    }
  });
