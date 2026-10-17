// Security test (plan 11 §7, 07 "Key handling"): no outbound telemetry payload may carry a string
// with the shape of a key or token. This is one of the four security tests CI runs; it fails the
// build if the guard in telemetry.ts is weakened or removed.

import { describe, expect, it } from 'vitest';
import {
  KEY_PREFIXES,
  WireBatchSchema,
  WireEventSchema,
  encodeTelemetryBatch,
  findKeyShapedStrings,
} from './telemetry.js';

const TS = 1_760_000_040_000;

/** A review event whose reviewer.model format ('^[a-z0-9][a-z0-9._:@/-]{0,63}$') would, on its own, accept these. */
const review = (model: string) => ({
  ts: TS,
  t: 'review',
  profile_id: 'local',
  pass: 1,
  verdict: 'revise',
  prose_words_bucket: 100,
  by_category: { hedge: 1 },
  rule_ids: ['core.hedge.001'],
  reviewer: { model, latency_bucket_ms: 1000, findings: 1, span_misses: 0 },
  cleared: 0,
  cleared_categories: [],
});
const batchOf = (model: string) => ({ events: [review(model)] });

describe('telemetry key-prefix guard', () => {
  it('a model id with an ordinary value passes (control)', () => {
    expect(WireBatchSchema.safeParse(batchOf('gpt-5-mini')).success).toBe(true);
    expect(() => encodeTelemetryBatch(batchOf('gpt-5-mini'))).not.toThrow();
  });

  it('the guard lists exactly the prefixes 07 names', () => {
    expect([...KEY_PREFIXES]).toEqual(['sk-', 'sk_', 'pk_', 'xox', 'ghp_', 'AKIA', 'pgd_']);
  });

  it.each(['sk-proj-abc123', 'sk_live_abc123', 'pk_live_abc123', 'xoxb-1234-abcd', 'ghp_abcdefgh', 'pgd_abcdefgh'])(
    'rejects a lower-case key prefix that the model format would otherwise accept: %s',
    (model) => {
      // prove the format alone does not stop it: the same string is a valid model id shape
      expect(/^[a-z0-9][a-z0-9._:@/-]{0,63}$/.test(model)).toBe(true);
      expect(WireBatchSchema.safeParse(batchOf(model)).success).toBe(false);
      expect(WireEventSchema.safeParse(review(model)).success).toBe(false);
      expect(() => encodeTelemetryBatch(batchOf(model))).toThrow(/key or token/);
    },
  );

  it('a 40+ character base64url or hex run is rejected, at 40 and not at 39', () => {
    const run = (n: number) => `m${'a1'.repeat(30)}`.slice(0, n);
    expect(WireBatchSchema.safeParse(batchOf(run(39))).success).toBe(true);
    expect(WireBatchSchema.safeParse(batchOf(run(40))).success).toBe(false);
    expect(WireBatchSchema.safeParse(batchOf(`gpt-${'0123456789abcdef'.repeat(3)}`)).success).toBe(false); // hex run in the middle
    expect(WireBatchSchema.safeParse(batchOf(`x-${'ab_cd-ef'.repeat(5)}`)).success).toBe(false); // base64url alphabet
  });

  it('a 43-char base64url device-key shape and a 64-char hex device-key shape are rejected', () => {
    const b64url43 = 'a'.repeat(43);
    const hex64 = '0123456789abcdef'.repeat(4);
    expect(b64url43).toHaveLength(43);
    expect(hex64).toHaveLength(64);
    for (const model of [b64url43, hex64]) expect(WireBatchSchema.safeParse(batchOf(model)).success).toBe(false);
  });

  it('the guard walks every string in the document, values and object keys, at any depth', () => {
    expect(findKeyShapedStrings({ a: ['ok', { b: 'sk-abc' }] })).toEqual(['.a[1].b']);
    expect(findKeyShapedStrings({ 'sk-abc': 1 })).toEqual(['.sk-abc (key)']);
    expect(findKeyShapedStrings({ a: 'AKIAIOSFODNN7EXAMPLE' })).toHaveLength(1);
    expect(findKeyShapedStrings('ghp_xxx')).toEqual(['(root)']);
    expect(findKeyShapedStrings({ a: 'fine', b: ['also fine'], c: { d: 1 } })).toEqual([]);
    let deep: unknown = 'x';
    for (let i = 0; i < 40; i++) deep = { a: deep };
    expect(findKeyShapedStrings(deep).length).toBeGreaterThan(0); // refuses to walk unboundedly
  });

  it('the upper-case AWS prefix and the bare prefixes are caught wherever they appear first', () => {
    expect(findKeyShapedStrings('AKIAXXXXXXXXXXXXXXXX')).toHaveLength(1);
    expect(findKeyShapedStrings('xoxp-1')).toHaveLength(1);
    expect(findKeyShapedStrings('akia-not-a-prefix')).toEqual([]); // case-sensitive, as the AWS prefix is
    expect(findKeyShapedStrings('task-sk-1')).toEqual([]); // only prefixes, not substrings
  });

  it('no outbound payload built by the encoder contains a key prefix (the batch is checked after parsing)', () => {
    const wire = encodeTelemetryBatch(batchOf('gpt-5-mini'));
    for (const p of KEY_PREFIXES) expect(wire).not.toContain(`"${p}`);
  });
});
