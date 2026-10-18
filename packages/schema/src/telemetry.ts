// Telemetry allowlist (docs/07 "Telemetry allowlist", threat 5; docs/06 POST /telemetry; ADR-17).
//
// Every object is strict, so a field this file does not name cannot pass: widening telemetry means
// editing this file, which is a reviewed schema change. There is deliberately no session id, turn
// id, span text, offset or prose field anywhere. Every string field has its own format (enum,
// semver, model-id pattern or the 04 id grammar) on top of a 64-char visible-ASCII token rule, so a
// sentence cannot ride in a string field, and every string in a batch is checked against the shapes
// of the secrets Prosegate handles.
//
// Two forms exist. The WIRE form is what the adapter sends: no account_id, no device_id. The STORED
// form adds both; the service stamps them from the authenticated device key, so a client cannot
// attribute an event to another account.

import { z } from 'zod';
import { CategorySchema, PROFILE_ID_RE, PassSchema, RULE_ID_RE, SkippedReasonSchema, VerdictSchema, categoryCountsSchema } from './schemas.js';

export const TELEMETRY_STRING_MAX = 64;
export const TELEMETRY_BATCH_MAX = 50;
export const TELEMETRY_COUNT_MAX = 1000;
export const TELEMETRY_WORDS_BUCKET_MAX = 1_000_000;
export const TELEMETRY_RULE_IDS_MAX = 64;
/** The server rejects an event whose ts is further than this from its own clock (see isTimestampWithinBounds). */
export const TELEMETRY_TS_WINDOW_MS = 24 * 60 * 60 * 1000;
const MINUTE_MS = 60_000;

/** 07 threat 5: strings over 64 chars are rejected. Whitespace is rejected too (tokens, not prose). */
const Token = z
  .string()
  .min(1)
  .max(TELEMETRY_STRING_MAX)
  .regex(/^[\x21-\x7e]+$/, 'must be visible ASCII with no whitespace');

const Count = z.number().int().nonnegative().max(TELEMETRY_COUNT_MAX);

/** The harnesses that may report. Extending this list is a code change reviewed with 05. */
export const HARNESSES = ['claude-code'] as const;

/** The fixed error codes of 07 (no messages). Adding a code is a change to 07 and to this list. */
export const ERROR_CODES = [
  'adapter_error',
  'reviewer_timeout',
  'reviewer_http_error',
  'reviewer_schema_invalid',
  'reviewer_key_missing',
  'profile_resolution_failed',
  'pack_rejected',
  'signature_invalid',
  'snapshot_missing',
  'turn_budget_exceeded',
  'keychain_unavailable',
  'keychain_timeout',
  'transcript_unreadable',
  'telemetry_dropped',
  'turn_truncated',
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

export const LATENCY_BUCKETS_MS = [500, 1000, 2000, 4000, 8000] as const;

const SEMVER_RE =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,63}$/;

/** A synced profile id (04 grammar, namespace not 'local') or the literal 'local'; never a local profile's own name. */
const TelemetryProfileId = Token.refine(
  (s) => s === 'local' || (PROFILE_ID_RE.test(s) && !s.startsWith('local/')),
  "must be a synced profile id (<namespace>/<slug>, namespace not 'local') or the literal 'local'",
);

// ---- timestamps (07: the adapter truncates to the minute; the server bounds the window) ------

export function truncateToMinute(ms: number): number {
  return Math.floor(ms / MINUTE_MS) * MINUTE_MS;
}

/** The check the server applies on top of the schema: ts is within +-1 day of the server clock. */
export function isTimestampWithinBounds(ts: number, nowMs: number, windowMs: number = TELEMETRY_TS_WINDOW_MS): boolean {
  return Number.isFinite(ts) && Number.isFinite(nowMs) && Math.abs(ts - nowMs) <= windowMs;
}

/** Schema-level sanity for ts: 2020-01-01 to 2100-01-01 (the server's +-1 day window check is separate). */
export const TELEMETRY_TS_MIN = Date.UTC(2020, 0, 1);
export const TELEMETRY_TS_MAX = Date.UTC(2100, 0, 1);

const Ts = z
  .number()
  .int()
  .min(TELEMETRY_TS_MIN)
  .max(TELEMETRY_TS_MAX)
  .refine((n) => n % MINUTE_MS === 0, 'ts must be truncated to the minute (a multiple of 60000 ms)');

// ---- key-shape guard (07 Key handling) --------------------------------------------------------

/**
 * Prefixes of the secrets Prosegate handles or could meet (provider keys, tokens, vended keys). A
 * prefix only counts with at least KEY_TAIL_MIN key characters after it, anywhere in the string, so
 * ordinary words that happen to start with "sk-" or "xox" ("sk-team/docs", "xoxo/gossip") pass.
 */
export const KEY_PREFIXES = ['sk-', 'sk_', 'pk_', 'xox[abprs]-', 'ghp_', 'AKIA', 'pgd_'] as const;
export const KEY_TAIL_MIN = 16;
const KEY_PREFIX_RE = new RegExp(`(?:${KEY_PREFIXES.join('|')})[A-Za-z0-9_-]{${KEY_TAIL_MIN},}`);
/**
 * A run of 40 or more base64url characters. This covers any 40+ char hex run, a 43-char base64url
 * device-key shape and a 64-char hex device-key shape, because hex and those shapes are subsets.
 */
const LONG_KEY_RUN = /[A-Za-z0-9_-]{40,}/;
const MAX_WALK_DEPTH = 16;
/**
 * The one exemption from the long-run rule: semver build metadata (after the first '+') in
 * adapter_version. Prosegate's own build metadata is at most a 12-hex short sha, so a longer run
 * there is not ours; it is allowed so a downstream rebuild with a full git sha does not lose all
 * telemetry. The prefix rule still applies to the whole string.
 */
const BUILD_METADATA_PATHS: ReadonlySet<string> = new Set(['.adapter_version']);

function looksLikeKey(s: string, buildMetadataAllowed = false): boolean {
  if (KEY_PREFIX_RE.test(s)) return true;
  const plus = s.indexOf('+');
  const runText = buildMetadataAllowed && plus !== -1 ? s.slice(0, plus) : s;
  return LONG_KEY_RUN.test(runText);
}

/** Paths of every string (value or object key) in `value` that has the shape of a key. */
export function findKeyShapedStrings(value: unknown, path = '', depth = 0): string[] {
  if (typeof value === 'string') return looksLikeKey(value, BUILD_METADATA_PATHS.has(path)) ? [path || '(root)'] : [];
  if (value === null || typeof value !== 'object') return [];
  if (depth >= MAX_WALK_DEPTH) return [`${path || '(root)'} (too deep)`];
  const out: string[] = [];
  if (Array.isArray(value)) {
    value.forEach((v, i) => out.push(...findKeyShapedStrings(v, `${path}[${i}]`, depth + 1)));
    return out;
  }
  for (const key of Object.keys(value)) {
    if (looksLikeKey(key)) out.push(`${path}.${key} (key)`);
    out.push(...findKeyShapedStrings((value as Record<string, unknown>)[key], `${path}.${key}`, depth + 1));
  }
  return out;
}

function rejectKeyShapes(value: unknown, ctx: z.core.$RefinementCtx): void {
  for (const p of findKeyShapedStrings(value)) {
    ctx.addIssue({ code: 'custom', message: `string at ${p} has the shape of a key or token` });
  }
}

/** As rejectKeyShapes, but the server-stamped account_id and device_id are not the client's to leak and are not checked. */
function rejectKeyShapesInEvent(value: unknown, ctx: z.core.$RefinementCtx): void {
  const rest: Record<string, unknown> = { ...(value as Record<string, unknown>) };
  Reflect.deleteProperty(rest, 'account_id');
  Reflect.deleteProperty(rest, 'device_id');
  rejectKeyShapes(rest, ctx);
}

// ---- event shapes ----------------------------------------------------------------------------

const sessionStartShape = {
  t: z.literal('session_start'),
  harness: z.enum(HARNESSES),
  adapter_version: Token.regex(SEMVER_RE, 'must be a semver version'),
  profile_count: Count,
  offline: z.boolean(),
};

const reviewShape = {
  t: z.literal('review'),
  profile_id: TelemetryProfileId,
  pass: PassSchema,
  verdict: VerdictSchema,
  skipped_reason: SkippedReasonSchema.exactOptional(),
  prose_words_bucket: z
    .number()
    .int()
    .nonnegative()
    .max(TELEMETRY_WORDS_BUCKET_MAX)
    .refine((n) => n % 100 === 0, 'must be a multiple of 100'),
  by_category: categoryCountsSchema(TELEMETRY_COUNT_MAX),
  rule_ids: z.array(Token.regex(RULE_ID_RE, 'must be a rule id')).max(TELEMETRY_RULE_IDS_MAX),
  reviewer: z
    .strictObject({
      model: Token.regex(MODEL_RE, 'must be a model id'),
      latency_bucket_ms: z.union([z.literal(500), z.literal(1000), z.literal(2000), z.literal(4000), z.literal(8000)]),
      findings: Count,
      span_misses: Count,
    })
    .exactOptional(),
  cleared: Count,
  cleared_categories: z.array(CategorySchema).max(CategorySchema.options.length),
};

type ReviewFields = {
  pass: 1 | 2;
  verdict: 'pass' | 'revise' | 'skipped';
  skipped_reason?: string | undefined;
  rule_ids: string[];
  cleared: number;
  cleared_categories: string[];
};

function reviewChecks(r: ReviewFields, ctx: z.core.$RefinementCtx): void {
  const bad = (path: string, message: string): void => {
    ctx.addIssue({ code: 'custom', path: [path], message });
  };
  if (new Set(r.rule_ids).size !== r.rule_ids.length) bad('rule_ids', 'rule_ids must be deduplicated');
  if (new Set(r.cleared_categories).size !== r.cleared_categories.length) bad('cleared_categories', 'cleared_categories must be deduplicated');
  if (r.pass === 1 && r.cleared !== 0) bad('cleared', 'cleared must be 0 on pass 1');
  if (r.pass === 1 && r.cleared_categories.length > 0) bad('cleared_categories', 'cleared_categories must be empty on pass 1');
  // 03 pass semantics rule 3: the call after pass 2 returns verdict 'pass' with skipped_reason 'pass_cap'.
  if (r.skipped_reason !== undefined && !(r.verdict === 'skipped' || (r.verdict === 'pass' && r.skipped_reason === 'pass_cap'))) {
    bad('skipped_reason', "skipped_reason is only allowed with verdict 'skipped' (or 'pass_cap' with verdict 'pass')");
  }
}

const enforcementShape = {
  t: z.literal('enforcement'),
  decision: z.enum(['allow', 'continue']),
  enforcement_unavailable: z.boolean(),
  override_used: z.boolean(),
  notice_via_model: z.boolean(),
};

const profileSelectShape = {
  t: z.literal('profile_select'),
  from: TelemetryProfileId,
  to: TelemetryProfileId,
  by: z.enum(['model', 'heuristic', 'user']),
};

const errorShape = {
  t: z.literal('error'),
  code: z.enum(ERROR_CODES),
};

const wire = { ts: Ts };
const stamp = { account_id: Token, device_id: Token };

/** Wire form: what the adapter sends. No account_id, no device_id. */
export const TELEMETRY_KINDS = {
  session_start: z.strictObject({ ...wire, ...sessionStartShape }),
  review: z.strictObject({ ...wire, ...reviewShape }).superRefine(reviewChecks),
  enforcement: z.strictObject({ ...wire, ...enforcementShape }),
  profile_select: z.strictObject({ ...wire, ...profileSelectShape }),
  error: z.strictObject({ ...wire, ...errorShape }),
} as const;

export const WireEventSchema = z
  .discriminatedUnion('t', [
    TELEMETRY_KINDS.session_start,
    TELEMETRY_KINDS.review,
    TELEMETRY_KINDS.enforcement,
    TELEMETRY_KINDS.profile_select,
    TELEMETRY_KINDS.error,
  ])
  .superRefine(rejectKeyShapes);
export type WireEvent = z.infer<typeof WireEventSchema>;

/** Body of POST /telemetry (06): at most 50 events; any unknown field anywhere drops the batch. */
export const WireBatchSchema = z.strictObject({ events: z.array(WireEventSchema).max(TELEMETRY_BATCH_MAX) });
export type WireBatch = z.infer<typeof WireBatchSchema>;

/**
 * Stored form: the wire event plus the identifiers the service stamps from the device key. FOR THE
 * CONFIG SERVICE ONLY (the adapter never builds one). The key-shape guard covers the event's own
 * fields but deliberately not the stamped account_id and device_id, which the service generated.
 */
const STORED_KINDS = {
  session_start: z.strictObject({ ...stamp, ...wire, ...sessionStartShape }),
  review: z.strictObject({ ...stamp, ...wire, ...reviewShape }).superRefine(reviewChecks),
  enforcement: z.strictObject({ ...stamp, ...wire, ...enforcementShape }),
  profile_select: z.strictObject({ ...stamp, ...wire, ...profileSelectShape }),
  error: z.strictObject({ ...stamp, ...wire, ...errorShape }),
} as const;

export const ServerStoredEventSchema = z
  .discriminatedUnion('t', [
    STORED_KINDS.session_start,
    STORED_KINDS.review,
    STORED_KINDS.enforcement,
    STORED_KINDS.profile_select,
    STORED_KINDS.error,
  ])
  .superRefine(rejectKeyShapesInEvent);
export type ServerStoredEvent = z.infer<typeof ServerStoredEventSchema>;

/** What the adapter knows about which names exist on the server (07: local names never leave the machine). */
export interface TelemetryMaskContext {
  /** Profile ids that are synced from the config service (e.g. 'org-default/pr-description'). */
  syncedProfileIds: ReadonlySet<string>;
  /** Pack ids that are synced from the config service. 'core' is always allowed. */
  syncedPackIds: ReadonlySet<string>;
}

function maskProfileId(id: unknown, ctx: TelemetryMaskContext): unknown {
  return typeof id === 'string' && id !== 'local' && !ctx.syncedProfileIds.has(id) ? 'local' : id;
}

function maskEvent(e: unknown, ctx: TelemetryMaskContext): unknown {
  if (e === null || typeof e !== 'object' || Array.isArray(e)) return e;
  const event = { ...(e as Record<string, unknown>) };
  if (event['t'] === 'review') {
    event['profile_id'] = maskProfileId(event['profile_id'], ctx);
    const ids = event['rule_ids'];
    if (Array.isArray(ids)) {
      event['rule_ids'] = ids.filter((id) => {
        if (typeof id !== 'string') return true; // not ours to hide: the schema rejects it
        const pack = id.split('.')[0] ?? '';
        return pack === 'core' || ctx.syncedPackIds.has(pack);
      });
    }
  } else if (event['t'] === 'profile_select') {
    event['from'] = maskProfileId(event['from'], ctx);
    event['to'] = maskProfileId(event['to'], ctx);
  }
  return event;
}

/**
 * THE ONLY WAY to produce the bytes the adapter POSTs. It (1) masks local names, because the schema
 * cannot know which profile and pack ids exist only on this machine and a user's own profile name is
 * private: any profile_id/from/to not in ctx.syncedProfileIds becomes 'local', and any rule id whose
 * pack is neither 'core' nor in ctx.syncedPackIds is dropped (category counts stay); (2) validates
 * the masked batch against the wire schema (strict, formats, bounds, key-shape guard); and (3)
 * serialises the parsed value, never the caller's object, so nothing the schema does not name can be
 * sent. Throws a ZodError on any violation.
 *
 * 07 obligation: the config service cannot tell a local id from a synced one, so this masking is
 * the only control on that leak and must be stated in 07 as an adapter duty.
 */
export function encodeTelemetryBatch(batch: unknown, ctx: TelemetryMaskContext): string {
  const masked =
    batch !== null && typeof batch === 'object' && Array.isArray((batch as { events?: unknown }).events)
      ? { ...(batch as Record<string, unknown>), events: (batch as { events: unknown[] }).events.map((e) => maskEvent(e, ctx)) }
      : batch;
  return JSON.stringify(WireBatchSchema.parse(masked));
}
