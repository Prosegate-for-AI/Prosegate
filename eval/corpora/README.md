# Eval corpora (docs/10)

The corpora are empty until HQ-7 (human-control sources and licences) and HQ-8 (AI-corpus generation and
annotation) are resolved. `pnpm eval:rules` handles that honestly: every metric that needs a corpus is
reported as `n/a (0 items)`, never as a pass, and the run says so in its last lines.

## Layout

```
eval/corpora/
  rule-examples/<pack>/<rule>-<hit|miss>-NN.md   whole-document examples cited by a pack as
                                                 <eval corpus ref: <pack>/<rule>-<hit|miss>-NN>
  human-control/<profile>/<id>.md                human-written text (UTF-8, LF)
  human-control/<profile>/<id>.meta.json         {source, licence, author?, date, url?, notes?}
  ai/<profile>/<id>.md                           agent-written text
  ai/<profile>/<id>.gold.json                    [{category, rule_id?, start, end, text?}]
  ai/<profile>/<id>.meta.json                    {model, model_version, prompt_file, generated_at}
  adversarial/human-machinelike/<id>.md          human text that reads as machine-like; + .meta.json (human record)
  adversarial/ai-passed/<id>.md                  AI text an editor passed; + .meta.json (AI record)
                                                 adversarial items may carry a .gold.json; they run under local/base
```

`<profile>` is the bundled profile name without the namespace: `base`, `pr-description`, `design-doc`,
`email`, `chat-reply`. Each document is reviewed under its own profile with that profile's real token
floor. One `.md` per item; a directory, a stray file, or an unknown profile is an error, not skipped.

`.gitattributes` marks `eval/corpora/**` as `-text`, so a checkout never rewrites line endings: gold offsets
stay valid. Do not re-save corpus files with an editor that changes them.

## Validation (exit code 2 on any failure)

Every `.meta.json` and `.gold.json` is validated strictly (unknown keys are rejected). All problems in a
corpus are reported together.

- **Licensing gate.** A human-control item (and an `adversarial/human-machinelike` item) without a non-empty
  `licence`, a `date` (`YYYY`, `YYYY-MM` or `YYYY-MM-DD`, a real date) or a `source` fails the run. The harness
  checks that a licence is recorded, not that it permits redistribution; that stays a human decision (HQ-7).
- **Gold spans** are UTF-16 code-unit offsets into the `.md`, `end` exclusive. A span must be in range and must
  not split a surrogate pair. If it carries `text`, `text` must equal the slice. A `rule_id` must belong to the
  span's `category`.
- An AI item must have a `.gold.json` (write `[]` for none).

## Metrics and the choices docs/10 leaves open

Packs are evaluated one at a time, each alone (D3). Budgets are in `rules-gates.ts`; everything is compared on
integer counts, so a rule exactly at its budget passes.

- **D1 Gate severity.** The gate uses the severity the pack publishes. A profile that softens or disables a rule
  does not change its budget. The report lists the effective severity per bundled profile, and the table marks a rule
  with `*` when any profile differs.
- **D2 Pinning.** The bundled profiles pin `core`. A pack under test that no profile pins (`--pack`) is added to the
  resolved profile so it runs under that profile's overrides.
- **D3 Isolation.** Each pack runs alone, so adding a pack never moves another pack's numbers through overlap
  resolution. Production runs all pinned packs together; that interaction is not measured here.
- **Example pass.** Same semantics as `packages/engine/test/examples.test.ts`: standalone document, token floor
  bypassed, `local/base`, a hit must produce a finding of that rule, a miss none. A corpus ref that points at a missing
  or empty file is a harness error. Gate: every example of every rule.
- **D4 False-positive rate** = human-control documents with at least one finding of the rule (any severity, info
  included, taken from `diagnostics.all_findings`, i.e. after overlap resolution) / human-control documents the rule
  ran on. A document counts only if it reached the rule stage (not skipped below the floor or as non-prose) and the
  profile has the rule enabled. Skipped documents are counted and reported, and left out of the denominator.
- **D5 Precision** = AI-corpus findings of the rule confirmed by gold / findings of the rule. A finding is confirmed
  when a gold span shares at least one UTF-16 unit with it and either has the same `rule_id`, or has no `rule_id` and
  the same `category`. A gold span naming a different rule never confirms. Every finding counts, info included.
  The 30-item floor for precision counts AI documents the rule ran on (not hits), so a rule with few hits is still
  gated; revisit if that proves too noisy.
- **D6 Recall** is per pack and category: gold spans of the category that any finding of that category overlaps
  / gold spans of the category. A gold span's `rule_id` is ignored. Gold spans in documents the profile skips count as
  missed. A category is judged by the strictest pack severity of its rules; `info` categories show recall but have
  no floor. Reviewer categories (`vague_claim`, `unsupported_claim`, `register`) are not rule categories and are
  counted but not scored here.
- **D7 Latency** is `stats.rules_latency_ms` (the pack's total rule time on a loaded pack, ADR-10), warm. With 10 or
  more AI documents of at least 2,000 prose words, each document is sampled 5 times after 2 warm-ups, its median is
  the sample, and the pack p95 is over documents. Otherwise it falls back to the engine's 2,000-word perf fixture
  (`rules-perf-doc.ts`, a copy of `realisticDoc()` because `check:deps` forbids a cross-package relative import) and
  the report says `engine-fixture` and `fallback`. Gate: p95 <= 200 ms. ADR-10's 50 ms target is reported beside it,
  not gated. The measurement is a reported metric, not an assertion in any unit test (the tests inject a clock).
- **Insufficient.** A metric with fewer than 30 items (documents for FP and precision, gold spans for recall) is
  shown as `insufficient` and does not gate. With 0 items, or a rule with no hits, it is `n/a`.
- **Baseline** (`eval/baseline.json`): per rule `precision` and `fp_rate`, `null` when unmeasured. A run fails when a
  rule loses more than 5 precision points, and also when the baseline held a measured precision and this run could
  not measure one. A missing baseline file is a harness error (it would silently disable the check). `--update-baseline`
  rewrites the entries of the evaluated packs, and only from a passing run.

## Running

```
pnpm eval:rules                       # bundled packs, these corpora, eval/baseline.json
pnpm eval:rules --pack path/to.yaml   # also evaluate another pack
pnpm eval:rules --update-baseline     # after an accepted, passing run
pnpm eval:rules --local               # write <date>-<sha>.local.json (gitignored) instead of <date>-<sha>.json
```

Reports go to `eval/reports/<YYYY-MM-DD>-<shortsha>.json`. Exit 0: every gate that could be evaluated passed.
Exit 1: a gate failed. Exit 2: harness error. Gate tests: `eval/runners/eval-rules.test.ts`, fixtures in
`eval/runners/test-fixtures/` (corpora are built into a temp directory per test, never into this tree).
