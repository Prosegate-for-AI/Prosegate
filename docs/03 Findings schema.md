# 03 — Findings schema

## Purpose and scope

The findings schema is the one contract shared by the rule engine, the reviewer client, the hook shim, the MCP tool and the UI. Every consumer reads `prosegate.findings/1`; nothing else in the system agrees on text positions, categories or what the model is told to do. Change it only by the versioning rules at the end.

The normative form is the TypeScript below. JSON Schema is generated from it at build time and shipped with the adapter.

## Review request

A review is a pure function of the request. The adapter builds the request from session state; the `review_prose` MCP tool accepts only `text` and an optional `profile_id` and fills the rest.

```typescript
export interface ReviewRequest {
  schema: 'prosegate.review/1';
  text: string;                     // the whole candidate turn, as the harness holds it
  context: {
    user_message: string;           // last user message, trimmed to 2,000 chars
    style_constraints: string;      // system-prompt / CLAUDE.md style lines, trimmed to 1,500 chars; '' if none
    mode: 'interactive' | 'headless';
  };
  profile_id: string;               // resolved profile (04), e.g. 'org-default/pr-description'
  pass: 1 | 2;
  stages: Array<'rules' | 'reviewer'>;  // reviewer omitted when no key, below floor, or disabled by profile
  session_id: string;
  turn_id: string;
  prior_findings: string[];         // finding ids reported on pass 1; empty on pass 1
}
```

## Review result

```typescript
export interface ReviewResult {
  schema: 'prosegate.findings/1';
  verdict: 'pass' | 'revise' | 'skipped';
  skipped_reason?: 'below_floor' | 'no_prose' | 'advisory_mode' | 'pass_cap' | 'reviewer_unavailable';
  profile: { id: string; version: string; resolved_from: string[] };  // inheritance chain, base first
  pass: 1 | 2;
  segments: Segment[];              // how the text was partitioned; only kind 'prose' is linted
  findings: Finding[];              // sorted by span.start; non-overlapping after resolution
  cleared: string[];                // pass 2 only: pass-1 finding ids no longer present
  stats: ReviewStats;
  feedback_text: string;            // rendered per the template below; what dumb shims hand the model
}

export interface Segment {
  id: string;                       // 's1', 's2', …
  kind: 'prose' | 'code' | 'table' | 'tool_output' | 'quote';
  start: number; end: number;       // UTF-16 code-unit offsets into ReviewRequest.text, end exclusive
}

export interface Finding {
  id: string;                       // first 10 hex of sha256(category|rule_id|span_key): span_key = span.text, or '' for document-metric findings; rule_id null → ''; stable across passes and position-independent; not unique within a result (ADR-17, ADR-23)
  span: { segment_id: string; start: number; end: number; text: string };  // text must equal the slice; consumers drop mismatches
  category: Category;
  source: 'rule' | 'reviewer';
  rule_id: string | null;           // '<pack>.<category>.<nnn>' for rules; null for reviewer
  severity: 'block' | 'warn' | 'info';
  confidence: number;               // 1.0 for rules; reviewer-supplied in [0,1]
  instruction: { action: Action; text: string };
  evidence: string | null;          // reviewer's one-line reason; null for rules
  profile_origin: string;           // profile id whose config enabled or set severity for this finding
  scope?: 'span' | 'document';      // default 'span'; 'document' for document_metric findings, which are exempt from overlap resolution (ADR-24)
}

export interface ReviewStats {
  prose_chars: number;
  sentence_count: number;
  findings_by_category: Partial<Record<Category, number>>;
  rule_packs: Array<{ id: string; version: string }>;  // every pack the resolved profile pinned
  reviewer: { model: string; latency_ms: number; input_tokens: number; output_tokens: number } | null;
  rules_latency_ms: number;
}

export type Category =
  | 'filler' | 'hedge' | 'vocab' | 'triad' | 'structure' | 'repetition'   // deterministic
  | 'vague_claim' | 'unsupported_claim' | 'register';                      // reviewer

export type Action =
  | 'remove' | 'replace' | 'shorten' | 'specify' | 'merge' | 'restructure' | 'rephrase'
  | 'cite_or_soften_or_remove';
```

## Categories

| Category | Source | What it flags | Default severity |
| --- | --- | --- | --- |
| `filler` | rule | Throat-clearing openers and closers, meta-commentary ("Let's dive in", "I hope this helps") | block |
| `hedge` | rule | Qualification that adds no information ("It's important to note", "arguably") | block |
| `vocab` | rule | Fingerprint vocabulary (delve, tapestry, robust, leverage, seamless) | warn |
| `triad` | rule | Reflexive groups of three and manufactured antithesis ("not X, but Y") | warn |
| `structure` | rule | Header or bullet density out of range for length; uniform sentence length; closing paragraph restating the opener | warn |
| `repetition` | rule | A sentence that restates an earlier one in the same turn | warn |
| `vague_claim` | reviewer | An assertion the user's question made specific that the answer left generic | block |
| `unsupported_claim` | reviewer | A factual claim presented as settled with no basis in the turn or the context | block |
| `register` | reviewer | Length, tone or format mismatched to the profile or the user's ask | warn |

Profiles may raise or lower severity per category or per rule (04). `info` findings never appear in `feedback_text`; they exist for telemetry and the UI.

## Instruction forks

Every instruction is imperative and specific to the span. Two categories carry a mandatory fork because the obvious instruction would pressure the model into fabricating:

- `unsupported_claim` → action `cite_or_soften_or_remove`, text: "Cite a source you actually have, restate this as expectation or opinion, or remove it. Do not invent a citation."
- `vague_claim` → action `specify`, text: "Give the specific detail the question asked for (the number, the file, the name). If you do not have it, say so in one clause instead of generalising."

Rule findings carry fixed instruction text from the rule definition (08). Reviewer findings carry text the reviewer wrote, constrained by the rubric to the span and the action.

## Pass semantics

The pass cap is two. The engine guarantees pass 2 reports a strict subset of what pass 1 reported, so the model never chases a moving target:

1. Pass 1 reports `block` and `warn`. `verdict` is `revise` if any `block` finding exists and the mode permits enforcement.
2. Pass 2 reports only `block` findings whose id appears in `prior_findings`. New findings on pass 2 are demoted to `info` and reported in `stats` only.
3. After pass 2, `verdict` is `pass` regardless, with `skipped_reason: 'pass_cap'` on any further call for the same `turn_id`.
4. `cleared` lists pass-1 ids absent from pass 2. The adapter sends `cleared.length` and the categories cleared to telemetry; never the spans.

Finding ids are content-derived and position-independent, so a span that survives revision unchanged keeps its id wherever it moves; a span the model reworded gets a new id and therefore counts as cleared. A document-level finding keeps its id as long as the rule still fires (ADR-23). `info` findings are never in `findings`; they are counted in `stats.findings_by_category` only.

## Overlap resolution

Two findings whose spans intersect are resolved before output, in this order: higher severity wins; `rule` beats `reviewer`; earlier `span.start` wins. The loser is dropped, not merged. A reviewer finding that fully contains a rule finding is kept only when its category differs; otherwise the rule finding wins. Document-scope findings (ADR-24) take no part in overlap resolution and may intersect anything; apart from them, that containment is the only intersection a result may hold; findings are sorted by `span.start`, then by `span.end` descending. Spans are never empty. Two occurrences of the same span text in one segment share an id; pass 2 treats ids as a set, and an id counts as cleared only when no occurrence remains (ADR-17).

## Thresholds

- Token floor (default; a profile overrides it through overrides.thresholds, 04): prose segments totalling fewer than 60 words → `skipped`, `below_floor`. No rules, no reviewer.
- Reviewer floor (default, same override): fewer than 150 words of prose → `stages` excludes `reviewer`.
- Segment kinds other than `prose` are never linted. A `quote` segment is text the model attributes to the user or a source; it is excluded so the linter never asks the model to rewrite someone else's words.

## feedback\_text template

Rendered by the adapter, not the reviewer, so every harness shows the same thing:

```text
[Prosegate] {n} finding(s) against profile "{profile.id}" (pass 1 of 2). Revise your last response.
{i}. {category label}{ (rule_id)} — "{span.text, trimmed to 80 chars}" → {instruction.text | same as <j>.}
…
Reply with the revised response only. Do not run prosegate commands.
To pause these revisions for this session, the user can run: prosegate advisory
```

On pass 2 the header reads `[Prosegate] {n} finding(s) remain(s) after your revision, against profile "{profile.id}" (pass 2 of 2). Revise your last response.` Details in ADR-12 and ADR-16.

Findings are listed in document order. A `warn` finding is rendered with the same shape on pass 1; it never appears on pass 2.

## Versioning

`schema` is an integer version. Adding an optional field, a new `skipped_reason`, or a new `Action` does not bump it; consumers must tolerate unknown values of those enums and render unknown actions with `instruction.text` alone. Adding a `Category`, removing or renaming any field, or changing offset semantics bumps the version. The adapter refuses a rule pack whose declared findings version it does not support. The JSON Schema files generated from these types are the producer form (unknown fields and values rejected); a consumer validating against them must still apply the tolerance rules above.
