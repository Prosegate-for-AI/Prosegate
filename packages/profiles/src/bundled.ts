import {
  BASE_YAML,
  CHAT_REPLY_YAML,
  CORE_PACK_YAML,
  DESIGN_DOC_YAML,
  EMAIL_YAML,
  PR_DESCRIPTION_YAML,
} from "./bundled.generated.js";
import type { PackVersionSource, ProfileSource } from "./resolve.js";

/** The five starter profiles (08 "Default profile membership"), keyed by profile id. */
export const BUNDLED_PROFILE_YAML: Readonly<Record<string, string>> = {
  "local/base": BASE_YAML,
  "local/pr-description": PR_DESCRIPTION_YAML,
  "local/design-doc": DESIGN_DOC_YAML,
  "local/email": EMAIL_YAML,
  "local/chat-reply": CHAT_REPLY_YAML,
};

/** The bundled rule packs (`core` 0.1.0), keyed by `<id>@<version>`. */
export const BUNDLED_PACK_YAML: Readonly<Record<string, string>> = {
  "core@0.1.0": CORE_PACK_YAML,
};

/**
 * The starters as resolver sources. They ship inside the adapter, so they are `origin: "bundled"`
 * with no service signature (`signed: false`); the adapter's own integrity (npm provenance, 07
 * threat 8) covers them.
 */
export function bundledProfileSources(): Record<string, ProfileSource> {
  const out: Record<string, ProfileSource> = {};
  for (const [id, yaml] of Object.entries(BUNDLED_PROFILE_YAML)) out[id] = { yaml, signed: false, origin: "bundled" };
  return out;
}

/** Available pack versions for the bundled packs, as resolver sources. */
export function bundledPackSources(): Record<string, PackVersionSource[]> {
  const out: Record<string, PackVersionSource[]> = {};
  for (const key of Object.keys(BUNDLED_PACK_YAML)) {
    const [id, version] = key.split("@") as [string, string];
    (out[id] ??= []).push({ version, signed: false, origin: "bundled" });
  }
  return out;
}
