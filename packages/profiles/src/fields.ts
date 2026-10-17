import semver from "semver";
import { z } from "zod";
import { RULE_CATEGORIES } from "@prosegate/schema";
import { injectedTextViolation } from "./text.js";

// Field schemas shared by the pack, profile and snapshot schemas.

/** ADR-17: namespace, slug and pack id are each [a-z0-9-]{1,31}, so ids fit the telemetry token rule. */
const ID_PART = "[a-z0-9-]{1,31}";
export const PackIdSchema = z.string().regex(new RegExp(`^${ID_PART}$`), "must match [a-z0-9-]{1,31}");
export const ProfileIdSchema = z.string().regex(new RegExp(`^${ID_PART}/${ID_PART}$`), "must be <namespace>/<slug>, each [a-z0-9-]{1,31}");
export const NamespaceSchema = z.string().regex(new RegExp(`^${ID_PART}$`), "must match [a-z0-9-]{1,31}");

/** Any rule id in any pack: `<pack>.<category>.<nnn>`. */
export const RuleIdSchema = z
  .string()
  .regex(new RegExp(`^${ID_PART}\\.(${RULE_CATEGORIES.join("|")})\\.\\d{3}$`), "must look like <pack>.<category>.<nnn>, e.g. core.hedge.001");

export const SeveritySchema = z.enum(["block", "warn", "info"]);

/** 06 and ADR-19: namespaces nobody may register as an account or org. */
export const RESERVED_NAMESPACES = ["local", "prosegate", "core"] as const;

/**
 * A string that reaches a model. `min` is always 1 (non-empty after trim); `max` is in code points.
 * The content check only runs on strings within the cap, so an oversized hostile string costs one
 * length scan.
 */
export function injectedText(max: number) {
  return z
    .string()
    .min(1)
    .superRefine((text, ctx) => {
      // A combining mark with nothing to combine with renders as a stray mark in the model's context.
      if (/^\p{M}/u.test(text)) {
        ctx.addIssue({ code: "custom", message: "text must not start with a combining mark" });
        return;
      }
      const reason = injectedTextViolation(text, max);
      if (reason !== null) ctx.addIssue({ code: "custom", message: `text ${reason}` });
    });
}

/**
 * A pack version range. Stored as `semver.validRange()` output so two spellings of one range compare
 * and hash alike. Empty, whitespace-only and wildcard ranges (`*`, `x`, `||`, `>=0.0.0`) all
 * normalise to `*` and are rejected: a profile must say which versions it accepts (04).
 */
export const RangeSchema = z
  .string()
  .max(100)
  .superRefine((range, ctx) => {
    const normal = semver.validRange(range);
    if (normal === null) ctx.addIssue({ code: "custom", message: "must be a semver range such as >=0.3.0 <1.0.0" });
    else if (normal === "*") ctx.addIssue({ code: "custom", message: "must not be empty or a wildcard; name the versions accepted" });
  })
  .transform((range) => semver.validRange(range) as string);
