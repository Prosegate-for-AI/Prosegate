/**
 * The engine's published stop-word list (04: "bag-of-words cosine over content words, using the
 * engine's published stop-word list"). `similarity_to_prior` and `closing_similarity` drop these
 * tokens before comparing; nothing else in the engine uses the list.
 *
 * Tokens are compared in lowercase after the possessive / contraction suffix `'s` is stripped
 * ("tenant's" -> "tenant", "it's" -> "it"), so the other contractions are listed in full.
 *
 * It is a closed class of English function words (articles, pronouns, prepositions, conjunctions,
 * auxiliaries, determiners, common adverbs of degree). It deliberately does NOT contain "per" or
 * other words that carry meaning in engineering prose. Changing this list changes which sentences
 * `core.repetition.001` and `core.structure.004` flag, so it is part of the pack contract: bump
 * `STOP_WORDS_VERSION` when it changes.
 */
export const STOP_WORDS_VERSION = 1;

const WORDS =
  "a about above after again against all also am an and any are aren't as at be because been before being below " +
  "between both but by can can't cannot could couldn't did didn't do does doesn't doing don't done down during each " +
  "else few for from further had hadn't has hasn't have haven't having he her here hers him his how i i'd i'll i'm " +
  "i've if in into is isn't it its just let like may me might more most must my no nor not now of off on once only " +
  "or other our ours out over own same shall she should shouldn't so some such than that the their theirs them then " +
  "there these they they'd they'll they're they've this those through to too under until up us very was wasn't we " +
  "we'd we'll we're we've were weren't what when where which while who whom whose why will with won't would " +
  "wouldn't you you'd you'll you're you've your yours s t";

/** The stop list, sorted, without duplicates. */
export const STOP_WORDS: readonly string[] = Object.freeze([...new Set(WORDS.split(" "))].sort());

const STOP_SET: ReadonlySet<string> = new Set(STOP_WORDS);

export function isStopWord(token: string): boolean {
  return STOP_SET.has(token);
}
