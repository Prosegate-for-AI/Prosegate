import type { Unit } from "@prosegate/segmenter";
import type { SearchMatch, SearchPart } from "./compile.js";
import type { DocContext } from "./context.js";
import { endsMidWord, spanAllowed, startsMidWord, type AllowTerm } from "./text.js";

/** A match of a rule: the span (offsets into the original text), its unit and, for document metrics, its scope. */
export interface Candidate {
  start: number;
  end: number;
  unit: number;
  /** Segment of the span when it is not the unit's (a bold span anchor). */
  segment?: string;
  scope?: "span" | "document";
}

export interface RunEnv {
  doc: DocContext;
  /** Allowed terms (normalised, lowercase); consulted for `vocab` rules only. */
  allowTerms: readonly AllowTerm[];
  /** Milliseconds; used with `deadline` to stop a runaway review between chunks. */
  clock: () => number;
  deadline: number;
  timedOut: boolean;
}

/** True (and records it) when the review budget is spent. */
export function overBudget(env: RunEnv): boolean {
  if (env.timedOut) return true;
  if (env.clock() > env.deadline) env.timedOut = true;
  return env.timedOut;
}

/** Chunks at least this long are gated by a DFA scan before the offset-producing search. */
const GATE_MIN_CHARS = 2000;
/** A unit longer than this is searched in windows of this many characters (ADR-24), each reading OVERLAP more. */
export const WINDOW_CHARS = 1500;
/** A match that starts in a window must end within this many characters of the window's end to be found. */
export const WINDOW_OVERLAP = 400;
/** How much text after a rejected start the strict retry reads. */
const RETRY_CHARS = 2000;

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
    if (overBudget(env)) break;
    runPart(part, isVocab, env, out);
  }
  return out;
}

function runPart(part: SearchPart, isVocab: boolean, env: RunEnv, out: Candidate[]): void {
  const { doc } = env;
  const f = part.filters;
  if (f.maxDocWords !== null && doc.proseWords > f.maxDocWords) return;

  const text = doc.match;
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
      if (pass && f.sentenceExclude !== null) pass = !f.sentenceExclude.matcher(text.slice(u.start, u.end)).find();
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
    if (overBudget(env)) return;
    const len = chunk.text.length;
    // Long chunks (a unit longer than the backtracker handles) cost the NFA about 100 ns per character per
    // pattern, so ask the DFA first whether the pattern can match at all (`test` is exact: a pattern that does not
    // match here has no candidate, whatever the boundary checks say).
    if (len > GATE_MIN_CHARS && !part.re.test(chunk.text)) continue;
    const base = chunk.start;
    const windowed = len > WINDOW_CHARS + WINDOW_OVERLAP;
    // [slice start, slice end, accept end] in chunk coordinates. A match is taken by the window it starts in.
    const windows: Array<[number, number, number]> = [];
    if (!windowed) windows.push([0, len, len]);
    else for (let ws = 0; ws < len; ws += WINDOW_CHARS) windows.push([ws, Math.min(len, ws + WINDOW_CHARS + WINDOW_OVERLAP), Math.min(len, ws + WINDOW_CHARS)]);

    let from = 0; // chunk coordinates: nothing before this is searched again
    for (const [ws, we, acceptEnd] of windows) {
      if (overBudget(env)) return;
      if (from >= acceptEnd && acceptEnd < len) continue;
      const slice = ws === 0 && we === len ? chunk.text : chunk.text.slice(ws, we);
      const m = part.re.matcher(slice);
      let local = Math.max(from, ws) - ws;
      while (local <= slice.length && m.find(local)) {
        const ms = ws + m.start(0); // chunk coordinates
        if (ms >= acceptEnd && acceptEnd < len) break; // the next window owns it
        const s0 = base + ms;
        let e0 = base + ws + m.end(0);
        const groupStart = part.spanGroup > 0 ? m.start(part.spanGroup) : -1;
        let spanFrom = groupStart >= 0 ? base + ws + groupStart : -1;
        let spanTo = groupStart >= 0 ? base + ws + m.end(part.spanGroup) : -1;
        const keyStart = part.keyGroup > 0 ? m.start(part.keyGroup) : -1;
        let keyFrom = keyStart >= 0 ? base + ws + keyStart : -1;
        let keyTo = keyStart >= 0 ? base + ws + m.end(part.keyGroup) : -1;
        const resume = (at: number): void => {
          local = at - ws;
          from = at;
        };
        // A zero-length match carries no span.
        if (e0 <= s0) {
          resume(ms + 1);
          continue;
        }
        if (part.checkLead && startsMidWord(text, s0, e0)) {
          resume(ms + 1);
          continue;
        }
        if (part.checkTrail && endsMidWord(text, s0, e0)) {
          let fixed = false;
          if (part.phrases !== null) {
            // A shorter phrase that starts here may be valid (the alternation prefers the longest).
            const shorter = shorterPhrase(part, text, s0, e0);
            if (shorter >= 0) {
              e0 = shorter;
              fixed = true;
            }
          } else {
            // The stripped pattern lost an alternative (or a longer lazy match) to the rejected one: ask RE2 with
            // its own trailing boundary, anchored here, then apply the Unicode check again.
            const strict = part.strict();
            if (strict !== null) {
              const sm = strict.matcher(text.slice(s0, Math.min(text.length, s0 + RETRY_CHARS)));
              if (sm.lookingAt()) {
                const end = s0 + sm.end(0);
                if (!endsMidWord(text, s0, end)) {
                  e0 = end;
                  const gs = part.spanGroup > 0 ? sm.start(part.spanGroup) : -1;
                  spanFrom = gs >= 0 ? s0 + gs : -1;
                  spanTo = gs >= 0 ? s0 + sm.end(part.spanGroup) : -1;
                  const ks = part.keyGroup > 0 ? sm.start(part.keyGroup) : -1;
                  keyFrom = ks >= 0 ? s0 + ks : -1;
                  keyTo = ks >= 0 ? s0 + sm.end(part.keyGroup) : -1;
                  fixed = true;
                }
              }
            }
          }
          if (!fixed) {
            resume(ms + 1);
            continue;
          }
        }
        const ui = doc.unitAt(s0);
        const u = ui < 0 ? null : (units[ui] as Unit);
        if (u === null || e0 > u.end) {
          // In a gap between units, or crossing units: not a match inside prose.
          resume(ms + 1);
          continue;
        }
        const verdict = judge(s0, e0, ui);
        if (verdict === Verdict.SkipUnit) {
          resume(u.end - base);
          continue;
        }
        if (verdict === Verdict.Next) {
          resume(ms + 1);
          continue;
        }
        const spanStart = spanFrom >= 0 ? spanFrom : s0;
        const spanEnd = spanFrom >= 0 ? spanTo : e0;
        if (spanEnd <= spanStart) {
          resume(ms + 1);
          continue;
        }
        if (isVocab && env.allowTerms.length > 0 && spanAllowed(text.slice(spanStart, spanEnd), keyFrom >= 0 ? text.slice(keyFrom, keyTo) : null, env.allowTerms)) {
          resume(ms + 1);
          continue;
        }
        out.push({ start: spanStart, end: spanEnd, unit: ui });
        resume(e0 - base);
      }
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
