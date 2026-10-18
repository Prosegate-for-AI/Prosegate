import { describe, expect, it } from 'vitest';
import { findingId } from './finding-id.js';

// Expected values were computed independently of the implementation with node:crypto (ADR-23):
//   createHash('sha256').update(Buffer.from([category, ruleId ?? '', spanKey].join('|'), 'utf8'))
//     .digest('hex').slice(0, 10)
// and pasted here. They are not produced by findingId.
const VECTORS: Array<{ name: string; args: Parameters<typeof findingId>; hex: string }> = [
  { name: 'rule finding', args: ['vocab', 'core.vocab.003', 'robust'], hex: '1b7afa2ecf' },
  { name: 'apostrophe in span', args: ['hedge', 'core.hedge.001', "It's worth noting that"], hex: 'e71a122db4' },
  { name: 'comma span', args: ['triad', 'core.triad.001', 'fast, simple, and reliable'], hex: '090c6d016f' },
  { name: 'null rule id (reviewer)', args: ['unsupported_claim', null, 'reduces cost by 40%'], hex: 'c1f7c5e5a9' },
  { name: 'null rule id, other claim', args: ['vague_claim', null, 'the industry standard approach'], hex: '37a346eb84' },
  {
    name: 'non-ASCII span (em dash, accent, astral, CJK)',
    args: ['vocab', 'core.vocab.003', 'a robust — café \u{1d4b3} 漢字'],
    hex: 'aad8dc4d2c',
  },
  { name: 'document-scope finding: empty span key', args: ['structure', 'core.structure.004', ''], hex: '59a90fbfef' },
  { name: 'empty span key, null rule id', args: ['register', null, ''], hex: '10c3444087' },
  { name: 'org pack rule id', args: ['filler', 'org-default.filler.012', 'Great question!'], hex: '6637b5dd77' },
  { name: 'leading/trailing whitespace and a newline are hashed verbatim', args: ['filler', 'core.filler.001', '  Great question!\n'], hex: '66bdcbb1bb' },
  { name: 'same span without the whitespace', args: ['filler', 'core.filler.001', 'Great question!'], hex: '7769b4aba2' },
  { name: 'span containing a pipe', args: ['vocab', 'core.vocab.003', 'a|b'], hex: '49d8918aea' },
  { name: 'CRLF inside a span', args: ['hedge', 'core.hedge.001', 'line one\r\nline two'], hex: '8ce01ffcb0' },
];

describe('findingId', () => {
  it.each(VECTORS)('matches the independently computed hash: $name', ({ args, hex }) => {
    expect(findingId(...args)).toBe(hex);
  });

  it('is 10 lowercase hex characters', () => {
    for (const { args } of VECTORS) expect(findingId(...args)).toMatch(/^[0-9a-f]{10}$/);
  });

  it('takes no segment: the id is the same wherever the span sits (ADR-23)', () => {
    expect(findingId.length).toBe(3);
  });

  it('renders a null rule id as the empty string, not the word null', () => {
    expect(findingId('register', null, 'x')).not.toBe(findingId('register', 'null', 'x'));
    expect(findingId('register', null, 'x')).toBe(findingId('register', '', 'x'));
  });

  it('changes when any one input changes', () => {
    const base = findingId('vocab', 'core.vocab.003', 'robust');
    expect(findingId('hedge', 'core.vocab.003', 'robust')).not.toBe(base);
    expect(findingId('vocab', 'core.vocab.004', 'robust')).not.toBe(base);
    expect(findingId('vocab', 'core.vocab.003', 'Robust')).not.toBe(base);
  });

  it('documented limitation: fields are joined with an unescaped pipe, so a pipe in a field can collide', () => {
    // sha256("vocab|core.vocab.003|x|y") for both. 03 defines the preimage this way; see finding-id.ts.
    expect(findingId('vocab', 'core.vocab.003', 'x|y')).toBe('2785b90b3d');
    expect(findingId('vocab', 'core.vocab.003|x', 'y')).toBe('2785b90b3d');
  });

  it('is deterministic', () => {
    expect(findingId('vocab', 'core.vocab.003', 'robust')).toBe(findingId('vocab', 'core.vocab.003', 'robust'));
  });
});
