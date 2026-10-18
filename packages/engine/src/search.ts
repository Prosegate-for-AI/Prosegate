import type { Unit } from "@prosegate/segmenter";
import type { SearchMatch, SearchPart } from "./compile.js";
import type { DocContext } from "./context.js";
import { endsMidWord, squashSpace, startsMidWord } from "./text.js";

/** A match of a phrase or regex part: the span (offsets into the original text) and its unit. */
export interface Candidate {
  start: number;
  end: number;
  unit: number;
}

export interface RunEnv {
  doc: DocContext;
  /** Allowed terms, lowercase and normalised; consulted for `vocab` rules only. */
  allowTerms: ReadonlySet<string>;
  /** Milliseconds; used with `deadline` to stop a runaway review between chunks. */
  clock: () => number;
  deadline: number;
  timedOut: boolean;
}

/** Chunks at least this long are gated by a DFA scan before the offset-producing search. */
const GATE_MIN_CHARS = 2000;

const enum Verdict {
  Accept,
  /** Drop this candidate and look again from the next character. */
  Next,
  /** Drop this candidate and every other match inside its unit. */
  SkipUnit,
}

/**
 * Runs every part of a phrase / regex / `any` rule over the document and returns its matches,
 * in no particular order. Matches lie inside one prose unit, outside every mask, and satisfy the
 * part's own filters (ADR-15). Resumes after a rejected candidate at start + 1, so a valid match
 * overlapping a rejected one is still found (S4 "Recommendations" 1.2).
 */
export function runSearchRule(match: SearchMatch, isVocab: boolean, env: RunEnv): Candidate[] {
  const out: Candidate[] = [];
  for (const part of match.parts) {
    if (env.timedOut) break;
    runPart(part, isVocab, env, out);
  }
  return out;
}

function runPart(part: SearchPart, isVocab: boolean, env: RunEnv, out: Candidate[]): void {
  const { doc } = env;
  const f = part.filters;
  if (f.maxDocWords !== null && doc.proseWords > f.maxDocWords) return;

  const normalized = doc.normalized;
  const units = doc.units;
  const closingFrom = f.position === "closing" ? doc.sentences.length - 2 : 0;
  // 0 = unknown, 1 = unit passes the sentence filters, 2 = unit is excluded
  let unitOk: Uint8Array | null = null;
  if (f.sentenceMaxWords !== null || f.sentenceExclude !== null) unitOk = new Uint8Array(units.length);

  const unitPasses = (ui: number): boolean => {
    if (unitOk === null) return true;
    let state = unitOk[ui] as number;
    if (state === 0) {
      const u = units[ui] as Unit;
      let pass = f.sentenceMaxWords === null || u.words <= f.sentenceMaxWords;
      if (pass && f.sentenceExclude !== null) pass = !f.sentenceExclude.matcher(normalized.slice(u.start, u.end)).find();
      state = pass ? 1 : 2;
      unitOk[ui] = state;
    }
    return state === 1;
  };

  const judge = (s0: number, e0: number, ui: number): Verdict => {
    const u = units[ui] as Unit;
    if (f.position === "sentence_start") {
      if (u.continuation) return Verdict.SkipUnit;
      if (s0 !== u.text_start) return s0 > u.text_start ? Verdict.SkipUnit : Verdict.Next;
    } else if (f.position === "closing") {
      const si = doc.unitSentence[ui] as number;
      if (si < 0 || si < closingFrom) return Verdict.SkipUnit;
    }
    if (!unitPasses(ui)) return Verdict.SkipUnit;
    if (doc.masks.intersects(s0, e0)) return Verdict.Next;
    return Verdict.Accept;
  };

  for (const chunk of doc.chunks) {
    if (env.timedOut) return;
    if (env.clock() > env.deadline) {
      env.timedOut = true;
      return;
    }
    const len = chunk.text.length;
    // Long chunks (a unit longer than the backtracker handles) cost the NFA about 100 ns per character per
    // pattern, so ask the DFA first whether the pattern can match at all (`test` is exact: a pattern that does not
    // match here has no candidate, whatever the boundary checks say).
    if (len > GATE_MIN_CHARS && !part.re.test(chunk.text)) continue;
    const m = part.re.matcher(chunk.text);
    const base = chunk.start;
    let from = 0;
    while (from <= len && m.find(from)) {
      const s0 = base + m.start(0);
      let e0 = base + m.end(0);
      // A zero-length match carries no span.
      if (e0 <= s0) {
        from = m.start(0) + 1;
        continue;
      }
      if (part.checkLead && startsMidWord(normalized, s0, e0)) {
        from = m.start(0) + 1;
        continue;
      }
      if (part.checkTrail && endsMidWord(normalized, s0, e0)) {
        // A shorter phrase that starts here may be valid (the alternation prefers the longest).
        const shorter = part.phrases !== null ? shorterPhrase(part, normalized, s0, e0) : -1;
        if (shorter < 0) {
          from = m.start(0) + 1;
          continue;
        }
        e0 = shorter;
      }
      const ui = doc.unitAt(s0);
      const u = ui < 0 ? null : (units[ui] as Unit);
      if (u === null || e0 > u.end) {
        // In a gap between units, or crossing units: not a match inside prose.
        from = m.start(0) + 1;
        continue;
      }
      const verdict = judge(s0, e0, ui);
      if (verdict === Verdict.SkipUnit) {
        from = u.end - base;
        continue;
      }
      if (verdict === Verdict.Next) {
        from = m.start(0) + 1;
        continue;
      }
      let spanStart = s0;
      let spanEnd = e0;
      if (part.spanGroup > 0) {
        const gs = m.start(part.spanGroup);
        if (gs >= 0) {
          spanStart = base + gs;
          spanEnd = base + m.end(part.spanGroup);
        }
      }
      if (spanEnd <= spanStart) {
        from = m.start(0) + 1;
        continue;
      }
      if (isVocab && env.allowTerms.size > 0 && env.allowTerms.has(squashSpace(normalized.slice(spanStart, spanEnd)))) {
        from = m.start(0) + 1;
        continue;
      }
      out.push({ start: spanStart, end: spanEnd, unit: ui });
      from = e0 - base;
    }
  }
}

/** End of the longest phrase shorter than the current match that starts at `s0` and ends on a boundary; -1 if none. */
function shorterPhrase(part: SearchPart, text: string, s0: number, e0: number): number {
  const phrases = part.phrases as readonly string[];
  for (let i = 0; i < phrases.length; i++) {
    const re = part.sticky(i);
    re.lastIndex = s0;
    const hit = re.exec(text);
    if (hit === null) continue;
    const end = s0 + hit[0].length;
    if (end >= e0) continue; // not shorter than the rejected match
    if (!endsMidWord(text, s0, end)) return end;
  }
  return -1;
}
