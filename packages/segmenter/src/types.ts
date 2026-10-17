import type { Segment } from "@prosegate/schema";

/** A sentence-like unit inside a prose segment. */
export interface Unit {
  segment_id: string;
  /** UTF-16 offsets into the original text, end exclusive; trimmed of surrounding whitespace and list/heading markers. */
  start: number;
  end: number;
  /**
   * Added field. Offset of the first word character (a letter or digit) of the unit, skipping
   * `* _ ~ " ' ( [ “ ‘`, backticks, emoji, symbols and any other leading non-word characters.
   * `position: sentence_start` rules match at `text_start`: start <= text_start < end.
   */
  text_start: number;
  kind: "sentence" | "list_item" | "heading";
  /** countWords() of the slice (masked text such as inline code and URLs is counted). */
  words: number;
  /**
   * Added field (not in the 11 spec). True when this unit does not begin its sentence / list item /
   * heading because an attributed quote segment cut it in two (units cannot span segments). The
   * engine should not treat such a unit as a sentence start and should not count a continuation
   * `list_item` unit as a second list item.
   */
  continuation: boolean;
  /**
   * Added field, the mirror of `continuation`: true when an attributed quote segment follows this
   * piece inside the same sentence / list item, i.e. the unit is cut short before the quote and
   * does not end where its sentence ends. A middle piece has both flags.
   */
  continued: boolean;
}

/**
 * A run of units in one prose segment from one block: one text paragraph, one heading, or one list.
 * `kind` says which; `block_id` identifies the block across segments, so the consecutive list
 * paragraphs of one list (tight or loose, interrupted by code or an attributed quote) share a
 * `block_id`, as do the pieces of a text paragraph that a quote cut. Consumers that need "the last
 * block" (closing_similarity) merge consecutive paragraphs with the same `block_id`.
 */
export interface Paragraph {
  segment_id: string;
  kind: "text" | "list" | "heading";
  /** 'b1', 'b2', ... in order of first appearance. */
  block_id: string;
  start: number;
  end: number;
  unit_indexes: number[];
}

export interface Mask {
  start: number;
  end: number;
  /** `html_comment` is an addition to the 11 list: `<!-- … -->`, unclosed ones run to the end of the paragraph. */
  kind: "inline_code" | "url" | "path" | "email" | "html_comment";
}

export interface Span {
  start: number;
  end: number;
}

export interface Analysis {
  /** The input, unchanged. */
  text: string;
  /** normalizeForMatching(text): same length, same offsets. */
  normalized: string;
  /** Partition of the whole text: every code unit is in exactly one segment, in order, ids s1..sn. */
  segments: Segment[];
  /** Prose units only, document order. */
  units: Unit[];
  /** Prose paragraphs, document order. */
  paragraphs: Paragraph[];
  /** Spans inside prose that rules must not match inside. Never cross a segment boundary. */
  masks: Mask[];
  /** `**x**` / `__x__` spans (markers included) in prose; only the outermost of nested spans. */
  bold: Span[];
  /** Words in prose units (headings included). */
  prose_words: number;
  /** 'unknown' when fewer than 40 prose words. */
  language: "en" | "non_en" | "unknown";
}
