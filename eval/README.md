# Phase 6 evaluation

The tooling is implemented. The corpus milestone is **not yet qualified**: HQ-7 (sources, licences and
consent) and HQ-8 (generation budget and independent annotators) still need to be supplied. Synthetic
test fixtures are not human controls or gold annotations. Tests, corpus validation and the rule
evaluator require no live API requests.

## Commands

| Command | Purpose |
| --- | --- |
| `pnpm eval:rules` | Example/FP/precision/recall/latency gates and baseline; now includes annotation coverage and κ. |
| `pnpm eval:corpus` | Validate provenance, saved prompts, duplicates, annotations and milestone coverage. |
| `pnpm eval:generate` | Generate drafts into a new staging directory under a supplied spending cap. |
| `pnpm eval:annotate` | Independent span marking and third-person adjudication; see `annotate/README.md`. |
| `pnpm eval:import` | Admit validated staging items without overwriting corpus files. |
| `pnpm eval:reviewer` | Run the production reviewer against the rubric, including retries and enforcement. |
| `pnpm eval:e2e` | Rules pass 1 → same-model revision → pass 2; judge, fabrication scan and human sample. |
| `pnpm eval:release` | Both production reviewers plus full e2e corpus, sharing one reservation budget. |

Use `--help` for options. New reports include date, Git revision, dirty state and a unique suffix.
They and spending ledgers live under `eval/reports/`, ignored by Git. E2e reports contain draft,
revision and context text: use a private report directory for private corpora and review before sharing.
Offline scoring accepts an e2e report or the nested e2e evidence in a release report.

Exit 0 means measured gates did not fail; `partial` means incomplete evidence. Exit 1 means a failed
gate/run; exit 2 means invalid input or a harness error. Add `--require-pass true` to reject partial
results. Generation reports plan completion only, never corpus quality. Failed generation preserves
completed drafts and spending records.

## Corpus collection and generation

Human controls retain the `.md` and `.meta.json` layout in `corpora/README.md`. Record source, licence
and date. Public import additionally requires this field in each human metadata record:

```json
{"redistribution":{"permitted":true,"evidence":"Exact permission URL or recorded consent reference"}}
```

This records a human decision; the tool does not infer permission from a licence name or scrape text.
For private writing use a private sibling repository and `eval:import --private true`; also pass
`--private true` to `eval:corpus` when auditing that private corpus.

Supply model pricing in a JSON manifest. Each record has:

```json
{
  "id":"EXACT-PROVIDER-MODEL-ID",
  "provider":"openai",
  "family":"MODEL-FAMILY",
  "generation":"GENERATION-LABEL",
  "input_usd_per_million":1,
  "output_usd_per_million":2,
  "pricing_checked_on":"YYYY-MM-DD",
  "max_output_tokens":4096
}
```

Prices above are **illustrative, not real prices**. Replace all values with verified data. Prices must
be positive and verified within 31 days. Use four families, each with two generations and exact version
IDs. The reviewer/e2e manifest is an array of these records. Generation takes
`{schema:"prosegate.generation-plan/1", models:[...], prompts:[...], samples_per_prompt:1}`.
Starter prompts are in `prompts.json`; vary tasks and lengths before collecting 200 items per profile.
Reviewer latency qualification needs ten rubric drafts of 1,350–1,650 prose words; other drafts should
reflect normal use. Targets are 300 eligible human controls and 200 AI drafts for at least three profiles,
100 adversarial items of each type, and 150 rubric drafts.

```text
pnpm eval:generate --plan my-plan.json --output eval/staging/run-001 --cap-usd 5
```

Set `OPENAI_API_KEY` and/or `ANTHROPIC_API_KEY` in the process environment. Evaluation does not read or
alter installed Prosegate credentials. Never put keys in a plan, argument or committed file.
Provider URLs are fixed, redirects disabled, completions not automatically retried. The production
reviewer's one retry remains enabled and is separately reserved.

Before transmission, each request reserves a conservative amount: UTF-8 request bytes plus framing
allowance as an input-token bound and maximum output tokens, at supplied prices. Reservations are
never refunded, including failures/timeouts. A run stops before exceeding its reservation budget.
Observed usage is reported separately. This is an operator-priced controller, **not a provider billing
guarantee**: bad prices or billing changes invalidate the estimate. Usage above the reservation stops
the run. Each invocation needs a new ledger; no hidden resume resets a previous budget.

Generation preserves prompts in `.prompts/` and model/version/generation in metadata. It creates no
gold file. Finish two annotations and adjudication for each AI/adversarial item before:

```text
pnpm eval:import --source eval/staging/run-001 --corpora eval/corpora
pnpm eval:corpus --require-pass true
```

Imports preflight permissions, text duplicates, annotations and collisions, then create files exclusively.
A filesystem interruption may leave a partial import; it cannot overwrite existing items. Review the
destination before retrying. Identical prompts can be reused. Rubric membership is curated separately;
import does not overwrite its manifest.

## Rubric and reviewer

Create `corpora/rubric.json`:

```json
{
  "schema":"prosegate.rubric/1",
  "items":[
    {"path":"ai/base/item.md","profile":"base","origin":"ai","prompt_file":".prompts/task.json"},
    {"path":"rubric/base/handwritten.md","profile":"base","origin":"handwritten","prompt_file":".prompts/handwritten-task.json"}
  ]
}
```

Handwritten items need human metadata, saved context, gold and the same annotation receipts. Include
30 handwritten drafts among 150 unique rubric drafts. AI membership references existing corpus files.

```text
pnpm eval:reviewer --models my-models.json --model EXACT-ID --cap-usd 5
```

Reviewer qualification accepts only exact current production candidate IDs. It uses real profile
floors/categories, transport, timeout, retry, re-finding and enforcement. Metrics cover first-attempt
schema validity, exactly one eligible occurrence of each raw span, raw/enforced claim forks,
one-to-one category precision/recall, 1,500-word latency, and cost per 1,000 words.
Empty denominators remain unmeasured. Missing adjudication, insufficient samples or κ below 0.6
cannot produce a supported-model result. A passing report does not enable paid hooks; ADR-35 still applies.

## End-to-end and human review

```text
pnpm eval:e2e --models my-models.json --model EXACT-GENERATING-ID --judge EXACT-JUDGE-ID --cap-usd 5
```

Selects up to 50 drafts per profile in a stable seeded order from that exact generating model, retaining
the saved system message, request, constraints and draft. Use `--sample-per-profile all` for release.
Use `--model all` to sample across the full model matrix; each selected draft is revised by its own
original model. The pricing manifest must include every generating version. This lets a 200-item
per-profile corpus support a 50-item mixed-model sample without requiring 50 items of each version.
Clearance counts surviving pass-1 block IDs; a fresh scan counts new blocks that pass 2 demotes.
Prose-less rewrites, incomplete engine runs and failed judges cannot certify success.
The runner is **rules-only**, matching the shipped hook path; reviewer-enabled e2e follows ADR-35.

An LLM judge checks meaning/fabrication. A conservative lexical scan flags added numbers, URLs, DOIs
and numeric citations absent from original/context. These are candidates, not proof of fabrication.
Flagged cases fail the zero-tolerance gate and enter a rubric-candidate list; independently annotate
them before admitting gold.

A person reviews a deterministic 10% of changed revisions:

```json
{
  "schema":"prosegate.e2e-human/1",
  "evidence_sha256":"HASH-FROM-REPORT",
  "reviewer":"human-identity",
  "items":[
    {"id":"SAMPLE-ID","revision_sha256":"ROW-HASH","meaning_preserved":true,"fabricated":false,"note":"Compared every claim."}
  ]
}
```

```text
pnpm eval:e2e --score previous-e2e-report.json --human human-checks.json --require-pass true
```

Scoring is offline. Missing human checks cannot pass meaning preservation; human disagreement
overrides a positive judge. Qualification needs 50 evaluated drafts in each of three profiles.
The human sample itself must also meet 95% meaning preservation. Median word-count reduction over
40% requires manual register review; record `register_review:true` in the human-check file after review.

## CI and qualification

PR CI runs rules and corpus readiness without keys. Gold lacking receipts remains exploratory.
Once paired ratings exist, categories with undefined/below-0.6 κ are withheld from precision/recall
and baseline comparisons; prior baseline entries are preserved. Agreement counts remain visible.

`eval-paid.yml` provides manual reviewer/e2e runs, a weekly sample and full release runs. Automatic
triggers are disabled unless `PROSEGATE_PAID_EVALS_ENABLED=true`. First configure the `evaluation`
environment, API-key secrets, `EVAL_MODEL`, `EVAL_JUDGE`, `EVAL_CAP_USD`, and verified `eval/models.json`.
The workflow refuses payment when corpus readiness fails. Release evaluates both reviewers and e2e
under one shared budget. Reports are evidence, not automatic publication approval; e2e still needs
offline human scoring.

Phase 6 exit still requires licensed sources/consent, the model matrix and generation budget,
independent annotators, collected corpora, live runs, human rewrite checks and rule triage.
Triad severity is not changed without control-set evidence. D-19/20/21/23/27 remain measurement debt.

Transport references checked during implementation:
[OpenAI text generation](https://developers.openai.com/api/docs/guides/text) and
[Anthropic Messages](https://platform.claude.com/docs/en/build-with-claude/working-with-messages).
