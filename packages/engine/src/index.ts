import { profilesPlaceholder } from "@prosegate/profiles";
import { schemaPlaceholder } from "@prosegate/schema";
import { segmenterPlaceholder } from "@prosegate/segmenter";
import { ENGINE_ID } from "./id.js";

/** Placeholder so the workspace graph is real; replaced by product code in a later item. */
export const enginePlaceholder = {
  id: ENGINE_ID,
  uses: [schemaPlaceholder.id, segmenterPlaceholder.id, profilesPlaceholder.id] as readonly string[],
} as const;
