# 10 — Eval plan

## Why the eval carries the weight

Implementation: Phase 6 tooling and metric decisions are in `eval/README.md`, `eval/GUIDELINES.md`
and ADR-37. The tools are available; corpus collection and live qualification remain pending HQ-7/HQ-8.

Telemetry is counts only (07), so it can say a rule fires often and gets cleared; it cannot say whether the rule was right. The eval corpus is the only place Prosegate can measure precision, and the false-positive budget is the only thing standing between enforcement-by-default and uninstall. Every rule, every reviewer prompt version and every supported model is gated on it.

## Corpora

| Corpus | Contents | Size target | Source | Use |
| --- | --- | --- | --- | --- |
| AI corpus | Agent-written text per profile, from four models across two generations, prompted the way real users prompt | 200 per profile | Generated; prompts stored beside outputs | Rule recall, reviewer precision and recall, end-to-end clearance |
| Human control | Human-written text per profile, written before 2022 where the genre allows | 300 per profile | Permissively licensed PR descriptions and design docs from open-source projects; pre-2020 mailing-list posts; the team's own pre-agent writing, with consent | False-positive rate; the gate |
| Adversarial | Human text that reads as machine-like (technical writers, non-native authors); AI text that a human editor passed as clean | 100 each | Hand-selected; annotator-labelled | Calibration; flags rules that fire on register rather than tic |
| Rubric set | Drafts with gold `unsupported_claim`, `vague_claim` and `register` spans, two annotators, adjudicated | 150 drafts | Drawn from the AI corpus plus 30 hand-written | Reviewer prompt and model gating |

Gold labels are span-level JSON beside each file: `{category, rule_id?, start, end}`. Inter-annotator agreement (Cohen's κ) is reported per category in the eval report; a category below 0.6 is not used as a gate until the guideline is fixed.

Licensing: every human-control item records its source and licence; nothing under a licence that forbids redistribution goes in the public repo. The team's own writing stays in a private corpus with the same layout.

## Per-rule metrics and budgets

| Metric | Definition | Budget for `block` | Budget for `warn` | Budget for `info` |
| --- | --- | --- | --- | --- |
| Example pass | Every `hit` fires, every `miss` does not | 100% | 100% | 100% |
| False-positive rate | Human-control documents with at least one hit ÷ documents | ≤ 1% | ≤ 3% | ≤ 10% |
| Precision | Hits on the AI corpus that annotators confirm as real ÷ hits | ≥ 90% | ≥ 80% | ≥ 60% |
| Recall | Gold spans of the rule's category it catches ÷ gold spans, summed per category across rules | ≥ 70% per category | ≥ 60% | — |
| Latency | Rule time over the AI corpus, 2,000-word documents | Pack total ≤ 200 ms p95 |  |  |

A rule over its false-positive budget is removed from the pack, not demoted; demotion hides a bad rule behind a softer severity. `core.triad.001` is the known risk and ships at `warn` only because its budget holds on the control set; if it does not, it ships as `info` with a note.

## Reviewer metrics, per model

| Metric | Target |
| --- | --- |
| Precision per category vs gold | ≥ 0.75 |
| Recall per category vs gold | ≥ 0.50 |
| Span find rate (returned `span_text` located once in the draft) | ≥ 95% |
| Schema validity on first try | ≥ 98% |
| Fork compliance (`unsupported_claim` carries the exact fork text) | 100% after adapter enforcement; ≥ 90% raw |
| p95 latency on a 1,500-word draft | ≤ 3 s |
| Cost per 1,000 words of draft | reported, no gate |

A model that misses any target is listed as unsupported for that prompt version. The first supported pair is one small OpenAI model and one small Anthropic model; the eval report names them with the version strings used.

## End-to-end clearance

The metric the product is sold on. For each AI-corpus document: run pass 1, feed `feedback_text` to the model that wrote the draft (same model, same prompt, same context), take the revision, run pass 2.

| Metric | Target |
| --- | --- |
| Clearance: pass-1 `block` findings absent on pass 2 | ≥ 80% |
| Introduced findings: new `block` findings on pass 2 (reported, demoted to info) | ≤ 10% of pass-1 count |
| Meaning preserved: LLM judge with a 10% human sample; a revision that drops a fact or changes a claim fails | ≥ 95% |
| Length change | reported; a median cut over 40% triggers a manual look at `register` |
| Fabrication check: any revision that adds a citation or a number not present in the context | 0 tolerated; each case becomes a rubric-set item |

## Dogfood metrics from telemetry

Thirty days on the author's team, measured against the success criteria in 01: sessions dropped to advisory, `override_used`, pass-2 clearance, `enforcement_unavailable`, `notice_via_model` failures, reviewer span misses. Any rule whose id dominates `advisory` sessions in the week before the switch is reviewed by hand against the corpus.

## Regression harness

- `pnpm eval:rules` runs example pass, false-positive rate, precision and latency for every pack in the repo and compares with `eval/baseline.json`. Runs on every pull request. Fails if any rule breaks its budget or loses more than five points of precision against baseline.
- `pnpm eval:reviewer --model <id>` runs the rubric set against one model. Runs on a pack or prompt release and when a model is added; costs money, so it is a manually triggered job with a cost cap in the workflow.
- `pnpm eval:e2e --model <id>` runs clearance on a 50-document sample per profile. Weekly on `main`, full corpus on release.
- Every run writes `eval/reports/<date>-<sha>.json`; the release notes for a pack link its report.

## Annotation process

Two annotators per item using a CLI that shows one document and takes span marks by category; disagreements are adjudicated by a third pass and the guideline is updated when the same disagreement recurs. Guidelines live in `eval/GUIDELINES.md` with one worked example per category. Annotators see the rule catalogue (08) for deterministic categories and the rubric for reviewer categories, and nothing about which model wrote the text.

## Known gaps

- English only in v0; the rule pack and the corpus are English. Non-English text is segmented and skipped with `skipped_reason: 'no_prose'`.
- Markdown-heavy documents (tables, nested lists) may trip `structure` rules; the control set includes them on purpose.
- The human control set cannot be fully free of AI-assisted writing after 2022; dating the sources is the mitigation, not a guarantee.
