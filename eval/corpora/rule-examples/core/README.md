# Rule examples for pack `core` 0.1.0 (corpus refs)

Whole-document examples that `core.yaml` cites as `<eval corpus ref: core/<rule>-<hit|miss>-01>`. Each file
reads like an agent reply or document in the genre of docs/08, and was written so that it exercises one rule
and trips no other `core` rule. Values below come from `_measure.ts`, which is a pre-engine check; the engine
is the authority. Run `npx tsx eval/corpora/rule-examples/core/_measure.ts` (add `--verbose` for every
cross-check, `--pairs` for the most similar sentence pair per file).

LICENSE-NOTE: these files are original work written for this repo; none is copied or adapted from third-party text.

- `filler-004-miss-01.md` — core.filler.004, miss: 858 words (rule inactive above 399), sentence-initial "In summary,".
- `structure-001-hit-01.md` — core.structure.001, hit: headers_per_100_words 2.26 (6 headings, 266 words; threshold above 1.5).
- `structure-001-miss-01.md` — core.structure.001, miss: headers_per_100_words 0.54 (6 headings, 1114 words).
- `structure-002-hit-01.md` — core.structure.002, hit: bullet_ratio 0.85 (17 items of 7+ words, 3 prose sentences; threshold above 0.6).
- `structure-002-miss-01.md` — core.structure.002, miss: bullet_ratio 0.00 (12 config keys, every item under 6 words; would be 0.75 with min_item_words 0).
- `structure-003-hit-01.md` — core.structure.003, hit: sentence_length_cv 0.03 (11 sentences of 20-22 words; threshold below 0.25).
- `structure-003-miss-01.md` — core.structure.003, miss: sentence_length_cv 0.77 (13 sentences of 3-48 words).
- `structure-004-hit-01.md` — core.structure.004, hit: closing_similarity 0.89 content words, 0.95 all words (threshold above 0.6).
- `structure-004-miss-01.md` — core.structure.004, miss: closing_similarity 0.00 content words, 0.00 all words.
- `structure-005-hit-01.md` — core.structure.005, hit: bold_per_100_words 4.58 (7 bold phrases, 153 words; threshold above 3).
- `structure-005-miss-01.md` — core.structure.005, miss: bold_per_100_words 0.74 (1 bold phrase, 136 words).
- `repetition-001-miss-01.md` — core.repetition.001, miss: max pairwise cosine 0.33 over content words (10 sentences; threshold above 0.7).

## Measuring definitions (`_measure.ts`)

- word: `[\p{L}\p{N}]+` with internal `'` or `-` joiners; heading and list markers and `**` are stripped first, so headings, list items and bold text all count as words.
- sentence: prose lines of a block joined by a space, split on `.` `!` `?` (plus any closing quote or bracket) followed by whitespace or the end of the block.
- unit: variant U counts every prose sentence, list item and heading as one sentence; variant P counts prose sentences only. Both are measured and each file satisfies its rule under both.
- list item: a line starting `- `, `* ` or `N. `; qualifying when it has at least 6 words (`min_item_words`). bullet_ratio R1 = qualifying / (prose sentences + all items); R2 = qualifying / (prose sentences + qualifying items).
- heading: a line starting 1-6 `#` and a space. headers_per_100_words = headings / words x 100.
- bold: a `**...**` pair on one line. bold_per_100_words = pairs / words x 100.
- sentence_length_cv: population standard deviation / mean of words per sentence (sample variant also checked).
- closing_similarity: cosine of term-frequency vectors of the last and the first paragraph (blank-line blocks, heading lines dropped), shown with stop words dropped and kept.
- repetition: cosine over lowercase content words (about 110 stop words dropped) between each unit and every earlier unit, reported for later sentences of 6 or more words and for any length.
- other-rule check: every phrase and regex rule of `core` is run over each file, ignoring `position` and `max_doc_words`, so it is stricter than the engine; `filler.004` is exempt in `filler-004-miss-01` only.
