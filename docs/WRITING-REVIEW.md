# Contextual writing review

The bundled `local/writing-review` profile implements the Writing Review Rules
Quick Reference as 34 contextual checks and two narrow local rules. Every finding
starts at warning severity. The existing five profiles retain their local rule
settings; this profile disables all 23 overlapping `core` heuristics so they cannot
flag legitimate technical vocabulary, contrasts, lists or necessary uncertainty.

Select it with `prosegate profile local/writing-review` in a bound session, or use
`select_profile` with that ID. Requests containing “writing review”, “review my
writing” or “review this prose” can suggest it through the existing profile
selection mechanism. Profile selection alone does not enable paid calls. Opt into automatic Stop-hook
review with `prosegate reviewer on --provider openai` (or `anthropic`), or use the
explicit `review --provider` command with `profile_id` set to
`local/writing-review` and `stages` containing `reviewer`. MCP stays local-only. This profile has zero word floors so short passages
can be checked. It does not change the active profile in existing installations.

## Checks

The trusted catalog is `packages/reviewer/src/writing-checks.ts`. Every entry
specifies a defect, an exception and a concrete revision target. The provider
returns a catalog `check_id` and an explicit `exception_applies` assessment;
local validation discards unknown IDs, category substitutions, missing exception
assessments and findings where an exception applies. Catalog findings are capped
at `warn` even if a provider or category override requests `block`. Pass two
demotes them to `info`, following the existing two-pass contract.

Catalog findings require model confidence of at least 0.7, up from 0.6 after live
exception testing. This conservative threshold can miss borderline defects; it is
not a calibrated probability. The writing profile and its descendants apply 0.7
to legacy labels too, preventing label changes from bypassing the floor. Other
profiles keep their existing 0.6 floor for legacy findings.
This profile enables `register` and `unsupported_claim` review. It excludes the
legacy `vague_claim` category, which demanded unrequested specificity in live
tests; all 34 contextual checks remain enabled. Other profiles retain their
reviewer category settings. Enabled categories are also supplied to the model.

| Group | Check IDs |
| --- | --- |
| Formulaic expression | `inflated-contrast`, `slogan-fragments`, `ornamental-triad`, `negative-parallelism`, `punctuation-rhythm`, `padded-enumeration`, `strained-metaphor`, `canned-empathy`, `empty-balance`, `manufactured-significance`, `promotional-tone`, `abstract-cluster` |
| Meaning and support | `empty-benefit`, `unsupported-causality`, `unattributed-authority`, `unspecified-comparison`, `missing-actor`, `process-for-rationale`, `meaning-lost`, `undefined-concept` |
| Direct language | `verbal-padding`, `bureaucratic-circumlocution`, `stacked-uncertainty`, `noun-chain`, `indirect-statement`, `audience-jargon`, `overloaded-sentence` |
| Structure | `generic-opening`, `request-echo`, `self-announcement`, `repeated-point`, `stock-closing`, `fragmented-structure`, `mechanical-labels` |

`unsupported-causality` and `unattributed-authority` use the existing
`unsupported_claim` category and its fixed citation/qualification/removal fork.
Other catalog entries use `register`, expanded to include clarity and preservation
of meaning in writing tasks. `check_id` belongs to the provider protocol; public
findings keep the existing categories and `rule_id: null`. No new findings category
or offset convention is introduced. The bundled prompt version is
`reviewer_prompt/11`.

The `writing` pack supplies two local checks:

- `writing.filler.001`: “at this point in time” and “in order to”. Shorten only
  where meaning is preserved.
- `writing.hedge.001`: “might possibly” and “could potentially”. Remove the
  redundant hedge while retaining uncertainty and its reason.

Other constructions, including “for the purpose of”, need a contextual rewrite.
The local checks do not ban passive voice, “may”, semicolons, dashes, lists, long
sentences or individual technical terms. Segmentation protects code, inline code,
tables and attributed quotations. The reviewer receives already-selected local
findings and suppresses overlapping catalog findings. Its own findings also
resolve to one diagnosis per overlapping passage.

## Optional context

The explicit review JSON accepts these optional `context` fields, in addition to
`user_message`, `style_constraints` and `mode`:

```json
{
  "audience": "Engineering managers familiar with the service",
  "original_text": "The vendor may terminate only after giving 30 days' written notice.",
  "source_material": "Report A, Table 2: median latency was 20 ms in the supplied benchmark."
}
```

Limits are 500 UTF-16 code units for `audience`, and 20,000 each for
`original_text` and `source_material`. Strict request validation rejects larger
values. Direct library prompt construction omits oversized originals and source
material rather than comparing partial documents. An absent, empty, oversized or
unchanged original makes `meaning-lost` ineligible locally. The reviewer must also
preserve omissions or corrections the user actually requested. For a complete
request and invocation, see the [reviewer guide](../packages/reviewer/README.md).

These fields are optional data, never executable instructions. Original text and
sources are sent verbatim to the chosen provider; submit only material appropriate
for that provider. No source retrieval or independent fact verification occurs.
Missing support is not evidence of falsehood, and the reviewer must not fabricate
citations, numbers, actors or definitions. Exact assertions supplied by the user
or in source material are locally exempt from the two catalog support checks.

## Exceptions and validation

The 34 contrast pairs in `eval/fixtures/writing-review.json` cover factual
corrections, concrete requirements, meaningful punctuation, real tradeoffs,
technical precision, expressed feelings, approvals, permissions, supported
comparisons, useful scope, steps and reference headings. These are synthetic
regression fixtures derived from the supplied reference, not independently
human-adjudicated model-quality labels.

Offline tests execute local rules against every exception. Mock-provider tests
cover all catalog IDs, warning caps, explicit exception vetoes, original-text
eligibility, context limits, protected spans and overlap suppression. Adapter tests
check that the explicit command carries context to the provider and returns a
valid warning-only result. The existing evaluation parser accepts the new provider
fields.

Mock-provider tests verify contract enforcement, not whether a real model correctly
recognizes each exception. The October 22 live evaluation found and corrected
overzealous treatment of expressed feelings, requested summaries, supported
arithmetic and equivalent wording. Exceptions now explicitly take precedence over
stylistic preferences; meaning preservation compares propositions rather than exact
words. Category/action guidance and shorter instruction targets also reduce invalid
provider output, without weakening local validation or changing warning severity.

The source-support/actor follow-up adds explicit reference resolution and logical
support checks. Missing antecedents are a reportable clarity defect even when the
reviewer cannot supply the correct names. Clear contextual references, generic
pronouns and passive voice stay exempt. A sole remaining user supports a same-scope
last-dependency conclusion; narrower or uncertain source evidence does not support
a broader or certain claim. Output examples distinguish genuine empty responses
from affirmative observations that must never be emitted as findings.

See the [source-support and actor follow-up](../eval/reports/writing-fixes-20261022/README.md)
and [initial live evaluation](../eval/reports/writing-live-20261022/README.md)
for measured results and remaining misses, and [the runner guide](../eval/README.md#contextual-writing-regression-evaluation)
to repeat it. Synthetic regression results do not replace human adjudication,
cross-provider evaluation or full-length latency qualification before automatic
reviewer rollout. No paid evaluation runs are part of the offline tests.
