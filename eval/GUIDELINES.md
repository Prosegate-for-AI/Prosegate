# Annotation guidelines, version 1

Annotate a specific problem in the draft using the request, supplied facts, constraints and selected
profile. Read the whole document. Mark the smallest span that demonstrates the issue; preserve its
exact spelling and punctuation. Do not mark code, quotations, tables or a user's own words as the
assistant's prose. A clean document is a valid result.

Two people mark each item independently, including a deliberate empty list when appropriate. A third
person adjudicates every pair, even identical ones, and records a rationale. Repeated disagreements
require a guideline revision and fresh annotation; do not tune labels to improve a rule's score.
The rule catalogue in `docs/08 Rule catalogue & rubric.md` is the reference for deterministic rules.

| Category | Worked example and mark | Why; boundary |
| --- | --- | --- |
| filler | In “Great question! The cache expires after ten minutes.” mark “Great question!” (`core.filler.001`). | Empty preamble. “The question is whether the cache expires” is substantive. |
| hedge | In “It is worth noting that the cache is shared.” mark “It is worth noting that”. | This delays the claim. Genuine uncertainty such as “The cache may be stale” is not the target. Check the catalogue before attaching an exact rule ID. |
| vocab | In “We leverage the existing index.” mark “leverage”. | A house-style word choice; do not flag a quoted term, proper name or profile-allowed term. |
| triad | In prose repeatedly padded by three-part lists, mark the redundant span, for example “fast, flexible, and powerful”. | A necessary list of three concrete requirements is not a tic. Judge redundancy in the whole document; a single phrase alone does not establish a hit. |
| structure | When a short answer adds “In summary” and restates the preceding answer, mark the redundant closing paragraph. | Headings in a requested design document may be appropriate. Use the profile and whole-document rule. |
| repetition | In adjacent paragraphs making the same point, mark the second unnecessary statement. | Restating a constraint before applying it may be useful. Mark the repeated claim, not common vocabulary. |
| unsupported_claim | With no measurement in context, “The new index cuts latency by 70%.”: mark the sentence. | The number has no supplied basis. User-provided measurements, attributed quotations and explicitly uncertain estimates are different. Never invent evidence. |
| vague_claim | User asks “Which file contains the timeout?”; answer “The relevant configuration contains it.”: mark the sentence. | The requested filename is missing. If unknown, say so. Generic explanations are acceptable when requested. |
| register | User requests one sentence; the draft adds a long introductory paragraph: mark that paragraph. | Record the concrete conflict with the request/profile. Do not penalize dialect, fluency or formality by itself. |

Use a `rule_id` only when the catalogue identifies that exact rule. Otherwise mark the category.
Never attach a different category's rule ID. UTF-16 offsets refer to the original Markdown, including
newlines; the CLI checks ranges, surrogate boundaries and an optional exact `text` field.

## Agreement and gating

Cohen's κ is computed per category over fixed non-whitespace tokens in the original draft.
A token is positive when any mark of that category overlaps it. This includes true negatives and gives
both raters the same units; it measures category/span agreement, not exact-boundary agreement.
Perfect all-negative ratings have undefined κ, reported as `null`, not 1.

A category with κ below 0.6 or undefined cannot qualify a precision/recall gate. Repair the guideline
and collect positive/negative examples. Reviewer precision and recall use maximum one-to-one
matching of same-category spans with at least half of the predicted span covered by gold. Duplicate
predictions cannot confirm the same gold twice. Rule matching retains `corpora/README.md` definitions.

## Rewrite review

For the deterministic 10% human sample, compare the request, original and revision. Reject meaning
preservation if a fact disappears or a claim changes. Mark fabrication if the revision adds a citation,
number or factual assertion without context support. Inspect every flagged fabrication case before
promoting it into the rubric; it still needs two independent annotations and adjudication.

Keep private writing in a private sibling corpus. Source-code repository licensing does not necessarily
cover PR discussion or mailing-list prose. Record actual permission evidence; public availability
does not itself grant redistribution.
