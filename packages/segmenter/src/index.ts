/**
 * @prosegate/segmenter: decides what is prose, where sentences and paragraphs are, and how words
 * are counted. `analyse(text)` is pure, synchronous and linear in the input length.
 *
 * Choices the spec (11 section 6.2, 03, 04) left open, in one place:
 *
 * Partition
 * - Segments partition the text. Each segment starts where its content starts and runs to the next
 *   segment's start; the first starts at 0 and the last ends at text.length. So the whitespace-only
 *   gap between two blocks (the line break and any blank lines) is the tail of the PRECEDING
 *   segment, and leading whitespace belongs to the first segment. A prose segment's content never
 *   contains a blank line; only its trailing gap does. Units and paragraphs never include the gap.
 * - Empty text has no segments. Non-empty whitespace-only text is one prose segment with no units.
 * - A new prose segment starts at each blank line. Headings and list items stay in the prose
 *   segment they sit in (a heading directly above a paragraph shares its segment; a loose list is
 *   one segment per item).
 * - Segment content starts at the start of the line, indentation included (a fenced block inside a
 *   list item is a `code` segment that begins with its indentation). The one exception is a fence
 *   opened on a list-marker line ("- ```bash"): the marker stays in the preceding prose segment and
 *   the code segment starts at the fence.
 * - `tool_output` is never produced.
 *
 * Blocks
 * - Fences: ``` or ~~~ (3+), up to 3 spaces of indent, or any indent inside a list; the closer needs
 *   the same character, at least the opener's length, and nothing else on the line; unterminated
 *   fences run to the end. A backtick fence's info string cannot contain a backtick.
 * - Indented code: 4+ columns (tab = 4, NBSP = 1) after a blank line, at the start, or directly after
 *   an ATX heading, a setext underline or a thematic break; never in a list.
 * - A BOM at offset 0 and NBSP indentation are skipped when looking for block markers.
 * - YAML front matter (--- at offset 0, a key or comment on the next line, closed by --- or ...) is
 *   a `code` segment.
 * - Tables: a header row and a delimiter row with the same cell count; rows continue while they
 *   contain `|`. A table may interrupt a paragraph, and may be indented inside a list.
 * - Blockquotes: lines starting with `>` plus CommonMark lazy continuation (a following plain text
 *   line joins the quote). A quote never contains another segment kind.
 * - List markers: - * + , 1. 1) and the typographic bullets • ‣ ◦ ▪ ● (followed by a space).
 * - Not handled (they stay prose): HTML blocks other than comments, footnote definitions, math blocks.
 *
 * Units
 * - heading: ATX (closing hashes trimmed) or setext, never split. list_item: one unit per item,
 *   continuation lines included, never split into sentences; task boxes are trimmed. sentence:
 *   everything else, split by the splitter. A text line directly after a list item (no blank line)
 *   is part of that item; an indented paragraph after a blank line inside a list is ordinary prose.
 * - Units with no word (an emoji-only line, a bare `...`) are dropped. `words` counts masked text.
 * - `text_start` is the offset of the first letter or digit of the unit; rules with
 *   `position: sentence_start` match there, so "**Great question!**" and "(Note that…)" start at G and N.
 * - A unit never spans a segment boundary. When an attributed quote cuts a sentence, list item or
 *   paragraph, the pieces are separate units: every piece after a quote has `continuation: true`,
 *   every piece before a quote has `continued: true` (a middle piece has both). The engine should
 *   not treat a `continuation` unit as a sentence start, and should not count a continuation
 *   list_item as a further bullet.
 *
 * Paragraphs (the closing_similarity contract)
 * - A paragraph is a run of units from one block inside one prose segment. `kind` is 'text', 'list'
 *   or 'heading'. `block_id` ('b1', 'b2', ... by first appearance) names the block: one text
 *   paragraph, one heading, or one list. A list keeps its block_id across blank lines (a loose list is
 *   one paragraph per item), indented code, an indented paragraph and quote segments; the pieces of
 *   a text paragraph that a quote cut share a block_id too. closing_similarity compares the first
 *   non-heading paragraph with the last non-heading BLOCK, merging all paragraphs that share its
 *   block_id. A paragraph never contains non-prose text.
 *
 * Splitter (see sentences.ts)
 * - Terminator runs of . ! ? … then closers ( " ' ) ] } * _ ~ and curly/guillemet closers ) stay
 *   with the sentence; the next sentence must start with an uppercase letter, digit, quote, bracket,
 *   an emphasis/code opener (* _ `) or an emoji / arrow (extensions of the spec list).
 * - Never break after e.g. i.e. vs. cf. approx. fig. vol. eq. ca. u.s. al. co. corp. esp. incl. viz.
 *   (any case), Mr. Mrs. Ms. Dr. Prof. Inc. Ltd. St. Jr. Sr. Dept. (capitalised), "No." or Jan.-Dec.
 *   before a digit. `a.m.`, `p.m.` and `etc.` end a sentence unless a weekday, a month name or a
 *   2-4 letter ALLCAPS token (a time zone) follows ("Meet at 9 a.m. Monday for the review.").
 * - A single capital (J., J.R.R.) is an initial, not a sentence end, when it is first in its unit or
 *   follows a capitalised word, another initial, or a name lead-in (by, and, with, from, of, said...),
 *   and the next word is not a sentence starter ("Appendix A. The next step" breaks) and not a
 *   lone capital without a dot. "Use option B. Otherwise..." and "Set it to X. Because..." break.
 * - Inline step numbers stay with their step: "Steps: 1. Install it. 2. Run it." gives the units
 *   "Steps: 1. Install it." and "2. Run it." (the number joins the FOLLOWING text, the lead-in joins
 *   the first step). A 1-2 digit number followed by a period is a step marker when it is first in
 *   the unit or follows : ; . ! ? that is not an abbreviation period.
 * - A sentence never ends inside Markdown link text ([Step 1. Install](#install)), inline code or
 *   an HTML comment.
 *
 * Quotes
 * - See inline.ts findQuotes. A double-quoted run of 3+ words becomes a `quote` segment only with a
 *   cue before it in the same sentence (named-source cue, at most 3 filler words; user cue, at most
 *   6) or a dash-and-Name credit after it. A run of 1-2 words needs a user cue (you said / asked /
 *   wrote / mentioned / requested / want / told me / noted, when you say, you've asked for) with at
 *   most 3 filler words. Pronouns and determiners are not Names ("He says" is not a cue).
 * - A cue line ending in a colon ("You asked:", "Your request:", "The docs say:") makes the next
 *   element (paragraph or list item) a quote when it is entirely a quoted run; it carries through
 *   consecutive such list items and is cancelled by anything else, including code.
 * - Added to the spec cue list: `say/state/write/note/read` after docs-like subjects, "<Name>'s docs
 *   say", "the error message says", "the documentation says", "your message/request says",
 *   "in your words:", "your request:", "quoting you:", "Dr./Mr./Prof." inside "as X put it", and an
 *   opener right after ** * _ or ( .
 *
 * Masks, bold
 * - Masks never cross segment boundaries; masks inside a quote segment are dropped. Kinds:
 *   inline_code, url, email, path, and `html_comment` (an addition to the 11 list: <!-- ... -->, an
 *   unclosed one runs to the end of its paragraph). Paths: a whitespace-delimited token with `/`
 *   or `\` and a dotted extension containing a letter, or a bare token with a known extension; a
 *   Markdown link [text](dest) is two tokens. `:12` line suffixes are part of the mask.
 * - Bold is `**x**`, `***x***` and `__x__` (intraword underscores never open or close). Spans that
 *   overlap a quote segment are dropped first; of nested spans only the outermost is reported.
 *
 * Language
 * - From 40 prose words: `non_en` only when the English function-word share (outside masks) is
 *   below 0.15 AND a second signal agrees: another language's function-word share (de fr es pt it
 *   nl) beats the English share and is at least 0.10, or more than 0.3 of the letters are
 *   non-Latin. Terse English with few function words stays `en`. Below 40 words `unknown`. Prose
 *   segments are never dropped for non_en; the engine maps non_en to skipped / no_prose. If every
 *   token is masked the answer is `en`. Unspaced scripts (Chinese, Japanese) have few "words" by the
 *   word definition, so most such texts stay `unknown` and are caught by the word floors instead.
 *
 * Word counts
 * - [\p{L}\p{N}][\p{L}\p{N}\p{M}]* joined by an internal ' ’ U+02BC - U+2010 or U+2011, so a
 *   decomposed "cafés" is one word and "no‑break" is one word. A decimal "3.5" counts as two words.
 */

import { schemaPlaceholder } from "@prosegate/schema";

export { analyse } from "./analyse.js";
export { countWords, normalizeForMatching } from "./words.js";
export type { Analysis, Mask, Paragraph, Span, Unit } from "./types.js";

/**
 * Kept so the sibling packages that still import the Phase-0 placeholder keep compiling.
 * Not part of the segmenter API; removable once those packages stop referencing it.
 */
export const segmenterPlaceholder = {
  id: "prosegate:segmenter:placeholder",
  uses: [schemaPlaceholder.id] as readonly string[],
} as const;
