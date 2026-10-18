import type { Paragraph, Unit } from "@prosegate/segmenter";
import type { DocumentMetricMatch, SentenceMetricMatch } from "./compile.js";
import type { DocContext, Sentence } from "./context.js";
import { overBudget, type Candidate, type RunEnv } from "./search.js";
import { cosine, finishBag, type Bag } from "./text.js";

/** ADR-15: `similarity_to_prior` is skipped above this many prose words (S4: it is O(n^2) in the worst case). */
export const SIMILARITY_MAX_WORDS = 6000;
/** ADR-24: a sentence is compared with at most this many earlier candidates (the most recent ones sharing a rare token). */
export const MAX_SIMILARITY_CANDIDATES = 200;
/** ADR-24: closing_similarity is undefined below this many non-heading blocks. */
export const MIN_CLOSING_BLOCKS = 3;

function fires(value: number, above: number | null, below: number | null): boolean {
  if (above !== null) return value > above;
  if (below !== null) return value < below;
  return false;
}

/** The span of a sentence-metric finding: the whole sentence (its first piece when a quote cut it). */
function sentenceCandidate(doc: DocContext, s: Sentence): Candidate {
  const u = doc.units[s.head] as Unit;
  return { start: u.start, end: u.end, unit: s.head };
}

// ---- sentence metrics ------------------------------------------------------------------------------

export function runSentenceMetric(m: SentenceMetricMatch, doc: DocContext, env: RunEnv): Candidate[] {
  switch (m.metric) {
    case "word_count":
      return doc.sentences.filter((s) => fires(s.words, m.above, m.below)).map((s) => sentenceCandidate(doc, s));
    case "comma_count":
      return doc.sentences.filter((s) => fires(commaCount(doc, s), m.above, m.below)).map((s) => sentenceCandidate(doc, s));
    case "starts_with": {
      const re = m.startsWith;
      if (re === null) return [];
      return doc.sentences
        .filter((s) => {
          const u = doc.units[s.head] as Unit;
          const hit = re.matcher(doc.normalized.slice(u.text_start, u.end)).find();
          return fires(hit ? 1 : 0, m.above, m.below);
        })
        .map((s) => sentenceCandidate(doc, s));
    }
    case "similarity_to_prior":
      return similarityToPrior(m, doc, env);
  }
}

/** Commas outside masks, not counting a thousands separator (a comma between two digits). */
function commaCount(doc: DocContext, s: Sentence): number {
  let n = 0;
  const text = doc.normalized;
  for (const ui of s.pieces) {
    const u = doc.units[ui] as Unit;
    let i = text.indexOf(",", u.start);
    while (i >= 0 && i < u.end) {
      const digits = i > 0 && i + 1 < text.length && /\d/.test(text[i - 1] as string) && /\d/.test(text[i + 1] as string);
      if (!digits && !doc.masks.intersects(i, i + 1)) n++;
      i = text.indexOf(",", i + 1);
    }
  }
  return n;
}

/**
 * Bag-of-words cosine over content words (STOP_WORDS) between a sentence with at least `min_words`
 * words and every earlier sentence of the turn. With `above t`, a sentence fires when any earlier
 * sentence has cosine > t; with `below t`, when the best earlier match has cosine < t (the first
 * sentence never fires). Cost: an inverted index over the earlier sentences. For `above`, tokens are
 * ordered most-common first and the longest such prefix whose squared weight stays under t^2 of the
 * sentence's squared norm is not used to find candidates: by Cauchy-Schwarz a sentence that shares
 * only those tokens cannot exceed cosine t. So the index is probed only through rarer tokens.
 */
function similarityToPrior(m: SentenceMetricMatch, doc: DocContext, env: RunEnv): Candidate[] {
  if (doc.proseWords > SIMILARITY_MAX_WORDS) return [];
  const n = doc.sentences.length;
  const out: Candidate[] = [];
  const postings = new Map<string, number[]>();
  const bags: Bag[] = [];
  for (let i = 0; i < n; i++) bags.push(doc.sentenceBag(i));
  for (let i = 0; i < n; i++) {
    if ((i & 31) === 0 && overBudget(env)) break;
    const s = doc.sentences[i] as Sentence;
    const bag = bags[i] as Bag;
    if (i > 0 && s.words >= m.minWords && bag.norm > 0) {
      const hit = m.above !== null ? anyAbove(bag, bags, postings, m.above) : bestBelow(bag, bags, postings, m.below ?? 0);
      if (hit) out.push(sentenceCandidate(doc, s));
    }
    for (const token of bag.tf.keys()) {
      const list = postings.get(token);
      if (list === undefined) postings.set(token, [i]);
      else list.push(i);
    }
  }
  return out;
}

function anyAbove(bag: Bag, bags: readonly Bag[], postings: ReadonlyMap<string, number[]>, threshold: number): boolean {
  const tokens = [...bag.tf.entries()]
    .map(([t, tf]) => ({ t, tf, df: postings.get(t)?.length ?? 0 }))
    .sort((a, b) => b.df - a.df);
  // tokens that cannot, on their own, carry the similarity over the threshold
  const budget = threshold * threshold * bag.norm * bag.norm - 1e-9;
  let skipped = 0;
  let first = 0;
  while (first < tokens.length) {
    const next = skipped + (tokens[first] as { tf: number }).tf ** 2;
    if (next > budget) break;
    skipped = next;
    first++;
  }
  const seen = new Set<number>();
  // rarest tokens first, most recent sentences first, and at most MAX_SIMILARITY_CANDIDATES comparisons (ADR-24)
  for (let k = tokens.length - 1; k >= first; k--) {
    const list = postings.get((tokens[k] as { t: string }).t);
    if (list === undefined) continue;
    for (let x = list.length - 1; x >= 0; x--) {
      const j = list[x] as number;
      if (seen.has(j)) continue;
      if (seen.size >= MAX_SIMILARITY_CANDIDATES) return false;
      seen.add(j);
      if (cosine(bag, bags[j] as Bag) > threshold) return true;
    }
  }
  return false;
}

function bestBelow(bag: Bag, bags: readonly Bag[], postings: ReadonlyMap<string, number[]>, threshold: number): boolean {
  let best = 0;
  const seen = new Set<number>();
  outer: for (const token of bag.tf.keys()) {
    const list = postings.get(token) ?? [];
    for (let x = list.length - 1; x >= 0; x--) {
      const j = list[x] as number;
      if (seen.has(j)) continue;
      if (seen.size >= MAX_SIMILARITY_CANDIDATES) break outer;
      seen.add(j);
      best = Math.max(best, cosine(bag, bags[j] as Bag));
    }
  }
  return best < threshold;
}

// ---- document metrics -----------------------------------------------------------------------------

/**
 * The finding for a document metric, or none when the document has fewer than `min_sentences`
 * sentences or the metric is undefined for it. It has document scope (ADR-24) and is anchored on the
 * text its instruction names (see documentAnchor); it takes no part in overlap resolution.
 */
export function runDocumentMetric(m: DocumentMetricMatch, doc: DocContext): Candidate[] {
  const n = doc.sentences.length;
  if (n === 0 || n < m.minSentences) return [];
  const value = documentMetricValue(m, doc);
  if (value === null || !fires(value, m.above, m.below)) return [];
  return [{ ...documentAnchor(m, doc), scope: "document" }];
}

/**
 * Where a document finding sits (ADR-24): headers_per_100_words on the first heading; bullet_ratio on
 * the first qualifying list item; sentence_length_cv on the first sentence; closing_similarity on the
 * first sentence of the closing block; bold_per_100_words on the first bold span. When the named
 * thing does not exist (a `below` rule on a document without headings) the first sentence.
 */
function documentAnchor(m: DocumentMetricMatch, doc: DocContext): Candidate {
  const firstSentence = (): Candidate => sentenceCandidate(doc, doc.sentences[0] as Sentence);
  const ofUnit = (ui: number): Candidate => {
    const u = doc.units[ui] as Unit;
    return { start: u.start, end: u.end, unit: ui };
  };
  switch (m.metric) {
    case "headers_per_100_words": {
      const ui = doc.units.findIndex((u) => u.kind === "heading" && !u.continuation);
      return ui < 0 ? firstSentence() : ofUnit(ui);
    }
    case "bullet_ratio": {
      const s = doc.sentences.find((x) => x.kind === "list_item" && x.words >= m.minItemWords);
      return s === undefined ? firstSentence() : sentenceCandidate(doc, s);
    }
    case "sentence_length_cv":
      return firstSentence();
    case "closing_similarity": {
      const ui = closingBlock(doc)?.[0]?.unit_indexes[0];
      return ui === undefined ? firstSentence() : ofUnit(ui);
    }
    case "bold_per_100_words": {
      const b = doc.emphasisBold[0];
      if (b === undefined) return firstSentence();
      const seg = doc.segmentAt(b.start);
      let ui = doc.unitAt(b.start);
      if (ui < 0) ui = doc.unitAt(b.end - 1);
      if (seg === null || ui < 0) return firstSentence();
      return { start: b.start, end: Math.min(b.end, seg.end), unit: ui, segment: seg.id };
    }
  }
}

/** The paragraphs of the last non-heading block (the closing block), in order, or null. */
function closingBlock(doc: DocContext): Paragraph[] | null {
  const paragraphs = doc.analysis.paragraphs.filter((p) => p.kind !== "heading");
  const last = paragraphs[paragraphs.length - 1];
  if (last === undefined) return null;
  return paragraphs.filter((p) => p.block_id === last.block_id);
}

/** The metric's value for this document, or null when it is undefined (no words, a single block...). */
export function documentMetricValue(m: DocumentMetricMatch, doc: DocContext): number | null {
  const words = doc.proseWords;
  const sentences = doc.sentences;
  switch (m.metric) {
    case "headers_per_100_words":
      return words === 0 ? null : (doc.headingCount / words) * 100;
    case "bold_per_100_words":
      return words === 0 ? null : (doc.emphasisBold.length / words) * 100;
    case "bullet_ratio": {
      const items = sentences.filter((s) => s.kind === "list_item" && s.words >= m.minItemWords).length;
      return items / sentences.length;
    }
    case "sentence_length_cv": {
      const lengths = sentences.map((s) => s.words);
      const mean = lengths.reduce((a, b) => a + b, 0) / lengths.length;
      if (mean === 0) return null;
      const variance = lengths.reduce((a, b) => a + (b - mean) ** 2, 0) / lengths.length;
      return Math.sqrt(variance) / mean;
    }
    case "closing_similarity":
      return closingSimilarity(doc);
  }
}

/**
 * Cosine over content words between the first non-heading paragraph and the last non-heading
 * block. Paragraphs that share a `block_id` are one block (a loose list, or a text paragraph that
 * an attributed quote cut); for the first paragraph that merge applies to text paragraphs only.
 * Undefined (null) when the document has a single block.
 */
function closingSimilarity(doc: DocContext): number | null {
  const paragraphs = doc.analysis.paragraphs.filter((p) => p.kind !== "heading");
  const first = paragraphs[0];
  const last = paragraphs[paragraphs.length - 1];
  if (first === undefined || last === undefined || first.block_id === last.block_id) return null;
  // "The closing restates the opening" presupposes a middle: fewer than three blocks is not a closing (ADR-24).
  if (new Set(paragraphs.map((p) => p.block_id)).size < MIN_CLOSING_BLOCKS) return null;
  const bagOf = (ps: typeof paragraphs): Bag => {
    const tf = new Map<string, number>();
    for (const p of ps) for (const ui of p.unit_indexes) doc.addUnitWords(ui, tf);
    return finishBag(tf);
  };
  const opening = bagOf(first.kind === "text" ? paragraphs.filter((p) => p.block_id === first.block_id) : [first]);
  const closing = bagOf(paragraphs.filter((p) => p.block_id === last.block_id));
  return cosine(opening, closing);
}
