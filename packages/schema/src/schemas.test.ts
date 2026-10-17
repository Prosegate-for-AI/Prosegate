import { describe, expect, expectTypeOf, it } from 'vitest';
import type { z } from 'zod';
import {
  ActionSchema,
  CategorySchema,
  FindingSchema,
  ReviewRequestSchema,
  ReviewResultSchema,
  ReviewStatsSchema,
  SegmentSchema,
  SeveritySchema,
  SkippedReasonSchema,
} from './schemas.js';
import { findingId } from './finding-id.js';
import { makeResult } from './fixtures.js';
import type {
  Action,
  Category,
  Finding,
  ReviewRequest,
  ReviewResult,
  ReviewStats,
  Segment,
  Severity,
  SkippedReason,
} from './types.js';

// ---- compile-time: z.infer<> equals the normative type, in both directions -----------------
// These are checked by `tsc -p tsconfig.test.json` (pnpm typecheck); vitest alone does not
// evaluate them, so a drift fails typecheck, not the runtime test run.

describe('schema types equal types.ts', () => {
  it('ReviewRequest', () => {
    expectTypeOf<z.infer<typeof ReviewRequestSchema>>().toEqualTypeOf<ReviewRequest>();
    expectTypeOf<z.infer<typeof ReviewRequestSchema>>().toExtend<ReviewRequest>();
    expectTypeOf<ReviewRequest>().toExtend<z.infer<typeof ReviewRequestSchema>>();
  });
  it('ReviewResult', () => {
    expectTypeOf<z.infer<typeof ReviewResultSchema>>().toEqualTypeOf<ReviewResult>();
    expectTypeOf<z.infer<typeof ReviewResultSchema>>().toExtend<ReviewResult>();
    expectTypeOf<ReviewResult>().toExtend<z.infer<typeof ReviewResultSchema>>();
  });
  it('Segment', () => {
    expectTypeOf<z.infer<typeof SegmentSchema>>().toEqualTypeOf<Segment>();
    expectTypeOf<z.infer<typeof SegmentSchema>>().toExtend<Segment>();
    expectTypeOf<Segment>().toExtend<z.infer<typeof SegmentSchema>>();
  });
  it('Finding', () => {
    expectTypeOf<z.infer<typeof FindingSchema>>().toEqualTypeOf<Finding>();
    expectTypeOf<z.infer<typeof FindingSchema>>().toExtend<Finding>();
    expectTypeOf<Finding>().toExtend<z.infer<typeof FindingSchema>>();
  });
  it('ReviewStats', () => {
    expectTypeOf<z.infer<typeof ReviewStatsSchema>>().toEqualTypeOf<ReviewStats>();
    expectTypeOf<z.infer<typeof ReviewStatsSchema>>().toExtend<ReviewStats>();
    expectTypeOf<ReviewStats>().toExtend<z.infer<typeof ReviewStatsSchema>>();
  });
  it('enums', () => {
    expectTypeOf<z.infer<typeof CategorySchema>>().toEqualTypeOf<Category>();
    expectTypeOf<z.infer<typeof ActionSchema>>().toEqualTypeOf<Action>();
    expectTypeOf<z.infer<typeof SkippedReasonSchema>>().toEqualTypeOf<SkippedReason>();
    expectTypeOf<z.infer<typeof SeveritySchema>>().toEqualTypeOf<Severity>();
  });
});

// ---- runtime ----------------------------------------------------------------------------

const TEXT = "This is robust. It's worth noting that it works.";

function validResult(): ReviewResult {
  return makeResult({
    text: TEXT,
    profileId: 'local/pr-description',
    findings: [
      {
        span: 'robust',
        category: 'vocab',
        ruleId: 'core.vocab.003',
        severity: 'warn',
        action: 'specify',
        instruction: 'Replace with the property that makes it so, or remove.',
      },
      {
        span: "It's worth noting that",
        category: 'hedge',
        ruleId: 'core.hedge.001',
        severity: 'block',
        action: 'remove',
        instruction: 'Remove the preamble; keep the clause after it.',
      },
    ],
  });
}

function validReviewerFinding(): Finding {
  const span = 'works';
  const start = TEXT.indexOf(span);
  return {
    id: findingId('unsupported_claim', null, span, 's1'),
    span: { segment_id: 's1', start, end: start + span.length, text: span },
    category: 'unsupported_claim',
    source: 'reviewer',
    rule_id: null,
    severity: 'block',
    confidence: 0.7,
    instruction: { action: 'cite_or_soften_or_remove', text: 'x' },
    evidence: 'No basis in the turn.',
    profile_origin: 'local/pr-description',
  };
}

function validRequest(): ReviewRequest {
  return {
    schema: 'prosegate.review/1',
    text: TEXT,
    context: { user_message: 'write the PR description', style_constraints: '', mode: 'interactive' },
    profile_id: 'local/pr-description',
    pass: 1,
    stages: ['rules'],
    session_id: 'sess-1',
    turn_id: 'turn-1',
    prior_findings: [],
  };
}

function clone<T>(v: T): T {
  return structuredClone(v);
}

describe('strict ReviewResult validation', () => {
  it('accepts the fixture results', () => {
    expect(ReviewResultSchema.safeParse(validResult()).success).toBe(true);
  });

  it('accepts an absent skipped_reason and every known one', () => {
    const r = validResult();
    expect(ReviewResultSchema.safeParse(r).success).toBe(true);
    for (const reason of SkippedReasonSchema.options) {
      expect(ReviewResultSchema.safeParse({ ...r, skipped_reason: reason }).success).toBe(true);
    }
  });

  it('rejects an unknown top-level field', () => {
    expect(ReviewResultSchema.safeParse({ ...validResult(), extra: 1 }).success).toBe(false);
  });

  it.each([
    ['finding', (r: ReviewResult) => Object.assign(r.findings[0] as object, { extra: 1 })],
    ['span', (r: ReviewResult) => Object.assign(r.findings[0]?.span as object, { extra: 1 })],
    ['instruction', (r: ReviewResult) => Object.assign(r.findings[0]?.instruction as object, { extra: 1 })],
    ['segment', (r: ReviewResult) => Object.assign(r.segments[0] as object, { extra: 1 })],
    ['stats', (r: ReviewResult) => Object.assign(r.stats as object, { extra: 1 })],
    ['profile', (r: ReviewResult) => Object.assign(r.profile as object, { extra: 1 })],
  ])('rejects an unknown field on %s', (_name, mutate) => {
    const r = clone(validResult());
    mutate(r);
    expect(ReviewResultSchema.safeParse(r).success).toBe(false);
  });

  it('rejects unknown enum values (producer side is strict)', () => {
    const r = clone(validResult()) as unknown as Record<string, unknown>;
    expect(ReviewResultSchema.safeParse({ ...r, skipped_reason: 'rate_limited' }).success).toBe(false);
    const f = clone(validResult());
    (f.findings[0] as { instruction: { action: string } }).instruction.action = 'delete_everything';
    expect(ReviewResultSchema.safeParse(f).success).toBe(false);
    const c = clone(validResult());
    (c.findings[0] as { category: string }).category = 'tone';
    expect(ReviewResultSchema.safeParse(c).success).toBe(false);
    const s = clone(validResult());
    (s.findings[0] as { severity: string }).severity = 'fatal';
    expect(ReviewResultSchema.safeParse(s).success).toBe(false);
  });

  it('rejects a wrong schema id and unknown findings_by_category keys', () => {
    expect(ReviewResultSchema.safeParse({ ...validResult(), schema: 'prosegate.findings/2' }).success).toBe(false);
    const r = clone(validResult());
    (r.stats.findings_by_category as Record<string, number>)['tone'] = 1;
    expect(ReviewResultSchema.safeParse(r).success).toBe(false);
  });

  it('rejects pass values other than 1 and 2', () => {
    expect(ReviewResultSchema.safeParse({ ...validResult(), pass: 3 }).success).toBe(false);
    expect(ReviewResultSchema.safeParse({ ...validResult(), pass: 0 }).success).toBe(false);
  });
});

describe('strict Finding invariants (03)', () => {
  const rule = () => clone(validResult().findings[0] as Finding);

  it('accepts a rule finding and a reviewer finding', () => {
    expect(FindingSchema.safeParse(rule()).success).toBe(true);
    expect(FindingSchema.safeParse(validReviewerFinding()).success).toBe(true);
  });

  it.each([-0.01, 1.01, Number.NaN, Number.POSITIVE_INFINITY])('rejects confidence %s', (c) => {
    expect(FindingSchema.safeParse({ ...validReviewerFinding(), confidence: c }).success).toBe(false);
  });

  it('accepts reviewer confidence at the bounds 0 and 1', () => {
    expect(FindingSchema.safeParse({ ...validReviewerFinding(), confidence: 0 }).success).toBe(true);
    expect(FindingSchema.safeParse({ ...validReviewerFinding(), confidence: 1 }).success).toBe(true);
  });

  it("requires confidence exactly 1 for source 'rule'", () => {
    expect(FindingSchema.safeParse({ ...rule(), confidence: 0.99 }).success).toBe(false);
    expect(FindingSchema.safeParse({ ...rule(), confidence: 0 }).success).toBe(false);
  });

  it('requires rule_id null iff source is reviewer', () => {
    expect(FindingSchema.safeParse({ ...rule(), rule_id: null }).success).toBe(false);
    expect(FindingSchema.safeParse({ ...validReviewerFinding(), rule_id: 'core.vocab.003' }).success).toBe(false);
  });

  it.each([
    'robust',
    'core.vocab',
    'core.vocab.03',
    'core.vocab.0003',
    'Core.vocab.003',
    'core.tone.003',
    'core.vague_claim.003',
    'core_pack.vocab.003',
    '.vocab.003',
    'core.vocab.003\n',
    'core.hedge.003', // valid shape but the category segment disagrees with category 'vocab'
  ])('rejects rule_id %j on a vocab rule finding', (id) => {
    expect(FindingSchema.safeParse({ ...rule(), rule_id: id }).success).toBe(false);
  });

  it('accepts hyphenated and digit pack ids', () => {
    expect(FindingSchema.safeParse({ ...rule(), rule_id: 'org-default2.vocab.012' }).success).toBe(true);
  });

  it("requires evidence null for source 'rule'", () => {
    expect(FindingSchema.safeParse({ ...rule(), evidence: 'because' }).success).toBe(false);
  });

  it('requires a deterministic category for rules and a reviewer category for reviewers', () => {
    expect(FindingSchema.safeParse({ ...validReviewerFinding(), category: 'hedge' }).success).toBe(false);
    expect(
      FindingSchema.safeParse({ ...rule(), category: 'register', rule_id: 'core.register.001' }).success,
    ).toBe(false);
  });

  it.each(['', 'ABCDEF0123', 'abcdef012', 'abcdef01234', 'abcdefghij', 'abcdef012g'])('rejects finding id %j', (id) => {
    expect(FindingSchema.safeParse({ ...rule(), id }).success).toBe(false);
  });

  it.each(['1', 's', 'S1', 's1a', 's-1', 'seg1', ''])('rejects segment id %j', (segment_id) => {
    const f = rule();
    expect(FindingSchema.safeParse({ ...f, span: { ...f.span, segment_id } }).success).toBe(false);
    expect(SegmentSchema.safeParse({ id: segment_id, kind: 'prose', start: 0, end: 1 }).success).toBe(false);
  });

  it('requires span.start <= span.end (and nonnegative integers)', () => {
    const f = rule();
    expect(FindingSchema.safeParse({ ...f, span: { ...f.span, start: 10, end: 9 } }).success).toBe(false);
    expect(FindingSchema.safeParse({ ...f, span: { ...f.span, start: -1 } }).success).toBe(false);
    expect(FindingSchema.safeParse({ ...f, span: { ...f.span, start: 1.5 } }).success).toBe(false);
    expect(SegmentSchema.safeParse({ id: 's1', kind: 'prose', start: 5, end: 4 }).success).toBe(false);
    expect(SegmentSchema.safeParse({ id: 's1', kind: 'prose', start: 4, end: 4 }).success).toBe(true);
  });

  it('requires span.text length to agree with the offsets', () => {
    const f = rule();
    expect(FindingSchema.safeParse({ ...f, span: { ...f.span, text: f.span.text + 'x' } }).success).toBe(false);
  });

  it('does not crash on a structurally broken finding', () => {
    const r = FindingSchema.safeParse({ ...rule(), span: null, confidence: 'high' });
    expect(r.success).toBe(false);
  });
});

describe('strict ReviewResult cross-checks', () => {
  it('rejects a finding that points at an unknown or non-prose segment', () => {
    const a = clone(validResult());
    (a.findings[0] as Finding).span.segment_id = 's9';
    expect(ReviewResultSchema.safeParse(a).success).toBe(false);
    const b = clone(validResult());
    (b.segments[0] as Segment).kind = 'code';
    expect(ReviewResultSchema.safeParse(b).success).toBe(false);
  });

  it('rejects unsorted, overlapping and duplicate findings', () => {
    const unsorted = clone(validResult());
    unsorted.findings.reverse();
    expect(ReviewResultSchema.safeParse(unsorted).success).toBe(false);
    const dup = clone(validResult());
    dup.findings.push(clone(dup.findings[1] as Finding));
    expect(ReviewResultSchema.safeParse(dup).success).toBe(false);
  });

  it('rejects a non-empty cleared list on pass 1', () => {
    const r = clone(validResult());
    r.cleared = ['0123456789'];
    expect(ReviewResultSchema.safeParse(r).success).toBe(false);
    expect(ReviewResultSchema.safeParse({ ...r, pass: 2 }).success).toBe(true);
  });
});

describe('strict ReviewRequest validation', () => {
  it('accepts a valid request', () => {
    expect(ReviewRequestSchema.safeParse(validRequest()).success).toBe(true);
  });
  it('rejects unknown fields, bad schema id, bad modes and stages', () => {
    expect(ReviewRequestSchema.safeParse({ ...validRequest(), extra: 1 }).success).toBe(false);
    expect(ReviewRequestSchema.safeParse({ ...validRequest(), schema: 'prosegate.review/2' }).success).toBe(false);
    const r = validRequest();
    expect(ReviewRequestSchema.safeParse({ ...r, context: { ...r.context, mode: 'batch' } }).success).toBe(false);
    expect(ReviewRequestSchema.safeParse({ ...r, context: { ...r.context, extra: 1 } }).success).toBe(false);
    expect(ReviewRequestSchema.safeParse({ ...r, stages: ['rules', 'oracle'] }).success).toBe(false);
  });
  it('enforces the 2,000 and 1,500 char context limits', () => {
    const r = validRequest();
    expect(ReviewRequestSchema.safeParse({ ...r, context: { ...r.context, user_message: 'x'.repeat(2000) } }).success).toBe(true);
    expect(ReviewRequestSchema.safeParse({ ...r, context: { ...r.context, user_message: 'x'.repeat(2001) } }).success).toBe(false);
    expect(ReviewRequestSchema.safeParse({ ...r, context: { ...r.context, style_constraints: 'x'.repeat(1501) } }).success).toBe(false);
  });
  it('requires empty prior_findings on pass 1 and well-formed ids on pass 2', () => {
    const r = validRequest();
    expect(ReviewRequestSchema.safeParse({ ...r, prior_findings: ['0123456789'] }).success).toBe(false);
    expect(ReviewRequestSchema.safeParse({ ...r, pass: 2, prior_findings: ['0123456789'] }).success).toBe(true);
    expect(ReviewRequestSchema.safeParse({ ...r, pass: 2, prior_findings: ['nope'] }).success).toBe(false);
  });
});
