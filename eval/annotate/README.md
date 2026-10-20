# Annotation CLI

Read [the guidelines](../GUIDELINES.md) before marking text. Run one document at a time:

```text
pnpm eval:annotate --document eval/staging/run/ai/base/item.md --context eval/staging/run/.prompts/prompt.json --annotator alice
```

The terminal displays the request, constraints and draft, without the generating model or another
annotator's marks. `find <exact text>` prints all matching start/end offsets. Enter
`category start end [rule_id]`, `undo`, then `done`. Offsets are UTF-16 code units, end exclusive.
Alternatively supply `--marks path/to/spans.json`. An empty array means the annotator reviewed the
document and found no issues; it must not be created automatically for an unreviewed draft.

A second person runs the same command with a different identity. Records are immutable under
`.annotations/<item>/<identity>.json` and bind to the draft and saved context SHA-256. AI/rubric
qualification requires `--context`; changing the request or constraints invalidates the ratings.
Use anonymous item names;
the CLI hides provenance, but it is not an access-control boundary against someone reading files.
Keep model metadata away from annotators when distributing assignments. Identities are self-attested.

A third person compares the two records and saves adjudicated marks:

```text
pnpm eval:annotate --document eval/staging/run/ai/base/item.md --context eval/staging/run/.prompts/prompt.json --adjudicator casey --marks resolved-spans.json --note "Removed the register mark: the user requested a formal tone."
```

This creates the adjacent `.gold.json` and an adjudication receipt binding both original annotations,
the document and final gold. Changing any of these invalidates qualification. Never overwrite an
annotation to hide a disagreement; create a new document revision and annotate it again.

Gold format:

```json
[{"category":"filler","rule_id":"core.filler.001","start":0,"end":15,"text":"Great question!"}]
```

Import completed items with `pnpm eval:import`; see [the workflow](../README.md).
