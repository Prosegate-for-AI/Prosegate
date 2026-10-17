# 04 — Profile and rule-pack schema

## Two documents, one resolver

A rule pack says what to detect; a profile says which packs apply, how severe each finding is, and how the reviewer judges register. Both are YAML, both are versioned, and the adapter resolves them into one immutable snapshot per session. The resolver is the only code that reads either format; everything downstream sees the resolved profile.

Free-tier users keep both kinds of file under `~/.prosegate/`; signed-in users get them from the config service (06) with local files overlaid on top. Same schema either way.

## Rule pack

```yaml
schema: prosegate.rulepack/1
id: core                         # [a-z0-9-]{1,31}, unique per publisher
version: 0.3.0                   # semver
findings_schema: 1               # the findings version its instructions target (03)
rules:
  - id: core.hedge.001           # <pack>.<category>.<nnn>; never reused once published
    category: hedge
    severity: block
    match:
      kind: phrase
      phrases: ["it's important to note", "it is worth noting", "it should be noted"]
      boundary: word
      case_insensitive: true
    instruction: { action: remove, text: "Remove." }
    examples:
      hit:  ["It's important to note that the cache is per tenant."]
      miss: ["Note the cache is per tenant."]

  - id: core.structure.002
    category: structure
    severity: warn
    match:
      kind: document_metric
      metric: bullet_ratio       # list items / sentences
      above: 0.6
      min_sentences: 8
    instruction: { action: restructure, text: "Rewrite as prose; keep a list only where the items are parallel." }
    examples:
      hit:  ["<eval corpus ref: core/structure-002-hit-01>"]
      miss: ["<eval corpus ref: core/structure-002-miss-01>"]
```

Match kinds, all deterministic and bounded in time:

| Kind | Fields | Span it produces |
| --- | --- | --- |
| `phrase` | `phrases[]`, `boundary: word \| none` (checked only at word-character edges), `case_insensitive` (must be `true` in v0), `position: any \| sentence_start \| closing` (closing = last two sentences), `max_doc_words` (rule inactive above it), `sentence_max_words`, `sentence_exclude` (RE2 pattern; a sentence containing a match is skipped) | The matched phrase |
| `regex` | `pattern` (RE2 syntax, lowercase: no backreferences, no lookaround), plus the same `position`, `max_doc_words`, `sentence_max_words`, `sentence_exclude` | The named group `(?P<span>…)` if present, else the whole match |
| `any` | `parts[]`: phrase or regex matches (no nesting), each with its own filters | Whichever part matched (ADR-15) |
| `sentence_metric` | `metric`, `above` or `below`, optional `pattern` | The whole sentence |
| `document_metric` | `metric`, `above` or `below`, `min_sentences` | The first sentence of the document |

All matching is case-insensitive on the segmenter's normalised, ASCII-lowercased copy of the text (offsets unchanged); spans are sliced from the original (ADR-15). Sentence metrics in v0: `word_count`, `starts_with` (pattern), `comma_count`, similarity\_to\_prior (bag-of-words cosine over content words, using the engine's published stop-word list, to any earlier sentence in the turn; optional `min_words` on the later sentence). Document metrics in v0: `bullet_ratio` (optional `min_item_words`: only items with at least that many words count), `headers_per_100_words`, `sentence_length_cv` (coefficient of variation, low = uniform), `closing_similarity` (cosine similarity of last paragraph to first, bag of words), bold\_per\_100\_words. The engine rejects a pack that names a metric it does not implement.

Every rule ships with at least one `hit` and one `miss` example. The eval harness (10) runs them on every pack change; a rule whose examples fail is not published. Long examples live in the eval corpus and are referenced by id.

## Profile

```yaml
schema: prosegate.profile/1
id: org-default/pr-description   # <namespace>/<slug>, each [a-z0-9-]{1,31}; namespace = account or org
version: 4                       # integer, server-assigned on save
name: PR description
extends: org-default/base        # single parent; chain depth ≤ 3 (base → domain → project)

trigger:
  description: "Writing a pull request title or description, a commit message, or a changelog entry"
  patterns: ["pull request", "PR description", "commit message", "changelog"]
  harness_hints: ["git_commit", "gh_pr_create"]   # tool names in the turn that imply this domain
  sticky: true                   # false = one-shot; reverts to the previous profile after the turn

rule_packs:
  - { id: core, version: ">=0.3.0 <1.0.0" }
  - { id: engineering-docs, version: "0.1.x" }

overrides:
  categories:
    triad:     { severity: info }
    structure: { severity: block }
  rules:
    core.vocab.004: { enabled: false }
  allow_terms: ["robust", "idempotent"]        # exempt from vocab rules; union with parents
  thresholds:
    token_floor_words: 40
    reviewer_floor_words: 120

reviewer:
  enabled: true
  categories: [unsupported_claim, vague_claim, register]
  register:
    max_words: 300
    tone: "terse, imperative, no pleasantries"
    format: "title line, blank line, body; a bulleted list only for the list of changes"

enforcement:
  mode: enforce                  # enforce | advisory
  pass_cap: 2
  render: diff                   # diff | summary | none; headless always renders summary
```

`trigger.description` is what the model reads when choosing with `select_profile`; `patterns` and `harness_hints` are what the adapter's heuristics read. Keep the description to one sentence a model can match against the user's ask.

## Inheritance and resolution

Resolution walks `extends` from the leaf to the root, then merges root-first so the leaf wins:

- `rule_packs`: union by `id`; on conflict the child's version range wins. Two ranges with no intersection → resolution error, profile unusable, user told which pair.
- `overrides.categories`, `overrides.rules`, `overrides.thresholds`: deep merge, child wins per key.
- `overrides.allow_terms`: union.
- `reviewer.register`: child replaces whole object if present.
- `reviewer.enabled`, `reviewer.categories`, `enforcement.*`, `trigger.*`: child replaces if present.

A cycle or a chain deeper than three is a resolution error. The resolved snapshot carries `id` = leaf id, `version` = `<leaf version>+<sha of resolved content, 8 hex>`, and `resolved_from` = the chain root first; those three are what `ReviewResult.profile` reports (03).

## Selection and hysteresis

State lives in the adapter: `active_profile`, `previous_profile`, `candidate` and `candidate_streak`.

1. Session start: `active_profile` = the last profile used for this working directory, else the account's default, else `<namespace>/base`.
2. Turn start: the adapter scores each profile's `patterns` against the user message and its `harness_hints` against tool calls so far. If the top-scoring profile differs from `active_profile`:
   - a hint match or a pattern match with two or more distinct phrases → confident; request selection now;
   - otherwise it becomes `candidate`; on the second consecutive turn with the same candidate, request selection.
3. Requesting selection = injecting one line at turn start: "Call `select_profile` before writing; the active profile may not match this task." The model's choice is authoritative and takes effect immediately.
4. The model may call `select_profile` at any turn without being asked.
5. A `sticky: false` profile reverts to `previous_profile` after the turn's review completes.
6. `prosegate profile <id>` from the terminal sets `active_profile` for the session and clears the candidate state.

Nothing is reviewed with no active profile; the fallback is always `<namespace>/base`, which ships in the adapter.

## Versioning, pinning and caching

- Rule packs are semver. A profile pins a range; the adapter resolves the highest cached version in range. A pack bumps its major version when it removes or renames a rule id or requires a newer findings schema.
- Profiles are integer-versioned by the server on every save. The adapter fetches at session start with `If-None-Match`; mid-session server changes apply at the next session or on `prosegate reload`.
- The adapter bundles `core` at a known version and `<namespace>/base` so the free tier and offline sessions work with no fetch.
- Local YAML overlays sync: a local file with the same `id` as a synced profile is merged as a child of it (local wins); a local pack with the same `id` as a synced pack is a version conflict and is rejected with a message naming both.
- Each resolved snapshot is written to `~/.prosegate/sessions/<session_id>/profile.json` so a turn-end hook in a fresh process reads the same profile the turn started with.
