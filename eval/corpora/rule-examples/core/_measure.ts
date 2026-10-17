// Measures the 12 corpus-ref rule examples of the `core` pack (W2.1) against the thresholds in
// packages/profiles/bundled/packs/core.yaml, with a margin, using deliberately simple definitions.
// The engine is the authority; this script exists so the documents are written with room to spare.
//
// Usage: npx tsx eval/corpora/rule-examples/core/_measure.ts      exit 0 = all PASS, 1 = any FAIL
//
// Definitions (kept identical in README.md):
//   word        [\p{L}\p{N}]+ with internal ' or - joiners (curly apostrophe folded). Heading and list
//               markers and ** are stripped first, so headings, list items and bold text all count.
//   sentence    prose text (consecutive prose lines of a block joined by a space) split on . ! ? (plus
//               any closing quote or bracket) followed by whitespace or the end of the block.
//   unit        variant U: every prose sentence, every list item and every heading is one unit.
//               variant P: prose sentences only. Both are measured; each document must satisfy its
//               rule under both, so the result does not hinge on how the engine counts bullets.
//   list item   a line starting with "- ", "* " or "N. ". Qualifying = at least 6 words (min_item_words).
//   heading     a line starting with 1-6 "#" and a space.
//   bold        a **...** pair on one line.
//   paragraph   a block of lines between blank lines, heading lines dropped (first / last for closing).
//   cosine      term-frequency vectors over lowercase words; "content" variant drops the stop list below.
//   CV          population standard deviation / mean of words per sentence (sample variant also shown).

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DIR = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------------------------
// Text model

const WORD = /[\p{L}\p{N}]+(?:['-][\p{L}\p{N}]+)*/gu;

function norm(s: string): string {
  return s.replace(/[‘’]/g, "'").replace(/[“”]/g, '"');
}

function words(s: string): string[] {
  return (norm(s).toLowerCase().match(WORD) ?? []).slice();
}

const STOP = new Set(
  (
    "a an the and or but if then else of to in on at by for with from as is are was were be been being am " +
    "it its this that these those i you he she we they me him her us them my your his our their not no nor " +
    "so than too very can could should would will shall may might must do does did done has have had having " +
    "there here which who whom whose what when where why how all any both each few more most other some such " +
    "only own same just also about into over under again further once up down out off above below between " +
    "through during before after while until against because i'm it's don't doesn't isn't aren't won't " +
    "can't didn't"
  ).split(" "),
);

function contentWords(s: string): string[] {
  return words(s).filter((w) => !STOP.has(w));
}

type UnitKind = "prose" | "item" | "heading";
interface Unit {
  kind: UnitKind;
  text: string;
}

const HEADING = /^#{1,6}\s+(.*)$/;
const ITEM = /^\s*(?:[-*]|\d+\.)\s+(.*)$/;

function stripMarkup(s: string): string {
  return s.replace(/\*\*/g, "");
}

function splitSentences(run: string): string[] {
  return stripMarkup(run)
    .split(/(?<=[.!?]["')\]”’]*)\s+/u)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

interface Doc {
  raw: string;
  units: Unit[];
  paragraphs: string[];
  bold: number;
}

function parse(raw: string): Doc {
  const lines = raw.replace(/\r\n/g, "\n").split("\n");
  const units: Unit[] = [];
  const paragraphs: string[] = [];
  let run: string[] = [];
  let para: string[] = [];
  const flushRun = (): void => {
    if (run.length > 0) {
      for (const s of splitSentences(run.join(" "))) units.push({ kind: "prose", text: s });
      run = [];
    }
  };
  const flushPara = (): void => {
    flushRun();
    if (para.length > 0) paragraphs.push(para.join(" "));
    para = [];
  };
  for (const line of lines) {
    if (line.trim() === "") {
      flushPara();
      continue;
    }
    const h = HEADING.exec(line);
    if (h) {
      flushRun();
      units.push({ kind: "heading", text: stripMarkup(h[1] ?? "") });
      continue;
    }
    const it = ITEM.exec(line);
    if (it) {
      flushRun();
      const t = stripMarkup(it[1] ?? "");
      units.push({ kind: "item", text: t });
      para.push(t);
      continue;
    }
    run.push(line.trim());
    para.push(stripMarkup(line.trim()));
  }
  flushPara();
  const bold = (raw.match(/\*\*[^*\n]+?\*\*/g) ?? []).length;
  return { raw, units, paragraphs, bold };
}

// ---------------------------------------------------------------------------------------------
// Metrics

function cosine(a: string[], b: string[]): number {
  const fa = new Map<string, number>();
  const fb = new Map<string, number>();
  for (const w of a) fa.set(w, (fa.get(w) ?? 0) + 1);
  for (const w of b) fb.set(w, (fb.get(w) ?? 0) + 1);
  let dot = 0;
  for (const [w, n] of fa) dot += n * (fb.get(w) ?? 0);
  const na = Math.sqrt([...fa.values()].reduce((s, n) => s + n * n, 0));
  const nb = Math.sqrt([...fb.values()].reduce((s, n) => s + n * n, 0));
  return na === 0 || nb === 0 ? 0 : dot / (na * nb);
}

function cv(lengths: number[], sample: boolean): number {
  if (lengths.length < 2) return Number.NaN;
  const mean = lengths.reduce((s, n) => s + n, 0) / lengths.length;
  const ss = lengths.reduce((s, n) => s + (n - mean) ** 2, 0);
  return Math.sqrt(ss / (sample ? lengths.length - 1 : lengths.length)) / mean;
}

interface Metrics {
  words: number;
  headings: number;
  items: number;
  qualifying: number;
  sentP: number;
  sentU: number;
  headersPer100: number;
  bulletR1: number; // qualifying items / (prose sentences + all items)
  bulletR2: number; // qualifying items / (prose sentences + qualifying items)
  bulletNoMin: number; // all items / (prose sentences + all items): what min_item_words 0 would give
  cvP: number;
  cvU: number;
  cvPSample: number;
  cvUSample: number;
  closingStop: number; // stop words kept
  closingContent: number; // stop words dropped
  bold: number;
  boldPer100: number;
  rep6: number; // max cosine of a later sentence with >= 6 words to any earlier unit (content words)
  repAll: number; // same, with no minimum length
  repPair: string; // the pair that produced rep6
  minLenP: number; // shortest / longest prose sentence, in words
  maxLenP: number;
}

function measure(doc: Doc): Metrics {
  const all = doc.units.map((u) => words(u.text));
  const total = all.reduce((s, w) => s + w.length, 0);
  const prose = doc.units.filter((u) => u.kind === "prose");
  const items = doc.units.filter((u) => u.kind === "item");
  const headings = doc.units.filter((u) => u.kind === "heading");
  const qualifying = items.filter((u) => words(u.text).length >= 6);
  const sentP = prose.length;
  const sentU = doc.units.length;
  const lenP = prose.map((u) => words(u.text).length);
  const lenU = doc.units.map((u) => words(u.text).length);
  const first = doc.paragraphs[0] ?? "";
  const last = doc.paragraphs[doc.paragraphs.length - 1] ?? "";
  const hasTwo = doc.paragraphs.length >= 2;

  // Repetition runs over every unit except headings, in document order.
  const seq = doc.units.filter((u) => u.kind !== "heading");
  let rep6 = 0;
  let repAll = 0;
  let repPair = "";
  for (let j = 1; j < seq.length; j++) {
    const later = seq[j];
    if (later === undefined) continue;
    const cj = contentWords(later.text);
    const nj = words(later.text).length;
    for (let i = 0; i < j; i++) {
      const earlier = seq[i];
      if (earlier === undefined) continue;
      const c = cosine(contentWords(earlier.text), cj);
      repAll = Math.max(repAll, c);
      if (nj >= 6 && c > rep6) {
        rep6 = c;
        repPair = `  [${i}] ${earlier.text}\n  [${j}] ${later.text}`;
      }
    }
  }

  return {
    words: total,
    headings: headings.length,
    items: items.length,
    qualifying: qualifying.length,
    sentP,
    sentU,
    headersPer100: total === 0 ? 0 : (headings.length / total) * 100,
    bulletR1: qualifying.length / Math.max(1, sentP + items.length),
    bulletR2: qualifying.length / Math.max(1, sentP + qualifying.length),
    bulletNoMin: items.length / Math.max(1, sentP + items.length),
    cvP: cv(lenP, false),
    cvU: cv(lenU, false),
    cvPSample: cv(lenP, true),
    cvUSample: cv(lenU, true),
    closingStop: hasTwo ? cosine(words(first), words(last)) : 0,
    closingContent: hasTwo ? cosine(contentWords(first), contentWords(last)) : 0,
    bold: doc.bold,
    boldPer100: total === 0 ? 0 : (doc.bold / total) * 100,
    rep6,
    repAll,
    repPair,
    minLenP: lenP.length === 0 ? 0 : Math.min(...lenP),
    maxLenP: lenP.length === 0 ? 0 : Math.max(...lenP),
  };
}

// ---------------------------------------------------------------------------------------------
// Lint against the phrase / regex rules of the core pack. Deliberately stricter than the engine:
// `position` and `max_doc_words` are ignored (a phrase anywhere counts), except for filler.004 below.

interface LintRule {
  id: string;
  phrases?: string[];
  regexes?: RegExp[];
  sentenceExclude?: RegExp;
  sentenceMaxWords?: number;
}

const LINT: LintRule[] = [
  {
    id: "core.filler.001",
    phrases: [
      "let's dive in", "let's dive into", "let's explore", "great question", "certainly!", "absolutely!",
      "sure thing", "i'd be happy to", "i'd be glad to",
    ],
  },
  {
    id: "core.filler.002",
    phrases: [
      "i hope this helps", "hope this helps", "feel free to reach out", "let me know if you have any questions",
      "happy to help", "don't hesitate to",
    ],
  },
  {
    id: "core.filler.003",
    phrases: ["as an ai", "as a language model", "this document outlines", "in this section we will", "in this response", "the following is"],
  },
  { id: "core.filler.004", phrases: ["in conclusion", "to summarize", "in summary", "overall,"] },
  {
    id: "core.hedge.001",
    phrases: ["note that"],
    regexes: [
      /\b(?:it's|it is) (?:important to note|worth noting|worth mentioning)(?: that)?,?/gu,
      /\bit should be noted(?: that)?,?/gu,
    ],
  },
  { id: "core.hedge.002", regexes: [/\b(?<span>somewhat|fairly|relatively)\s+[a-z]+/gu] },
  {
    id: "core.hedge.003",
    phrases: ["arguably", "generally speaking", "in many cases", "it could be argued", "to some extent", "in a sense"],
  },
  { id: "core.hedge.004", regexes: [/\b(may or may not|could potentially|might possibly|can possibly)\b/gu] },
  { id: "core.hedge.005", regexes: [/\bit depends[.!]/gu] },
  {
    id: "core.vocab.001",
    phrases: [
      "delve", "delves", "delved", "delving", "leverages", "leveraged", "leveraging", "utilize", "utilizes",
      "utilized", "utilizing", "utilise", "utilises", "utilised", "utilising", "foster", "fosters", "fostered",
      "fostering", "streamline", "streamlines", "streamlined", "streamlining", "bolster", "bolsters", "bolstered",
      "elevate", "elevates", "elevated", "elevating",
    ],
    regexes: [
      /\b(?:to|can|could|should|will|would|we|you|they|i|us) (?<span>leverage)\b/gu,
      /\b(?<span>underscore[sd]) (?:the|that|how|why|a|an|our|its|this)\b/gu,
    ],
  },
  {
    id: "core.vocab.002",
    phrases: ["tapestry", "realm", "testament", "synergy", "paradigm shift", "game-changer", "cornerstone"],
    regexes: [/\b(?:the|this|today's) (?:current |modern |evolving |changing )?landscape\b/gu],
  },
  {
    id: "core.vocab.003",
    phrases: [
      "robust", "seamless", "seamlessly", "crucial", "pivotal", "nuanced", "holistic", "cutting-edge",
      "comprehensive", "meticulous", "ever-evolving",
    ],
  },
  {
    id: "core.vocab.004",
    phrases: ["truly", "genuinely", "incredibly", "remarkably", "extremely"],
    regexes: [/\b(?<span>highly) (?:effective|efficient|scalable|recommended|likely|unlikely)\b/gu],
  },
  {
    id: "core.vocab.005",
    phrases: ["a wide range of", "a variety of", "a plethora of", "a myriad of", "a number of", "various"],
  },
  {
    id: "core.triad.001",
    regexes: [/\b[a-z]{1,12}, [a-z]{1,12},? and [a-z]{1,12}\b/gu],
    sentenceExclude: /\d/u,
    sentenceMaxWords: 25,
  },
  { id: "core.triad.002", regexes: [/\bnot (?:just|only|merely|about) .{3,80}?, (?:but|it's about|it is about)\b/gu] },
  {
    id: "core.triad.003",
    phrases: ["whether it's", "whether you're"],
    regexes: [/\bfrom [a-z]+ to [a-z]+, (?:and )?[a-z]+/gu],
  },
];

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function phraseRe(p: string): RegExp {
  const first = p[0] ?? "";
  const last = p[p.length - 1] ?? "";
  const wc = /[\p{L}\p{N}_\p{M}]/u;
  const pre = wc.test(first) ? "(?<![\\p{L}\\p{N}_\\p{M}])" : "";
  const post = wc.test(last) ? "(?![\\p{L}\\p{N}_\\p{M}])" : "";
  return new RegExp(pre + escapeRe(p) + post, "gu");
}

function lintHits(doc: Doc, ignoreFiller004: boolean): string[] {
  const text = norm(stripMarkup(doc.raw)).toLowerCase();
  const sentences = doc.units.map((u) => norm(u.text).toLowerCase());
  const hits: string[] = [];
  for (const rule of LINT) {
    if (ignoreFiller004 && rule.id === "core.filler.004") continue;
    const res: RegExp[] = [...(rule.phrases ?? []).map(phraseRe), ...(rule.regexes ?? [])];
    for (const re of res) {
      const scopes = rule.sentenceExclude === undefined ? [text] : sentences.filter(
        (s) =>
          !rule.sentenceExclude?.test(s) && (rule.sentenceMaxWords === undefined || words(s).length <= rule.sentenceMaxWords),
      );
      for (const scope of scopes) {
        for (const m of scope.matchAll(new RegExp(re.source, re.flags))) hits.push(`${rule.id}:"${m[0]}"`);
      }
    }
  }
  return hits;
}

// ---------------------------------------------------------------------------------------------
// Specification of the 12 documents

type Own = "filler.004" | "structure.001" | "structure.002" | "structure.003" | "structure.004" | "structure.005" | "repetition.001";

interface Row {
  file: string;
  metric: string;
  value: string;
  threshold: string;
  pass: boolean;
}

interface Spec {
  file: string;
  own: Own;
  kind: "hit" | "miss";
  primary: (m: Metrics, d: Doc) => Omit<Row, "file">;
  readmeValue: (m: Metrics) => string;
}

const f2 = (n: number): string => (Number.isNaN(n) ? "n/a" : n.toFixed(2));

const SPECS: Spec[] = [
  {
    file: "filler-004-miss-01", own: "filler.004", kind: "miss",
    primary: (m, d) => {
      const initial = d.units.some((u) => u.kind === "prose" && /^in summary,/i.test(u.text));
      return { metric: "doc_words (rule inactive above 399) + sentence-initial 'In summary,'", value: `${m.words} words, initial=${initial}`, threshold: ">= 800 words, present", pass: m.words >= 800 && initial };
    },
    readmeValue: (m) => `${m.words} words (max_doc_words 399), contains a sentence-initial "In summary,"`,
  },
  {
    file: "structure-001-hit-01", own: "structure.001", kind: "hit",
    primary: (m) => ({ metric: "headers_per_100_words", value: f2(m.headersPer100), threshold: ">= 2.0 (rule: > 1.5)", pass: m.headersPer100 >= 2.0 }),
    readmeValue: (m) => `headers_per_100_words ${f2(m.headersPer100)} (${m.headings} headings, ${m.words} words)`,
  },
  {
    file: "structure-001-miss-01", own: "structure.001", kind: "miss",
    primary: (m) => ({ metric: "headers_per_100_words", value: f2(m.headersPer100), threshold: "<= 1.0 (rule: > 1.5)", pass: m.headersPer100 <= 1.0 }),
    readmeValue: (m) => `headers_per_100_words ${f2(m.headersPer100)} (${m.headings} headings, ${m.words} words)`,
  },
  {
    file: "structure-002-hit-01", own: "structure.002", kind: "hit",
    primary: (m) => ({ metric: "bullet_ratio (min_item_words 6)", value: `${f2(m.bulletR1)} / ${f2(m.bulletR2)}`, threshold: ">= 0.75 (rule: > 0.6)", pass: m.bulletR1 >= 0.75 && m.bulletR2 >= 0.75 }),
    readmeValue: (m) => `bullet_ratio ${f2(m.bulletR1)} (${m.qualifying} qualifying items, ${m.sentP} prose sentences)`,
  },
  {
    file: "structure-002-miss-01", own: "structure.002", kind: "miss",
    primary: (m) => ({ metric: "bullet_ratio (min_item_words 6)", value: `${f2(m.bulletR1)} / ${f2(m.bulletR2)}`, threshold: "<= 0.30 (rule: > 0.6)", pass: m.bulletR1 <= 0.3 && m.bulletR2 <= 0.3 }),
    readmeValue: (m) => `bullet_ratio ${f2(m.bulletR1)} (${m.items} items, none with 6 or more words; ${f2(m.bulletNoMin)} if min_item_words were 0)`,
  },
  {
    file: "structure-003-hit-01", own: "structure.003", kind: "hit",
    primary: (m) => ({ metric: "sentence_length_cv", value: `${f2(m.cvP)} (sample ${f2(m.cvPSample)})`, threshold: "<= 0.15 (rule: < 0.25)", pass: m.cvP <= 0.15 && m.cvPSample <= 0.15 }),
    readmeValue: (m) => `sentence_length_cv ${f2(m.cvP)} (${m.sentP} sentences)`,
  },
  {
    file: "structure-003-miss-01", own: "structure.003", kind: "miss",
    primary: (m) => ({ metric: "sentence_length_cv", value: `${f2(m.cvP)} (sample ${f2(m.cvPSample)})`, threshold: ">= 0.45 (rule: < 0.25)", pass: m.cvP >= 0.45 && m.cvPSample >= 0.45 }),
    readmeValue: (m) => `sentence_length_cv ${f2(m.cvP)} (${m.sentP} sentences)`,
  },
  {
    file: "structure-004-hit-01", own: "structure.004", kind: "hit",
    primary: (m) => ({ metric: "closing_similarity", value: `${f2(m.closingContent)} content / ${f2(m.closingStop)} all words`, threshold: ">= 0.75 both (rule: > 0.6)", pass: m.closingContent >= 0.75 && m.closingStop >= 0.75 }),
    readmeValue: (m) => `closing_similarity ${f2(m.closingContent)} content words, ${f2(m.closingStop)} all words`,
  },
  {
    file: "structure-004-miss-01", own: "structure.004", kind: "miss",
    primary: (m) => ({ metric: "closing_similarity", value: `${f2(m.closingContent)} content / ${f2(m.closingStop)} all words`, threshold: "<= 0.35 both (rule: > 0.6)", pass: m.closingContent <= 0.35 && m.closingStop <= 0.35 }),
    readmeValue: (m) => `closing_similarity ${f2(m.closingContent)} content words, ${f2(m.closingStop)} all words`,
  },
  {
    file: "structure-005-hit-01", own: "structure.005", kind: "hit",
    primary: (m) => ({ metric: "bold_per_100_words", value: f2(m.boldPer100), threshold: ">= 4.0 (rule: > 3)", pass: m.boldPer100 >= 4 }),
    readmeValue: (m) => `bold_per_100_words ${f2(m.boldPer100)} (${m.bold} bold phrases, ${m.words} words)`,
  },
  {
    file: "structure-005-miss-01", own: "structure.005", kind: "miss",
    primary: (m) => ({ metric: "bold_per_100_words", value: f2(m.boldPer100), threshold: "<= 1.0 (rule: > 3)", pass: m.boldPer100 <= 1 }),
    readmeValue: (m) => `bold_per_100_words ${f2(m.boldPer100)} (${m.bold} bold phrase, ${m.words} words)`,
  },
  {
    file: "repetition-001-miss-01", own: "repetition.001", kind: "miss",
    primary: (m) => ({ metric: "max pairwise cosine (content words, later sentence >= 6 words)", value: f2(m.rep6), threshold: "<= 0.40 (rule: > 0.7)", pass: m.rep6 <= 0.4 && m.sentP >= 6 }),
    readmeValue: (m) => `max pairwise cosine ${f2(m.rep6)} (${f2(m.repAll)} with no minimum length; ${m.sentP} sentences)`,
  },
];

// Cross-checks: the sentence-count gates must be met (so a miss is not a miss merely because the rule
// was skipped), no other core rule may fire, with margin.
function crossChecks(spec: Spec, m: Metrics, d: Doc): Row[] {
  const rows: Row[] = [];
  const add = (metric: string, value: string, threshold: string, pass: boolean): void => {
    rows.push({ file: spec.file, metric, value, threshold, pass });
  };
  const own = spec.own;
  // Sentence-count gates of the own rule.
  const gate: Partial<Record<Own, { n: number; useU: boolean }>> = {
    "structure.001": { n: 8, useU: false },
    "structure.002": { n: 8, useU: true },
    "structure.003": { n: 10, useU: false },
    "structure.004": { n: 6, useU: false },
    "structure.005": { n: 6, useU: false },
    "repetition.001": { n: 6, useU: false },
  };
  const g = gate[own];
  if (g) {
    const n = g.useU ? m.sentU : m.sentP;
    add(`min_sentences gate (${g.useU ? "units incl. items" : "prose sentences"})`, String(n), `>= ${g.n}`, n >= g.n);
  }
  if (own === "structure.003") add("min_sentences gate (units)", String(m.sentU), ">= 10", m.sentU >= 10);

  // Other structure rules must stay quiet (margins inside the rule thresholds).
  if (own !== "structure.001") add("other: headers_per_100_words", f2(m.headersPer100), "<= 1.2 (rule fires > 1.5)", m.headersPer100 <= 1.2);
  if (own !== "structure.002") add("other: bullet_ratio", `${f2(m.bulletR1)} / ${f2(m.bulletR2)}`, "<= 0.45 (rule fires > 0.6)", m.bulletR1 <= 0.45 && m.bulletR2 <= 0.45);
  if (own !== "structure.003") {
    const okP = m.sentP < 10 || m.cvP >= 0.35;
    const okU = m.sentU < 10 || m.cvU >= 0.35;
    add("other: sentence_length_cv", `P ${f2(m.cvP)} / U ${f2(m.cvU)}`, ">= 0.35 when >= 10 sentences (rule fires < 0.25)", okP && okU);
  }
  if (own !== "structure.004") add("other: closing_similarity", `${f2(m.closingContent)} content / ${f2(m.closingStop)} all`, "<= 0.45 / 0.55 (rule fires > 0.6)", m.closingContent <= 0.45 && m.closingStop <= 0.55);
  if (own !== "structure.005") add("other: bold_per_100_words", f2(m.boldPer100), "<= 2.0 (rule fires > 3)", m.boldPer100 <= 2);
  if (own !== "repetition.001") {
    const lim = 0.6;
    add("other: repetition max cosine", f2(m.rep6), `<= ${lim} (rule fires > 0.7)`, m.rep6 <= lim);
  } else {
    add("repetition max cosine, no minimum length", f2(m.repAll), "<= 0.40", m.repAll <= 0.4);
  }

  // Phrase / regex rules.
  const hits = lintHits(d, own === "filler.004");
  add("other: phrase/regex rules (filler, hedge, vocab, triad)", hits.length === 0 ? "none" : hits.join(" "), "none", hits.length === 0);
  if (own === "filler.004") {
    const phrases = ["in conclusion", "to summarize", "overall,"].filter((p) => phraseRe(p).test(norm(d.raw).toLowerCase()));
    add("filler.004: other closers", phrases.length === 0 ? "none" : phrases.join(","), "none", phrases.length === 0);
  }
  return rows;
}

// ---------------------------------------------------------------------------------------------

function table(rows: Row[]): string {
  const head = ["file", "metric", "value", "threshold", "result"];
  const body = rows.map((r) => [r.file, r.metric, r.value, r.threshold, r.pass ? "PASS" : "FAIL"]);
  const widths = head.map((h, i) => Math.max(h.length, ...body.map((b) => (b[i] ?? "").length)));
  const fmt = (cells: string[]): string => cells.map((c, i) => c.padEnd(widths[i] ?? 0)).join("  ");
  return [fmt(head), fmt(widths.map((w) => "-".repeat(w))), ...body.map(fmt)].join("\n");
}

const primary: Row[] = [];
const cross: Row[] = [];
const readme: string[] = [];
const numbers: string[] = [];
for (const spec of SPECS) {
  const raw = readFileSync(join(DIR, `${spec.file}.md`), "utf8");
  const doc = parse(raw);
  const m = measure(doc);
  primary.push({ file: spec.file, ...spec.primary(m, doc) });
  cross.push(...crossChecks(spec, m, doc));
  readme.push(`${spec.file}\t${spec.readmeValue(m)}`);
  numbers.push(
    `${spec.file.padEnd(24)} words=${m.words} len=${m.minLenP}-${m.maxLenP} sentP=${m.sentP} sentU=${m.sentU} headings=${m.headings} items=${m.items}/${m.qualifying}q ` +
      `hdr/100=${f2(m.headersPer100)} bulletR1=${f2(m.bulletR1)} R2=${f2(m.bulletR2)} cvP=${f2(m.cvP)} cvU=${f2(m.cvU)} ` +
      `closing=${f2(m.closingContent)}c/${f2(m.closingStop)}a bold=${m.bold} bold/100=${f2(m.boldPer100)} rep6=${f2(m.rep6)} repAll=${f2(m.repAll)}` +
      (process.argv.includes("--pairs") ? `\n${m.repPair}` : ""),
  );
}

console.log("PRIMARY: each document against the metric its rule measures\n");
console.log(table(primary));
const verbose = process.argv.includes("--verbose");
console.log("\nNUMBERS: every measured value per document\n");
console.log(numbers.join("\n"));
console.log(`\nCROSS-CHECKS: sentence-count gates, and no other core rule fires (${verbose ? "all" : "failures only"})\n`);
console.log(verbose || cross.some((r) => !r.pass) ? table(verbose ? cross : cross.filter((r) => !r.pass)) : "(none failing)");
if (process.argv.includes("--readme")) console.log("\n" + readme.join("\n"));

const failed = [...primary, ...cross].filter((r) => !r.pass).length;
console.log(`\n${primary.filter((r) => r.pass).length}/${primary.length} primary PASS, ${cross.filter((r) => r.pass).length}/${cross.length} cross-checks PASS`);
process.exit(failed === 0 ? 0 : 1);
