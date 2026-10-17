// Build-only fixture for scripts/check-bundle.test.mjs: imports every workspace package the
// adapter may depend on, so the test can prove tsup inlines them into one file.
import { enginePlaceholder } from "@prosegate/engine";
import { profilesPlaceholder } from "@prosegate/profiles";
import { reviewerPlaceholder } from "@prosegate/reviewer";
import { schemaPlaceholder } from "@prosegate/schema";
import { segmenterPlaceholder } from "@prosegate/segmenter";

for (const p of [schemaPlaceholder, segmenterPlaceholder, profilesPlaceholder, enginePlaceholder, reviewerPlaceholder]) {
  console.log(p.id);
}
