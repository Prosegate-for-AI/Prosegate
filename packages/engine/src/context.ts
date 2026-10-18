import type { Analysis, Unit } from "@prosegate/segmenter";
import { addContentWords, finishBag, MaskIndex, type Bag } from "./text.js";

/** Chunk size for per-chunk matching (S4: RE2's backtracker only runs on short inputs). */
export const CHUNK_TARGET_CHARS = 1500;
/** Units closer than this (in characters) share a chunk; a code block in between breaks it. */
export const CHUNK_MAX_GAP = 256;

/**
 * A sentence for metrics and for `position: closing` (04, ADR-15): a unit of kind `sentence` or
 * `list_item`; headings are not sentences. A continuation piece (the part after an attributed
 * quote that cut its sentence) is merged into its head.
 */
export interface Sentence {
  /** Index into units of the first (head) piece. */
  head: number;
  /** Indexes of all pieces, head first. */
  pieces: number[];
  kind: "sentence" | "list_item";
  /** Words over all pieces. */
  words: number;
}

export interface Chunk {
  start: number;
  end: number;
  /** The normalised text of [start, end). */
  text: string;
}

/** Everything derived from one analyse() result that the matchers share. Built once per review. */
export class DocContext {
  readonly text: string;
  readonly normalized: string;
  /** `normalized` with CR, LF and TAB as spaces (1:1): what patterns run on, so a hard wrap is a space (ADR-24). */
  readonly match: string;
  readonly units: readonly Unit[];
  readonly masks: MaskIndex;
  readonly sentences: Sentence[] = [];
  /** unit index -> index into sentences, or -1 for a heading. */
  readonly unitSentence: Int32Array;
  /** Headings that begin a heading (not continuation pieces). */
  readonly headingCount: number;
  private chunkList: Chunk[] | null = null;
  private sentenceBags: Bag[] | null = null;
  private readonly unitStarts: number[];

  constructor(readonly analysis: Analysis) {
    this.text = analysis.text;
    this.normalized = analysis.normalized;
    this.match = analysis.normalized.replace(/[\r\n\t]/g, " ");
    this.units = analysis.units;
    this.masks = new MaskIndex(analysis.masks);
    this.unitStarts = analysis.units.map((u) => u.start);
    this.unitSentence = new Int32Array(analysis.units.length).fill(-1);
    let headings = 0;
    let current: Sentence | null = null;
    let currentContinued = false;
    analysis.units.forEach((u, i) => {
      if (u.kind === "heading") {
        if (!u.continuation) headings++;
        current = null;
        return;
      }
      if (u.continuation && current !== null && currentContinued && current.kind === u.kind) {
        current.pieces.push(i);
        current.words += u.words;
        currentContinued = u.continued;
        this.unitSentence[i] = this.sentences.length - 1;
        return;
      }
      current = { head: i, pieces: [i], kind: u.kind, words: u.words };
      currentContinued = u.continued;
      this.unitSentence[i] = this.sentences.length;
      this.sentences.push(current);
    });
    this.headingCount = headings;
  }

  get proseWords(): number {
    return this.analysis.prose_words;
  }

  /** Index of the unit that contains offset `pos`, or -1 when `pos` is in a gap. */
  unitAt(pos: number): number {
    let lo = 0;
    let hi = this.unitStarts.length - 1;
    let ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if ((this.unitStarts[mid] as number) <= pos) {
        ans = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    if (ans < 0) return -1;
    return pos < (this.units[ans] as Unit).end ? ans : -1;
  }

  /** The segment id containing offset `pos` (segments partition the text), or null. */
  segmentAt(pos: number): { id: string; end: number } | null {
    const segs = this.analysis.segments;
    let lo = 0;
    let hi = segs.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const seg = segs[mid] as { id: string; start: number; end: number };
      if (pos < seg.start) hi = mid - 1;
      else if (pos >= seg.end) lo = mid + 1;
      else return seg;
    }
    return null;
  }

  /** Index of the first unit that starts after `pos`, or units.length. */
  nextUnitAfter(pos: number): number {
    let lo = 0;
    let hi = this.unitStarts.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((this.unitStarts[mid] as number) <= pos) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  /**
   * Runs of nearby units, each about CHUNK_TARGET_CHARS long, never splitting a unit (a longer unit
   * is a chunk of its own). Matching a short chunk at a time is what keeps re2js on its fast path.
   */
  get chunks(): readonly Chunk[] {
    if (this.chunkList !== null) return this.chunkList;
    const out: Chunk[] = [];
    let start = -1;
    let end = -1;
    const flush = (): void => {
      if (start >= 0) out.push({ start, end, text: this.match.slice(start, end) });
      start = -1;
    };
    for (const u of this.units) {
      if (start >= 0 && (u.start - end > CHUNK_MAX_GAP || u.end - start > CHUNK_TARGET_CHARS)) flush();
      if (start < 0) start = u.start;
      end = u.end;
    }
    flush();
    this.chunkList = out;
    return out;
  }

  /** The content-word bag of a sentence (all pieces), text outside masks only. Built lazily, once. */
  sentenceBag(i: number): Bag {
    if (this.sentenceBags === null) this.sentenceBags = new Array<Bag>(this.sentences.length);
    let bag = this.sentenceBags[i];
    if (bag === undefined) {
      const tf = new Map<string, number>();
      for (const ui of (this.sentences[i] as Sentence).pieces) this.addUnitWords(ui, tf);
      bag = finishBag(tf);
      this.sentenceBags[i] = bag;
    }
    return bag;
  }

  /** Adds the content words of unit `ui` (outside masks) to `tf`. */
  addUnitWords(ui: number, tf: Map<string, number>): void {
    const u = this.units[ui] as Unit;
    for (const [s, e] of this.masks.outside(u.start, u.end)) addContentWords(this.normalized.slice(s, e), tf);
  }
}
