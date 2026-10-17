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
 *   list item is a `code` segment that begins with its indentation).
 * - `tool_output` is never produced.
 *
 * Blocks
 * - Fences: ``` or ~~~ (3+), up to 3 spaces of indent, or any indent inside a list; the closer needs
 *   the same character, at least the opener's length, and nothing else on the line; unterminated
 *   fences run to the end. A backtick fence's info string cannot contain a backtick.
 * - Indented code: 4+ columns (tab = 4) after a blank line or at the start, never in a list.
 * - Tables: a header row and a delimiter row with the same cell count; rows continue while they
 *   contain `|`. A table may interrupt a paragraph.
 * - Blockquotes: lines starting with `>` plus CommonMark lazy continuation (a following plain text
 *   line joins the quote). A quote never contains another segment kind.
 * - Not handled (they stay prose): HTML blocks and comments, YAML front matter (its closing --- reads
 *   as a setext underline), footnote definitions, bullet characters other than - * +.
 *
 * Units
 * - heading: ATX (closing hashes trimmed) or setext, never split. list_item: one unit per item,
 *   continuation lines included, never split into sentences; task boxes are trimmed. sentence:
 *   everything else, split by the splitter. A text line directly after a list item (no blank line)
 *   is part of that item; an indented paragraph after a blank line inside a list is ordinary prose.
 * - Units with no word (an emoji-only line, a bare `...`) are dropped. `words` counts masked text.
 * - A unit never spans a segment boundary. When an attributed quote cuts a sentence, list item or
 *   paragraph, the pieces are separate units and every piece after the quote has
 *   `continuation: true` (added field, see Unit). The engine should not treat those as sentence
 *   starts, and should not count a continuation list_item as a further bullet.
 *
 * Splitter (see sentences.ts)
 * - Terminator runs of . ! ? … then closers ( " ' ) ] } * _ ~ and curly/guillemet closers ) stay
 *   with the sentence; the next sentence must start with an uppercase letter, digit, quote, bracket
 *   or an emphasis/code opener (* _ `, an extension of the spec list).
 * - Never break after e.g. i.e. vs. cf. approx. fig. vol. eq. ca. u.s. (any case), Mr. Mrs. Ms. Dr.
 *   Prof. Inc. Ltd. St. Jr. Sr. Dept. (capitalised), "No." or Jan.-Dec. before a digit, or an
 *   initial (J., J.R.R.) before a name. `etc.`, `a.m.` and `p.m.` DO end a sentence when an uppercase
 *   word follows (the spec lists them among the abbreviations; ending sentences on them is far more
 *   common in model output than continuing). An initial does not veto before a sentence starter
 *   ("Appendix A. The next step") or before a lone capital ("A. A few").
 *
 * Quotes
 * - See inline.ts findQuotes. A double-quoted run of 3+ words becomes a `quote` segment only with a
 *   cue before it in the same sentence (cue, at most 3 filler words, then the quote) or a
 *   dash-and-Name credit after it. Pronouns and determiners are not Names ("He says" is not a cue).
 *   Added beyond the spec list: `say` for "the docs say", "Dr./Mr./Prof." inside "as X put it".
 *
 * Paragraphs
 * - A paragraph is a maximal run of units that came from one paragraph element and sit in one prose
 *   segment. Each heading is its own paragraph. A list block (consecutive list items not separated
 *   by a heading, a rule or a segment break) is one paragraph, so a loose list or a list split by a
 *   fence gives one paragraph per piece. A paragraph cut by an attributed quote becomes one paragraph
 *   per prose piece, so a paragraph never contains non-prose text.
 *
 * Masks, bold
 * - Masks never cross segment boundaries; masks inside a quote segment are dropped. Paths: a
 *   whitespace-delimited token with `/` or `\` and a dotted extension containing a letter, or a bare
 *   token with a known extension; a Markdown link [text](dest) is two tokens. `:12` line suffixes are
 *   part of the mask. Bold is `**x**`, `***x***` and `__x__` (intraword underscores never open or
 *   close); a bold span that overlaps a quote segment is dropped.
 *
 * Language
 * - From 40 prose words: `non_en` if fewer than 15% of word tokens (outside masks) are in the
 *   stop-word list, else `en`; below 40 words `unknown`. Prose segments are never dropped for
 *   non_en; the engine maps non_en to skipped / no_prose. If every token is masked the answer is `en`.
 *
 * Word counts
 * - Exactly [\p{L}\p{N}]+ joined by an internal ' ’ or -. U+2010/U+2011 do not join, combining marks
 *   do not extend a word (a decomposed "é" still counts once because the mark ends the word, but
 *   "cafés" counts twice), and a decimal "3.5" counts as two words.
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
