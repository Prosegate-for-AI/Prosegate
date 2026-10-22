# Source-support and ambiguous-reference follow-up — October 22, 2026

This follows the [initial live evaluation](../writing-live-20261022/README.md).
It uses the production `claude-haiku-5-5` transport, four-second reviewer deadline,
local rules, span mapping and output enforcement. The cases are synthetic
regressions used during prompt development, not independent human-adjudicated gold.
All findings remain warnings; hooks and MCP still run local rules only.

Both original failures are corrected in the final `reviewer_prompt/11` runs:

- **Source support: 9/9.** The last-runtime-dependency claim returned genuinely
  empty raw findings, not a false diagnosis hidden by the validation layer.
- **Ambiguous actor: 9/9.** The unresolved “They told them to change it…” sentence
  returned a retained `register` warning with `check_id: missing-actor` each time.

These nine repetitions per case combine one broad run, three focused repetitions
and five final verification repetitions on the same prompt. They are regression
evidence, not nine independent examples or a claim of perfect model accuracy.

## Recorded results

Accepted means a completed review with no retained local or reviewer finding.
Raw-empty counts only completed exception responses with an empty raw array.
Positive any/target counts retained warnings / the intended catalog check.

| Report | Prompt | Attempts | Exceptions accepted / completed | Raw-empty | Positive any / target / completed | Timeouts |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| [Initial focused](focused.json) | 8 | 42 | 21 / 23 | 19 | 14 / 6 / 17 | 2 |
| [Source refinement](focused-v9.json) | 9 | 42 | 20 / 24 | 18 | 17 / 8 / 18 | 0 |
| [Actor refinement](focused-v10.json) | 10 | 42 | 23 / 23 | 23 | 18 / 12 / 18 | 1 |
| [First broad run](broad-v10.json) | 10 | 122 | 71 / 76 | 66 | 45 / 37 / 46 | 0 |
| [Final broad run](broad-v11.json) | 11 | 122 | 74 / 76 | 68 | 45 / 35 / 45 | 1 |
| [Final focused repetitions](focused-v11.json) | 11 | 42 | 24 / 24 | 24 | 18 / 15 / 18 | 0 |
| [Original-case verification](verification-v11.json) | 11 | 10 | 5 / 5 | 5 | 5 / 5 / 5 | 0 |

The final focused set passes all 42 cases with no timeout or filtered exception.
All nine actor-positive responses use the intended check. Three warnings about
another remaining format reader use the legacy `unsupported_claim` label instead
of `unsupported-causality`; their retained evidence correctly identifies that
remaining dependency, so they are useful detections but not exact-check matches.

The broad run is **not false-positive-free or a full model qualification**:

- `manufactured-significance/exception` and `repeated-point/exception` still emit
  support warnings. Both fixtures lack source material; the former asserts a last
  dependency and the latter a cache's database effect. Their acceptance labels
  test style exceptions without independently adjudicating factual support. The
  counts above retain the original labels rather than silently treating these
  warnings as successes. They differ from the requested source-supported failure.
- Six additional exceptions have nonempty raw responses removed by confidence,
  exception or output-contract enforcement. In particular, the model still asks
  for unnecessary API-reference details and unrequested deadline specificity.
  Some other raw responses are confirmations incorrectly serialized as findings.
- `slogan-fragments/positive` timed out. It is excluded from completed positives;
  there is no claim that all 122 cases completed successfully in that single run.
- Ten broad positives use another diagnosis. Any finding is not proof that the
  intended rule detected its target. Longer documents, other providers and
  independent human labels remain unqualified.

## Changes

- The reviewer now compares propositions and direct implications: a sole remaining
  user supports a same-scope last-dependency conclusion. Explicitly narrower scope,
  other remaining users and uncertain evidence still warrant support warnings.
- Reference resolution uses the draft and supplied conversation/source context.
  Missing antecedents are a clarity defect even if the reviewer cannot name the
  intended people. Instructions must ask for clarification rather than invent names.
  Ambiguous possessives are unresolved identities, not assertions of invented names.
- Clear contextual references, generic pronouns, passive voice and concrete task
  nouns/roles remain exceptions. An understandable instruction need not specify
  proper names or inventory IDs. Brief safety warnings and clear conditional
  clauses do not need expansion just to satisfy a stylistic preference.
- Added 12 source/actor controls and the `--set support-actors` selection, which
  also includes the two original failures. All 122 cases participate in `--set all`.
  The confidence threshold and local output validation were not weakened.
- Reports now separate empty raw responses from findings discarded by enforcement.
  A filtered false diagnosis is not evidence of correct semantic recognition.

## Fixture corrections

The first focused run's two-candidate source did not explicitly support the telling
event. Later runs supply that event while preserving the unresolved applicant.
The first broad run also exposed a missing decision reason and release exception
in `real-rationale/exception`'s source. Its final fixture supplies both facts using
different wording. Those are fixture repairs, not demonstrated model improvements;
original reports preserve their original requests. No report has been overwritten.

## Reproduction

Use a new report name and currently verified pricing. The manifest here records
the prices checked on October 22, not a permanently current price list.

```text
pnpm eval:writing --live --model CURRENT-pricing.json --out eval/reports/NEW-run --name focused --cap-usd 2 --set support-actors --repeat 3
pnpm eval:writing --live --model CURRENT-pricing.json --out eval/reports/NEW-run --name broad --cap-usd 2 --set all
pnpm eval:writing --live --model CURRENT-pricing.json --out eval/reports/NEW-run --name verify --cap-usd 2 --ids-file eval/reports/writing-fixes-20261022/verification-ids.json --repeat 5
```

Use one sequential writer per report directory. Reservations, including failures,
accumulate across that directory. Every report preserves prompt text/hash, case
hash, actual requests, raw and retained outputs, failures and cost accounting.
The [runner guide](../../README.md#contextual-writing-regression-evaluation)
explains the metrics. No paid requests run in offline tests.

## Cost and offline checks

This follow-up made **422 requests** across seven runs. Measured token cost was
**$0.3762092**, with **$1.830255** reserved under its separate **$2 cumulative cap**.
Four requests timed out; their reservations remain charged against the cap and
their billable usage may be absent, so measured cost is not an invoice total.
The [pricing manifest](model.json) records $0.10/M input and $0.50/M output at
these input sizes. The initial evaluation's separate budget and reports are intact.

Offline validation: **330 tests across nine files passed**, including all exception
fixtures, raw-versus-retained scoring, confidence and category boundaries, context
transport and output enforcement. Workspace typecheck, lint, build, dependency,
secret and bundle checks passed (1,280,605-byte adapter bundle).
