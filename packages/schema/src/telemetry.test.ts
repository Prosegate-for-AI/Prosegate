/* eslint-disable @typescript-eslint/no-explicit-any -- tests mutate untyped event documents on purpose */
import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  ERROR_CODES,
  HARNESSES,
  ServerStoredEventSchema,
  TELEMETRY_BATCH_MAX,
  TELEMETRY_KINDS,
  TELEMETRY_TS_MAX,
  TELEMETRY_TS_MIN,
  WireBatchSchema,
  WireEventSchema,
  encodeTelemetryBatch,
  isTimestampWithinBounds,
  truncateToMinute,
  type ServerStoredEvent,
  type WireEvent,
} from './telemetry.js';
import { CATEGORIES } from './types.js';
import { REVIEWER_MODELS } from './reviewer-models.js';
import type { Category, SkippedReason } from './types.js';

// ---- compile-time: the schema's output type is exactly this, no wider (toEqualTypeOf) -------

type ErrorCodeLiteral =
  | 'adapter_error' | 'reviewer_timeout' | 'reviewer_http_error' | 'reviewer_schema_invalid' | 'reviewer_key_missing'
  | 'profile_resolution_failed' | 'pack_rejected' | 'signature_invalid' | 'snapshot_missing' | 'turn_budget_exceeded'
  | 'keychain_unavailable' | 'keychain_timeout' | 'transcript_unreadable' | 'telemetry_dropped' | 'turn_truncated';
type Expected =
  | { ts: number; t: 'session_start'; harness: 'claude-code'; adapter_version: string; profile_count: number; offline: boolean }
  | {
      ts: number;
      t: 'review';
      profile_id: string;
      pass: 1 | 2;
      verdict: 'pass' | 'revise' | 'skipped';
      skipped_reason?: SkippedReason;
      prose_words_bucket: number;
      by_category: Partial<Record<Category, number>>;
      rule_ids: string[];
      reviewer?: { model: string; latency_bucket_ms: 500 | 1000 | 2000 | 4000 | 8000; findings: number; span_misses: number };
      cleared: number;
      cleared_categories: Category[];
    }
  | { ts: number; t: 'enforcement'; decision: 'allow' | 'continue'; enforcement_unavailable: boolean; override_used: boolean; notice_via_model: boolean }
  | { ts: number; t: 'profile_select'; from: string; to: string; by: 'model' | 'heuristic' | 'user' }
  | { ts: number; t: 'error'; code: ErrorCodeLiteral };

type Stamped<T> = T extends unknown ? { [K in keyof (T & { account_id: string; device_id: string })]: (T & { account_id: string; device_id: string })[K] } : never;

describe('telemetry types', () => {
  it('the wire event type is exactly the 07 allowlist (no account_id, no device_id)', () => {
    expectTypeOf<WireEvent>().toEqualTypeOf<Expected>();
  });
  it('the stored event type is the wire type plus the stamped identifiers', () => {
    expectTypeOf<ServerStoredEvent>().toEqualTypeOf<Stamped<Expected>>();
  });
});

const TS = 1_760_000_040_000; // a multiple of 60000

const CTX = {
  syncedProfileIds: new Set(['org-default/pr-description', 'org-default/design-doc']),
  syncedPackIds: new Set(['org-default']),
};
const encode = (b: unknown) => encodeTelemetryBatch(b, CTX);

const VALID: Record<string, WireEvent> = {
  session_start: { ts: TS, t: 'session_start', harness: 'claude-code', adapter_version: '0.1.0', profile_count: 3, offline: false },
  review_minimal: { ts: TS, t: 'review', profile_id: 'local', pass: 1, verdict: 'pass', prose_words_bucket: 0, by_category: {}, rule_ids: [], cleared: 0, cleared_categories: [] },
  review_full: {
    ts: TS,
    t: 'review',
    profile_id: 'org-default/pr-description',
    pass: 2,
    verdict: 'skipped',
    skipped_reason: 'pass_cap',
    prose_words_bucket: 300,
    by_category: { hedge: 1, vocab: 2, unsupported_claim: 1 },
    rule_ids: ['core.hedge.001', 'core.vocab.003'],
    reviewer: { model: REVIEWER_MODELS[0], latency_bucket_ms: 2000, findings: 1, span_misses: 0 },
    cleared: 2,
    cleared_categories: ['filler', 'triad'],
  },
  enforcement: { ts: TS, t: 'enforcement', decision: 'continue', enforcement_unavailable: false, override_used: false, notice_via_model: true },
  profile_select: { ts: TS, t: 'profile_select', from: 'local', to: 'org-default/design-doc', by: 'heuristic' },
  error: { ts: TS, t: 'error', code: 'reviewer_timeout' },
};
const V = (name: string): any => structuredClone(VALID[name]);
const wireOk = (e: unknown) => WireEventSchema.safeParse(e).success;

describe('telemetry allowlist: valid events', () => {
  it.each(Object.entries(VALID))('validates %s', (_name, event) => {
    expect(wireOk(event)).toBe(true);
  });

  it('the stored form is the wire form plus account_id and device_id; the wire form refuses them', () => {
    for (const event of Object.values(VALID)) {
      const stored = { ...event, account_id: 'acct_01HZX', device_id: 'dev_01HZY' };
      expect(ServerStoredEventSchema.safeParse(stored).success).toBe(true);
      expect(wireOk(stored)).toBe(false);
      expect(wireOk({ ...event, account_id: 'acct_01HZX' })).toBe(false);
      expect(wireOk({ ...event, device_id: 'dev_01HZY' })).toBe(false);
      expect(ServerStoredEventSchema.safeParse(event).success).toBe(false); // an unstamped event is not a stored event
    }
  });

  it('stored identifiers are bounded visible-ASCII tokens (server-stamped: the key-shape guard does not apply to them)', () => {
    const e = { ...VALID['error'], account_id: 'a'.repeat(64), device_id: 'd' };
    expect(ServerStoredEventSchema.safeParse(e).success).toBe(true);
    expect(ServerStoredEventSchema.safeParse({ ...e, account_id: 'a'.repeat(65) }).success).toBe(false);
    expect(ServerStoredEventSchema.safeParse({ ...e, device_id: 'two words' }).success).toBe(false);
    expect(ServerStoredEventSchema.safeParse({ ...e, account_id: 5 }).success).toBe(false);
    expect(ServerStoredEventSchema.safeParse({ ...e, account_id: '' }).success).toBe(false);
  });

  it('pins the exact field list of every event kind', () => {
    const keys = (k: keyof typeof TELEMETRY_KINDS) => Object.keys(TELEMETRY_KINDS[k].shape).sort();
    expect(keys('session_start')).toEqual(['adapter_version', 'harness', 'offline', 'profile_count', 't', 'ts']);
    expect(keys('review')).toEqual([
      'by_category', 'cleared', 'cleared_categories', 'pass', 'profile_id', 'prose_words_bucket', 'reviewer', 'rule_ids',
      'skipped_reason', 't', 'ts', 'verdict',
    ]);
    expect(keys('enforcement')).toEqual(['decision', 'enforcement_unavailable', 'notice_via_model', 'override_used', 't', 'ts']);
    expect(keys('profile_select')).toEqual(['by', 'from', 't', 'to', 'ts']);
    expect(keys('error')).toEqual(['code', 't', 'ts']);
    expect(Object.keys(TELEMETRY_KINDS).sort()).toEqual(['enforcement', 'error', 'profile_select', 'review', 'session_start']);
    const reviewer = (TELEMETRY_KINDS.review.shape.reviewer as any).unwrap().shape;
    expect(Object.keys(reviewer).sort()).toEqual(['findings', 'latency_bucket_ms', 'model', 'span_misses']);
  });

  it('ERROR_CODES is exactly the 07 ErrorCode list, in order', () => {
    expect([...ERROR_CODES]).toEqual([
      'adapter_error', 'reviewer_timeout', 'reviewer_http_error', 'reviewer_schema_invalid', 'reviewer_key_missing',
      'profile_resolution_failed', 'pack_rejected', 'signature_invalid', 'snapshot_missing', 'turn_budget_exceeded',
      'keychain_unavailable', 'keychain_timeout', 'transcript_unreadable', 'telemetry_dropped', 'turn_truncated',
    ]);
    for (const code of ERROR_CODES) expect(wireOk({ ts: TS, t: 'error', code })).toBe(true);
  });
});

describe('telemetry allowlist: unknown fields are rejected everywhere', () => {
  it.each(Object.entries(VALID))('top-level extra field on %s', (_name, event) => {
    expect(wireOk({ ...event, extra: 1 })).toBe(false);
  });

  it('nested extra field in reviewer', () => {
    const e = V('review_full');
    e.reviewer.extra = 1;
    expect(wireOk(e)).toBe(false);
  });

  it('unknown category keys in by_category, and in cleared_categories', () => {
    const e = V('review_full');
    e.by_category.tone = 1;
    expect(wireOk(e)).toBe(false);
    expect(wireOk({ ...V('review_full'), cleared_categories: ['tone'] })).toBe(false);
  });

  it('an own __proto__ key, as JSON.parse creates it, is rejected in every object and record', () => {
    const inject = (doc: any, path: string[]) => {
      const copy = JSON.parse(JSON.stringify(doc));
      let t = copy;
      for (const p of path) t = t[p];
      Object.defineProperty(t, '__proto__', { value: { polluted: true }, enumerable: true, configurable: true, writable: true });
      return copy;
    };
    for (const event of Object.values(VALID)) expect(wireOk(inject(event, []))).toBe(false);
    expect(wireOk(inject(VALID['review_full'], ['by_category']))).toBe(false);
    expect(wireOk(inject(VALID['review_full'], ['reviewer']))).toBe(false);
    expect(wireOk(inject(VALID['review_minimal'], ['by_category']))).toBe(false);
    const batch = { events: [VALID['error']] };
    expect(WireBatchSchema.safeParse(inject(batch, [])).success).toBe(false);
    expect(WireBatchSchema.safeParse(inject(batch, ['events', '0'])).success).toBe(false);
    expect(ServerStoredEventSchema.safeParse({ ...inject(VALID['review_full'], ['by_category']), account_id: 'a', device_id: 'd' }).success).toBe(false);
    // a __proto__ array element must not be a way around the by_category schema either
    expect(Object.prototype.hasOwnProperty.call({}, 'polluted')).toBe(false);
  });

  it('extra field on the batch envelope and on an event inside a batch', () => {
    expect(WireBatchSchema.safeParse({ events: [VALID['error']], extra: 1 }).success).toBe(false);
    expect(WireBatchSchema.safeParse({ events: [{ ...VALID['error'], extra: 1 }] }).success).toBe(false);
  });

  it('an unknown event kind', () => {
    expect(wireOk({ ts: TS, t: 'prose_sample', text: 'x' })).toBe(false);
    expect(wireOk({ ts: TS, t: 'review' })).toBe(false);
  });

  it.each(['session_id', 'turn_id', 'text', 'span_text', 'start', 'end', 'offsets', 'message', 'prose', 'user_message', 'finding_ids', 'ids'])(
    'a %s field is rejected on every event kind',
    (field) => {
      for (const event of Object.values(VALID)) {
        expect(wireOk({ ...event, [field]: 'abc' })).toBe(false);
        expect(wireOk({ ...event, [field]: 5 })).toBe(false);
      }
    },
  );
});

describe('telemetry allowlist: per-field formats', () => {
  const set = (name: string, path: string[], value: unknown) => {
    const e = V(name);
    let t = e;
    for (const p of path.slice(0, -1)) t = t[p];
    t[path[path.length - 1] as string] = value;
    return e;
  };

  it('accepts a 64-char and rejects a 65-char value in every string field that has room for one', () => {
    // Reviewer model is now an allowlist, not a free-form token (D-16).
    expect(wireOk(set('review_full', ['reviewer', 'model'], `${'a'.repeat(30)}.${'a'.repeat(33)}`))).toBe(false);
    expect(wireOk(set('review_full', ['reviewer', 'model'], `${'a'.repeat(30)}.${'a'.repeat(34)}`))).toBe(false); // 65 chars
    // every other string field is bounded by its own, tighter format; 65 chars never passes
    expect(wireOk(set('session_start', ['adapter_version'], `1.0.0-${'a'.repeat(28)}.${'a'.repeat(29)}`))).toBe(true);
    expect(wireOk(set('session_start', ['adapter_version'], `1.0.0-${'a'.repeat(28)}.${'a'.repeat(30)}`))).toBe(false);
    expect(wireOk(set('session_start', ['harness'], 'a'.repeat(65)))).toBe(false);
    expect(wireOk(set('profile_select', ['from'], `${'a'.repeat(31)}/${'b'.repeat(31)}`))).toBe(true);
    expect(wireOk(set('profile_select', ['to'], `${'a'.repeat(31)}/${'b'.repeat(32)}`))).toBe(false);
    expect(wireOk(set('review_full', ['profile_id'], 'a'.repeat(65)))).toBe(false);
    expect(wireOk(set('review_full', ['skipped_reason'], 'a'.repeat(65)))).toBe(false);
    expect(wireOk(set('review_full', ['rule_ids'], [`${'a'.repeat(55)}.hedge.001`]))).toBe(false);
  });

  it('harness is an enum', () => {
    expect([...HARNESSES]).toEqual(['claude-code']);
    for (const bad of ['claude code', 'Claude-Code', 'cursor', '', 5]) expect(wireOk(set('session_start', ['harness'], bad))).toBe(false);
  });

  it.each([
    ['0.1.0', true], ['1.2.3', true], ['10.20.30', true], ['1.0.0-beta.1', true], ['1.0.0-rc.1+build.5', true], ['1.0.0+20260101', true],
    ['1.0', false], ['v1.0.0', false], ['01.0.0', false], ['1.0.0 ', false], ['1.0.0-', false], ['1.0.0.0', false], ['latest', false], ['', false],
    ['1.0.0-beta..1', false], ['1.0.0 beta', false],
  ])('adapter_version %j is %s', (v, valid) => {
    expect(wireOk(set('session_start', ['adapter_version'], v))).toBe(valid);
  });

  it.each([
    [REVIEWER_MODELS[0], true], [REVIEWER_MODELS[1], true], ['gpt-5-mini', false], ['claude-haiku-4-5-20251001', false], ['openai:gpt-5.1', false], ['org/model@v2', false], ['o3', false], ['0', false],
    ['GPT-5', false], ['GPT4o-Prod', false], ['ft:gpt-4o-mini-2024-07-18:acme-corp::9qTVM5AR', false], ['meta-llama/Meta-Llama-3.1-8B-Instruct', false], ['gpt+5', false], ['gpt_5 ', false], ['-gpt', false], ['.model', false], ['gpt 5', false], ['gpt\n5', false], ['gpt#5', false], ['', false], ['This_PR_introduces_a_robust_caching_layer', false],
  ])('reviewer.model %j is %s', (v, valid) => {
    expect(wireOk(set('review_full', ['reviewer', 'model'], v))).toBe(valid);
  });

  it('skipped_reason is the SkippedReason enum', () => {
    for (const ok of ['below_floor', 'no_prose', 'advisory_mode', 'reviewer_unavailable']) {
      expect(wireOk({ ...V('review_full'), skipped_reason: ok })).toBe(true);
    }
    for (const bad of ['rate_limited', 'Below_Floor', 'free text here', '', 5]) expect(wireOk({ ...V('review_full'), skipped_reason: bad })).toBe(false);
  });

  it.each([
    ['local', true], ['org-default/pr-description', true], ['acme/design-doc', true], ['0/0', true],
    ['local/my-private-profile', false], ['Local', false], ['local/', false], ['a', false], ['a/b/c', false], ['A/b', false],
    [`${'a'.repeat(32)}/b`, false], ['a b/c', false], ['', false], ['/b', false], ['a/b ', false], ['x_y/z', false],
  ])('profile id %j in profile_id, from and to is %s', (v, valid) => {
    expect(wireOk(set('review_full', ['profile_id'], v))).toBe(valid);
    expect(wireOk(set('profile_select', ['from'], v))).toBe(valid);
    expect(wireOk(set('profile_select', ['to'], v))).toBe(valid);
  });

  it('error.code accepts only the 07 list', () => {
    for (const bad of ['something went wrong', 'unknown_code', 'ADAPTER_ERROR', '', 5, null, 'adapter_error ']) {
      expect(wireOk({ ts: TS, t: 'error', code: bad })).toBe(false);
    }
  });

  it('rule_ids must look like rule ids and be deduplicated', () => {
    for (const bad of ['Great question!', 'core.hedge', 'core.hedge.1', 'Core.hedge.001', 'core.tone.001', '']) {
      expect(wireOk({ ...V('review_full'), rule_ids: [bad] })).toBe(false);
    }
    expect(wireOk({ ...V('review_full'), rule_ids: ['core.hedge.001', 'core.hedge.001'] })).toBe(false);
  });

  it('latency_bucket_ms is one of the 07 buckets', () => {
    for (const b of [500, 1000, 2000, 4000, 8000]) expect(wireOk(set('review_full', ['reviewer', 'latency_bucket_ms'], b))).toBe(true);
    for (const bad of [0, 250, 499, 501, 3000, 16000, '500', null]) expect(wireOk(set('review_full', ['reviewer', 'latency_bucket_ms'], bad))).toBe(false);
  });

  it('enums: pass, verdict, decision, by', () => {
    for (const bad of [0, 3, '1', null]) expect(wireOk(set('review_full', ['pass'], bad))).toBe(false);
    for (const bad of ['maybe', 'PASS', 5]) expect(wireOk(set('review_full', ['verdict'], bad))).toBe(false);
    for (const bad of ['block', '', 1]) expect(wireOk(set('enforcement', ['decision'], bad))).toBe(false);
    for (const bad of ['admin', '', 1]) expect(wireOk(set('profile_select', ['by'], bad))).toBe(false);
  });
});

describe('telemetry allowlist: timestamps', () => {
  it('ts must be an integer epoch-ms multiple of 60000, between 2020-01-01 and 2100-01-01', () => {
    for (const ok of [TELEMETRY_TS_MIN, TELEMETRY_TS_MIN + 60_000, TS, TELEMETRY_TS_MAX]) expect(wireOk({ ...V('error'), ts: ok })).toBe(true);
    const bad = [
      0, 60_000, TELEMETRY_TS_MIN - 60_000, TELEMETRY_TS_MAX + 60_000, 4_102_444_800_000_000,
      1, 59_999, TS + 1, -60_000, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '1760000040000', null,
    ];
    for (const b of bad) expect(wireOk({ ...V('error'), ts: b }), String(b)).toBe(false);
    const missing = V('error');
    delete missing.ts;
    expect(wireOk(missing)).toBe(false);
  });

  it('truncateToMinute floors to the minute', () => {
    expect(truncateToMinute(1_760_000_059_999)).toBe(1_760_000_040_000);
    expect(truncateToMinute(1_760_000_040_000)).toBe(1_760_000_040_000);
    expect(truncateToMinute(59_999)).toBe(0);
    expect(truncateToMinute(TS + 12_345) % 60_000).toBe(0);
  });

  it('isTimestampWithinBounds accepts +-1 day of the server clock and nothing further', () => {
    const now = 1_760_000_000_000;
    const day = 86_400_000;
    expect(isTimestampWithinBounds(now, now)).toBe(true);
    expect(isTimestampWithinBounds(now + day, now)).toBe(true);
    expect(isTimestampWithinBounds(now - day, now)).toBe(true);
    expect(isTimestampWithinBounds(now + day + 1, now)).toBe(false);
    expect(isTimestampWithinBounds(now - day - 1, now)).toBe(false);
    expect(isTimestampWithinBounds(Number.NaN, now)).toBe(false);
    expect(isTimestampWithinBounds(now, Number.NaN)).toBe(false);
    expect(isTimestampWithinBounds(now + 10, now, 5)).toBe(false);
  });
});

describe('telemetry allowlist: bounds', () => {
  const rev = (over: Record<string, unknown>) => ({ ...V('review_full'), ...over });

  it('prose_words_bucket is a non-negative multiple of 100, at most 1e6', () => {
    for (const ok of [0, 100, 900, 12_300, 1_000_000]) expect(wireOk(rev({ prose_words_bucket: ok }))).toBe(true);
    for (const bad of [-100, 50, 101, 1.5, Number.NaN, 99.9, '100', 1_000_100, 10_000_000]) expect(wireOk(rev({ prose_words_bucket: bad }))).toBe(false);
  });

  it('every count is an integer in [0, 1000]', () => {
    const at = (path: string[], value: unknown) => {
      const e = V('review_full');
      let t = e;
      for (const p of path.slice(0, -1)) t = t[p];
      t[path[path.length - 1] as string] = value;
      return e;
    };
    const fields: string[][] = [['cleared'], ['reviewer', 'findings'], ['reviewer', 'span_misses'], ['by_category', 'hedge']];
    for (const f of fields) {
      expect(wireOk(at(f, 0))).toBe(true);
      expect(wireOk(at(f, 1000))).toBe(true);
      for (const bad of [-1, 1001, 1.5, '1', Number.NaN]) expect(wireOk(at(f, bad))).toBe(false);
    }
    const s = V('session_start');
    expect(wireOk({ ...s, profile_count: 1000 })).toBe(true);
    for (const bad of [-1, 1001, 0.5]) expect(wireOk({ ...s, profile_count: bad })).toBe(false);
  });

  it('rule_ids has at most 64 entries', () => {
    const ids = (n: number) => Array.from({ length: n }, (_, i) => `core.hedge.${String(i).padStart(3, '0')}`);
    expect(wireOk(rev({ rule_ids: ids(64) }))).toBe(true);
    expect(wireOk(rev({ rule_ids: ids(65) }))).toBe(false);
  });

  it('cleared_categories is deduplicated and has at most 9 entries', () => {
    expect(wireOk(rev({ cleared_categories: [...CATEGORIES] }))).toBe(true);
    expect(wireOk(rev({ cleared_categories: ['hedge', 'hedge'] }))).toBe(false);
    expect(wireOk(rev({ cleared_categories: [...CATEGORIES, 'hedge'] }))).toBe(false);
  });

  it('on pass 1, cleared is 0 and cleared_categories is empty', () => {
    const p1 = (over: Record<string, unknown>) => {
      const e = rev({ pass: 1, verdict: 'revise', ...over });
      delete e.skipped_reason;
      return e;
    };
    expect(wireOk(p1({ cleared: 0, cleared_categories: [] }))).toBe(true);
    expect(wireOk(p1({ cleared: 1, cleared_categories: [] }))).toBe(false);
    expect(wireOk(p1({ cleared: 0, cleared_categories: ['hedge'] }))).toBe(false);
    expect(wireOk(rev({ pass: 2, cleared: 1, cleared_categories: ['hedge'] }))).toBe(true);
  });

  it("skipped_reason only goes with verdict 'skipped' (or 'pass_cap' with verdict 'pass', 03 pass rule 3)", () => {
    const r = (verdict: string, skipped_reason?: string) => {
      const e = V('review_full');
      e.verdict = verdict;
      if (skipped_reason === undefined) delete e.skipped_reason;
      else e.skipped_reason = skipped_reason;
      return e;
    };
    expect(wireOk(r('skipped', 'below_floor'))).toBe(true);
    expect(wireOk(r('skipped'))).toBe(true);
    expect(wireOk(r('pass', 'pass_cap'))).toBe(true);
    expect(wireOk(r('pass', 'below_floor'))).toBe(false);
    expect(wireOk(r('revise', 'below_floor'))).toBe(false);
    expect(wireOk(r('revise', 'pass_cap'))).toBe(false);
    expect(wireOk(r('pass'))).toBe(true);
  });
});

describe('telemetry allowlist: wrong types and gaps in every field', () => {
  function paths(value: any, prefix: string[] = []): Array<{ path: string[]; value: unknown }> {
    const out: Array<{ path: string[]; value: unknown }> = [];
    for (const [k, v] of Object.entries(value)) {
      if (v !== null && typeof v === 'object' && !Array.isArray(v)) out.push({ path: [...prefix, k], value: v }, ...paths(v, [...prefix, k]));
      else out.push({ path: [...prefix, k], value: v });
      if (Array.isArray(v)) v.forEach((item, i) => out.push({ path: [...prefix, k, String(i)], value: item }));
    }
    return out;
  }
  const wrongFor = (v: unknown): unknown[] => {
    if (typeof v === 'string') return [5, null, true, [], {}];
    if (typeof v === 'number') return ['5', null, true, [], {}, Number.NaN];
    if (typeof v === 'boolean') return ['true', 1, 0, null, [], {}];
    if (Array.isArray(v)) return ['x', null, {}, 5];
    return ['x', null, [], 5, true];
  };
  const OPTIONAL = new Set(['skipped_reason', 'reviewer']);

  it.each(Object.entries(VALID))('every field of %s rejects values of the wrong type', (_name, event) => {
    let n = 0;
    for (const { path, value } of paths(event)) {
      for (const wrong of wrongFor(value)) {
        const e = structuredClone(event) as any;
        let t = e;
        for (const p of path.slice(0, -1)) t = t[p];
        t[path[path.length - 1] as string] = wrong;
        expect(wireOk(e), `${path.join('.')} = ${JSON.stringify(wrong)}`).toBe(false);
        n++;
      }
    }
    expect(n).toBeGreaterThan(5);
  });

  it.each(Object.entries(VALID))('every required field of %s is required', (_name, event) => {
    for (const { path } of paths(event)) {
      if (OPTIONAL.has(path[path.length - 1] as string) || path[0] === 'by_category') continue;
      if (path.length > 1 && /^\d+$/.test(path[path.length - 1] as string)) continue; // array elements
      const e = structuredClone(event) as any;
      let t = e;
      for (const p of path.slice(0, -1)) t = t[p];
      Reflect.deleteProperty(t, path[path.length - 1] as string);
      expect(wireOk(e), `without ${path.join('.')}`).toBe(false);
    }
  });
});

describe('telemetry batch and the send path', () => {
  it(`accepts up to ${TELEMETRY_BATCH_MAX} events and rejects more`, () => {
    const mk = (n: number) => ({ events: Array.from({ length: n }, () => VALID['error']) });
    expect(WireBatchSchema.safeParse(mk(0)).success).toBe(true);
    expect(WireBatchSchema.safeParse(mk(1)).success).toBe(true);
    expect(WireBatchSchema.safeParse(mk(50)).success).toBe(true);
    expect(WireBatchSchema.safeParse(mk(51)).success).toBe(false);
  });
  it('one bad event drops the whole batch', () => {
    expect(WireBatchSchema.safeParse({ events: [VALID['error'], { ...VALID['error'], text: 'x' }] }).success).toBe(false);
  });
  it('rejects a bare array and a missing or mistyped events key', () => {
    expect(WireBatchSchema.safeParse([VALID['error']]).success).toBe(false);
    expect(WireBatchSchema.safeParse({}).success).toBe(false);
    expect(WireBatchSchema.safeParse({ events: 'x' }).success).toBe(false);
  });

  it('encodeTelemetryBatch returns the JSON of the parsed batch and round-trips', () => {
    const batch = { events: Object.values(VALID) };
    const wire = encode(batch);
    expect(typeof wire).toBe('string');
    expect(JSON.parse(wire)).toEqual(batch);
    expect(wire).toBe(JSON.stringify(WireBatchSchema.parse(batch)));
    expect(WireBatchSchema.safeParse(JSON.parse(wire)).success).toBe(true);
  });

  it('encodeTelemetryBatch throws on anything the schema refuses, and returns nothing', () => {
    expect(() => encode({ events: [{ ...VALID['error'], session_id: 's1' }] })).toThrow();
    expect(() => encode({ events: [{ ...VALID['error'], account_id: 'a', device_id: 'd' }] })).toThrow();
    expect(() => encode({ events: Array.from({ length: 51 }, () => VALID['error']) })).toThrow();
    expect(() => encode({ events: [{ ...VALID['review_full'], reviewer: { ...VALID['review_full'], model: 'sk-proj-abcdef' } }] })).toThrow();
    expect(() => encode(null)).toThrow();
    expect(() => encode('{"events":[]}')).toThrow();
  });

  it('encodeTelemetryBatch refuses a model id with the shape of a key', () => {
    const e = V('review_full');
    e.reviewer.model = ['sk', 'proj', 'abcdefghijklmnop'].join('-');
    expect(() => encode({ events: [e] })).toThrow(/key or token/);
  });
});

// ---- property-style: prose cannot leak -----------------------------------------------------

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FAKE_PROSE = 'This PR introduces a robust caching layer that significantly improves performance.';
const SPACELESS_PROSE = 'This_PR_introduces_a_robust_caching_layer';

describe('telemetry property: prose cannot leak', () => {
  const rnd = mulberry32(0xc0ffee);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)] as T;
  const int = (n: number) => Math.floor(rnd() * n);
  const slug = () => Array.from({ length: 1 + int(20) }, () => pick([...'abcdefghijklmnopqrstuvwxyz0123456789-'])).join('');
  const profile = () => (rnd() < 0.2 ? 'local' : `${slug().replace(/^local$/, 'x')}/${slug()}`);
  const ruleId = () => `${slug()}.${pick(['filler', 'hedge', 'vocab', 'triad', 'structure', 'repetition'])}.${String(int(1000)).padStart(3, '0')}`;
  const minute = () => TELEMETRY_TS_MIN + int(30_000_000) * 60_000;

  function gen(): WireEvent {
    switch (int(5)) {
      case 0:
        return { ts: minute(), t: 'session_start', harness: 'claude-code', adapter_version: `${int(10)}.${int(30)}.${int(100)}`, profile_count: int(20), offline: rnd() < 0.5 };
      case 1: {
        const byCat: Partial<Record<Category, number>> = {};
        for (const c of CATEGORIES) if (rnd() < 0.4) byCat[c] = int(10);
        const pass = pick([1, 2] as const);
        const cleared = pass === 1 ? 0 : int(10);
        const cats = pass === 1 ? [] : [...new Set(Array.from({ length: int(4) }, () => pick(CATEGORIES)))];
        const e: WireEvent = {
          ts: minute(),
          t: 'review',
          profile_id: profile(),
          pass,
          verdict: pick(['pass', 'revise', 'skipped'] as const),
          prose_words_bucket: int(100) * 100,
          by_category: byCat,
          rule_ids: [...new Set(Array.from({ length: int(6) }, ruleId))],
          cleared,
          cleared_categories: cats,
        };
        if (e.t === 'review' && e.verdict === 'skipped' && rnd() < 0.5) e.skipped_reason = pick(['below_floor', 'no_prose', 'advisory_mode', 'reviewer_unavailable'] as const);
        if (e.t === 'review' && rnd() < 0.5) {
          e.reviewer = { model: pick(REVIEWER_MODELS), latency_bucket_ms: pick([500, 1000, 2000, 4000, 8000] as const), findings: int(9), span_misses: int(3) };
        }
        return e;
      }
      case 2:
        return { ts: minute(), t: 'enforcement', decision: pick(['allow', 'continue'] as const), enforcement_unavailable: rnd() < 0.5, override_used: rnd() < 0.5, notice_via_model: rnd() < 0.5 };
      case 3:
        return { ts: minute(), t: 'profile_select', from: profile(), to: profile(), by: pick(['model', 'heuristic', 'user'] as const) };
      default:
        return { ts: minute(), t: 'error', code: pick(ERROR_CODES) };
    }
  }

  const events = Array.from({ length: 600 }, gen);

  it('the generator produces only events the schema accepts', () => {
    for (const e of events) {
      const r = WireEventSchema.safeParse(e);
      if (!r.success) throw new Error(`generator produced an invalid event: ${JSON.stringify(e)} ${r.error.message}`);
    }
  });

  it('an encoded batch never contains the prose sentence', () => {
    for (let i = 0; i < events.length; i += TELEMETRY_BATCH_MAX) {
      const wire = encode({ events: events.slice(i, i + TELEMETRY_BATCH_MAX) });
      expect(wire).not.toContain(FAKE_PROSE);
      expect(wire).not.toContain('caching layer');
    }
  });

  function stringPaths(value: any, prefix: string[] = []): string[][] {
    const out: string[][] = [];
    for (const [k, v] of Object.entries(value)) {
      if (typeof v === 'string' && k !== 't') out.push([...prefix, k]);
      else if (Array.isArray(v)) v.forEach((item, i) => typeof item === 'string' && out.push([...prefix, k, String(i)]));
      else if (v !== null && typeof v === 'object') out.push(...stringPaths(v, [...prefix, k]));
    }
    return out;
  }
  const inject = (event: unknown, path: string[], value: string) => {
    const copy = structuredClone(event) as any;
    let t = copy;
    for (const p of path.slice(0, -1)) t = t[p];
    t[path[path.length - 1] as string] = value;
    return copy;
  };

  it('prose (with spaces) injected into ANY string field of any generated event is rejected', () => {
    let injected = 0;
    for (const e of events) {
      for (const path of stringPaths(e)) {
        expect(wireOk(inject(e, path, FAKE_PROSE)), path.join('.')).toBe(false);
        injected++;
      }
    }
    expect(injected).toBeGreaterThan(500);
  });

  it('the whitespace-free prose variant is rejected in every string field whose format can exclude it', () => {
    let injected = 0;
    for (const e of events) {
      for (const path of stringPaths(e)) {
        expect(wireOk(inject(e, path, SPACELESS_PROSE)), path.join('.')).toBe(false);
        injected++;
      }
    }
    expect(injected).toBeGreaterThan(500);
  });

  it('prose injected as an extra key, under any name, is rejected', () => {
    for (const e of events.slice(0, 200)) {
      expect(wireOk({ ...e, [slug()]: FAKE_PROSE })).toBe(false);
      expect(wireOk({ ...e, [SPACELESS_PROSE]: 1 })).toBe(false);
    }
  });
});

describe('telemetry: local names never leave the machine (encodeTelemetryBatch masking)', () => {
  const review = (over: Record<string, unknown>) => ({ ...V('review_full'), ...over });
  const decode = (events: unknown[]) => (JSON.parse(encode({ events })) as { events: any[] }).events;

  it('maps an unsynced profile_id to local and keeps a synced one', () => {
    const [a, b, c] = decode([
      review({ profile_id: 'me/divorce-letter-to-sarah' }),
      review({ profile_id: 'org-default/pr-description' }),
      review({ profile_id: 'local' }),
    ]);
    expect(a.profile_id).toBe('local');
    expect(b.profile_id).toBe('org-default/pr-description');
    expect(c.profile_id).toBe('local');
  });

  it('maps unsynced from and to in profile_select', () => {
    const [e] = decode([{ ts: TS, t: 'profile_select', from: 'me/secret-novel', to: 'org-default/design-doc', by: 'user' }]);
    expect(e.from).toBe('local');
    expect(e.to).toBe('org-default/design-doc');
    const [f] = decode([{ ts: TS, t: 'profile_select', from: 'org-default/pr-description', to: 'me/cover-letter-for-acme', by: 'model' }]);
    expect(f.from).toBe('org-default/pr-description');
    expect(f.to).toBe('local');
  });

  it("drops a rule id whose pack is local, keeps core and synced packs, and leaves the category counts alone", () => {
    const [e] = decode([
      review({
        rule_ids: ['core.hedge.001', 'org-default.vocab.002', 'my-private-pack.filler.001', 'sarah-letter.triad.003'],
        by_category: { hedge: 1, vocab: 1, filler: 1, triad: 1 },
      }),
    ]);
    expect(e.rule_ids).toEqual(['core.hedge.001', 'org-default.vocab.002']);
    expect(e.by_category).toEqual({ hedge: 1, vocab: 1, filler: 1, triad: 1 });
  });

  it('the encoded bytes contain none of the local names', () => {
    const wire = encode({
      events: [
        review({ profile_id: 'me/divorce-letter-to-sarah', rule_ids: ['my-private-pack.filler.001'] }),
        { ts: TS, t: 'profile_select', from: 'me/divorce-letter-to-sarah', to: 'me/other-private', by: 'user' },
      ],
    });
    for (const name of ['divorce', 'sarah', 'my-private-pack', 'other-private']) expect(wire).not.toContain(name);
  });

  it('with empty sets everything but core is masked', () => {
    const empty = { syncedProfileIds: new Set<string>(), syncedPackIds: new Set<string>() };
    const out = JSON.parse(encodeTelemetryBatch({ events: [review({ rule_ids: ['core.hedge.001', 'org-default.vocab.002'] })] }, empty)) as { events: any[] };
    expect(out.events[0].profile_id).toBe('local');
    expect(out.events[0].rule_ids).toEqual(['core.hedge.001']);
  });

  it('does not mutate its input, and masks only what it should (other events pass through)', () => {
    const input = { events: [review({ profile_id: 'me/private-x' }), V('error')] };
    const before = JSON.stringify(input);
    const out = decode(input.events);
    expect(JSON.stringify(input)).toBe(before);
    expect(out[1]).toEqual(V('error'));
  });

  it('masking never rescues an otherwise invalid batch: wrong types and unknown fields still throw', () => {
    expect(() => encode({ events: [review({ profile_id: 5 })] })).toThrow();
    expect(() => encode({ events: [review({ rule_ids: [5] })] })).toThrow();
    expect(() => encode({ events: [review({ session_id: 'x' })] })).toThrow();
    expect(() => encode({ events: ['x'] })).toThrow();
    expect(() => encode({ events: [null] })).toThrow();
  });

  it('a masked id that is still not valid (a synced set that contains a local-namespace id) is rejected, not sent', () => {
    const bad = { syncedProfileIds: new Set(['local/my-profile']), syncedPackIds: new Set<string>() };
    expect(() => encodeTelemetryBatch({ events: [review({ profile_id: 'local/my-profile' })] }, bad)).toThrow();
  });
});
