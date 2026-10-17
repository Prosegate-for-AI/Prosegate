import { schemaPlaceholder } from "@prosegate/schema";

/** Placeholder so the workspace graph is real; replaced by product code in a later item. */
export const profilesPlaceholder = {
  id: "prosegate:profiles:placeholder",
  uses: [schemaPlaceholder.id] as readonly string[],
} as const;
