import { schemaPlaceholder } from "@prosegate/schema";

/**
 * Kept until engine, adapter and eval stop importing it (their placeholders chain through this
 * export, and those packages are outside W1.3). Delete together with index.test.ts then.
 */
export const profilesPlaceholder = {
  id: "prosegate:profiles:placeholder",
  uses: [schemaPlaceholder.id] as readonly string[],
} as const;

export { bundledPackSources, bundledProfileSources, BUNDLED_PACK_YAML, BUNDLED_PROFILE_YAML } from "./bundled.js";
export { ResolutionError, type Issue, type ParseResult, type ResolutionErrorCode } from "./errors.js";
export { parseProfile, parseProfileYaml, type Profile } from "./profile.js";
export {
  DOCUMENT_METRICS,
  SENTENCE_METRICS,
  SUPPORTED_FINDINGS_SCHEMA,
  parseRulePack,
  parseRulePackYaml,
  type Rule,
  type RuleMatch,
  type RulePack,
} from "./rulepack.js";
export {
  MAX_PROFILE_DEPTH,
  effectiveReviewer,
  effectiveRule,
  resolveProfile,
  type EffectiveReviewer,
  type EffectiveRule,
  type LocalOverlay,
  type PackVersionSource,
  type ProfileSource,
  type ResolutionSources,
  type ResolveOptions,
} from "./resolve.js";
export {
  OrgPolicyBodySchema,
  OrgPolicyInputSchema,
  ResolvedPolicySchema,
  SNAPSHOT_SCHEMA,
  canonicalJson,
  contentHash,
  parseSnapshot,
  serializeSnapshot,
  type OrgPolicyBody,
  type OrgPolicyInput,
  type ResolvedPolicy,
  type ResolvedProfile,
} from "./snapshot.js";
export { MAX_PACK_BYTES, MAX_PACK_NODES, MAX_PROFILE_BYTES, MAX_PROFILE_NODES } from "./yaml.js";
export { injectedTextViolation } from "./text.js";
