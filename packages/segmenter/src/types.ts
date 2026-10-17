import type { Segment } from "@prosegate/schema";

/** A sentence-like unit inside a prose segment. */
export interface Unit {
  segment_id: string;
  /** UTF-16 offsets into the original text, end exclusive; trimmed of surrounding whitespace and list/heading markers. */
  start: number;
  end: number;
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
}

/** A run of units in one prose segment that is not interrupted by a list, a heading or a quote segment. */
export interface Paragraph {
  segment_id: string;
  start: number;
  end: number;
  unit_indexes: number[];
}

export interface Mask {
  start: number;
  end: number;
  kind: "inline_code" | "url" | "path" | "email";
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
  /** `**x**` / `__x__` spans (markers included) in prose. */
  bold: Span[];
  /** Words in prose units (headings included). */
  prose_words: number;
  /** 'unknown' when fewer than 40 prose words. */
  language: "en" | "non_en" | "unknown";
}
