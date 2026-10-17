/* eslint-disable @typescript-eslint/no-explicit-any -- tests mutate untyped JSON documents on purpose */
import { describe, expect, it } from 'vitest';
import { makeResult } from './fixtures.js';
import { isKnownAction, parseReviewResultLenient, renderInstructionForConsumer } from './lenient.js';
import { renderFeedbackText } from './render.js';
import { ReviewRequestSchema, ReviewResultSchema } from './schemas.js';
import { ACTIONS, CATEGORIES, FINDINGS_SCHEMA_VERSION, SKIPPED_REASONS } from './types.js';
import { generateJsonSchemas } from './json-schema.js';

const TEXT = "It's worth noting that this is robust.";

function base() {
  return JSON.parse(
    JSON.stringify(
      makeResult({
        text: TEXT,
        profileId: 'local/pr-description',
        findings: [
          {
            span: "It's worth noting that",
            category: 'hedge',
            ruleId: 'core.hedge.001',
            severity: 'block',
            action: 'remove',
            instruction: 'Remove the preamble; keep the clause after it.',
          },
        ],
      }),
    ),
  ) as Record<string, any>;
}

describe('parseReviewResultLenient: tolerates what 03 says may grow', () => {
  it('accepts a normal document unchanged', () => {
    const r = parseReviewResultLenient(base());
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual(base());
  });

  it('accepts raw JSON text as well as a parsed value', () => {
    expect(parseReviewResultLenient(JSON.stringify(base())).ok).toBe(true);
  });

  it('accepts an unknown skipped_reason that the strict producer validator rejects', () => {
    const doc = { ...base(), verdict: 'skipped', skipped_reason: 'rate_limited' };
    expect(ReviewResultSchema.safeParse(doc).success).toBe(false);
    const r = parseReviewResultLenient(doc);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.skipped_reason).toBe('rate_limited');
  });

  it('accepts an unknown Action and keeps instruction.text', () => {
    const doc = base();
    doc.findings[0].instruction = { action: 'quote_the_source', text: 'Quote the source verbatim.' };
    expect(ReviewResultSchema.safeParse(doc).success).toBe(false);
    const r = parseReviewResultLenient(doc);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.findings[0]?.instruction).toEqual({ action: 'quote_the_source', text: 'Quote the source verbatim.' });
    }
  });

  it('strips unknown optional fields at every level instead of rejecting them', () => {
    const doc = base();
    doc.future_field = { a: 1 };
    doc.findings[0].future_score = 0.5;
    doc.findings[0].span.future_line = 3;
    doc.findings[0].instruction.future_hint = 'x';
    doc.segments[0].future_label = 'x';
    doc.stats.future_stat = 1;
    doc.profile.future_meta = 'x';
    expect(ReviewResultSchema.safeParse(doc).success).toBe(false);
    const r = parseReviewResultLenient(doc);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual(base());
  });
});

describe('parseReviewResultLenient: still rejects', () => {
  it.each([
    'schema',
    'verdict',
    'profile',
    'pass',
    'segments',
    'findings',
    'cleared',
    'stats',
    'feedback_text',
  ])('a missing required top-level field: %s', (field) => {
    const doc = base();
    Reflect.deleteProperty(doc, field);
    const r = parseReviewResultLenient(doc);
    expect(r.ok).toBe(false);
  });

  it.each(['id', 'span', 'category', 'source', 'rule_id', 'severity', 'confidence', 'instruction', 'evidence', 'profile_origin'])(
    'a finding missing %s',
    (field) => {
      const doc = base();
      Reflect.deleteProperty(doc.findings[0], field);
      expect(parseReviewResultLenient(doc).ok).toBe(false);
    },
  );

  it('an instruction missing text or action', () => {
    const a = base();
    delete a.findings[0].instruction.text;
    expect(parseReviewResultLenient(a).ok).toBe(false);
    const b = base();
    delete b.findings[0].instruction.action;
    expect(parseReviewResultLenient(b).ok).toBe(false);
    const c = base();
    c.findings[0].instruction.action = '';
    expect(parseReviewResultLenient(c).ok).toBe(false);
  });

  it('a wrong schema id, including a future version', () => {
    for (const id of ['prosegate.findings/2', 'prosegate.findings/0', 'prosegate.review/1', '', 1]) {
      const r = parseReviewResultLenient({ ...base(), schema: id });
      expect(r.ok).toBe(false);
    }
  });

  it('unknown values of the enums whose growth bumps the version', () => {
    const cat = base();
    cat.findings[0].category = 'tone';
    expect(parseReviewResultLenient(cat).ok).toBe(false);
    const sev = base();
    sev.findings[0].severity = 'fatal';
    expect(parseReviewResultLenient(sev).ok).toBe(false);
    const verdict = base();
    verdict.verdict = 'maybe';
    expect(parseReviewResultLenient(verdict).ok).toBe(false);
    const kind = base();
    kind.segments[0].kind = 'image';
    expect(parseReviewResultLenient(kind).ok).toBe(false);
  });

  it('wrong field types and broken invariants', () => {
    const t = base();
    t.pass = '1';
    expect(parseReviewResultLenient(t).ok).toBe(false);
    const c = base();
    c.findings[0].confidence = 0.5; // rule finding must be 1
    expect(parseReviewResultLenient(c).ok).toBe(false);
  });

  it('invalid JSON text and non-objects, with an error message rather than a throw', () => {
    for (const bad of ['{not json', 'null', '42', '[]', undefined, null]) {
      const r = parseReviewResultLenient(bad);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.length).toBeGreaterThan(0);
    }
  });
});

describe('renderInstructionForConsumer', () => {
  it('renders instruction.text alone for an unknown action', () => {
    expect(renderInstructionForConsumer({ action: 'quote_the_source', text: 'Quote the source verbatim.' })).toBe(
      'Quote the source verbatim.',
    );
  });
  it('never leaks the action name for any known action either', () => {
    for (const action of ACTIONS) {
      expect(renderInstructionForConsumer({ action, text: 'T' })).toBe('T');
    }
  });
  it('isKnownAction distinguishes the two', () => {
    expect(isKnownAction('remove')).toBe(true);
    expect(isKnownAction('quote_the_source')).toBe(false);
  });
  it('feedback_text built from a lenient result with an unknown action shows the text, not the action', () => {
    const doc = base();
    doc.findings[0].instruction = { action: 'quote_the_source', text: 'Quote the source verbatim.' };
    const r = parseReviewResultLenient(doc);
    expect(r.ok).toBe(true);
    if (r.ok) {
      const text = renderFeedbackText(r.value);
      expect(text).toContain('→ Quote the source verbatim.');
      expect(text).not.toContain('quote_the_source');
    }
  });
});

// 03 "Versioning": adding an optional field, a skipped_reason or an Action does not bump the
// schema id; adding a Category, removing/renaming a field or changing offset semantics does.
describe('versioning rule (03)', () => {
  const ID = `prosegate.findings/${FINDINGS_SCHEMA_VERSION}`;

  it('the schema id constants are fixed at version 1', () => {
    expect(FINDINGS_SCHEMA_VERSION).toBe(1);
    const files = Object.fromEntries(generateJsonSchemas().map((f) => [f.file, JSON.parse(f.content)]));
    expect(files['prosegate.findings.1.json'].properties.schema.const).toBe('prosegate.findings/1');
    expect(files['prosegate.review.1.json'].properties.schema.const).toBe('prosegate.review/1');
    expect(ReviewRequestSchema.shape.schema.value).toBe('prosegate.review/1');
    expect(ReviewResultSchema.shape.schema.value).toBe(ID);
  });

  it('a producer one Action and one skipped_reason ahead still carries the same id and is still readable', () => {
    const future = base();
    future.verdict = 'skipped';
    future.skipped_reason = 'quota_exhausted'; // a hypothetical later skipped_reason
    future.findings[0].instruction.action = 'consolidate'; // a hypothetical later Action
    future.findings[0].new_optional = 'x'; // a hypothetical later optional field
    expect(future.schema).toBe(ID);
    const r = parseReviewResultLenient(future);
    expect(r.ok).toBe(true);
  });

  it('the same document with a bumped id is refused by the same consumer', () => {
    const future = base();
    future.skipped_reason = 'quota_exhausted';
    future.schema = 'prosegate.findings/2';
    expect(parseReviewResultLenient(future).ok).toBe(false);
  });

  it('tripwire: the version-bumping enums are pinned alongside version 1', () => {
    // Adding a Category bumps the version. If you add one, bump FINDINGS_SCHEMA_VERSION and the
    // schema id literals in schemas.ts and these pins together. Adding an Action or a
    // skipped_reason must NOT touch this test or the ids.
    expect(FINDINGS_SCHEMA_VERSION).toBe(1);
    expect([...CATEGORIES]).toEqual([
      'filler', 'hedge', 'vocab', 'triad', 'structure', 'repetition', 'vague_claim', 'unsupported_claim', 'register',
    ]);
    // These two lists may grow without a bump; asserting only that they are non-empty documents that.
    expect(ACTIONS.length).toBeGreaterThan(0);
    expect(SKIPPED_REASONS.length).toBeGreaterThan(0);
  });
});
