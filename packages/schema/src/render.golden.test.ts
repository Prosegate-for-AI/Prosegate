// Golden tests for feedback_text (03 template) and the user notice (09 mock transcripts, ADR-12).
// Every expected string below is written out by hand from the spec, not produced by the renderer.
// Fixtures are built with makeResult(), which runs them through the strict ReviewResult validator.

import { describe, expect, it } from 'vitest';
import { makeResult, type FixtureFinding } from './fixtures.js';
import { renderFeedbackText, renderNotice, type NoticeContext } from './render.js';
import { ReviewResultSchema } from './schemas.js';
import { FORK_TEXT } from './types.js';
import type { ReviewResult } from './types.js';

const HEDGE_001 = 'Remove the preamble; keep the clause after it.'; // docs/08 core.hedge.001
const VOCAB_003 = 'Replace with the property that makes it so, or remove.'; // docs/08 core.vocab.003
const TRIAD_001 = 'Keep the one that matters, or give evidence for each.'; // docs/08 core.triad.001

const diff: NoticeContext = { mode: 'enforce', render: 'diff', firstNoticeOfSession: false, phase: 'pass1' };

const ALL_OUTPUTS: string[] = [];
function seen<T extends string | null>(s: T): T {
  if (s !== null) ALL_OUTPUTS.push(s);
  return s;
}

// ---- 09 mock 1 ------------------------------------------------------------------------------

const MOCK1_TEXT =
  "This PR introduces a robust caching layer that significantly improves performance. It's worth noting that the cache is per tenant, which makes the system fast, simple, and reliable.";

const MOCK1_FEEDBACK = [
  '[Prosegate] 3 findings against profile "local/pr-description" (pass 1/2). Revise your last response.',
  `1. vocab (core.vocab.003) — "robust" → ${VOCAB_003}`,
  `2. hedge (core.hedge.001) — "It's worth noting that" → ${HEDGE_001}`,
  `3. triad (core.triad.001) — "fast, simple, and reliable" → ${TRIAD_001}`,
  'Reply with the revised response only. Session override: prosegate advisory',
].join('\n');

const MOCK1_FINDINGS: FixtureFinding[] = [
  { span: 'robust', category: 'vocab', ruleId: 'core.vocab.003', severity: 'warn', action: 'specify', instruction: VOCAB_003 },
  { span: "It's worth noting that", category: 'hedge', ruleId: 'core.hedge.001', severity: 'block', action: 'remove', instruction: HEDGE_001 },
  { span: 'fast, simple, and reliable', category: 'triad', ruleId: 'core.triad.001', severity: 'warn', action: 'shorten', instruction: TRIAD_001 },
];

function mock1(): ReviewResult {
  return makeResult({ text: MOCK1_TEXT, profileId: 'local/pr-description', findings: MOCK1_FINDINGS, feedbackText: MOCK1_FEEDBACK });
}

describe('09 mock 1: interactive pass 1', () => {
  it('notice is byte-identical to the 09 transcript', () => {
    const expected = [
      'Prosegate · profile pr-description · 3 findings (hedge 1, vocab 1, triad 1) · revising, pass 1 of 2',
      '  hedge   core.hedge.001  "It\'s worth noting that"',
      '  vocab   core.vocab.003  "robust"',
      '  triad   core.triad.001  "fast, simple, and reliable"',
    ].join('\n');
    expect(seen(renderNotice(mock1(), diff))).toBe(expected);
  });

  it('feedback_text is the hand-written template in document order (robust, hedge, triad)', () => {
    const r = mock1();
    expect(r.feedback_text).toBe(MOCK1_FEEDBACK);
    expect(seen(renderFeedbackText(r))).toBe(MOCK1_FEEDBACK);
  });

  it('the fixture is a valid strict ReviewResult with matching spans', () => {
    expect(ReviewResultSchema.safeParse(mock1()).success).toBe(true);
    for (const f of mock1().findings) expect(MOCK1_TEXT.slice(f.span.start, f.span.end)).toBe(f.span.text);
  });

  it('has no trailing newline and no empty lines', () => {
    const t = renderFeedbackText(mock1());
    expect(t.endsWith('\n')).toBe(false);
    expect(t.split('\n')).toHaveLength(5);
    expect(t.split('\n').every((l) => l.length > 0)).toBe(true);
  });

  it('via_model inserts the notice instruction as the second-to-last line; the override line stays last', () => {
    const notice = 'Prosegate · profile pr-description · 3 findings (hedge 1, vocab 1, triad 1) · revising, pass 1 of 2';
    const expected = [
      ...MOCK1_FEEDBACK.split('\n').slice(0, 4),
      `Begin your revised response with this line, verbatim: ${notice}`,
      'Reply with the revised response only. Session override: prosegate advisory',
    ].join('\n');
    expect(seen(renderFeedbackText(mock1(), { noticeViaModel: notice }))).toBe(expected);
  });

  it('feedback_text lists findings in document order even when the array is not', () => {
    const r = mock1();
    r.findings.reverse();
    expect(renderFeedbackText(r)).toBe(MOCK1_FEEDBACK);
  });

  it('summary render is one line; the finding lines are the only difference from diff', () => {
    expect(seen(renderNotice(mock1(), { ...diff, render: 'summary' }))).toBe(
      'Prosegate · profile pr-description · 3 findings (hedge 1, vocab 1, triad 1) · revising, pass 1 of 2',
    );
  });
});

// ---- 09 mock 2 ------------------------------------------------------------------------------

const MOCK2_TEXT = 'The design reduces cost by 40%. It is the industry standard approach for this problem.';
const mock2Findings: FixtureFinding[] = [
  { span: 'reduces cost by 40%', category: 'unsupported_claim', ruleId: null, severity: 'block', action: 'cite_or_soften_or_remove', instruction: FORK_TEXT.unsupported_claim },
  { span: 'the industry standard approach', category: 'unsupported_claim', ruleId: null, severity: 'block', action: 'cite_or_soften_or_remove', instruction: FORK_TEXT.unsupported_claim },
];

describe('09 mock 2: pass cap reached', () => {
  const pass1 = () => makeResult({ text: MOCK2_TEXT, profileId: 'local/design-doc', findings: mock2Findings });

  it('pass 1 notice', () => {
    expect(seen(renderNotice(pass1(), diff))).toBe(
      [
        'Prosegate · profile design-doc · 2 findings (unsupported claim 2) · revising, pass 1 of 2',
        '  unsupported claim  "reduces cost by 40%"',
        '  unsupported claim  "the industry standard approach"',
      ].join('\n'),
    );
  });

  it('pass 1 feedback_text carries the 03 fork text and no rule ids', () => {
    expect(seen(renderFeedbackText(pass1()))).toBe(
      [
        '[Prosegate] 2 findings against profile "local/design-doc" (pass 1/2). Revise your last response.',
        `1. unsupported_claim — "reduces cost by 40%" → ${FORK_TEXT.unsupported_claim}`,
        `2. unsupported_claim — "the industry standard approach" → ${FORK_TEXT.unsupported_claim}`,
        'Reply with the revised response only. Session override: prosegate advisory',
      ].join('\n'),
    );
  });

  it('pass 2 with one survivor: "1 of 2 findings remain"', () => {
    const survivor = makeResult({ text: MOCK2_TEXT, profileId: 'local/design-doc', pass: 2, findings: [mock2Findings[1] as FixtureFinding] });
    const ctx: NoticeContext = { ...diff, phase: 'pass2', pass1BlockCount: 2 };
    expect(seen(renderNotice(survivor, ctx))).toBe('Prosegate · 1 of 2 findings remain · revising, pass 2 of 2');
    // pass 2 is a one-line summary whatever render says
    expect(renderNotice(survivor, { ...ctx, render: 'summary' })).toBe('Prosegate · 1 of 2 findings remain · revising, pass 2 of 2');
  });

  it('shipped with one remaining: "1 finding remains"', () => {
    const survivor = makeResult({ text: MOCK2_TEXT, profileId: 'local/design-doc', pass: 2, findings: [mock2Findings[1] as FixtureFinding] });
    expect(seen(renderNotice(survivor, { ...diff, phase: 'shipped' }))).toBe('Prosegate · 1 finding remains after 2 passes · shipped as is');
  });

  it('shipped with two remaining pluralises: "2 findings remain"', () => {
    const both = makeResult({ text: MOCK2_TEXT, profileId: 'local/design-doc', pass: 2, findings: mock2Findings });
    expect(seen(renderNotice(both, { ...diff, phase: 'shipped' }))).toBe('Prosegate · 2 findings remain after 2 passes · shipped as is');
  });

  it('"1 of 1 finding remains" agrees in number with the pass-1 block count', () => {
    const survivor = makeResult({ text: MOCK2_TEXT, profileId: 'local/design-doc', pass: 2, findings: [mock2Findings[0] as FixtureFinding] });
    expect(seen(renderNotice(survivor, { ...diff, phase: 'pass2', pass1BlockCount: 1 }))).toBe(
      'Prosegate · 1 of 1 finding remains · revising, pass 2 of 2',
    );
    expect(renderNotice(survivor, { ...diff, phase: 'pass2', pass1BlockCount: 3 })).toBe(
      'Prosegate · 1 of 3 findings remain · revising, pass 2 of 2',
    );
  });

  it('a zero-finding pass 2 and a zero-finding shipped result print nothing', () => {
    const none = makeResult({ text: MOCK2_TEXT, profileId: 'local/design-doc', pass: 2, findings: [] });
    expect(renderNotice(none, { ...diff, phase: 'pass2', pass1BlockCount: 2 })).toBeNull();
    expect(renderNotice(none, { ...diff, phase: 'shipped' })).toBeNull();
    expect(renderFeedbackText(none)).toBe('');
  });

  it('pass2 requires pass1BlockCount', () => {
    const survivor = makeResult({ text: MOCK2_TEXT, profileId: 'local/design-doc', pass: 2, findings: [mock2Findings[1] as FixtureFinding] });
    expect(() => renderNotice(survivor, { ...diff, phase: 'pass2' })).toThrow(/pass1BlockCount/);
    expect(() => renderNotice(survivor, { ...diff, phase: 'pass2', pass1BlockCount: 0 })).toThrow(/pass1BlockCount/);
  });

  it('pass-2 feedback_text renders block only and says pass 2/2', () => {
    const r = makeResult({
      text: MOCK1_TEXT,
      profileId: 'local/pr-description',
      pass: 2,
      findings: [
        ...MOCK1_FINDINGS,
        { span: 'significantly', category: 'vocab', ruleId: 'core.vocab.004', severity: 'info', action: 'remove', instruction: 'Remove the intensifier.' },
      ],
    });
    expect(renderFeedbackText(r)).toBe(
      [
        '[Prosegate] 1 finding against profile "local/pr-description" (pass 2/2). Revise your last response.',
        `1. hedge (core.hedge.001) — "It's worth noting that" → ${HEDGE_001}`,
        'Reply with the revised response only. Session override: prosegate advisory',
      ].join('\n'),
    );
  });
});

// ---- 09 mock 3 ------------------------------------------------------------------------------

describe('09 mock 3: advisory', () => {
  const text = 'Great question! Here is the summary. - one - two - three - four. The incident was a bad deploy.';
  const r = makeResult({
    text,
    profileId: 'local/chat-reply',
    findings: [
      { span: 'Great question!', category: 'filler', ruleId: 'core.filler.001', severity: 'block', action: 'remove', instruction: 'Remove. Start with the answer.' },
      { span: '- one - two - three - four.', category: 'structure', ruleId: 'core.structure.002', severity: 'warn', action: 'restructure', instruction: 'Rewrite as prose; keep a list only where the items are parallel.' },
    ],
  });
  const advisory: NoticeContext = { mode: 'advisory', render: 'summary', firstNoticeOfSession: false, phase: 'pass1' };

  it('one summary line, advisory tail, no finding lines', () => {
    expect(seen(renderNotice(r, advisory))).toBe(
      'Prosegate · profile chat-reply · 2 findings (filler 1, structure 1) · advisory, not enforced',
    );
  });

  it('advisory never lists finding lines or the override line, even when asked for diff and first notice', () => {
    expect(renderNotice(r, { ...advisory, render: 'diff', firstNoticeOfSession: true })).toBe(
      'Prosegate · profile chat-reply · 2 findings (filler 1, structure 1) · advisory, not enforced',
    );
  });
});

// ---- other cases ----------------------------------------------------------------------------

const WORDS = 'alpha bravo charlie delta echo foxtrot golf hotel india';
const EIGHT: FixtureFinding[] = [
  { span: 'alpha', category: 'vocab', ruleId: 'core.vocab.003', severity: 'warn', action: 'specify', instruction: 'i-alpha' },
  { span: 'bravo', category: 'triad', ruleId: 'core.triad.001', severity: 'warn', action: 'shorten', instruction: 'i-bravo' },
  { span: 'charlie', category: 'hedge', ruleId: 'core.hedge.001', severity: 'block', action: 'remove', instruction: 'i-charlie' },
  { span: 'delta', category: 'filler', ruleId: 'core.filler.001', severity: 'block', action: 'remove', instruction: 'i-delta' },
  { span: 'echo', category: 'vocab', ruleId: 'core.vocab.003', severity: 'warn', action: 'specify', instruction: 'i-echo' },
  { span: 'foxtrot', category: 'repetition', ruleId: 'core.repetition.001', severity: 'warn', action: 'merge', instruction: 'i-foxtrot' },
  { span: 'golf', category: 'structure', ruleId: 'core.structure.001', severity: 'warn', action: 'restructure', instruction: 'i-golf' },
  { span: 'hotel', category: 'hedge', ruleId: 'core.hedge.002', severity: 'warn', action: 'specify', instruction: 'i-hotel' },
];
const eight = (n = 8) => makeResult({ text: WORDS, profileId: 'org-default/chat-reply', findings: EIGHT.slice(0, n) });

describe('noise budget and first notice (ADR-12)', () => {
  it('8 findings: the notice line counts all 8 and lists exactly 6 lines, in Category then document order', () => {
    const out = seen(renderNotice(eight(), diff));
    expect(out).toBe(
      [
        'Prosegate · profile chat-reply · 8 findings (filler 1, hedge 2, vocab 2, triad 1, structure 1, repetition 1) · revising, pass 1 of 2',
        '  filler  core.filler.001  "delta"',
        '  hedge   core.hedge.001   "charlie"',
        '  hedge   core.hedge.002   "hotel"',
        '  vocab   core.vocab.003   "alpha"',
        '  vocab   core.vocab.003   "echo"',
        '  triad   core.triad.001   "bravo"',
      ].join('\n'),
    );
    expect(out?.split('\n')).toHaveLength(7); // the notice line + six finding lines
  });

  it('first notice of a session: 5 finding lines then the override line (7 lines)', () => {
    const out = seen(renderNotice(eight(), { ...diff, firstNoticeOfSession: true }));
    expect(out).toBe(
      [
        'Prosegate · profile chat-reply · 8 findings (filler 1, hedge 2, vocab 2, triad 1, structure 1, repetition 1) · revising, pass 1 of 2',
        '  filler  core.filler.001  "delta"',
        '  hedge   core.hedge.001   "charlie"',
        '  hedge   core.hedge.002   "hotel"',
        '  vocab   core.vocab.003   "alpha"',
        '  vocab   core.vocab.003   "echo"',
        '  Session override: prosegate advisory',
      ].join('\n'),
    );
    expect(out?.split('\n')).toHaveLength(7);
  });

  it('first notice with exactly 5 findings lists all 5', () => {
    const out = renderNotice(eight(5), { ...diff, firstNoticeOfSession: true });
    expect(out?.split('\n')).toHaveLength(7);
    expect(out?.split('\n').slice(1, 6).join('|')).toBe(
      [
        '  filler  core.filler.001  "delta"',
        '  hedge   core.hedge.001   "charlie"',
        '  vocab   core.vocab.003   "alpha"',
        '  vocab   core.vocab.003   "echo"',
        '  triad   core.triad.001   "bravo"',
      ].join('|'),
    );
    expect(out?.endsWith('\n  Session override: prosegate advisory')).toBe(true);
  });

  it('first notice with fewer findings lists them all, then the override line', () => {
    expect(seen(renderNotice(eight(2), { ...diff, firstNoticeOfSession: true }))).toBe(
      [
        'Prosegate · profile chat-reply · 2 findings (vocab 1, triad 1) · revising, pass 1 of 2',
        '  vocab   core.vocab.003  "alpha"',
        '  triad   core.triad.001  "bravo"',
        '  Session override: prosegate advisory',
      ].join('\n'),
    );
  });

  it('first notice in summary render appends the override line to the single notice line', () => {
    expect(renderNotice(eight(2), { ...diff, render: 'summary', firstNoticeOfSession: true })).toBe(
      [
        'Prosegate · profile chat-reply · 2 findings (vocab 1, triad 1) · revising, pass 1 of 2',
        '  Session override: prosegate advisory',
      ].join('\n'),
    );
  });

  it('the feedback_text header counts all 8 and lists all 8 (no six-line cap for the model)', () => {
    const t = renderFeedbackText(eight());
    expect(t.split('\n')).toHaveLength(10);
    expect(t.split('\n')[0]).toBe('[Prosegate] 8 findings against profile "org-default/chat-reply" (pass 1/2). Revise your last response.');
  });
});

describe('info, severity and pass filtering', () => {
  const text = 'robust and seamless and crucial';
  const mixed = (pass: 1 | 2) =>
    makeResult({
      text,
      profileId: 'local/chat-reply',
      pass,
      findings: [
        { span: 'robust', category: 'vocab', ruleId: 'core.vocab.003', severity: 'info', action: 'specify', instruction: 'i-robust' },
        { span: 'seamless', category: 'vocab', ruleId: 'core.vocab.003', severity: 'warn', action: 'specify', instruction: 'i-seamless' },
        { span: 'crucial', category: 'hedge', ruleId: 'core.hedge.001', severity: 'block', action: 'remove', instruction: 'i-crucial' },
      ],
    });

  it('info is excluded from notice lines and counts', () => {
    expect(seen(renderNotice(mixed(1), diff))).toBe(
      [
        'Prosegate · profile chat-reply · 2 findings (hedge 1, vocab 1) · revising, pass 1 of 2',
        '  hedge   core.hedge.001  "crucial"',
        '  vocab   core.vocab.003  "seamless"',
      ].join('\n'),
    );
  });

  it('info is excluded from feedback_text; pass 1 keeps warn, pass 2 drops it', () => {
    const p1 = renderFeedbackText(mixed(1));
    expect(p1).toContain('seamless');
    expect(p1).toContain('crucial');
    expect(p1).not.toContain('"robust"');
    expect(p1.split('\n')[0]).toContain('2 findings');
    const p2 = renderFeedbackText(mixed(2));
    expect(p2).not.toContain('seamless');
    expect(p2).not.toContain('"robust"');
    expect(p2.split('\n')[0]).toBe('[Prosegate] 1 finding against profile "local/chat-reply" (pass 2/2). Revise your last response.');
  });

  it('only-info results render nothing', () => {
    const only = makeResult({
      text,
      profileId: 'local/chat-reply',
      findings: [{ span: 'robust', category: 'vocab', ruleId: 'core.vocab.003', severity: 'info', action: 'specify', instruction: 'x' }],
    });
    expect(renderNotice(only, diff)).toBeNull();
    expect(renderFeedbackText(only)).toBe('');
  });

  it('pass-1 warn-only results still render (pass 1 shows block and warn)', () => {
    const warnOnly = makeResult({
      text,
      profileId: 'local/chat-reply',
      findings: [{ span: 'seamless', category: 'vocab', ruleId: 'core.vocab.003', severity: 'warn', action: 'specify', instruction: 'x' }],
    });
    expect(renderNotice(warnOnly, diff)).not.toBeNull();
    expect(renderFeedbackText(warnOnly)).toContain('1. vocab');
  });
});

describe('suppression', () => {
  it('quiet, off and render none return null even with findings', () => {
    expect(renderNotice(mock1(), { ...diff, mode: 'quiet' })).toBeNull();
    expect(renderNotice(mock1(), { ...diff, mode: 'off' })).toBeNull();
    expect(renderNotice(mock1(), { ...diff, render: 'none' })).toBeNull();
  });
  it('a zero-finding pass 1 returns null and an empty feedback_text', () => {
    const none = makeResult({ text: MOCK1_TEXT, profileId: 'local/pr-description', findings: [] });
    expect(renderNotice(none, diff)).toBeNull();
    expect(renderFeedbackText(none)).toBe('');
  });
  it('quiet does not suppress feedback_text (the model is still continued)', () => {
    expect(renderFeedbackText(mock1())).not.toBe('');
  });
});

describe('mixed rule and reviewer findings', () => {
  const text = "It's worth noting that the change reduces cost by 40%.";
  const r = makeResult({
    text,
    profileId: 'org-default/design-doc',
    findings: [
      { span: "It's worth noting that", category: 'hedge', ruleId: 'core.hedge.001', severity: 'block', action: 'remove', instruction: HEDGE_001 },
      { span: 'reduces cost by 40%', category: 'unsupported_claim', ruleId: null, severity: 'block', action: 'cite_or_soften_or_remove', instruction: FORK_TEXT.unsupported_claim },
    ],
  });

  it('the rule-id column is blank for the reviewer finding and the spans stay aligned', () => {
    const label = 19; // "unsupported claim" (17) + 2
    const idCol = 16; // "core.hedge.001" (14) + 2
    const expected = [
      'Prosegate · profile design-doc · 2 findings (hedge 1, unsupported claim 1) · revising, pass 1 of 2',
      `  ${'hedge'.padEnd(label)}${'core.hedge.001'.padEnd(idCol)}"It's worth noting that"`,
      `  ${'unsupported claim'.padEnd(label)}${''.padEnd(idCol)}"reduces cost by 40%"`,
    ].join('\n');
    expect(seen(renderNotice(r, diff))).toBe(expected);
    // and the literal widths, so the helper arithmetic above is itself checked
    expect(expected.split('\n')[1]?.indexOf('"')).toBe(2 + label + idCol);
    expect(expected.split('\n')[2]?.indexOf('"')).toBe(2 + label + idCol);
  });

  it('feedback_text prints the rule id only for rule findings', () => {
    const lines = renderFeedbackText(r).split('\n');
    expect(lines[1]).toBe(`1. hedge (core.hedge.001) — "It's worth noting that" → ${HEDGE_001}`);
    expect(lines[2]).toBe(`2. unsupported_claim — "reduces cost by 40%" → ${FORK_TEXT.unsupported_claim}`);
  });
});

describe('trimming counts code points and never splits a surrogate pair', () => {
  const noLoneSurrogates = (s: string) =>
    Array.from(s).every((cp) => cp.length === 2 || cp.charCodeAt(0) < 0xd800 || cp.charCodeAt(0) > 0xdfff);

  function single(span: string) {
    return makeResult({
      text: `${span} end`,
      profileId: 'local/chat-reply',
      findings: [{ span, category: 'vocab', ruleId: 'core.vocab.003', severity: 'warn', action: 'specify', instruction: 'x' }],
    });
  }
  const spanLine = (notice: string | null) => notice?.split('\n')[1] ?? '';

  it('notice: 60 code points pass unchanged, 61 become 59 + an ellipsis', () => {
    expect(spanLine(renderNotice(single('a'.repeat(60)), diff))).toBe(`  vocab   core.vocab.003  "${'a'.repeat(60)}"`);
    expect(spanLine(renderNotice(single('a'.repeat(61)), diff))).toBe(`  vocab   core.vocab.003  "${'a'.repeat(59)}…"`);
  });

  it('notice: an astral character at the cut point is kept whole', () => {
    const span = `${'a'.repeat(58)}\u{1d4b3}tail of the span`; // code point 59 is the astral one
    const line = spanLine(renderNotice(single(span), diff));
    expect(line).toBe(`  vocab   core.vocab.003  "${'a'.repeat(58)}\u{1d4b3}…"`);
    expect(noLoneSurrogates(line)).toBe(true);
  });

  it('notice: an astral character just past the cut point is dropped, not half-kept', () => {
    const span = `${'a'.repeat(59)}\u{1f600}tail`; // code point 60 is the emoji: it falls in the dropped part
    const line = spanLine(renderNotice(single(span), diff));
    expect(line).toBe(`  vocab   core.vocab.003  "${'a'.repeat(59)}…"`);
    expect(noLoneSurrogates(line)).toBe(true);
  });

  it('notice: 60 astral characters are 60 code points (120 code units) and are not trimmed', () => {
    const span = '\u{1d4b3}'.repeat(60);
    expect(span.length).toBe(120);
    expect(spanLine(renderNotice(single(span), diff))).toBe(`  vocab   core.vocab.003  "${span}"`);
  });

  it('feedback_text: 80 code points pass, 81 trim to 79 + an ellipsis, astral at the cut stays whole', () => {
    const prefix = '1. vocab (core.vocab.003) — "';
    const suffix = '" → x';
    expect(renderFeedbackText(single('b'.repeat(80))).split('\n')[1]).toBe(`${prefix}${'b'.repeat(80)}${suffix}`);
    expect(renderFeedbackText(single('b'.repeat(81))).split('\n')[1]).toBe(`${prefix}${'b'.repeat(79)}…${suffix}`);
    const astral = `${'b'.repeat(78)}\u{1f600}more words here`;
    const line = renderFeedbackText(single(astral)).split('\n')[1] ?? '';
    expect(line).toBe(`${prefix}${'b'.repeat(78)}\u{1f600}…${suffix}`);
    expect(noLoneSurrogates(line)).toBe(true);
  });
});

describe('line integrity', () => {
  it('collapses line breaks inside a span or an instruction so each finding stays on one line', () => {
    const text = 'first line\nsecond line';
    const r = makeResult({
      text,
      profileId: 'local/chat-reply',
      findings: [{ span: 'first line\nsecond line', category: 'vocab', ruleId: 'core.vocab.003', severity: 'warn', action: 'specify', instruction: 'Do this.\nThen that.' }],
    });
    expect(renderNotice(r, diff)?.split('\n')).toHaveLength(2);
    expect(renderFeedbackText(r).split('\n')[1]).toBe('1. vocab (core.vocab.003) — "first line second line" → Do this. Then that.');
  });
});

describe('profile naming', () => {
  it('the notice uses the slug after the last "/", feedback_text the full id; a bare id is its own slug', () => {
    const r = makeResult({ text: WORDS, profileId: 'alpha-org/team/pr-description', findings: EIGHT.slice(0, 1) });
    expect(renderNotice(r, { ...diff, render: 'summary' })).toContain('profile pr-description ·');
    expect(renderFeedbackText(r)).toContain('against profile "alpha-org/team/pr-description"');
    const bare = makeResult({ text: WORDS, profileId: 'default', findings: EIGHT.slice(0, 1) });
    expect(renderNotice(bare, { ...diff, render: 'summary' })).toContain('profile default ·');
  });
});

describe('every rendered string (09 noise budget)', () => {
  it('contains no ANSI escape, no carriage return and no emoji; only the three expected non-ASCII marks', () => {
    expect(ALL_OUTPUTS.length).toBeGreaterThan(15);
    for (const s of ALL_OUTPUTS) {
      expect(s.includes(String.fromCharCode(27))).toBe(false);
      expect(s).not.toContain('\r');
      expect(s).not.toMatch(/\p{Extended_Pictographic}/u);
      expect(s.endsWith('\n')).toBe(false);
      // allowed non-ASCII: middle dot, em dash, right arrow (and the ellipsis from trimming, which the
      // trimming tests exercise separately and are not collected here)
      expect(s.replace(/[·—→]/g, '')).toMatch(/^[\x20-\x7e\n]*$/);
    }
  });
});
