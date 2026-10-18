// prosegate.findings/1 and prosegate.review/1 — transcribed verbatim from docs/03 Findings schema.md.
// This file is the normative TypeScript form. Do not change a field here without following 03 "Versioning".

export interface ReviewRequest {
  schema: 'prosegate.review/1';
  text: string; // the whole candidate turn, as the harness holds it
  context: {
    user_message: string; // last user message, trimmed to 2,000 chars
    style_constraints: string; // system-prompt / CLAUDE.md style lines, trimmed to 1,500 chars; '' if none
    mode: 'interactive' | 'headless';
  };
  profile_id: string; // resolved profile (04), e.g. 'org-default/pr-description'
  pass: 1 | 2;
  stages: Array<'rules' | 'reviewer'>; // reviewer omitted when no key, below floor, or disabled by profile
  session_id: string;
  turn_id: string;
  prior_findings: string[]; // finding ids reported on pass 1; empty on pass 1
}

export interface ReviewResult {
  schema: 'prosegate.findings/1';
  verdict: 'pass' | 'revise' | 'skipped';
  skipped_reason?: SkippedReason;
  profile: { id: string; version: string; resolved_from: string[] }; // inheritance chain, base first
  pass: 1 | 2;
  segments: Segment[]; // how the text was partitioned; only kind 'prose' is linted
  findings: Finding[]; // sorted by span.start; non-overlapping after resolution
  cleared: string[]; // pass 2 only: pass-1 finding ids no longer present
  stats: ReviewStats;
  feedback_text: string; // rendered per the template; what dumb shims hand the model
}

export type SkippedReason = 'below_floor' | 'no_prose' | 'advisory_mode' | 'pass_cap' | 'reviewer_unavailable';

export type SegmentKind = 'prose' | 'code' | 'table' | 'tool_output' | 'quote';

export interface Segment {
  id: string; // 's1', 's2', …
  kind: SegmentKind;
  start: number;
  end: number; // UTF-16 code-unit offsets into ReviewRequest.text, end exclusive
}

export interface Finding {
  id: string; // first 10 hex of sha256(category|rule_id|span_key): span_key = span.text, or '' for document-metric findings; rule_id null → ''; stable across passes and position-independent; not unique within a result (ADR-17, ADR-23)
  span: { segment_id: string; start: number; end: number; text: string }; // text must equal the slice; consumers drop mismatches
  category: Category;
  source: 'rule' | 'reviewer';
  rule_id: string | null; // '<pack>.<category>.<nnn>' for rules; null for reviewer
  severity: Severity;
  confidence: number; // 1.0 for rules; reviewer-supplied in [0,1]
  instruction: { action: Action; text: string };
  evidence: string | null; // reviewer's one-line reason; null for rules
  profile_origin: string; // profile id whose config enabled or set severity for this finding
  scope?: 'span' | 'document'; // default 'span'; 'document' for document_metric findings, which are exempt from overlap resolution (ADR-24)
}

export type Severity = 'block' | 'warn' | 'info';

export interface ReviewStats {
  prose_chars: number;
  sentence_count: number;
  findings_by_category: Partial<Record<Category, number>>;
  rule_packs: Array<{ id: string; version: string }>; // every pack the resolved profile pinned
  reviewer: { model: string; latency_ms: number; input_tokens: number; output_tokens: number } | null;
  rules_latency_ms: number;
}

export type Category =
  | 'filler' | 'hedge' | 'vocab' | 'triad' | 'structure' | 'repetition' // deterministic
  | 'vague_claim' | 'unsupported_claim' | 'register'; // reviewer

export type Action =
  | 'remove' | 'replace' | 'shorten' | 'specify' | 'merge' | 'restructure' | 'rephrase'
  | 'cite_or_soften_or_remove';

export const CATEGORIES = [
  'filler', 'hedge', 'vocab', 'triad', 'structure', 'repetition',
  'vague_claim', 'unsupported_claim', 'register',
] as const satisfies readonly Category[];

export const RULE_CATEGORIES = ['filler', 'hedge', 'vocab', 'triad', 'structure', 'repetition'] as const satisfies readonly Category[];
export const REVIEWER_CATEGORIES = ['vague_claim', 'unsupported_claim', 'register'] as const satisfies readonly Category[];

export const ACTIONS = [
  'remove', 'replace', 'shorten', 'specify', 'merge', 'restructure', 'rephrase', 'cite_or_soften_or_remove',
] as const satisfies readonly Action[];

export const SKIPPED_REASONS = [
  'below_floor', 'no_prose', 'advisory_mode', 'pass_cap', 'reviewer_unavailable',
] as const satisfies readonly SkippedReason[];

// 03 "Categories" default severities.
export const DEFAULT_SEVERITY: Record<Category, Severity> = {
  filler: 'block', hedge: 'block', vocab: 'warn', triad: 'warn', structure: 'warn', repetition: 'warn',
  vague_claim: 'block', unsupported_claim: 'block', register: 'warn',
};

// 03 "Instruction forks": exact text.
export const FORK_TEXT = {
  unsupported_claim: 'Cite a source you actually have, restate this as expectation or opinion, or remove it. Do not invent a citation.',
  vague_claim: 'Give the specific detail the question asked for (the number, the file, the name). If you do not have it, say so in one clause instead of generalising.',
} as const;

// 03 "Thresholds" defaults.
export const DEFAULT_THRESHOLDS = { token_floor_words: 60, reviewer_floor_words: 150 } as const;

export const FINDINGS_SCHEMA_VERSION = 1;
