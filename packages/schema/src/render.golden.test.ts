// Golden tests for feedback_text (03 template, ADR-16) and the user notice (09 mock transcripts,
// ADR-12, ADR-16). Every expected string below is written out by hand from the spec, not produced
// by the renderer, and the fork texts are literal copies of 03 (see constants.test.ts), not
// imports. Fixtures are built with makeResult(), which runs them through the strict validator.

import { describe, expect, it } from 'vitest';
import { makeRawResult, makeResult, type FixtureFinding } from './fixtures.js';
import { renderFeedbackText, renderNotice, trimSpan, type NoticeContext } from './render.js';
import { ReviewResultSchema } from './schemas.js';
import type { ReviewResult } from './types.js';

const HEDGE_001 = 'Remove the preamble; keep the clause after it.'; // docs/08 core.hedge.001
const VOCAB_003 = 'Replace with the property that makes it so, or remove.'; // docs/08 core.vocab.003
const TRIAD_001 = 'Keep the one that matters, or give evidence for each.'; // docs/08 core.triad.001
const UNSUPPORTED_FORK =
  'Cite a source you actually have, restate this as expectation or opinion, or remove it. Do not invent a citation.'; // docs/03

const diff: NoticeContext = { mode: 'enforce', render: 'diff', firstNoticeOfSession: false, phase: 'pass1' };

const ALL_OUTPUTS: string[] = [];
function seen<T extends string | null>(s: T): T {
  if (s !== null) ALL_OUTPUTS.push(s);
  return s;
}

const LAST_LINES = [
  'Reply with the revised response only. Do not run prosegate commands.',
  'To pause these revisions for this session, the user can run: prosegate advisory',
];

// ---- 09 mock 1 ------------------------------------------------------------------------------

const MOCK1_TEXT =
  "This PR introduces a robust caching layer that significantly improves performance. It's worth noting that the cache is per tenant, which makes the system fast, simple, and reliable.";

const MOCK1_FEEDBACK = [
  '[Prosegate] 3 findings against profile "local/pr-description" (pass 1 of 2). Revise your last response.',
  `1. vocab (core.vocab.003) \u2014 "robust" \u2192 ${VOCAB_003}`,
  `2. hedge (core.hedge.001) \u2014 "It's worth noting that" \u2192 ${HEDGE_001}`,
  `3. triad (core.triad.001) \u2014 "fast, simple, and reliable" \u2192 ${TRIAD_001}`,
  ...LAST_LINES,
].join('\n');

const MOCK1_FINDINGS: FixtureFinding[] = [
  { span: 'robust', category: 'vocab', ruleId: 'core.vocab.003', severity: 'warn', action: 'specify', instruction: VOCAB_003 },
  { span: "It's worth noting that", category: 'hedge', ruleId: 'core.hedge.001', severity: 'block', action: 'remove', instruction: HEDGE_001 },
  { span: 'fast, simple, and reliable', category: 'triad', ruleId: 'core.triad.001', severity: 'warn', action: 'shorten', instruction: TRIAD_001 },
];

function mock1(): ReviewResult {
  return makeResult({ text: MOCK1_TEXT, profileId: 'local/pr-description', findings: MOCK1_FINDINGS });
}

const MOCK1_NOTICE_LINE = 'Prosegate \u00b7 profile pr-description \u00b7 3 findings (hedge 1, vocab 1, triad 1) \u00b7 revising, pass 1 of 2';

describe('09 mock 1: interactive pass 1', () => {
  it('notice is byte-identical to the 09 transcript', () => {
    const expected = [
      MOCK1_NOTICE_LINE,
      '  hedge   core.hedge.001  "It\'s worth noting that"',
      '  vocab   core.vocab.003  "robust"',
      '  triad   core.triad.001  "fast, simple, and reliable"',
    ].join('\n');
    expect(seen(renderNotice(mock1(), diff))).toBe(expected);
  });

  it('feedback_text is the hand-written ADR-16 template in document order (robust, hedge, triad)', () => {
    expect(seen(renderFeedbackText(mock1()))).toBe(MOCK1_FEEDBACK);
  });

  it('the fixture carries that same text in its feedback_text field and is a valid strict result', () => {
    expect(mock1().feedback_text).toBe(MOCK1_FEEDBACK);
    expect(ReviewResultSchema.safeParse(mock1()).success).toBe(true);
    for (const f of mock1().findings) expect(MOCK1_TEXT.slice(f.span.start, f.span.end)).toBe(f.span.text);
  });

  it('has no trailing newline, no empty lines, and ends with the two ADR-16 lines', () => {
    const lines = renderFeedbackText(mock1()).split('\n');
    expect(lines).toHaveLength(6);
    expect(lines.every((l) => l.length > 0)).toBe(true);
    expect(lines.slice(-2)).toEqual(LAST_LINES);
    expect(renderFeedbackText(mock1()).endsWith('\n')).toBe(false);
  });

  it('via_model inserts the notice instruction before the two closing lines, which stay last', () => {
    const expected = [
      ...MOCK1_FEEDBACK.split('\n').slice(0, 4),
      `Begin your revised response with this line, verbatim: ${MOCK1_NOTICE_LINE}`,
      ...LAST_LINES,
    ].join('\n');
    expect(seen(renderFeedbackText(mock1(), { noticeViaModel: MOCK1_NOTICE_LINE }))).toBe(expected);
  });

  it('feedback_text lists findings in document order even when the array is not', () => {
    const r = mock1();
    r.findings.reverse();
    expect(renderFeedbackText(r)).toBe(MOCK1_FEEDBACK);
  });

  it('the notice order does not depend on the order of the input array (R20c)', () => {
    const r = mock1();
    r.findings.reverse();
    expect(renderNotice(r, diff)).toBe(renderNotice(mock1(), diff));
  });

  it('summary render is the notice line alone', () => {
    expect(seen(renderNotice(mock1(), { ...diff, render: 'summary' }))).toBe(MOCK1_NOTICE_LINE);
  });
});

// ---- 09 mock 2 ------------------------------------------------------------------------------

const MOCK2_TEXT = 'The design reduces cost by 40%. It is the industry standard approach for this problem.';
const mock2Findings: FixtureFinding[] = [
  { span: 'reduces cost by 40%', category: 'unsupported_claim', ruleId: null, severity: 'block', action: 'cite_or_soften_or_remove', instruction: UNSUPPORTED_FORK },
  { span: 'the industry standard approach', category: 'unsupported_claim', ruleId: null, severity: 'block', action: 'cite_or_soften_or_remove', instruction: UNSUPPORTED_FORK },
];
const mock2 = (pass: 1 | 2, findings: FixtureFinding[]) => makeResult({ text: MOCK2_TEXT, profileId: 'local/design-doc', pass, findings });

describe('09 mock 2: pass cap reached', () => {
  it('pass 1 notice', () => {
    expect(seen(renderNotice(mock2(1, mock2Findings), diff))).toBe(
      [
        'Prosegate \u00b7 profile design-doc \u00b7 2 findings (unsupported claim 2) \u00b7 revising, pass 1 of 2',
        '  unsupported claim  "reduces cost by 40%"',
        '  unsupported claim  "the industry standard approach"',
      ].join('\n'),
    );
  });

  it('pass 1 feedback_text prints the fork once and refers back to it', () => {
    expect(seen(renderFeedbackText(mock2(1, mock2Findings)))).toBe(
      [
        '[Prosegate] 2 findings against profile "local/design-doc" (pass 1 of 2). Revise your last response.',
        `1. unsupported claim \u2014 "reduces cost by 40%" \u2192 ${UNSUPPORTED_FORK}`,
        '2. unsupported claim \u2014 "the industry standard approach" \u2192 same as 1.',
        ...LAST_LINES,
      ].join('\n'),
    );
  });

  it('pass 2 with one survivor: "1 of 2 findings remain" (the pass-2 summary is one line whatever render says)', () => {
    const survivor = mock2(2, [mock2Findings[1] as FixtureFinding]);
    const ctx: NoticeContext = { ...diff, phase: 'pass2', pass1BlockCount: 2 };
    expect(seen(renderNotice(survivor, ctx))).toBe('Prosegate \u00b7 1 of 2 findings remain \u00b7 revising, pass 2 of 2');
    expect(renderNotice(survivor, { ...ctx, render: 'summary' })).toBe('Prosegate \u00b7 1 of 2 findings remain \u00b7 revising, pass 2 of 2');
  });

  it('pass-2 feedback_text uses the pass-2 header', () => {
    expect(seen(renderFeedbackText(mock2(2, [mock2Findings[1] as FixtureFinding])))).toBe(
      [
        '[Prosegate] 1 finding remains after your revision, against profile "local/design-doc" (pass 2 of 2). Revise your last response.',
        `1. unsupported claim \u2014 "the industry standard approach" \u2192 ${UNSUPPORTED_FORK}`,
        ...LAST_LINES,
      ].join('\n'),
    );
    expect(renderFeedbackText(mock2(2, mock2Findings)).split('\n')[0]).toBe(
      '[Prosegate] 2 findings remain after your revision, against profile "local/design-doc" (pass 2 of 2). Revise your last response.',
    );
  });

  it('shipped with one remaining: the 09 line, then the finding', () => {
    expect(seen(renderNotice(mock2(2, [mock2Findings[1] as FixtureFinding]), { ...diff, phase: 'shipped' }))).toBe(
      ['Prosegate \u00b7 1 finding remains after 2 passes \u00b7 shipped as is', '  unsupported claim  "the industry standard approach"'].join('\n'),
    );
  });

  it('shipped with one remaining in summary render is the 09 line alone', () => {
    expect(renderNotice(mock2(2, [mock2Findings[1] as FixtureFinding]), { ...diff, render: 'summary', phase: 'shipped' })).toBe(
      'Prosegate \u00b7 1 finding remains after 2 passes \u00b7 shipped as is',
    );
  });

  it('shipped with two remaining pluralises: "2 findings remain"', () => {
    expect(seen(renderNotice(mock2(2, mock2Findings), { ...diff, phase: 'shipped' }))).toBe(
      [
        'Prosegate \u00b7 2 findings remain after 2 passes \u00b7 shipped as is',
        '  unsupported claim  "reduces cost by 40%"',
        '  unsupported claim  "the industry standard approach"',
      ].join('\n'),
    );
  });

  it('"1 of 1" collapses to "1 finding remains"; "k of n" with k = n collapses to "k findings remain"', () => {
    const one = mock2(2, [mock2Findings[0] as FixtureFinding]);
    expect(seen(renderNotice(one, { ...diff, phase: 'pass2', pass1BlockCount: 1 }))).toBe('Prosegate \u00b7 1 finding remains \u00b7 revising, pass 2 of 2');
    expect(renderNotice(one, { ...diff, phase: 'pass2', pass1BlockCount: 3 })).toBe('Prosegate \u00b7 1 of 3 findings remain \u00b7 revising, pass 2 of 2');
    expect(renderNotice(mock2(2, mock2Findings), { ...diff, phase: 'pass2', pass1BlockCount: 2 })).toBe(
      'Prosegate \u00b7 2 findings remain \u00b7 revising, pass 2 of 2',
    );
  });

  it('pass2 without pass1BlockCount degrades to the collapsed form instead of throwing', () => {
    expect(renderNotice(mock2(2, mock2Findings), { ...diff, phase: 'pass2' })).toBe('Prosegate \u00b7 2 findings remain \u00b7 revising, pass 2 of 2');
  });

  it('pass2 rejects a pass1BlockCount that is not a positive integer', () => {
    const survivor = mock2(2, [mock2Findings[1] as FixtureFinding]);
    for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => renderNotice(survivor, { ...diff, phase: 'pass2', pass1BlockCount: bad })).toThrow(/pass1BlockCount/);
    }
  });

  it('a zero-finding pass 2 and a zero-finding shipped result print nothing', () => {
    const none = mock2(2, []);
    expect(renderNotice(none, { ...diff, phase: 'pass2', pass1BlockCount: 2 })).toBeNull();
    expect(renderNotice(none, { ...diff, phase: 'shipped' })).toBeNull();
    expect(renderFeedbackText(none)).toBe('');
  });

  it('pass 2 and shipped count block findings only: warn and info in the fixture are ignored (R43-R47)', () => {
    const r = makeResult({
      text: MOCK1_TEXT,
      profileId: 'local/pr-description',
      pass: 2,
      findings: [
        ...MOCK1_FINDINGS,
        { span: 'significantly', category: 'vocab', ruleId: 'core.vocab.004', severity: 'info', action: 'remove', instruction: 'Remove the intensifier.' },
      ],
    });
    expect(renderNotice(r, { ...diff, phase: 'pass2', pass1BlockCount: 4 })).toBe('Prosegate \u00b7 1 of 4 findings remain \u00b7 revising, pass 2 of 2');
    expect(renderNotice(r, { ...diff, phase: 'shipped' })).toBe(
      ['Prosegate \u00b7 1 finding remains after 2 passes \u00b7 shipped as is', '  hedge   core.hedge.001  "It\'s worth noting that"'].join('\n'),
    );
    const warnOnly = makeResult({ text: MOCK1_TEXT, profileId: 'local/pr-description', pass: 2, findings: [MOCK1_FINDINGS[0] as FixtureFinding] });
    expect(renderNotice(warnOnly, { ...diff, phase: 'pass2', pass1BlockCount: 1 })).toBeNull();
    expect(renderNotice(warnOnly, { ...diff, phase: 'shipped' })).toBeNull();
  });

  it('pass-2 feedback_text renders block only', () => {
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
        '[Prosegate] 1 finding remains after your revision, against profile "local/pr-description" (pass 2 of 2). Revise your last response.',
        `1. hedge (core.hedge.001) \u2014 "It's worth noting that" \u2192 ${HEDGE_001}`,
        ...LAST_LINES,
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
    verdict: 'skipped',
    findings: [
      { span: 'Great question!', category: 'filler', ruleId: 'core.filler.001', severity: 'block', action: 'remove', instruction: 'Remove. Start with the answer.' },
      { span: '- one - two - three - four.', category: 'structure', ruleId: 'core.structure.002', severity: 'warn', action: 'restructure', instruction: 'Rewrite as prose; keep a list only where the items are parallel.' },
    ],
  });
  const advisory: NoticeContext = { mode: 'advisory', render: 'diff', firstNoticeOfSession: false, phase: 'pass1' };
  const LINE = 'Prosegate \u00b7 profile chat-reply \u00b7 2 findings (filler 1, structure 1) \u00b7 advisory, not enforced';

  it('the 09 line, then the findings (interactive advisory)', () => {
    expect(seen(renderNotice(r, advisory))).toBe(
      [
        LINE,
        '  filler     core.filler.001     "Great question!"',
        '  structure  core.structure.002  "- one - two - three - four."',
      ].join('\n'),
    );
  });

  it('summary render is the 09 line alone', () => {
    expect(seen(renderNotice(r, { ...advisory, render: 'summary' }))).toBe(LINE);
  });

  it('never adds the override line, even on a first notice', () => {
    expect(renderNotice(r, { ...advisory, render: 'summary', firstNoticeOfSession: true })).toBe(LINE);
    expect(renderNotice(r, { ...advisory, firstNoticeOfSession: true })?.includes('To pause for this session')).toBe(false);
  });

  it('render none wins over advisory', () => {
    expect(renderNotice(r, { ...advisory, render: 'none' })).toBeNull();
  });

  it('advisory shows a warn-only turn (the model is not continued, the user still sees it)', () => {
    const warnOnly = makeResult({
      text,
      profileId: 'local/chat-reply',
      verdict: 'skipped',
      findings: [{ span: '- one - two - three - four.', category: 'structure', ruleId: 'core.structure.002', severity: 'warn', action: 'restructure', instruction: 'x' }],
    });
    expect(renderNotice(warnOnly, advisory)).not.toBeNull();
  });
});

// ---- overflow, first notice and block-first selection (ADR-12, ADR-16) -----------------------

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
const eight = (n = 8, over: Partial<FixtureFinding>[] = []) =>
  makeResult({
    text: WORDS,
    profileId: 'org-default/chat-reply',
    verdict: 'revise',
    findings: EIGHT.slice(0, n).map((f, i) => ({ ...f, ...(over[i] ?? {}) })),
  });
const HEAD8 = 'Prosegate \u00b7 profile chat-reply \u00b7 8 findings (filler 1, hedge 2, vocab 2, triad 1, structure 1, repetition 1) \u00b7 revising, pass 1 of 2';

describe('noise budget (ADR-12, ADR-16)', () => {
  it('exactly 6 findings are all listed, with no marker', () => {
    expect(seen(renderNotice(eight(6), diff))).toBe(
      [
        'Prosegate \u00b7 profile chat-reply \u00b7 6 findings (filler 1, hedge 1, vocab 2, triad 1, repetition 1) \u00b7 revising, pass 1 of 2',
        '  filler      core.filler.001      "delta"',
        '  hedge       core.hedge.001       "charlie"',
        '  vocab       core.vocab.003       "alpha"',
        '  vocab       core.vocab.003       "echo"',
        '  triad       core.triad.001       "bravo"',
        '  repetition  core.repetition.001  "foxtrot"',
      ].join('\n'),
    );
  });

  it('7 findings: five listed and "+2 more" in the sixth slot', () => {
    const out = seen(renderNotice(eight(7), diff));
    expect(out?.split('\n')).toHaveLength(7);
    expect(out?.split('\n').slice(-1)[0]).toBe('  +2 more');
  });

  it('8 findings: the notice line counts all 8, lists five and "+3 more", chosen block first then in Category order', () => {
    expect(seen(renderNotice(eight(), diff))).toBe(
      [
        HEAD8,
        '  filler  core.filler.001  "delta"',
        '  hedge   core.hedge.001   "charlie"',
        '  hedge   core.hedge.002   "hotel"',
        '  vocab   core.vocab.003   "alpha"',
        '  vocab   core.vocab.003   "echo"',
        '  +3 more',
      ].join('\n'),
    );
  });

  it('overflow picks block findings before warn findings even when they sit late in Category order', () => {
    const blocks = eight(8, [{}, {}, { severity: 'warn' }, { severity: 'warn' }, {}, { severity: 'block' }, { severity: 'block' }, {}]);
    expect(seen(renderNotice(blocks, diff))).toBe(
      [
        HEAD8,
        '  filler      core.filler.001      "delta"',
        '  hedge       core.hedge.001       "charlie"',
        '  hedge       core.hedge.002       "hotel"',
        '  structure   core.structure.001   "golf"',
        '  repetition  core.repetition.001  "foxtrot"',
        '  +3 more',
      ].join('\n'),
    );
  });

  it('first notice of a session with 5 findings: all five, then the override line', () => {
    expect(seen(renderNotice(eight(5), { ...diff, firstNoticeOfSession: true }))).toBe(
      [
        'Prosegate \u00b7 profile chat-reply \u00b7 5 findings (filler 1, hedge 1, vocab 2, triad 1) \u00b7 revising, pass 1 of 2',
        '  filler  core.filler.001  "delta"',
        '  hedge   core.hedge.001   "charlie"',
        '  vocab   core.vocab.003   "alpha"',
        '  vocab   core.vocab.003   "echo"',
        '  triad   core.triad.001   "bravo"',
        '  To pause for this session, run: prosegate advisory',
      ].join('\n'),
    );
  });

  it('first notice with 6 or more: four findings, "+k more", then the override line (still 7 lines)', () => {
    const out = seen(renderNotice(eight(), { ...diff, firstNoticeOfSession: true }));
    expect(out).toBe(
      [
        HEAD8,
        '  filler  core.filler.001  "delta"',
        '  hedge   core.hedge.001   "charlie"',
        '  hedge   core.hedge.002   "hotel"',
        '  vocab   core.vocab.003   "alpha"',
        '  +4 more',
        '  To pause for this session, run: prosegate advisory',
      ].join('\n'),
    );
    expect(out?.split('\n')).toHaveLength(7);
    expect(renderNotice(eight(6), { ...diff, firstNoticeOfSession: true })?.split('\n').slice(-2)).toEqual(['  +2 more', '  To pause for this session, run: prosegate advisory']);
  });

  it('first notice with fewer findings lists them all, then the override line', () => {
    expect(seen(renderNotice(eight(2), { ...diff, firstNoticeOfSession: true }))).toBe(
      [
        'Prosegate \u00b7 profile chat-reply \u00b7 2 findings (vocab 1, triad 1) \u00b7 revising, pass 1 of 2',
        '  vocab   core.vocab.003  "alpha"',
        '  triad   core.triad.001  "bravo"',
        '  To pause for this session, run: prosegate advisory',
      ].join('\n'),
    );
  });

  it('first notice in summary render appends the override line to the single notice line', () => {
    expect(renderNotice(eight(2), { ...diff, render: 'summary', firstNoticeOfSession: true })).toBe(
      ['Prosegate \u00b7 profile chat-reply \u00b7 2 findings (vocab 1, triad 1) \u00b7 revising, pass 1 of 2', '  To pause for this session, run: prosegate advisory'].join('\n'),
    );
  });

  it('the override line is never added to pass 2 or shipped notices', () => {
    const survivor = mock2(2, [mock2Findings[1] as FixtureFinding]);
    expect(renderNotice(survivor, { ...diff, firstNoticeOfSession: true, phase: 'pass2', pass1BlockCount: 2 })?.includes('To pause for this session')).toBe(false);
    expect(renderNotice(survivor, { ...diff, firstNoticeOfSession: true, phase: 'shipped' })?.includes('To pause for this session')).toBe(false);
  });

  it('shipped and advisory notices follow the same six-slot budget', () => {
    const many = eight();
    const shipped = renderNotice(many, { ...diff, phase: 'shipped' });
    expect(shipped?.split('\n')[0]).toBe('Prosegate \u00b7 2 findings remain after 2 passes \u00b7 shipped as is');
    const adv = renderNotice(many, { ...diff, mode: 'advisory' });
    expect(adv?.split('\n')).toHaveLength(7);
    expect(adv?.split('\n').slice(-1)[0]).toBe('  +3 more');
  });

  it('the feedback_text lists all 8 (no cap for the model), repeating no instruction', () => {
    const t = renderFeedbackText(eight());
    expect(t.split('\n')).toHaveLength(11);
    expect(t.split('\n')[0]).toBe('[Prosegate] 8 findings against profile "org-default/chat-reply" (pass 1 of 2). Revise your last response.');
  });
});

describe('repeated instructions in feedback_text (ADR-16)', () => {
  it('a repeated instruction refers back to its first occurrence, not the latest', () => {
    const r = makeResult({
      text: 'robust seamless crucial pivotal',
      profileId: 'local/chat-reply',
      findings: ['robust', 'seamless', 'crucial', 'pivotal'].map((span, i) => ({
        span,
        category: 'vocab' as const,
        ruleId: 'core.vocab.003',
        severity: 'warn' as const,
        action: 'specify' as const,
        instruction: i === 2 ? 'A different instruction.' : VOCAB_003,
      })),
    });
    expect(renderFeedbackText(r).split('\n').slice(1, 5)).toEqual([
      `1. vocab (core.vocab.003) \u2014 "robust" \u2192 ${VOCAB_003}`,
      '2. vocab (core.vocab.003) \u2014 "seamless" \u2192 same as 1.',
      '3. vocab (core.vocab.003) \u2014 "crucial" \u2192 A different instruction.',
      '4. vocab (core.vocab.003) \u2014 "pivotal" \u2192 same as 1.',
    ]);
  });

  it('same-as numbering follows document order, not the input array order', () => {
    const r = eight(2, [{ instruction: 'same' }, { instruction: 'same' }]);
    r.findings.reverse();
    expect(renderFeedbackText(r).split('\n')[2]).toContain('same as 1.');
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
        'Prosegate \u00b7 profile chat-reply \u00b7 2 findings (hedge 1, vocab 1) \u00b7 revising, pass 1 of 2',
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
    expect(p2.split('\n')[0]).toBe('[Prosegate] 1 finding remains after your revision, against profile "local/chat-reply" (pass 2 of 2). Revise your last response.');
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

  it('09 silence: an enforce pass-1 turn that passes (warn only) shows no notice, though feedback_text can still be rendered', () => {
    const warnOnly = makeResult({
      text,
      profileId: 'local/chat-reply',
      findings: [{ span: 'seamless', category: 'vocab', ruleId: 'core.vocab.003', severity: 'warn', action: 'specify', instruction: 'x' }],
    });
    expect(warnOnly.verdict).toBe('pass');
    expect(renderNotice(warnOnly, diff)).toBeNull();
    expect(renderNotice(warnOnly, { ...diff, render: 'summary' })).toBeNull();
    expect(renderFeedbackText(warnOnly)).toContain('1. vocab');
  });

  it('a result without a verdict field is not silenced (the verdict is optional input)', () => {
    const warnOnly = makeResult({
      text,
      profileId: 'local/chat-reply',
      findings: [{ span: 'seamless', category: 'vocab', ruleId: 'core.vocab.003', severity: 'warn', action: 'specify', instruction: 'x' }],
    });
    const withoutVerdict: Record<string, unknown> = { ...warnOnly };
    Reflect.deleteProperty(withoutVerdict, 'verdict');
    expect(renderNotice(withoutVerdict as unknown as ReviewResult, diff)).not.toBeNull();
  });
});

describe('suppression', () => {
  it('quiet, off and render none return null on every phase, even with findings (R83-R86)', () => {
    const survivor = mock2(2, [mock2Findings[1] as FixtureFinding]);
    const phases: Array<Partial<NoticeContext>> = [{ phase: 'pass1' }, { phase: 'pass2', pass1BlockCount: 2 }, { phase: 'shipped' }];
    for (const p of phases) {
      for (const over of [{ mode: 'quiet' as const }, { mode: 'off' as const }, { render: 'none' as const }]) {
        expect(renderNotice(survivor, { ...diff, ...p, ...over })).toBeNull();
        expect(renderNotice(mock1(), { ...diff, ...p, ...over })).toBeNull();
      }
    }
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
      { span: 'reduces cost by 40%', category: 'unsupported_claim', ruleId: null, severity: 'block', action: 'cite_or_soften_or_remove', instruction: UNSUPPORTED_FORK },
    ],
  });

  it('the rule-id column is blank for the reviewer finding and the spans stay aligned', () => {
    expect(seen(renderNotice(r, diff))).toBe(
      [
        'Prosegate \u00b7 profile design-doc \u00b7 2 findings (hedge 1, unsupported claim 1) \u00b7 revising, pass 1 of 2',
        '  hedge              core.hedge.001  "It\'s worth noting that"',
        '  unsupported claim                  "reduces cost by 40%"',
      ].join('\n'),
    );
  });

  it('feedback_text prints the rule id only for rule findings, and labels with spaces', () => {
    const lines = renderFeedbackText(r).split('\n');
    expect(lines[1]).toBe(`1. hedge (core.hedge.001) \u2014 "It's worth noting that" \u2192 ${HEDGE_001}`);
    expect(lines[2]).toBe(`2. unsupported claim \u2014 "reduces cost by 40%" \u2192 ${UNSUPPORTED_FORK}`);
  });
});

describe('trimming counts code points, never splits a surrogate pair, and prefers a word boundary (ADR-16)', () => {
  const noLoneSurrogates = (s: string) =>
    Array.from(s).every((cp) => cp.length === 2 || cp.charCodeAt(0) < 0xd800 || cp.charCodeAt(0) > 0xdfff);

  function single(span: string) {
    return makeResult({
      text: `${span} end`,
      profileId: 'local/chat-reply',
      verdict: 'revise',
      findings: [{ span, category: 'vocab', ruleId: 'core.vocab.003', severity: 'warn', action: 'specify', instruction: 'x' }],
    });
  }
  const PRE = '  vocab   core.vocab.003  ';
  const noticeSpan = (span: string, ctx: NoticeContext = { ...diff }) => renderNotice(single(span), ctx)?.split('\n')[1] ?? '';
  const feedbackSpan = (span: string) => renderFeedbackText(single(span)).split('\n')[1] ?? '';

  it('notice: 60 code points pass unchanged, 61 become 59 plus an ellipsis outside the quotes', () => {
    expect(noticeSpan('a'.repeat(60))).toBe(`${PRE}"${'a'.repeat(60)}"`);
    expect(noticeSpan('a'.repeat(61))).toBe(`${PRE}"${'a'.repeat(59)}"\u2026`);
  });

  it('notice: an astral character at the cut point is kept whole', () => {
    const line = noticeSpan(`${'a'.repeat(58)}\u{1d4b3}tail of the span`);
    expect(line).toBe(`${PRE}"${'a'.repeat(58)}\u{1d4b3}"\u2026`);
    expect(noLoneSurrogates(line)).toBe(true);
  });

  it('notice: an astral character just past the cut point is dropped, not half-kept', () => {
    const line = noticeSpan(`${'a'.repeat(59)}\u{1f600}tail`);
    expect(line).toBe(`${PRE}"${'a'.repeat(59)}"\u2026`);
    expect(noLoneSurrogates(line)).toBe(true);
  });

  it('notice: 60 astral characters are 60 code points (120 code units) and are not trimmed', () => {
    const span = '\u{1d4b3}'.repeat(60);
    expect(span.length).toBe(120);
    expect(noticeSpan(span)).toBe(`${PRE}"${span}"`);
  });

  it('cuts back to the last space when it falls within the final 15 characters, and not otherwise', () => {
    // kept = first 59 code points. A space at index 44 leaves 15 characters after it: cut back.
    expect(noticeSpan(`${'a'.repeat(44)} ${'b'.repeat(30)}`)).toBe(`${PRE}"${'a'.repeat(44)}"\u2026`);
    // A space at index 43 leaves 16: no cut-back, the ellipsis follows the 59th code point.
    expect(noticeSpan(`${'a'.repeat(43)} ${'b'.repeat(30)}`)).toBe(`${PRE}"${'a'.repeat(43)} ${'b'.repeat(15)}"\u2026`);
  });

  it('a space at index 0 is not used as the cut point', () => {
    expect(trimSpan(` ${'b'.repeat(70)}`, 60)).toEqual({ text: ` ${'b'.repeat(58)}`, trimmed: true });
  });

  it('feedback_text: 80 code points pass, 81 trim to 79, the ellipsis outside the quotes, same word rule', () => {
    const pre = '1. vocab (core.vocab.003) \u2014 ';
    expect(feedbackSpan('b'.repeat(80))).toBe(`${pre}"${'b'.repeat(80)}" \u2192 x`);
    expect(feedbackSpan('b'.repeat(81))).toBe(`${pre}"${'b'.repeat(79)}"\u2026 \u2192 x`);
    const astral = feedbackSpan(`${'b'.repeat(78)}\u{1f600}more words here`);
    expect(astral).toBe(`${pre}"${'b'.repeat(78)}\u{1f600}"\u2026 \u2192 x`);
    expect(noLoneSurrogates(astral)).toBe(true);
    expect(feedbackSpan(`${'c'.repeat(60)} ${'d'.repeat(40)}`)).toBe(`${pre}"${'c'.repeat(60)} ${'d'.repeat(18)}"\u2026 \u2192 x`);
    expect(feedbackSpan(`${'c'.repeat(70)} ${'d'.repeat(40)}`)).toBe(`${pre}"${'c'.repeat(70)}"\u2026 \u2192 x`);
  });

  it('line breaks at the trim boundary collapse before counting (a \n b, \r\n)', () => {
    expect(noticeSpan('a \n b')).toBe(`${PRE}"a b"`);
    // 58 a, CRLF, tail: sanitised to 58 a + one space + tail (63 code points), cut back to the space.
    expect(noticeSpan(`${'a'.repeat(58)}\r\ntail`)).toBe(`${PRE}"${'a'.repeat(58)}"\u2026`);
    // exactly 60 after collapsing: not trimmed
    expect(noticeSpan(`${'a'.repeat(58)}\r\nb`)).toBe(`${PRE}"${'a'.repeat(58)} b"`);
  });

  it('feedback_text collapses line breaks in spans and instructions so each finding stays on one line', () => {
    const text = 'first line\nsecond line';
    // Raw: the strict validator refuses a line break in the instruction; the renderer collapses it anyway.
    const r = makeRawResult({
      text,
      profileId: 'local/chat-reply',
      verdict: 'revise',
      findings: [{ span: 'first line\nsecond line', category: 'vocab', ruleId: 'core.vocab.003', severity: 'warn', action: 'specify', instruction: 'Do this.\nThen that.' }],
    });
    expect(renderNotice(r, diff)?.split('\n')).toHaveLength(2);
    expect(renderFeedbackText(r).split('\n')[1]).toBe('1. vocab (core.vocab.003) \u2014 "first line second line" \u2192 Do this. Then that.');
  });

  it('the instruction is hard-capped at 200 code points as printed', () => {
    // the strict validator refuses this instruction, but the renderer must hold the line on its own
    const r = eight(1);
    (r.findings[0] as { instruction: { text: string } }).instruction.text = 'q'.repeat(300);
    expect(renderFeedbackText(r).split('\n')[1]).toBe(`1. vocab (core.vocab.003) \u2014 "alpha" \u2192 ${'q'.repeat(199)}\u2026`);
    const exact = eight(1, [{ instruction: 'q'.repeat(200) }]);
    expect(renderFeedbackText(exact).split('\n')[1]).toBe(`1. vocab (core.vocab.003) \u2014 "alpha" \u2192 ${'q'.repeat(200)}`);
  });
});

describe('profile naming', () => {
  it('the notice uses the slug after the last "/", feedback_text the full id', () => {
    const r = makeResult({ text: WORDS, profileId: 'org-default/team-doc', findings: EIGHT.slice(2, 3) });
    expect(renderNotice(r, { ...diff, render: 'summary' })).toContain('profile team-doc \u00b7');
    expect(renderFeedbackText(r)).toContain('against profile "org-default/team-doc"');
  });
});

describe('every rendered string (09 noise budget)', () => {
  it('contains no ANSI escape, no carriage return and no emoji; only the expected non-ASCII marks', () => {
    expect(ALL_OUTPUTS.length).toBeGreaterThan(20);
    for (const s of ALL_OUTPUTS) {
      expect(s.includes(String.fromCharCode(27))).toBe(false);
      expect(s).not.toContain('\r');
      expect(s).not.toMatch(/\p{Extended_Pictographic}/u);
      expect(s.endsWith('\n')).toBe(false);
      expect(s.replace(/[\u00b7\u2014\u2192]/g, '')).toMatch(/^[\x20-\x7e\n]*$/);
    }
  });
});
