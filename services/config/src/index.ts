import { schemaPlaceholder } from "@prosegate/schema";
import { profilesPlaceholder } from "@prosegate/profiles";

/** Placeholder so the workspace graph is real; replaced by product code in a later item. */
export const configPlaceholder = {
  id: "prosegate:config:placeholder",
  uses: [schemaPlaceholder.id, profilesPlaceholder.id] as readonly string[],
} as const;
