import { schemaPlaceholder } from "@prosegate/schema";
import { segmenterPlaceholder } from "@prosegate/segmenter";
import { profilesPlaceholder } from "@prosegate/profiles";
export { buildPrompt, PROMPT_VERSION, SYSTEM_PROMPT, type ReviewerPrompt } from "./prompt.js";
export { reviewDraft, reviewerEligibility, type ReviewDraftInput, type ReviewerOutcome } from "./review.js";

/** Scaffold identity retained for existing workspace-graph consumers; real APIs are exported above. */
export const reviewerPlaceholder = {
  id: "prosegate:reviewer:placeholder",
  uses: [schemaPlaceholder.id, segmenterPlaceholder.id, profilesPlaceholder.id] as readonly string[],
} as const;
