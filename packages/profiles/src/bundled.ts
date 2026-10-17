import {
  BASE_YAML,
  CHAT_REPLY_YAML,
  DESIGN_DOC_YAML,
  EMAIL_YAML,
  PR_DESCRIPTION_YAML,
} from "./bundled.generated.js";
import type { ProfileSource } from "./resolve.js";

/** The five starter profiles (08 "Default profile membership"), keyed by profile id. */
export const BUNDLED_PROFILE_YAML: Readonly<Record<string, string>> = {
  "local/base": BASE_YAML,
  "local/pr-description": PR_DESCRIPTION_YAML,
  "local/design-doc": DESIGN_DOC_YAML,
  "local/email": EMAIL_YAML,
  "local/chat-reply": CHAT_REPLY_YAML,
};

/**
 * The starters as resolver sources. They ship inside the adapter, so they carry no service
 * signature (`signed: false`); the adapter's own integrity (npm provenance, 07 threat 8) covers them.
 */
export function bundledProfileSources(): Record<string, ProfileSource> {
  const out: Record<string, ProfileSource> = {};
  for (const [id, yaml] of Object.entries(BUNDLED_PROFILE_YAML)) out[id] = { yaml, signed: false };
  return out;
}
