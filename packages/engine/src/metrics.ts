import type { Unit } from "@prosegate/segmenter";
import type { DocumentMetricMatch, SentenceMetricMatch } from "./compile.js";
import type { DocContext, Sentence } from "./context.js";
import type { Candidate } from "./search.js";
import { cosine, finishBag, type Bag } from "./text.js";

/** ADR-15: `similarity_to_prior` is skipped above this many prose words (S4: it is O(n^2) in the worst case). */
export const SIMILARITY_MAX_WORDS = 6000;

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

export function runSentenceMetric(m: SentenceMetricMatch, doc: DocContext): Candidate[] {
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
      return similarityToPrior(m, doc);
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
function similarityToPrior(m: SentenceMetricMatch, doc: DocContext): Candidate[] {
  if (doc.proseWords > SIMILARITY_MAX_WORDS) return [];
  const n = doc.sentences.length;
  const out: Candidate[] = [];
  const postings = new Map<string, number[]>();
  const bags: Bag[] = [];
  for (let i = 0; i < n; i++) bags.push(doc.sentenceBag(i));
  for (let i = 0; i < n; i++) {
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
  for (let k = first; k < tokens.length; k++) {
    const list = postings.get((tokens[k] as { t: string }).t);
    if (list === undefined) continue;
    for (const j of list) {
      if (seen.has(j)) continue;
      seen.add(j);
      if (cosine(bag, bags[j] as Bag) > threshold) return true;
    }
  }
  return false;
}

function bestBelow(bag: Bag, bags: readonly Bag[], postings: ReadonlyMap<string, number[]>, threshold: number): boolean {
  let best = 0;
  const seen = new Set<number>();
  for (const token of bag.tf.keys()) {
    for (const j of postings.get(token) ?? []) {
      if (seen.has(j)) continue;
      seen.add(j);
      best = Math.max(best, cosine(bag, bags[j] as Bag));
    }
  }
  return best < threshold;
}

// ---- document metrics -----------------------------------------------------------------------------

/**
 * The finding for a document metric: the first sentence of the document (04), or none when the
 * document has fewer than `min_sentences` sentences or the metric is undefined for it.
 */
export function runDocumentMetric(m: DocumentMetricMatch, doc: DocContext): Candidate[] {
  const n = doc.sentences.length;
  if (n === 0 || n < m.minSentences) return [];
  const value = documentMetricValue(m, doc);
  if (value === null || !fires(value, m.above, m.below)) return [];
  return [sentenceCandidate(doc, doc.sentences[0] as Sentence)];
}

/** The metric's value for this document, or null when it is undefined (no words, a single block...). */
export function documentMetricValue(m: DocumentMetricMatch, doc: DocContext): number | null {
  const words = doc.proseWords;
  const sentences = doc.sentences;
  switch (m.metric) {
    case "headers_per_100_words":
      return words === 0 ? null : (doc.headingCount / words) * 100;
    case "bold_per_100_words":
      return words === 0 ? null : (doc.analysis.bold.length / words) * 100;
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
  const bagOf = (ps: typeof paragraphs): Bag => {
    const tf = new Map<string, number>();
    for (const p of ps) for (const ui of p.unit_indexes) doc.addUnitWords(ui, tf);
    return finishBag(tf);
  };
  const opening = bagOf(first.kind === "text" ? paragraphs.filter((p) => p.block_id === first.block_id) : [first]);
  const closing = bagOf(paragraphs.filter((p) => p.block_id === last.block_id));
  return cosine(opening, closing);
}
