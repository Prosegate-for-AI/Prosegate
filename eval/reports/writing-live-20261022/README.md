# Live contextual writing evaluation — October 22, 2026

Ran 547 paid requests across seven exploratory runs using the actual
`claude-haiku-5-5` reviewer, local engine, four-second reviewer deadline, span
validation and exception enforcement. There are 110 distinct synthetic cases;
repetitions are not independent gold samples. No OpenAI evaluation or human
adjudication was performed. Changes remain local and warning-only.

The evaluation reduced several false-positive failure modes, but it did **not**
establish zero false positives. A supplied-source scope judgment remains
inconsistent, and an ambiguous-actor defect is still missed. The final targeted
source case produced no user-visible warning only because its raw evidence
exceeded the existing 25-word limit. That is boundary protection, not proof of a
correct semantic judgment.

## Recorded results

“Accepted” means a completed review with no retained local or reviewer finding.
Timeouts are excluded from that denominator and listed separately. “Any / target”
counts positive cases with any retained finding / their intended check. An
alternative diagnosis is not automatically evidence of correct target detection.

| Report | Prompt | Cases | Exceptions accepted / completed | Positive any / target / completed | Timeouts |
| --- | --- | ---: | ---: | ---: | ---: |
| [baseline](baseline.json) | 2 | 86 | 47 / 50 | 24 / 16 / 35 | 1 |
| [revised](revised.json) | 3 | 86 | 50 / 50 | 28 / 22 / 36 | 0 |
| [additional probes, three repetitions](holdout.json) | 3 | 72 | 50 / 57 | 15 / 12 / 15 | 0 |
| [second full run](final.json) | 4 | 110 | 67 / 69 | 38 / 30 / 41 | 0 |
| [category/floor adjustment](verified.json) | 5 | 110 | 68 / 69 | 39 / 30 / 39 | 2 |
| [confirmation](confirmation.json) | 6 | 79 | 67 / 68 | 9 / 8 / 10 | 1 |
| [final targeted checks](spot.json) | 7 | 4 | 2 / 2 | 1 / 1 / 2 | 0 |

Names such as `final` and `verified` are historical run identifiers, not quality
certificates. Prompt 7 received only the final four live checks; there is no clean,
complete 110-case run of the final prompt. The most recent broad confirmation
accepted 67 exceptions, flagged one, and timed out on one; the two latter cases
returned no retained warnings in the targeted rerun. The ambiguous-actor positive
still returned no finding. Do not combine these runs into a claim of independent
100% accuracy.

All four errors were reviewer timeouts, across 547 attempts. Completed short-case
latency p95 was approximately 1,974 ms across all versions; this is not a
1,500-word latency qualification and excludes the timeouts. All new findings
remain warnings, and automatic paid hooks/MCP were not enabled.

## Corrections and changes

- The initial empathy and measured-benefit exception fixtures omitted the user's
  expressed feeling and the measurement source. Those were fixture omissions,
  not demonstrated model errors. The additional process-order fixture likewise
  needed a source for its named reviewers. Original reports retain the original
  context. Positive echo, rationale, indirect-statement and structure cases now
  include the actual question or source needed to test their intended defects.
  Before/after numbers are therefore not a controlled accuracy comparison.
- Genuine failures included criticizing expressed feelings, demanding an
  unrequested calendar date, treating equivalent wording/units as meaning loss,
  and demanding repeated measurement explanations for supported arithmetic.
  The prompt now gives exceptions precedence, compares propositions, respects
  the supplied task scope and distinguishes supported paraphrases from additions.
- The catalog's category/action contract is explicit, with shorter instruction
  and evidence targets. Invalid IDs, categories, actions, overlong instructions
  and unsafe output are still rejected. Raw correct-looking diagnoses that local
  enforcement drops do not count as detections.
- Catalog findings now need confidence of at least 0.7. The bundled writing
  profile and descendants apply the same floor to legacy labels so `check_id:null`
  cannot bypass it. Other profiles retain the legacy 0.6 floor. This is a
  conservative operating choice, not a calibrated probability, and can reduce
  sensitivity to borderline defects.
- `local/writing-review` enables `register` and `unsupported_claim`, excluding
  legacy `vague_claim`, which demanded details outside the user's scope. All 34
  catalog checks remain enabled. Other profiles keep their category settings.
- An explicit-scope instruction was added after the remaining source-support
  failure. Its targeted result still contains an incorrect raw diagnosis; further
  semantic evaluation is needed. Do not weaken the source/exception boundary or
  suppress every supported-source claim to hide this issue.

## Reproduction and cost

From the repository root, use the [runner guide](../../README.md#contextual-writing-regression-evaluation).
To repeat the confirmation selection, choose a **new** output directory and
verify current prices before authorizing a new budget:

```text
pnpm eval:writing --live --model CURRENT-pricing.json --out eval/reports/NEW-run --name confirmation --cap-usd 2 --ids-file eval/reports/writing-live-20261022/confirmation-ids.json
```

The final source/timeout/positive selection is in [spot-ids.json](spot-ids.json).
The complete request and actual raw/retained output are in every report. Later
runner reports also preserve prompt text, hashes and case selection; the initial
scratch runner preserved prompt version/hash and requests. All cases are synthetic
and were authored for this investigation. “Holdout” probes became regression cases
once inspected and used to tune the prompt.

Total measured token cost was **$0.3748432** at the recorded prices. Conservative
reservations totaled **$1.997623**, including failed attempts, below the shared
**$2** cap. The remaining reservation budget cannot fund another request. Failed
attempts retain their reservation and may not have returned billable usage, so
measured cost is not an invoice total. Pricing was checked against
[Anthropic's pricing documentation](https://platform.claude.com/docs/en/about-claude/pricing):
$0.10/M input and $0.50/M output at these short input sizes, as captured in
[model.json](model.json). Each run has an append-only reservation/usage ledger.

Offline validation: 321 tests across nine affected files passed, covering the
exception fixtures, confidence boundary and legacy-label bypass, category policy,
schema/context limits, local rules, adapter transport and evaluation accounting.
Workspace typecheck, lint, build, dependency, secret and bundle checks pass.
Full cross-provider quality, independent gold, longer documents, and reliable
semantic recognition of every exception remain unqualified.
