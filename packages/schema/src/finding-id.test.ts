import { describe, expect, it } from 'vitest';
import { findingId } from './finding-id.js';

// Expected values were computed independently of the implementation with node:crypto:
//   createHash('sha256').update(Buffer.from([category, ruleId ?? '', spanText, segmentId].join('|'), 'utf8'))
//     .digest('hex').slice(0, 10)
// and pasted here. They are not produced by findingId.
const VECTORS: Array<{ name: string; args: Parameters<typeof findingId>; hex: string }> = [
  { name: 'rule finding', args: ['vocab', 'core.vocab.003', 'robust', 's1'], hex: 'd381b3db5f' },
  { name: 'apostrophe in span', args: ['hedge', 'core.hedge.001', "It's worth noting that", 's1'], hex: '2550fdd520' },
  { name: 'comma span', args: ['triad', 'core.triad.001', 'fast, simple, and reliable', 's1'], hex: '0fa466c57c' },
  { name: 'null rule id (reviewer)', args: ['unsupported_claim', null, 'reduces cost by 40%', 's1'], hex: '8834f8fedf' },
  { name: 'null rule id, other segment', args: ['vague_claim', null, 'the industry standard approach', 's2'], hex: '86bc8068ed' },
  {
    name: 'non-ASCII span (em dash, accent, astral, CJK)',
    args: ['vocab', 'core.vocab.003', 'a robust — café \u{1d4b3} 漢字', 's1'],
    hex: 'ac5eba8c9e',
  },
  { name: 'empty span, null rule id, two-digit segment', args: ['register', null, '', 's10'], hex: '66e20bd290' },
  { name: 'org pack rule id', args: ['filler', 'org-default.filler.012', 'Great question!', 's3'], hex: '2953e31a10' },
];

describe('findingId', () => {
  it.each(VECTORS)('matches the independently computed hash: $name', ({ args, hex }) => {
    expect(findingId(...args)).toBe(hex);
  });

  it('is 10 lowercase hex characters', () => {
    for (const { args } of VECTORS) expect(findingId(...args)).toMatch(/^[0-9a-f]{10}$/);
  });

  it('renders a null rule id as the empty string, not the word null', () => {
    // The preimage for a null rule id is "register||text|s1"; a literal "null" would hash differently.
    expect(findingId('register', null, 'x', 's1')).not.toBe(findingId('register', 'null', 'x', 's1'));
    expect(findingId('register', null, 'x', 's1')).toBe(findingId('register', '', 'x', 's1'));
  });

  it('changes when any one input changes', () => {
    const base = findingId('vocab', 'core.vocab.003', 'robust', 's1');
    expect(findingId('hedge', 'core.vocab.003', 'robust', 's1')).not.toBe(base);
    expect(findingId('vocab', 'core.vocab.004', 'robust', 's1')).not.toBe(base);
    expect(findingId('vocab', 'core.vocab.003', 'Robust', 's1')).not.toBe(base);
    expect(findingId('vocab', 'core.vocab.003', 'robust', 's2')).not.toBe(base);
  });

  it('is deterministic', () => {
    expect(findingId('vocab', 'core.vocab.003', 'robust', 's1')).toBe(findingId('vocab', 'core.vocab.003', 'robust', 's1'));
  });
});
