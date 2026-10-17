// Test support: builds ReviewResult fixtures that pass the strict validator. Pure (no Node APIs);
// not exported from index.ts.

import { findingId } from './finding-id.js';
import { ReviewResultSchema } from './schemas.js';
import type { Action, Category, Finding, ReviewResult, Severity } from './types.js';

export interface FixtureFinding {
  /** Exact substring of the text; located with indexOf (from `after` for repeated phrases). */
  span: string;
  category: Category;
  /** null makes this a reviewer finding. */
  ruleId: string | null;
  severity: Severity;
  action: Action;
  instruction: string;
  after?: number;
}

export interface FixtureOptions {
  text: string;
  profileId: string;
  pass?: 1 | 2;
  findings: FixtureFinding[];
  feedbackText?: string;
}

export function makeResult(opts: FixtureOptions): ReviewResult {
  const findings: Finding[] = opts.findings.map((f) => {
    const start = opts.text.indexOf(f.span, f.after ?? 0);
    if (start === -1) throw new Error(`fixture span not in text: ${f.span}`);
    const isRule = f.ruleId !== null;
    return {
      id: findingId(f.category, f.ruleId, f.span, 's1'),
      span: { segment_id: 's1', start, end: start + f.span.length, text: f.span },
      category: f.category,
      source: isRule ? 'rule' : 'reviewer',
      rule_id: f.ruleId,
      severity: f.severity,
      confidence: isRule ? 1 : 0.85,
      instruction: { action: f.action, text: f.instruction },
      evidence: isRule ? null : 'The turn gives no basis for this claim.',
      profile_origin: opts.profileId,
    };
  });
  findings.sort((a, b) => a.span.start - b.span.start);
  const byCategory: Partial<Record<Category, number>> = {};
  for (const f of findings) byCategory[f.category] = (byCategory[f.category] ?? 0) + 1;
  const result: ReviewResult = {
    schema: 'prosegate.findings/1',
    verdict: findings.some((f) => f.severity === 'block') ? 'revise' : 'pass',
    profile: { id: opts.profileId, version: '1', resolved_from: [opts.profileId] },
    pass: opts.pass ?? 1,
    segments: [{ id: 's1', kind: 'prose', start: 0, end: opts.text.length }],
    findings,
    cleared: [],
    stats: {
      prose_chars: opts.text.length,
      sentence_count: 2,
      findings_by_category: byCategory,
      rule_packs: [{ id: 'core', version: '1.0.0' }],
      reviewer: null,
      rules_latency_ms: 3,
    },
    feedback_text: opts.feedbackText ?? '',
  };
  return ReviewResultSchema.parse(result);
}
