import { schemaPlaceholder } from "@prosegate/schema";
import { segmenterPlaceholder } from "@prosegate/segmenter";
import { profilesPlaceholder } from "@prosegate/profiles";

/** Placeholder so the workspace graph is real; replaced by product code in a later item. */
export const reviewerPlaceholder = {
  id: "prosegate:reviewer:placeholder",
  uses: [schemaPlaceholder.id, segmenterPlaceholder.id, profilesPlaceholder.id] as readonly string[],
} as const;
