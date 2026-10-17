// Security test (plan 11 §7, 07 "Key handling"): no outbound telemetry payload may carry a string
// with the shape of a key or token. This is one of the four security tests CI runs; it fails the
// build if the guard in telemetry.ts is weakened or removed.
//
// Key-like fixtures are assembled from fragments at run time so this file does not itself trip
// `pnpm check:secrets`.

import { describe, expect, it } from 'vitest';
import {
  KEY_PREFIXES,
  KEY_TAIL_MIN,
  ServerStoredEventSchema,
  WireBatchSchema,
  WireEventSchema,
  encodeTelemetryBatch,
  findKeyShapedStrings,
} from './telemetry.js';

const TS = 1_760_000_040_000;
const CTX = {
  syncedProfileIds: new Set(['org-default/pr-description']),
  syncedPackIds: new Set(['org-default']),
};
const encode = (b: unknown) => encodeTelemetryBatch(b, CTX);

const base = {
  ts: TS,
  t: 'review',
  profile_id: 'local',
  pass: 1,
  verdict: 'revise',
  prose_words_bucket: 100,
  by_category: { hedge: 1 },
  rule_ids: ['core.hedge.001'],
  cleared: 0,
  cleared_categories: [],
};
/** A review event whose reviewer.model format ('^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,63}$') accepts any of these on its own. */
const review = (model: string) => ({ ...base, reviewer: { model, latency_bucket_ms: 1000, findings: 1, span_misses: 0 } });
const batchOf = (model: string) => ({ events: [review(model)] });
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,63}$/;
const tail = (n: number) => 'abcdef0123456789abcdef'.slice(0, n);
const frag = (...parts: string[]) => parts.join('');

describe('telemetry key-prefix guard', () => {
  it('a model id with an ordinary value passes (control)', () => {
    expect(WireBatchSchema.safeParse(batchOf('gpt-5-mini')).success).toBe(true);
    expect(() => encode(batchOf('gpt-5-mini'))).not.toThrow();
  });

  it('the guard lists exactly the prefixes 07 names, with a 16-character minimum tail', () => {
    expect([...KEY_PREFIXES]).toEqual(['sk-', 'sk_', 'pk_', 'xox[abprs]-', 'ghp_', 'AKIA', 'pgd_']);
    expect(KEY_TAIL_MIN).toBe(16);
  });

  it.each([
    frag('sk', '-proj-', tail(16)),
    frag('sk', '_live_', tail(16)),
    frag('pk', '_live_', tail(16)),
    frag('xox', 'b-', tail(16)),
    frag('xox', 'p-', tail(16)),
    frag('gh', 'p_', tail(16)),
    frag('pg', 'd_', tail(16)),
    frag('AK', 'IA', tail(16).toUpperCase()),
  ])('rejects a key prefix with a 16+ character tail that the model format would accept: %s', (model) => {
    // prove the format alone does not stop it: the same string has a valid model-id shape
    expect(MODEL_RE.test(model)).toBe(true);
    expect(WireBatchSchema.safeParse(batchOf(model)).success).toBe(false);
    expect(WireEventSchema.safeParse(review(model)).success).toBe(false);
    expect(() => encode(batchOf(model))).toThrow(/key or token/);
  });

  it('the tail threshold is exactly 16: 15 characters pass, 16 fail', () => {
    expect(WireBatchSchema.safeParse(batchOf(frag('sk', '-', tail(15)))).success).toBe(true);
    expect(WireBatchSchema.safeParse(batchOf(frag('sk', '-', tail(16)))).success).toBe(false);
    expect(WireBatchSchema.safeParse(batchOf(frag('xox', 'b-', tail(15)))).success).toBe(true);
    expect(WireBatchSchema.safeParse(batchOf(frag('xox', 'b-', tail(16)))).success).toBe(false);
  });

  it('a prefix is found anywhere in the string, not only at the start', () => {
    expect(WireBatchSchema.safeParse(batchOf(frag('openai/', 'sk', '-proj-', tail(16)))).success).toBe(false);
    expect(WireBatchSchema.safeParse(batchOf(frag('x:', 'gh', 'p_', tail(16)))).success).toBe(false);
    const session = { ts: TS, t: 'session_start', harness: 'claude-code', profile_count: 1, offline: false };
    expect(WireEventSchema.safeParse({ ...session, adapter_version: frag('1.0.0-', 'sk', '-ant-api03-', tail(16)) }).success).toBe(false);
    expect(WireEventSchema.safeParse({ ...session, adapter_version: '1.0.0-rc.1' }).success).toBe(true);
  });

  it('ordinary words that start like a prefix pass', () => {
    const profile = (id: string) => WireEventSchema.safeParse({ ...base, profile_id: id }).success;
    expect(profile(frag('sk', '-team/docs'))).toBe(true);
    expect(profile('xoxo/gossip')).toBe(true);
    expect(profile('pk-notes/ideas')).toBe(true);
    expect(WireBatchSchema.safeParse(batchOf(frag('sk', '-model'))).success).toBe(true);
    expect(WireBatchSchema.safeParse(batchOf('xoxo-1')).success).toBe(true);
    expect(WireBatchSchema.safeParse(batchOf('AKIAmodel')).success).toBe(true);
  });

  it('a 40+ character base64url or hex run is rejected, at 40 and not at 39', () => {
    const run = (n: number) => `m${'a1'.repeat(30)}`.slice(0, n);
    expect(WireBatchSchema.safeParse(batchOf(run(39))).success).toBe(true);
    expect(WireBatchSchema.safeParse(batchOf(run(40))).success).toBe(false);
    expect(WireBatchSchema.safeParse(batchOf(`gpt-${'0123456789abcdef'.repeat(3)}`)).success).toBe(false); // hex run in the middle
    expect(WireBatchSchema.safeParse(batchOf(`x-${'ab_cd-ef'.repeat(5)}`)).success).toBe(false); // base64url alphabet
    expect(WireBatchSchema.safeParse(batchOf(`${'Ab9'.repeat(14)}`)).success).toBe(false); // mixed case
  });

  it('a 43-char base64url device-key shape and a 64-char hex device-key shape are rejected', () => {
    const b64url43 = 'a'.repeat(43);
    const hex64 = '0123456789abcdef'.repeat(4);
    expect(b64url43).toHaveLength(43);
    expect(hex64).toHaveLength(64);
    for (const model of [b64url43, hex64]) expect(WireBatchSchema.safeParse(batchOf(model)).success).toBe(false);
  });

  describe('adapter_version build metadata', () => {
    const session = (adapter_version: string) =>
      WireEventSchema.safeParse({ ts: TS, t: 'session_start', harness: 'claude-code', adapter_version, profile_count: 1, offline: false }).success;
    it('is exempt from the long-run rule only after the first "+"', () => {
      expect(session('1.2.3+abcdef012345')).toBe(true); // Prosegate builds: at most a 12-hex short sha
      expect(session(`1.2.3+${'0123456789abcdef'.repeat(3)}`)).toBe(true); // a full 48-hex run in build metadata
      expect(session(`1.2.3-${'a'.repeat(40)}`)).toBe(false); // the same run in the pre-release is not
      expect(session(`1.2.3-${'a'.repeat(36)}`)).toBe(true); // '3-' + 36 = a 38-character run
    });
    it('still rejects a key prefix inside the build metadata', () => {
      expect(session(frag('1.2.3+', 'sk', '-', tail(16)))).toBe(false);
      expect(session(frag('1.2.3+', 'gh', 'p_', tail(16)))).toBe(false);
    });
    it('the exemption does not leak to other fields', () => {
      expect(WireBatchSchema.safeParse(batchOf(`gpt+${'a'.repeat(45)}`)).success).toBe(false); // '+' is not even a model character
      expect(WireBatchSchema.safeParse(batchOf(`gpt-${'a'.repeat(45)}`)).success).toBe(false);
    });
  });

  it('the stored form checks the event fields but not the server-stamped identifiers', () => {
    const stamped = { ...base, account_id: 'a'.repeat(48), device_id: 'd'.repeat(48) };
    expect(ServerStoredEventSchema.safeParse(stamped).success).toBe(true);
    expect(ServerStoredEventSchema.safeParse({ ...stamped, reviewer: review(frag('sk', '-', tail(16))).reviewer }).success).toBe(false);
    expect(ServerStoredEventSchema.safeParse({ ...stamped, account_id: 'a'.repeat(65) }).success).toBe(false); // still a bounded token
  });

  it('the guard walks every string in the document, values and object keys, at any depth', () => {
    const k = frag('sk', '-', tail(16));
    expect(findKeyShapedStrings({ a: ['ok', { b: k }] })).toEqual(['.a[1].b']);
    expect(findKeyShapedStrings({ [k]: 1 })).toEqual([`.${k} (key)`]);
    expect(findKeyShapedStrings({ a: frag('AK', 'IA', 'IOSFODNN7EXAMPLE') })).toHaveLength(1);
    expect(findKeyShapedStrings(frag('gh', 'p_', tail(16)))).toEqual(['(root)']);
    expect(findKeyShapedStrings({ a: 'fine', b: ['also fine'], c: { d: 1 } })).toEqual([]);
    let deep: unknown = 'x';
    for (let i = 0; i < 40; i++) deep = { a: deep };
    expect(findKeyShapedStrings(deep).length).toBeGreaterThan(0); // refuses to walk unboundedly
  });

  it('prefixes are case-sensitive and match as prefixes of a key, not as part of a word with a short tail', () => {
    expect(findKeyShapedStrings(frag('akia', tail(16)))).toEqual([]);
    expect(findKeyShapedStrings(frag('task', '-1'))).toEqual([]);
    expect(findKeyShapedStrings(frag('xox', 'z-', tail(16)))).toEqual([]); // xoxz is not a Slack prefix
    expect(findKeyShapedStrings(frag('xox', 'a-', tail(16)))).toHaveLength(1);
  });

  it('no outbound payload built by the encoder contains a key shape (the batch is checked after masking and parsing)', () => {
    const wire = encode(batchOf('gpt-5-mini'));
    expect(findKeyShapedStrings(JSON.parse(wire))).toEqual([]);
  });
});
