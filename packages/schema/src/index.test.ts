import { describe, expect, it } from 'vitest';
import * as api from './index.js';
import {
  ACTIONS,
  ActionSchema,
  CATEGORIES,
  CategorySchema,
  DEFAULT_SEVERITY,
  DEFAULT_THRESHOLDS,
  ERROR_CODES,
  FINDINGS_SCHEMA_VERSION,
  FORK_TEXT,
  FindingSchema,
  HARNESSES,
  KEY_PREFIXES,
  PRODUCER_SCHEMA_COMMENT,
  REVIEWER_CATEGORIES,
  RULE_CATEGORIES,
  RULE_ID_RE,
  ReviewRequestSchema,
  ReviewResultSchema,
  SKIPPED_REASONS,
  SegmentSchema,
  ServerStoredEventSchema,
  WireBatchSchema,
  WireEventSchema,
  dropMismatchedSpans,
  encodeTelemetryBatch,
  findKeyShapedStrings,
  findingId,
  generateJsonSchemas,
  isKnownAction,
  isTimestampWithinBounds,
  parseReviewResultLenient,
  renderFeedbackText,
  renderInstructionForConsumer,
  renderNotice,
  safeInline,
  schemaPlaceholder,
  spanMatches,
  trimSpan,
  truncateToMinute,
} from './index.js';

describe('@prosegate/schema entry point', () => {
  it('exports its placeholder (other packages import it) and wires its workspace deps', () => {
    expect(schemaPlaceholder.id).toBe('prosegate:schema:placeholder');
    expect(schemaPlaceholder.uses).toEqual([]);
  });

  it('every documented export is present and of the right kind', () => {
    const fns = [
      dropMismatchedSpans, encodeTelemetryBatch, findKeyShapedStrings, findingId, generateJsonSchemas, isKnownAction,
      isTimestampWithinBounds, parseReviewResultLenient, renderFeedbackText, renderInstructionForConsumer, renderNotice,
      safeInline, spanMatches, trimSpan, truncateToMinute,
    ];
    for (const f of fns) expect(typeof f).toBe('function');
    const schemas = [
      ActionSchema, CategorySchema, FindingSchema, ReviewRequestSchema, ReviewResultSchema, SegmentSchema, ServerStoredEventSchema,
      WireBatchSchema, WireEventSchema,
    ];
    for (const s of schemas) expect(typeof s.safeParse).toBe('function');
    for (const c of [ACTIONS, CATEGORIES, ERROR_CODES, HARNESSES, KEY_PREFIXES, REVIEWER_CATEGORIES, RULE_CATEGORIES, SKIPPED_REASONS]) {
      expect(Array.isArray(c)).toBe(true);
    }
    expect(FINDINGS_SCHEMA_VERSION).toBe(1);
    expect(typeof FORK_TEXT.unsupported_claim).toBe('string');
    expect(typeof DEFAULT_SEVERITY.hedge).toBe('string');
    expect(DEFAULT_THRESHOLDS.token_floor_words).toBe(60);
    expect(RULE_ID_RE.test('core.hedge.001')).toBe(true);
    expect(typeof PRODUCER_SCHEMA_COMMENT).toBe('string');
  });

  it('does not export the raw per-kind telemetry schemas or the old stored-event name', () => {
    expect(Object.keys(api)).not.toContain('TELEMETRY_KINDS');
    expect(Object.keys(api)).not.toContain('StoredEventSchema');
  });

  it('exports nothing that is not on the public list (a removed or renamed export fails here)', () => {
    expect(Object.keys(api).sort()).toEqual(EXPECTED_EXPORTS);
  });
});

/** The complete runtime export list, sorted. Update it deliberately when the public surface changes. */
const EXPECTED_EXPORTS = [
  'ACTIONS',
  'ActionSchema',
  'CATEGORIES',
  'CategorySchema',
  'DEFAULT_SEVERITY',
  'DEFAULT_THRESHOLDS',
  'ERROR_CODES',
  'FEEDBACK_TRIM',
  'FINDINGS_SCHEMA_VERSION',
  'FINDING_ID_RE',
  'FORK_TEXT',
  'FindingIdSchema',
  'FindingSchema',
  'HARNESSES',
  'INSTRUCTION_CAP',
  'KEY_PREFIXES',
  'KEY_TAIL_MIN',
  'LATENCY_BUCKETS_MS',
  'MAX_INSTRUCTION_CODEPOINTS',
  'MAX_REGISTER_INSTRUCTION_CODEPOINTS',
  'MAX_VAGUE_PARENTHETICAL_CODEPOINTS',
  'NOTICE_SLOTS',
  'NOTICE_SLOTS_FIRST',
  'NOTICE_TRIM',
  'OVERRIDE_LINE',
  'OffsetSchema',
  'PACK_ID_RE',
  'PAUSE_LINE',
  'PRODUCER_SCHEMA_COMMENT',
  'PROFILE_ID_RE',
  'PackIdSchema',
  'PassSchema',
  'ProfileIdFormatSchema',
  'ProfileIdSchema',
  'REPLY_LINE',
  'REVIEWER_CATEGORIES',
  'REVIEWER_MODELS',
  'REVIEWER_MODEL_BY_PROVIDER',
  'RULE_CATEGORIES',
  'RULE_ID_RE',
  'ReviewRequestSchema',
  'ReviewResultSchema',
  'ReviewStatsSchema',
  'SEGMENT_ID_RE',
  'SKIPPED_REASONS',
  'SegmentIdSchema',
  'SegmentKindSchema',
  'SegmentSchema',
  'ServerStoredEventSchema',
  'SeveritySchema',
  'SkippedReasonSchema',
  'SourceSchema',
  'TELEMETRY_BATCH_MAX',
  'TELEMETRY_COUNT_MAX',
  'TELEMETRY_RULE_IDS_MAX',
  'TELEMETRY_STRING_MAX',
  'TELEMETRY_TS_MAX',
  'TELEMETRY_TS_MIN',
  'TELEMETRY_TS_WINDOW_MS',
  'TELEMETRY_WORDS_BUCKET_MAX',
  'TRIM_WORD_WINDOW',
  'VAGUE_CLAIM_PREFIX',
  'VAGUE_CLAIM_SUFFIX',
  'VIA_MODEL_CAP',
  'VerdictSchema',
  'WireBatchSchema',
  'WireEventSchema',
  'categoryCountsSchema',
  'documentProblems',
  'dropMismatchedSpans',
  'emit',
  'encodeTelemetryBatch',
  'findKeyShapedStrings',
  'findingId',
  'findingProblems',
  'generateJsonSchemas',
  'idDenylistViolation',
  'injectedTextDenylistViolation',
  'injectedTextViolation',
  'isKnownAction',
  'isTimestampWithinBounds',
  'parseReviewResultLenient',
  'placementProblems',
  'renderFeedbackText',
  'renderInstructionForConsumer',
  'renderNotice',
  'safeInline',
  'schemaPlaceholder',
  'segmentIndex',
  'spanMatches',
  'trimSpan',
  'truncateToMinute',
];
