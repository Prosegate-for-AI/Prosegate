/* eslint-disable @typescript-eslint/no-explicit-any -- tests mutate untyped event documents on purpose */
import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  ERROR_CODES,
  TELEMETRY_BATCH_MAX,
  TelemetryBatchSchema,
  TelemetryEventSchema,
  type TelemetryEvent,
} from './telemetry.js';
import { CATEGORIES } from './types.js';
import type { Category } from './types.js';

// ---- compile-time: nothing the schema emits falls outside the 07 `Event` type ---------------
type Envelope = { account_id: string; device_id: string; ts: number };
type Event07 = Envelope &
  (
    | { t: 'session_start'; harness: string; adapter_version: string; profile_count: number; offline: boolean }
    | {
        t: 'review';
        profile_id: string;
        pass: 1 | 2;
        verdict: 'pass' | 'revise' | 'skipped';
        skipped_reason?: string;
        prose_words_bucket: number;
        by_category: Partial<Record<Category, number>>;
        rule_ids: string[];
        reviewer?: { model: string; latency_bucket_ms: 500 | 1000 | 2000 | 4000 | 8000; findings: number; span_misses: number };
        cleared: number;
        cleared_categories: Category[];
      }
    | { t: 'enforcement'; decision: 'allow' | 'continue'; enforcement_unavailable: boolean; override_used: boolean; notice_via_model: boolean }
    | { t: 'profile_select'; from: string; to: string; by: 'model' | 'heuristic' | 'user' }
    | { t: 'error'; code: string }
  );
describe('telemetry types', () => {
  it('every event the schema accepts is a 07 Event', () => {
    expectTypeOf<TelemetryEvent>().toExtend<Event07>();
  });
});

const ENV = { account_id: 'acct_01HZX', device_id: 'dev_01HZY', ts: 1_760_000_000_000 };

const VALID: Record<string, TelemetryEvent> = {
  session_start: { ...ENV, t: 'session_start', harness: 'claude-code', adapter_version: '0.1.0', profile_count: 3, offline: false },
  review_minimal: {
    ...ENV,
    t: 'review',
    profile_id: 'local',
    pass: 1,
    verdict: 'pass',
    prose_words_bucket: 0,
    by_category: {},
    rule_ids: [],
    cleared: 0,
    cleared_categories: [],
  },
  review_full: {
    ...ENV,
    t: 'review',
    profile_id: 'org-default/pr-description',
    pass: 2,
    verdict: 'skipped',
    skipped_reason: 'pass_cap',
    prose_words_bucket: 300,
    by_category: { hedge: 1, vocab: 2, unsupported_claim: 1 },
    rule_ids: ['core.hedge.001', 'core.vocab.003'],
    reviewer: { model: 'gpt-5-mini', latency_bucket_ms: 2000, findings: 1, span_misses: 0 },
    cleared: 2,
    cleared_categories: ['filler', 'triad'],
  },
  enforcement: { ...ENV, t: 'enforcement', decision: 'continue', enforcement_unavailable: false, override_used: false, notice_via_model: true },
  profile_select: { ...ENV, t: 'profile_select', from: 'local/chat-reply', to: 'org-default/design-doc', by: 'heuristic' },
  error: { ...ENV, t: 'error', code: 'reviewer_timeout' },
};

function sets(e: unknown) {
  return TelemetryEventSchema.safeParse(e).success;
}

describe('telemetry allowlist: valid events', () => {
  it.each(Object.entries(VALID))('validates %s', (_name, event) => {
    expect(sets(event)).toBe(true);
  });

  it('validates every error code and every latency bucket and every profile_select source', () => {
    for (const code of ERROR_CODES) expect(sets({ ...ENV, t: 'error', code })).toBe(true);
    for (const b of [500, 1000, 2000, 4000, 8000]) {
      const e = structuredClone(VALID['review_full']) as Record<string, any>;
      e['reviewer'].latency_bucket_ms = b;
      expect(sets(e)).toBe(true);
    }
    for (const by of ['model', 'heuristic', 'user']) expect(sets({ ...VALID['profile_select'], by })).toBe(true);
  });

  it('starts ERROR_CODES with the agreed list', () => {
    expect([...ERROR_CODES]).toEqual([
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
    ]);
  });
});

describe('telemetry allowlist: unknown fields are rejected everywhere', () => {
  it.each(Object.entries(VALID))('top-level extra field on %s', (_name, event) => {
    expect(sets({ ...event, extra: 1 })).toBe(false);
  });

  it('nested extra field in reviewer', () => {
    const e = structuredClone(VALID['review_full']) as Record<string, any>;
    e['reviewer'].extra = 1;
    expect(sets(e)).toBe(false);
  });

  it('unknown category keys in by_category', () => {
    const e = structuredClone(VALID['review_full']) as Record<string, any>;
    e['by_category'].tone = 1;
    expect(sets(e)).toBe(false);
  });

  it('unknown category in cleared_categories', () => {
    expect(sets({ ...VALID['review_full'], cleared_categories: ['tone'] })).toBe(false);
  });

  it('extra field on the batch envelope and on an event inside a batch', () => {
    expect(TelemetryBatchSchema.safeParse({ events: [VALID['error']], extra: 1 }).success).toBe(false);
    expect(TelemetryBatchSchema.safeParse({ events: [{ ...VALID['error'], extra: 1 }] }).success).toBe(false);
  });

  it('an unknown event kind', () => {
    expect(sets({ ...ENV, t: 'prose_sample', text: 'x' })).toBe(false);
  });

  it.each(['session_id', 'turn_id', 'text', 'span_text', 'start', 'end', 'offsets', 'message', 'prose', 'user_message'])(
    'a %s field is rejected on every event kind',
    (field) => {
      for (const event of Object.values(VALID)) {
        expect(sets({ ...event, [field]: 'abc' })).toBe(false);
        expect(sets({ ...event, [field]: 5 })).toBe(false);
      }
    },
  );

  it('a missing envelope field', () => {
    for (const k of ['account_id', 'device_id', 'ts'] as const) {
      const e: Record<string, unknown> = { ...VALID['error'] };
      Reflect.deleteProperty(e, k);
      expect(sets(e)).toBe(false);
    }
  });
});

describe('telemetry allowlist: string and number limits', () => {
  const STRING_PATHS: Array<[string, TelemetryEvent, (e: any, v: string) => void]> = [
    ['account_id', VALID['error'] as TelemetryEvent, (e, v) => (e.account_id = v)],
    ['device_id', VALID['error'] as TelemetryEvent, (e, v) => (e.device_id = v)],
    ['harness', VALID['session_start'] as TelemetryEvent, (e, v) => (e.harness = v)],
    ['adapter_version', VALID['session_start'] as TelemetryEvent, (e, v) => (e.adapter_version = v)],
    ['profile_id', VALID['review_full'] as TelemetryEvent, (e, v) => (e.profile_id = v)],
    ['skipped_reason', VALID['review_full'] as TelemetryEvent, (e, v) => (e.skipped_reason = v)],
    ['reviewer.model', VALID['review_full'] as TelemetryEvent, (e, v) => (e.reviewer.model = v)],
    ['from', VALID['profile_select'] as TelemetryEvent, (e, v) => (e.from = v)],
    ['to', VALID['profile_select'] as TelemetryEvent, (e, v) => (e.to = v)],
  ];

  it.each(STRING_PATHS)('accepts a 64-char and rejects a 65-char %s', (_name, base, set) => {
    const ok = structuredClone(base);
    set(ok, 'a'.repeat(64));
    expect(sets(ok)).toBe(true);
    const bad = structuredClone(base);
    set(bad, 'a'.repeat(65));
    expect(sets(bad)).toBe(false);
  });

  it('rejects a 65-char rule id even when it has the right shape', () => {
    const id = `${'a'.repeat(55)}.hedge.001`;
    expect(id.length).toBeGreaterThan(64);
    expect(sets({ ...VALID['review_full'], rule_ids: [id] })).toBe(false);
  });

  it('rejects strings with whitespace (a sentence cannot ride in a string field)', () => {
    expect(sets({ ...VALID['session_start'], harness: 'claude code' })).toBe(false);
    expect(sets({ ...VALID['session_start'], harness: 'a\nb' })).toBe(false);
    expect(sets({ ...VALID['session_start'], harness: '' })).toBe(false);
  });

  it('rule_ids must look like rule ids and be deduplicated', () => {
    expect(sets({ ...VALID['review_full'], rule_ids: ['Great question!'] })).toBe(false);
    expect(sets({ ...VALID['review_full'], rule_ids: ['core.hedge.001', 'core.hedge.001'] })).toBe(false);
  });

  it('prose_words_bucket is a non-negative multiple of 100', () => {
    for (const ok of [0, 100, 900, 12_300]) expect(sets({ ...VALID['review_full'], prose_words_bucket: ok })).toBe(true);
    for (const bad of [-100, 50, 101, 1.5, Number.NaN, 99.9, '100']) {
      expect(sets({ ...VALID['review_full'], prose_words_bucket: bad })).toBe(false);
    }
  });

  it('latency_bucket_ms must be one of the 07 buckets', () => {
    for (const bad of [0, 250, 499, 501, 3000, 16000, '500']) {
      const e = structuredClone(VALID['review_full']) as Record<string, any>;
      e['reviewer'].latency_bucket_ms = bad;
      expect(sets(e)).toBe(false);
    }
  });

  it('error.code must come from ERROR_CODES (no free messages)', () => {
    expect(sets({ ...ENV, t: 'error', code: 'something went wrong' })).toBe(false);
    expect(sets({ ...ENV, t: 'error', code: 'unknown_code' })).toBe(false);
  });

  it('counts must be non-negative integers', () => {
    expect(sets({ ...VALID['review_full'], cleared: -1 })).toBe(false);
    expect(sets({ ...VALID['review_full'], by_category: { hedge: 1.5 } })).toBe(false);
    expect(sets({ ...VALID['review_full'], by_category: { hedge: -1 } })).toBe(false);
    expect(sets({ ...VALID['session_start'], profile_count: -1 })).toBe(false);
  });
});

describe('telemetry batch', () => {
  it(`accepts up to ${TELEMETRY_BATCH_MAX} events and rejects more`, () => {
    const mk = (n: number) => ({ events: Array.from({ length: n }, () => VALID['error']) });
    expect(TelemetryBatchSchema.safeParse(mk(1)).success).toBe(true);
    expect(TelemetryBatchSchema.safeParse(mk(50)).success).toBe(true);
    expect(TelemetryBatchSchema.safeParse(mk(51)).success).toBe(false);
  });
  it('one bad event drops the whole batch', () => {
    expect(TelemetryBatchSchema.safeParse({ events: [VALID['error'], { ...VALID['error'], text: 'x' }] }).success).toBe(false);
  });
  it('rejects a bare array and a missing events key', () => {
    expect(TelemetryBatchSchema.safeParse([VALID['error']]).success).toBe(false);
    expect(TelemetryBatchSchema.safeParse({}).success).toBe(false);
  });
});

// ---- property-style: prose never reaches the wire ------------------------------------------

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

describe('telemetry property: prose cannot leak', () => {
  const rnd = mulberry32(0xc0ffee);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)] as T;
  const int = (n: number) => Math.floor(rnd() * n);
  const tokenChars = 'abcdefghijklmnopqrstuvwxyz0123456789-_./:@';
  const token = () => Array.from({ length: 1 + int(40) }, () => pick([...tokenChars])).join('');
  const ruleId = () => `${token().replace(/[^a-z0-9-]/g, 'x')}.${pick(['filler', 'hedge', 'vocab', 'triad', 'structure', 'repetition'])}.${String(int(1000)).padStart(3, '0')}`;
  const env = () => ({ account_id: token(), device_id: token(), ts: int(2_000_000_000_000) });

  function gen(): TelemetryEvent {
    switch (int(5)) {
      case 0:
        return { ...env(), t: 'session_start', harness: token(), adapter_version: token(), profile_count: int(20), offline: rnd() < 0.5 };
      case 1: {
        const byCat: Partial<Record<Category, number>> = {};
        for (const c of CATEGORIES) if (rnd() < 0.4) byCat[c] = int(10);
        const ids = [...new Set(Array.from({ length: int(6) }, ruleId))];
        const e: TelemetryEvent = {
          ...env(),
          t: 'review',
          profile_id: token(),
          pass: pick([1, 2] as const),
          verdict: pick(['pass', 'revise', 'skipped'] as const),
          prose_words_bucket: int(100) * 100,
          by_category: byCat,
          rule_ids: ids,
          cleared: int(10),
          cleared_categories: Array.from({ length: int(4) }, () => pick(CATEGORIES)),
        };
        if (rnd() < 0.5 && e.t === 'review') e.skipped_reason = token();
        if (rnd() < 0.5 && e.t === 'review') {
          e.reviewer = { model: token(), latency_bucket_ms: pick([500, 1000, 2000, 4000, 8000] as const), findings: int(9), span_misses: int(3) };
        }
        return e;
      }
      case 2:
        return { ...env(), t: 'enforcement', decision: pick(['allow', 'continue'] as const), enforcement_unavailable: rnd() < 0.5, override_used: rnd() < 0.5, notice_via_model: rnd() < 0.5 };
      case 3:
        return { ...env(), t: 'profile_select', from: token(), to: token(), by: pick(['model', 'heuristic', 'user'] as const) };
      default:
        return { ...env(), t: 'error', code: pick(ERROR_CODES) };
    }
  }

  const events = Array.from({ length: 600 }, gen);

  it('the generator produces only events the schema accepts', () => {
    for (const e of events) {
      const r = TelemetryEventSchema.safeParse(e);
      if (!r.success) throw new Error(`generator produced an invalid event: ${JSON.stringify(e)} ${r.error.message}`);
    }
  });

  it('a parsed, serialised batch never contains the prose sentence or any of its words in a free field', () => {
    for (let i = 0; i < events.length; i += TELEMETRY_BATCH_MAX) {
      const batch = TelemetryBatchSchema.parse({ events: events.slice(i, i + TELEMETRY_BATCH_MAX) });
      const wire = JSON.stringify(batch);
      expect(wire).not.toContain(FAKE_PROSE);
      expect(wire).not.toContain('caching layer');
    }
  });

  it('prose injected into ANY string field of any generated event is rejected', () => {
    let injected = 0;
    for (const e of events) {
      const doc = e as Record<string, any>;
      const targets: Array<[Record<string, any>, string]> = [];
      for (const [k, v] of Object.entries(doc)) {
        if (typeof v === 'string' && k !== 't') targets.push([doc, k]);
      }
      if (doc['reviewer']) targets.push([doc['reviewer'], 'model']);
      for (const [obj, key] of targets) {
        const copy = structuredClone(doc);
        const holder = obj === doc ? copy : copy['reviewer'];
        holder[key] = FAKE_PROSE;
        expect(TelemetryEventSchema.safeParse(copy).success).toBe(false);
        injected++;
      }
    }
    expect(injected).toBeGreaterThan(1000);
  });

  it('prose injected as an extra key, under any name, is rejected', () => {
    for (const e of events.slice(0, 200)) {
      expect(TelemetryEventSchema.safeParse({ ...e, [token()]: FAKE_PROSE }).success).toBe(false);
    }
  });
});
