// Telemetry allowlist (docs/07 "Telemetry allowlist", threat 5; docs/06 POST /telemetry).
//
// Every object is strict, so a field this file does not name cannot pass: widening telemetry means
// editing this file, which is a reviewed schema change. There is deliberately no session id, turn
// id, span text, offset or prose field anywhere. Every string is a short visible-ASCII token
// (<= 64 chars, no whitespace), so a sentence cannot ride in a string field either.

import { z } from 'zod';
import { CategorySchema, PassSchema, RULE_ID_RE, VerdictSchema } from './schemas.js';

export const TELEMETRY_STRING_MAX = 64;
export const TELEMETRY_BATCH_MAX = 50;

/** 07 threat 5: strings over 64 chars are rejected. Whitespace is rejected too (tokens, not prose). */
const Token = z
  .string()
  .min(1)
  .max(TELEMETRY_STRING_MAX)
  .regex(/^[\x21-\x7e]+$/, 'must be visible ASCII with no whitespace');

const Count = z.number().int().nonnegative();

/** Fixed list of error codes (07: "code from a fixed list; no messages"). Extending it is a reviewed change. */
export const ERROR_CODES = [
  'adapter_error',
  'reviewer_timeout',
  'reviewer_http_error',
  'reviewer_schema_invalid',
  'profile_resolution_failed',
  'pack_rejected',
  'snapshot_missing',
  'turn_budget_exceeded',
  'keychain_unavailable',
  'telemetry_dropped',
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

export const LATENCY_BUCKETS_MS = [500, 1000, 2000, 4000, 8000] as const;

/** Envelope carried by every event. ts is integer milliseconds since the Unix epoch. */
const envelope = {
  account_id: Token,
  device_id: Token,
  ts: z.number().int().nonnegative(),
};

const SessionStart = z.strictObject({
  ...envelope,
  t: z.literal('session_start'),
  harness: Token,
  adapter_version: Token,
  profile_count: Count,
  offline: z.boolean(),
});

const ReviewerStats = z.strictObject({
  model: Token,
  latency_bucket_ms: z.union([z.literal(500), z.literal(1000), z.literal(2000), z.literal(4000), z.literal(8000)]),
  findings: Count,
  span_misses: Count,
});

const Review = z.strictObject({
  ...envelope,
  t: z.literal('review'),
  profile_id: Token,
  pass: PassSchema,
  verdict: VerdictSchema,
  skipped_reason: Token.exactOptional(),
  prose_words_bucket: Count.refine((n) => n % 100 === 0, 'must be a multiple of 100'),
  by_category: z.partialRecord(CategorySchema, Count),
  rule_ids: z
    .array(Token.regex(RULE_ID_RE, 'must be a rule id'))
    .refine((ids) => new Set(ids).size === ids.length, 'rule_ids must be deduplicated'),
  reviewer: ReviewerStats.exactOptional(),
  cleared: Count,
  cleared_categories: z.array(CategorySchema),
});

const Enforcement = z.strictObject({
  ...envelope,
  t: z.literal('enforcement'),
  decision: z.enum(['allow', 'continue']),
  enforcement_unavailable: z.boolean(),
  override_used: z.boolean(),
  notice_via_model: z.boolean(),
});

const ProfileSelect = z.strictObject({
  ...envelope,
  t: z.literal('profile_select'),
  from: Token,
  to: Token,
  by: z.enum(['model', 'heuristic', 'user']),
});

const ErrorEvent = z.strictObject({
  ...envelope,
  t: z.literal('error'),
  code: z.enum(ERROR_CODES),
});

export const TelemetryEventSchema = z.discriminatedUnion('t', [
  SessionStart,
  Review,
  Enforcement,
  ProfileSelect,
  ErrorEvent,
]);
export type TelemetryEvent = z.infer<typeof TelemetryEventSchema>;

/** Body of POST /telemetry (06): at most 50 events; any unknown field anywhere drops the batch. */
export const TelemetryBatchSchema = z.strictObject({
  events: z.array(TelemetryEventSchema).max(TELEMETRY_BATCH_MAX),
});
export type TelemetryBatch = z.infer<typeof TelemetryBatchSchema>;
