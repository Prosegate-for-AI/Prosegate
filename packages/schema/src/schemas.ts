// Strict (producer-side) zod validators for prosegate.review/1 and prosegate.findings/1.
// The normative types live in ./types.ts; schemas.test.ts proves each z.infer<> equals the
// corresponding type exactly. Unknown fields and unknown enum values are rejected here.
// Consumers that must survive newer producers use ./lenient.ts instead.
//
// The invariant checks (findingProblems, placementProblems, documentProblems) return plain lists
// so the strict schema (reject the result) and the lenient parser (drop the finding) share them.

import { z } from 'zod';
import { ACTIONS, CATEGORIES, FORK_TEXT, REVIEWER_CATEGORIES, RULE_CATEGORIES, SKIPPED_REASONS } from './types.js';
import type { Category, Severity } from './types.js';

// ---- shared leaf schemas ------------------------------------------------------------------

export const CategorySchema = z.enum(CATEGORIES);
export const ActionSchema = z.enum(ACTIONS);
export const SkippedReasonSchema = z.enum(SKIPPED_REASONS);
export const SegmentKindSchema = z.enum(['prose', 'code', 'table', 'tool_output', 'quote']);
export const SeveritySchema = z.enum(['block', 'warn', 'info']);
export const SourceSchema = z.enum(['rule', 'reviewer']);
export const PassSchema = z.union([z.literal(1), z.literal(2)]);
export const VerdictSchema = z.enum(['pass', 'revise', 'skipped']);

/** ADR-17: pack ids and each half of a profile id are `[a-z0-9-]{1,31}`. */
export const PACK_ID_RE = /^[a-z0-9-]{1,31}$/;
export const PROFILE_ID_RE = /^[a-z0-9-]{1,31}\/[a-z0-9-]{1,31}$/;
/** '<pack>.<category>.<nnn>' (03). Only deterministic categories appear in a rule id. */
export const RULE_ID_RE = new RegExp(`^[a-z0-9-]{1,31}\\.(${RULE_CATEGORIES.join('|')})\\.\\d{3}$`);
export const FINDING_ID_RE = /^[0-9a-f]{10}$/;
export const SEGMENT_ID_RE = /^s[0-9]+$/;

export const ProfileIdSchema = z.string().regex(PROFILE_ID_RE, 'profile id must be <namespace>/<slug>, each [a-z0-9-]{1,31}');
export const PackIdSchema = z.string().regex(PACK_ID_RE, 'pack id must be [a-z0-9-]{1,31}');
export const FindingIdSchema = z.string().regex(FINDING_ID_RE, 'finding id must be 10 lowercase hex characters');
export const SegmentIdSchema = z.string().regex(SEGMENT_ID_RE, "segment id must look like 's1', 's2', \u2026");
export const OffsetSchema = z.number().int().nonnegative();

/**
 * A strict object with one optional non-negative integer per Category. Used instead of
 * z.partialRecord, which silently skips an own "__proto__" key (JSON.parse creates one); a strict
 * object reports it as an unrecognised key.
 */
export function categoryCountsSchema(max = Number.MAX_SAFE_INTEGER) {
  const count = z.number().int().nonnegative().max(max);
  return z.strictObject({
    filler: count.exactOptional(),
    hedge: count.exactOptional(),
    vocab: count.exactOptional(),
    triad: count.exactOptional(),
    structure: count.exactOptional(),
    repetition: count.exactOptional(),
    vague_claim: count.exactOptional(),
    unsupported_claim: count.exactOptional(),
    register: count.exactOptional(),
  });
}

// ---- invariants ---------------------------------------------------------------------------

export interface Problem {
  path: (string | number)[];
  message: string;
}

/** 07 threat 3/4: instruction text is bounded; register (free reviewer text) is bounded harder. */
export const MAX_INSTRUCTION_CODEPOINTS = 200;
export const MAX_REGISTER_INSTRUCTION_CODEPOINTS = 160;

const codePointLength = (s: string): number => Array.from(s).length;

// vague_claim fork: fixed prefix and suffix, the parenthetical is filled per 08.
const VAGUE_OPEN = FORK_TEXT.vague_claim.indexOf('(') + 1;
const VAGUE_CLOSE = FORK_TEXT.vague_claim.lastIndexOf(')');
export const VAGUE_CLAIM_PREFIX = FORK_TEXT.vague_claim.slice(0, VAGUE_OPEN);
export const VAGUE_CLAIM_SUFFIX = FORK_TEXT.vague_claim.slice(VAGUE_CLOSE);

export interface FindingShape {
  category: Category;
  source: 'rule' | 'reviewer';
  rule_id: string | null;
  severity: Severity;
  confidence: number;
  evidence: string | null;
  span: { start: number; end: number; text: string };
  instruction: { action: string; text: string };
}

/** What 03 and 07 state about a single finding that a field-level schema cannot express. */
export function findingProblems(f: FindingShape): Problem[] {
  const out: Problem[] = [];
  const add = (path: (string | number)[], message: string): void => {
    out.push({ path, message });
  };
  if (f.span.start > f.span.end) add(['span', 'end'], 'span.start must be <= span.end');
  else if (f.span.start === f.span.end) add(['span'], 'span must not be empty');
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

  // Injection limits on text that reaches the model (07 threat 3 and 4) and the 03 forks.
  const { action, text } = f.instruction;
  if (codePointLength(text) > MAX_INSTRUCTION_CODEPOINTS) {
    add(['instruction', 'text'], `instruction text must be at most ${MAX_INSTRUCTION_CODEPOINTS} code points`);
  }
  if (f.category === 'unsupported_claim') {
    if (action !== 'cite_or_soften_or_remove') add(['instruction', 'action'], 'unsupported_claim requires action cite_or_soften_or_remove');
    if (text !== FORK_TEXT.unsupported_claim) add(['instruction', 'text'], 'unsupported_claim requires the fixed fork text');
  } else if (f.category === 'vague_claim') {
    if (action !== 'specify') add(['instruction', 'action'], 'vague_claim requires action specify');
    const middle = text.slice(VAGUE_CLAIM_PREFIX.length, text.length - VAGUE_CLAIM_SUFFIX.length);
    const shaped =
      text.startsWith(VAGUE_CLAIM_PREFIX) &&
      text.endsWith(VAGUE_CLAIM_SUFFIX) &&
      text.length > VAGUE_CLAIM_PREFIX.length + VAGUE_CLAIM_SUFFIX.length &&
      !/[()\r\n]/.test(middle);
    if (!shaped) add(['instruction', 'text'], 'vague_claim requires the fork template with the parenthetical filled in');
  } else if (f.category === 'register') {
    if (f.severity === 'block') add(['severity'], 'register findings are capped at warn');
    if (codePointLength(text) > MAX_REGISTER_INSTRUCTION_CODEPOINTS) {
      add(['instruction', 'text'], `register instruction text must be at most ${MAX_REGISTER_INSTRUCTION_CODEPOINTS} code points`);
    }
  }
  return out;
}

export interface PlacedSegment {
  id: string;
  kind: string;
  start: number;
  end: number;
}

export interface PlacedFinding {
  category: Category;
  source: 'rule' | 'reviewer';
  span: { segment_id: string; start: number; end: number };
}

/**
 * Where a finding sits relative to its segment and to the findings listed before it (03, ADR-17):
 * inside a prose segment; ordered by start ascending then end descending; and the only allowed
 * intersection is a reviewer finding that fully contains a rule finding of a different category.
 * Every earlier finding is compared, not only the previous one.
 */
export function placementProblems(
  earlier: readonly PlacedFinding[],
  f: PlacedFinding,
  segments: ReadonlyMap<string, PlacedSegment>,
): Problem[] {
  const out: Problem[] = [];
  const seg = segments.get(f.span.segment_id);
  if (!seg) {
    out.push({ path: ['span', 'segment_id'], message: `unknown segment ${f.span.segment_id}` });
  } else {
    if (seg.kind !== 'prose') out.push({ path: ['span', 'segment_id'], message: 'only prose segments are linted' });
    if (f.span.start < seg.start || f.span.end > seg.end) out.push({ path: ['span'], message: 'span must lie inside its segment' });
  }
  const prev = earlier[earlier.length - 1];
  if (prev && (f.span.start < prev.span.start || (f.span.start === prev.span.start && f.span.end > prev.span.end))) {
    out.push({ path: ['span', 'start'], message: 'findings must be sorted by span.start, then span.end descending' });
  }
  for (const e of earlier) {
    const intersects = f.span.start < e.span.end && e.span.start < f.span.end;
    if (!intersects) continue;
    const nested =
      e.source === 'reviewer' &&
      f.source === 'rule' &&
      e.category !== f.category &&
      e.span.start <= f.span.start &&
      f.span.end <= e.span.end;
    if (!nested) {
      out.push({ path: ['span'], message: 'spans intersect; only a reviewer finding containing a rule finding of another category may' });
      break;
    }
  }
  return out;
}

export interface DocumentShape {
  pass: 1 | 2;
  cleared: readonly string[];
  segments: readonly PlacedSegment[];
}

/** Result-level invariants that do not depend on any one finding. */
export function documentProblems(r: DocumentShape): Problem[] {
  const out: Problem[] = [];
  if (r.pass === 1 && r.cleared.length > 0) out.push({ path: ['cleared'], message: 'cleared is pass 2 only' });
  const seen = new Set<string>();
  r.segments.forEach((s, i) => {
    if (s.start > s.end) out.push({ path: ['segments', i, 'end'], message: 'segment start must be <= end' });
    if (seen.has(s.id)) out.push({ path: ['segments', i, 'id'], message: `duplicate segment id ${s.id}` });
    seen.add(s.id);
  });
  return out;
}

export function segmentIndex(segments: readonly PlacedSegment[]): Map<string, PlacedSegment> {
  const m = new Map<string, PlacedSegment>();
  for (const s of segments) if (!m.has(s.id)) m.set(s.id, s);
  return m;
}

type RefinementCtx = z.core.$RefinementCtx;

export function emit(ctx: RefinementCtx, problems: readonly Problem[], prefix: (string | number)[] = []): void {
  for (const p of problems) ctx.addIssue({ code: 'custom', path: [...prefix, ...p.path], message: p.message });
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
    profile_origin: ProfileIdSchema,
  })
  .superRefine((f, ctx) => {
    emit(ctx, findingProblems(f));
  });

export const ReviewStatsSchema = z.strictObject({
  prose_chars: z.number().int().nonnegative(),
  sentence_count: z.number().int().nonnegative(),
  findings_by_category: categoryCountsSchema(),
  rule_packs: z.array(z.strictObject({ id: PackIdSchema, version: z.string() })),
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
    profile: z.strictObject({ id: ProfileIdSchema, version: z.string(), resolved_from: z.array(ProfileIdSchema) }),
    pass: PassSchema,
    segments: z.array(SegmentSchema),
    findings: z.array(FindingSchema),
    cleared: z.array(FindingIdSchema),
    stats: ReviewStatsSchema,
    feedback_text: z.string(),
  })
  .superRefine((r, ctx) => {
    emit(ctx, documentProblems(r));
    const segs = segmentIndex(r.segments);
    r.findings.forEach((f, i) => {
      emit(ctx, placementProblems(r.findings.slice(0, i), f, segs), ['findings', i]);
    });
  });

export const ReviewRequestSchema = z
  .strictObject({
    schema: z.literal('prosegate.review/1'),
    text: z.string(),
    context: z.strictObject({
      user_message: z.string().max(2000),
      style_constraints: z.string().max(1500),
      mode: z.enum(['interactive', 'headless']),
    }),
    profile_id: ProfileIdSchema,
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
