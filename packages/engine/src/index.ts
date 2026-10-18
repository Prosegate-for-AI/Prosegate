/**
 * @prosegate/engine: the deterministic rule stage. `compilePack` turns a parsed rule pack into an
 * immutable CompiledPack; `reviewRules` runs the packs of a resolved profile over a turn's text and
 * returns the ReviewResult (03).
 *
 * Choices 03, 04, 08 and ADR-15 leave open are documented where they are made: matching in
 * search.ts, metric definitions in metrics.ts, overlap tie-breaks in overlap.ts, pass semantics and
 * the stats fields in review.ts.
 */
import { profilesPlaceholder } from "@prosegate/profiles";
import { schemaPlaceholder } from "@prosegate/schema";
import { segmenterPlaceholder } from "@prosegate/segmenter";
import { ENGINE_ID } from "./id.js";

/** Placeholder so the workspace graph is real; kept until the sibling packages stop importing it. */
export const enginePlaceholder = {
  id: ENGINE_ID,
  uses: [schemaPlaceholder.id, segmenterPlaceholder.id, profilesPlaceholder.id] as readonly string[],
} as const;

export {
  clearPackCache,
  compilePack,
  PackCompileError,
  type CompiledMatch,
  type CompiledPack,
  type CompiledRule,
  type DocumentMetricMatch,
  type SearchFilters,
  type SearchMatch,
  type SearchPart,
  type SentenceMetricMatch,
} from "./compile.js";
export { MAX_SIMILARITY_CANDIDATES, MIN_CLOSING_BLOCKS, SIMILARITY_MAX_WORDS } from "./metrics.js";
export { WINDOW_CHARS, WINDOW_OVERLAP } from "./search.js";
export { resolveOverlaps, type Resolvable } from "./overlap.js";
export {
  MAX_FINDINGS_PER_RULE,
  MAX_FINDINGS_PER_TURN,
  PackVersionError,
  reviewRules,
  reviewRulesDetailed,
  RULES_BUDGET_MS,
  stagesFor,
  type DetailedReview,
  type ReviewRulesInput,
  type RuleCandidate,
  type RulesDiagnostics,
} from "./review.js";
export { isStopWord, STOP_WORDS, STOP_WORDS_VERSION } from "./stopwords.js";
