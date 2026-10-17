import { schemaPlaceholder } from "@prosegate/schema";
import { segmenterPlaceholder } from "@prosegate/segmenter";
import { enginePlaceholder } from "@prosegate/engine";
import { profilesPlaceholder } from "@prosegate/profiles";
import { reviewerPlaceholder } from "@prosegate/reviewer";

/** Placeholder so the workspace graph is real; replaced by product code in a later item. */
export const evalPlaceholder = {
  id: "prosegate:eval:placeholder",
  uses: [schemaPlaceholder.id, segmenterPlaceholder.id, enginePlaceholder.id, profilesPlaceholder.id, reviewerPlaceholder.id] as readonly string[],
} as const;
