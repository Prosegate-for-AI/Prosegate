// Pins the normative constants in types.ts against literal copies of docs/03 Findings schema.md.
// The golden render tests do not import FORK_TEXT, so a drift here is caught twice. If you change
// 03, change the literal here by hand; do not import the constant under test.

import { describe, expect, it } from 'vitest';
import {
  ACTIONS,
  CATEGORIES,
  DEFAULT_SEVERITY,
  DEFAULT_THRESHOLDS,
  FINDINGS_SCHEMA_VERSION,
  FORK_TEXT,
  REVIEWER_CATEGORIES,
  RULE_CATEGORIES,
  SKIPPED_REASONS,
} from './types.js';

describe('types.ts constants equal 03', () => {
  it('FORK_TEXT: the two mandatory instruction forks, character for character', () => {
    expect(FORK_TEXT).toEqual({
      unsupported_claim: 'Cite a source you actually have, restate this as expectation or opinion, or remove it. Do not invent a citation.',
      vague_claim: 'Give the specific detail the question asked for (the number, the file, the name). If you do not have it, say so in one clause instead of generalising.',
    });
  });

  it('DEFAULT_SEVERITY: the 03 Categories table', () => {
    expect(DEFAULT_SEVERITY).toEqual({
      filler: 'block',
      hedge: 'block',
      vocab: 'warn',
      triad: 'warn',
      structure: 'warn',
      repetition: 'warn',
      vague_claim: 'block',
      unsupported_claim: 'block',
      register: 'warn',
    });
  });

  it('DEFAULT_THRESHOLDS: 60-word token floor, 150-word reviewer floor', () => {
    expect(DEFAULT_THRESHOLDS).toEqual({ token_floor_words: 60, reviewer_floor_words: 150 });
  });

  it('ACTIONS and SKIPPED_REASONS: the 03 lists, in order', () => {
    expect([...ACTIONS]).toEqual(['remove', 'replace', 'shorten', 'specify', 'merge', 'restructure', 'rephrase', 'cite_or_soften_or_remove']);
    expect([...SKIPPED_REASONS]).toEqual(['below_floor', 'no_prose', 'advisory_mode', 'pass_cap', 'reviewer_unavailable']);
  });

  it('CATEGORIES, and the split into rule and reviewer categories', () => {
    expect([...CATEGORIES]).toEqual(['filler', 'hedge', 'vocab', 'triad', 'structure', 'repetition', 'vague_claim', 'unsupported_claim', 'register']);
    expect([...RULE_CATEGORIES]).toEqual(['filler', 'hedge', 'vocab', 'triad', 'structure', 'repetition']);
    expect([...REVIEWER_CATEGORIES]).toEqual(['vague_claim', 'unsupported_claim', 'register']);
  });

  it('FINDINGS_SCHEMA_VERSION is the integer 1', () => {
    expect(FINDINGS_SCHEMA_VERSION).toBe(1);
  });
});
