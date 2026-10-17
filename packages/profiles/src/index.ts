import { schemaPlaceholder } from "@prosegate/schema";

/**
 * Kept until engine, adapter and eval stop importing it (their placeholders chain through this
 * export, and those packages are outside W1.3). Delete together with index.test.ts then.
 */
export const profilesPlaceholder = {
  id: "prosegate:profiles:placeholder",
  uses: [schemaPlaceholder.id] as readonly string[],
} as const;

export { bundledProfileSources, BUNDLED_PROFILE_YAML } from "./bundled.js";
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
  effectiveRule,
  resolveProfile,
  type EffectiveRule,
  type LocalOverlay,
  type PackVersionSource,
  type ProfileSource,
  type ResolutionSources,
  type ResolveOptions,
} from "./resolve.js";
export {
  OrgPolicySchema,
  SNAPSHOT_SCHEMA,
  canonicalJson,
  contentHash,
  parseSnapshot,
  serializeSnapshot,
  type OrgPolicy,
  type ResolvedProfile,
} from "./snapshot.js";
export { MAX_PACK_BYTES, MAX_PROFILE_BYTES } from "./yaml.js";
export { findTextViolation, type TextViolation } from "./text.js";
