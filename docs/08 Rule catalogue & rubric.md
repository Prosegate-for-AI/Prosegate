# 08 — Rule catalogue v0 and reviewer rubric

## Pack `core` 0.1.0

Twenty-three deterministic rules across six categories, each with a hit and a miss, plus the reviewer rubric for the three judgement categories. This is the product; the rest of the design is plumbing for it. Every rule here has a false-positive budget in 10; a rule that exceeds it on the human control set is pulled from the pack, not softened.

Conventions (ADR-15): all matching is case-insensitive on the normalised text (curly quotes and NBSP-class spaces folded); phrase matches are word-bounded at word-character edges only; regexes are RE2, written lowercase, and the span is the named group `(?P<span>…)` if present, else the whole match. Rules that list both phrases and a regex use match kind `any`. `allow_terms` in the profile exempt any `vocab` match. Instruction text is what the model sees verbatim.

**Additions after the realistic false-positive and recall reviews** (ADR-24, ADR-26). These are in the shipped `core.yaml`, which is normative for phrase lists; ids, severities and instruction texts below are unchanged.
- filler.001 (sentence-initial): that's a great question, good question, excellent question, really good question, good catch, you're absolutely right, of course!, sure!, happy to help, certainly., absolutely.
- filler.002 (closing): let me know if you have any other questions, let me know if you'd like, hope that helps, i hope that helps, hopefully this helps, feel free to ask.
- filler.003: "in this response" and "the following is" match at sentence start only.
- filler.004 (sentence-initial, short documents): in short, to sum up, in a nutshell, simply put, the bottom line is.
- hedge.001: it's also worth noting; please note that, keep in mind that and it's important to remember (sentence-initial).
- hedge.003: notably, and interestingly, (sentence-initial). hedge.004: can potentially.
- vocab.001: we'll/you'll/they'll/then before "leverage"; empowers. vocab.002: up to two words between the determiner and "landscape"; silver bullet. vocab.003: blazing-fast. vocab.005: a wide array of, numerous.
- triad.001: words may be hyphenated. triad.002: "; " and an em dash as separators; "not only … but also" without a comma.

### filler

| ID | Match | Hit | Miss | Severity | Instruction |
| --- | --- | --- | --- | --- | --- |
| `core.filler.001` | phrase, sentence-initial: "let's dive in", "let's dive into", "let's explore", "great question", "certainly!", "absolutely!", "sure thing", "i'd be happy to", "i'd be glad to" | "Great question! Let's dive into the cache layer." | "The cache layer is per tenant." | block | remove: "Remove. Start with the answer." |
| `core.filler.002` | phrase, last 2 sentences: "i hope this helps", "hope this helps", "feel free to reach out", "let me know if you have any questions", "happy to help", "don't hesitate to" | "Let me know if you have any questions!" | "Reply by Thursday if the dates don't work." | block | remove: "Remove. End on the last substantive point." |
| `core.filler.003` | phrase: "as an ai", "as a language model", "this document outlines", "in this section we will", "in this response", "the following is" | "This document outlines the migration plan." | "The migration runs in three phases." | block | remove: "Remove the meta-commentary; state the content directly." |
| `core.filler.004` | phrase, sentence-initial, document under 400 words: "in conclusion", "to summarize", "in summary", "overall," | "In summary, the fix is safe." (in a 120-word reply) | "In summary, …" (in a 900-word doc) | warn | remove: "Remove; a reply this short needs no summary." |

### hedge

| ID | Match | Hit | Miss | Severity | Instruction |
| --- | --- | --- | --- | --- | --- |
| `core.hedge.001` | any: regex `\b(?:it's\|it is) (?:important to note\|worth noting\|worth mentioning)(?: that)?,?` and `\bit should be noted(?: that)?,?`; phrase "note that" (sentence-initial) | "It's worth noting that the index is unique." | "The index is unique." | block | remove: "Remove the preamble; keep the clause after it." |
| `core.hedge.002` | regex: `\b(?P<span>somewhat\|fairly\|relatively)\s+[a-z]+` ("rather" dropped: "rather than", ADR-15) | "The query is relatively slow." | "The query takes 400 ms." | warn | specify: "Replace the qualifier with the measurement or the plain adjective." |
| `core.hedge.003` | phrase: "arguably", "generally speaking", "in many cases", "it could be argued", "to some extent", "in a sense" | "Arguably, the retry is unnecessary." | "The retry is unnecessary." | warn | remove: "Remove the hedge or state who argues it and why." |
| `core.hedge.004` | regex: `\b(may or may not\|could potentially\|might possibly\|can possibly)\b` | "This could potentially break the build." | "This breaks the build when X." | block | replace: "Pick one: say whether it does, and under what condition." |
| `core.hedge.005` | regex: `\bit depends[.!]` (sentence ends immediately) | "It depends." | "It depends on whether the table is partitioned." | warn | specify: "Say what it depends on, in the same sentence." |

### vocab

| ID | Match | Hit | Miss | Severity | Instruction |
| --- | --- | --- | --- | --- | --- |
| `core.vocab.001` | any: phrase, verbs: delve, delves, delved, delving, leverages, leveraged, leveraging, utilize, utilizes, utilized, utilizing, utilise, utilises, utilised, utilising, foster, fosters, fostered, fostering, streamline, streamlines, streamlined, streamlining, bolster, bolsters, bolstered, elevate, elevates, elevated, elevating; regex `\b(?:to\|can\|could\|should\|will\|would\|we\|you\|they\|i\|us) (?P<span>leverage)\b`; regex `\b(?P<span>underscore[sd]) (?:the\|that\|how\|why\|a\|an\|our\|its\|this)\b` | "We can leverage the existing cache." | "We can use the existing cache." | warn | replace: "Use the plain verb (use, build, support, speed up)." |
| `core.vocab.002` | any: phrase, nouns: tapestry, realm, testament, synergy, paradigm shift, game-changer, cornerstone; regex `\b(?:the\|this\|today's) (?:current \|modern \|evolving \|changing )?landscape\b` | "The current landscape of auth libraries…" | "Three auth libraries fit: …" | warn | replace: "Name the concrete thing instead of the abstraction." |
| `core.vocab.003` | phrase, adjectives: robust, seamless, seamlessly, crucial, pivotal, nuanced, holistic, cutting-edge, comprehensive, meticulous, ever-evolving | "A robust and seamless integration." | "The integration retries on 5xx and is idempotent." | warn | specify: "Replace with the property that makes it so, or remove." |
| `core.vocab.004` | any: phrase, intensifiers: truly, genuinely, incredibly, remarkably, extremely; regex `\b(?P<span>highly) (?:effective\|efficient\|scalable\|recommended\|likely\|unlikely)\b` | "This is incredibly useful." | "This saves 20 minutes per deploy." | warn | remove: "Remove the intensifier." |
| `core.vocab.005` | phrase: "a wide range of", "a variety of", "a plethora of", "a myriad of", "a number of", "various" | "There are a number of options." | "There are three options." | warn | specify: "Give the count or the items." |

### triad

| ID | Match | Hit | Miss | Severity | Instruction |
| --- | --- | --- | --- | --- | --- |
| `core.triad.001` | regex `\b[a-z]{1,12}, [a-z]{1,12},? and [a-z]{1,12}\b`; `sentence_exclude: \d`; `sentence_max_words: 25` | "It is fast, simple, and reliable." | "It is fast, simple, and reliable on 3 runners." ("Install git, node, and pnpm." is a known false positive kept in the adversarial corpus; budget in 10) | warn | shorten: "Keep the one that matters, or give evidence for each." |
| `core.triad.002` | regex: `\bnot (?:just\|only\|merely\|about) .{3,80}?, (?:but\|it's about\|it is about)\b` | "It's not just about speed, it's about trust." | "Not only did the test fail, the build did too." (narrative, no antithesis) | warn | rephrase: "State the point directly without the contrast." |
| `core.triad.003` | any: phrase "whether it's", "whether you're"; regex `\bfrom [a-z]+ to [a-z]+, (?:and )?[a-z]+` | "Whether it's a startup or an enterprise…" | "Whether the flag is set decides the path." | info | rephrase: "Name the actual case instead of the range." |

### structure

| ID | Match | Hit | Miss | Severity | Instruction |
| --- | --- | --- | --- | --- | --- |
| `core.structure.001` | document\_metric `headers_per_100_words` above 1.5, min 8 sentences | A 300-word reply with six headings | A 1,200-word doc with six headings | warn | restructure: "Remove headings; this is short enough to read as prose." |
| `core.structure.002` | document\_metric `bullet_ratio` above 0.6, min 8 sentences, `min_item_words: 6` | A reply that is 80% bullets | A list of 12 config keys under one sentence | warn | restructure: "Rewrite as prose; keep a list only where the items are parallel." |
| `core.structure.003` | document\_metric `sentence_length_cv` below 0.25, min 10 sentences | Ten sentences of 18–22 words | Ten or more sentences of 6, 24, 11, 31… words | warn | rephrase: "Vary sentence length; combine or split so the rhythm is uneven." |
| `core.structure.004` | document\_metric `closing_similarity` above 0.75, min 6 sentences, at least 3 non-heading blocks (ADR-24, ADR-25) | Last paragraph restates the first | Last paragraph gives the next step | block | remove: "Remove the closing paragraph; it restates the opening." |
| `core.structure.005` | document\_metric `bold_per_100_words` above 3, min 6 sentences | Seven bolded phrases in 150 words | One bolded warning | warn | remove: "Remove bold except for the one thing a reader must not miss." |

### repetition

| ID | Match | Hit | Miss | Severity | Instruction |
| --- | --- | --- | --- | --- | --- |
| `core.repetition.001` | sentence\_metric `similarity_to_prior` above 0.7 (bag-of-words cosine over content words, engine stop-word list, to any earlier sentence in the turn), `min_words: 6` on the later sentence; skipped above 6,000 prose words | "The cache is per tenant. … Each tenant has its own cache." | Two sentences sharing only stop words | warn | merge: "Remove this sentence or merge it with the earlier one that says the same thing." |

## Default profile membership

Starter profiles ship with the adapter. Cells show the category severity each profile sets; blank means the pack default from 03.

| Category | `base` | `pr-description` | `design-doc` | `email` | `chat-reply` |
| --- | --- | --- | --- | --- | --- |
| filler |  |  |  | 002 → info (sign-offs allowed) |  |
| hedge |  |  | 003 → info (positions argued) |  |  |
| vocab |  |  | `comprehensive` allowed |  |  |
| triad |  |  |  |  |  |
| structure |  | 001, 002 → info (PR templates use headings and a change list; ADR-24) | 001, 002 → info (headings expected) | 001 → block | 005 → block |
| repetition |  |  |  |  |  |
| reviewer `register.max_words` | 600 | 300 | 2,500 | 200 | 250 |

## Reviewer rubric

The reviewer sees four blocks: the user's last message, the style constraints, the profile's register specification, and the draft with code blocks replaced by `[code block omitted]`. It returns spans by text, not offset; the adapter re-finds each span in the original draft and drops any it cannot find once, counting the miss in telemetry.

System prompt, version `reviewer_prompt/1`, shipped with the pack and pinned by the profile:

```text
You review a draft response an AI assistant is about to send. You do not rewrite anything. You return findings: exact spans from the draft, each with a category, a severity, and an instruction the assistant can act on without reading your reasoning.

Use only these categories:

unsupported_claim — a factual assertion presented as settled with no basis in the draft, the user's message or the constraints. action: cite_or_soften_or_remove. instruction must be exactly: "Cite a source you actually have, restate this as expectation or opinion, or remove it. Do not invent a citation."

vague_claim — the user asked for something specific (a number, a file, a name, a date, a command) and the span answers generically. action: specify. instruction: "Give the specific detail the question asked for (<what was asked>). If you do not have it, say so in one clause instead of generalising." Fill the angle brackets from the user's message.

register — the draft's length, tone or format conflicts with the register specification or with what the user's message plainly calls for. action: shorten, restructure or rephrase. instruction: one imperative sentence naming the conflict and the target (for example "Cut to under 300 words; the profile is a PR description.").

Rules:
1. span_text is an exact, contiguous substring of the draft, at most 240 characters, never crossing a code block placeholder.
2. At most 6 findings. Choose the ones that most change what a reader takes from the draft.
3. Never flag: text inside code blocks; text the draft quotes from the user or from a named source; claims the user's own message asserted; hedging about things that are uncertain.
4. Never flag vocabulary, filler, hedging style, lists or headings. Deterministic rules own those.
5. confidence is in [0, 1]. Omit any finding below 0.6.
6. evidence is one sentence of at most 25 words saying why.
7. Output JSON only, matching the schema. No prose before or after. An empty findings array is a correct and common answer.
```

Output schema the model is held to (structured output where the provider supports it; otherwise validated and retried once):

```json
{
  "findings": [
    {
      "span_text": "string",
      "category": "unsupported_claim | vague_claim | register",
      "severity": "block | warn",
      "confidence": 0.0,
      "action": "cite_or_soften_or_remove | specify | shorten | restructure | rephrase",
      "instruction": "string",
      "evidence": "string"
    }
  ]
}
```

The adapter enforces, after parsing: `unsupported_claim` must carry the exact fork text or the finding is rewritten to it; severity for `register` is capped at `warn` regardless of what the model returns; any category outside the three is dropped; a span that matches more than once in the draft is attached to the first occurrence.

Model requirements: JSON-mode or structured output, 8k-token context, p95 latency under 3 s on a 1,500-word draft. The prompt is tested against one small OpenAI model and one small Anthropic model on every pack release (10); a model that fails the rubric eval is listed as unsupported in the config UI rather than silently degraded.
