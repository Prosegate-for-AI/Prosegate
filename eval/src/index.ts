import { schemaPlaceholder } from "@prosegate/schema";
import { segmenterPlaceholder } from "@prosegate/segmenter";
import { enginePlaceholder } from "@prosegate/engine";
import { profilesPlaceholder } from "@prosegate/profiles";
import { reviewerPlaceholder } from "@prosegate/reviewer";
export { annotate, adjudicate, qualified, agreement, kappa } from "./annotations.js";
export { corpusAudit, loadRubric } from "./corpus.js";
export { importCorpus } from "./import.js";
export { GenerationPlan, generate } from "./generate.js";
export { evaluateReviewer } from "./reviewer-eval.js";
export { evaluateE2e, scoreE2e } from "./e2e.js";
export { ModelSchema, Spend, type Model } from "./provider.js";

/** Scaffold identity retained for existing graph consumers; evaluation APIs are exported above. */
export const evalPlaceholder = {
  id: "prosegate:eval:placeholder",
  uses: [schemaPlaceholder.id, segmenterPlaceholder.id, enginePlaceholder.id, profilesPlaceholder.id, reviewerPlaceholder.id] as readonly string[],
} as const;
