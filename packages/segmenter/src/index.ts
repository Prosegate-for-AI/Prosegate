import { schemaPlaceholder } from "@prosegate/schema";

/** Placeholder so the workspace graph is real; replaced by product code in a later item. */
export const segmenterPlaceholder = {
  id: "prosegate:segmenter:placeholder",
  uses: [schemaPlaceholder.id] as readonly string[],
} as const;
