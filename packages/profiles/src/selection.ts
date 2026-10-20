import type { ResolvedProfile } from "./snapshot.js";

export interface SelectionState {
  active_profile: string;
  previous_profile: string | null;
  candidate: string | null;
  candidate_streak: number;
}

export const SELECTION_REQUEST = "Call `select_profile` before writing; the active profile may not match this task.";

const normalise = (s: string): string => s.normalize("NFKC").toLowerCase().replace(/\s+/gu, " ").trim();
const word = (s: string): boolean => /[\p{L}\p{N}_]/u.test(s);

/** Triggers are literal phrases, never executable regular expressions. */
function containsPhrase(message: string, phrase: string): boolean {
  if (phrase === "") return false;
  for (let at = message.indexOf(phrase); at !== -1; at = message.indexOf(phrase, at + 1)) {
    const before = [...message.slice(0, at)].at(-1) ?? "";
    const after = [...message.slice(at + phrase.length)][0] ?? "";
    if ((!word(phrase[0] ?? "") || !word(before)) && (!word(phrase.at(-1) ?? "") || !word(after))) return true;
  }
  return false;
}

export function scoreProfiles(profiles: readonly ResolvedProfile[], message: string, tools: readonly string[]) {
  const text = normalise(message);
  const hints = new Set(tools.map(normalise));
  return profiles.map((p) => {
    const phrases = [...new Set(p.trigger.patterns.map(normalise))].filter((phrase) => containsPhrase(text, phrase)).length;
    const hint = p.trigger.harness_hints.some((h) => hints.has(normalise(h)));
    return { id: p.id, score: phrases + (hint ? 2 : 0), confident: hint || phrases >= 2 };
  });
}

/** A suggestion never changes the active profile; only a tool/user choice does (04). */
export function suggestProfile(state: SelectionState, profiles: readonly ResolvedProfile[], message: string, tools: readonly string[]) {
  const scores = scoreProfiles(profiles, message, tools);
  const best = Math.max(0, ...scores.map((p) => p.score));
  const leaders = scores.filter((p) => p.score === best);
  const top = leaders.length === 1 ? leaders[0] : undefined;
  if (best === 0 || top === undefined || top.id === state.active_profile) {
    return { candidate: null, candidate_streak: 0, inject: null };
  }
  const streak = state.candidate === top.id ? Math.min(1000, state.candidate_streak + 1) : 1;
  return { candidate: top.id, candidate_streak: streak, inject: top.confident || streak >= 2 ? SELECTION_REQUEST : null };
}
