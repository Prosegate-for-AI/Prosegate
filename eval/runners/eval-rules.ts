// Stub. Becomes the real rule-pack evaluation runner in Phase 2 (plan section 6.9).
// It imports a workspace package on purpose: this proves tsx resolves workspace sources and
// their relative `.js` imports before any real runner exists.
import { enginePlaceholder } from "@prosegate/engine";

if (enginePlaceholder.id.length === 0) throw new Error("engine placeholder missing");
console.log("eval:rules: no packs yet");
