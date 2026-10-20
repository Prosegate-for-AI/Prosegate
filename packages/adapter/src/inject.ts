// What the adapter says to the model at session start (05 `inject`), and the user-facing lines that go
// beside it as `notice` (ADR-28). The two are separate channels: a notice names prosegate commands and
// spends the model's tokens, so notices are never appended to `inject`. The inject describes only what
// exists (the local MCP tools and rules checker), and every profile-derived field in it
// passed the injected-text filter (ADR-19, ADR-20, obligation 18).

import type { ResolvedProfile } from "@prosegate/profiles";
import { idDenylistViolation, injectedTextViolation } from "@prosegate/schema";
import type { Issue } from "./profiles.js";
import { integerVersion } from "./profiles.js";

/** Longest assembled profile-derived text: name 100 + description 200 + tone 200 + format 200, plus separators. */
const DYNAMIC_MAX = 760;

/** The guard the feedback also carries (ADR-16, ADR-28); the model meets it before it meets the word "prosegate" anywhere else. */
export const GUARD_LINE = "If a later message starts with [Prosegate], revise your last response as it asks. Do not run prosegate commands.";

export function profileSlug(id: string): string {
  const i = id.lastIndexOf("/");
  return i === -1 ? id : id.slice(i + 1);
}

/** ADR-28, 09: `Prosegate · profile pr-description updated to v5 (2 rules changed)`; no pointer to a command that does not exist. */
export function profileUpdatedLine(profileId: string, version: string, rulesChanged: number): string {
  const what = rulesChanged === 0 ? "" : rulesChanged === 1 ? " (1 rule changed)" : ` (${rulesChanged} rules changed)`;
  return `Prosegate · profile ${profileSlug(profileId)} updated to v${integerVersion(version)}${what}`;
}

/** N7: a revision with no prose cannot show that earlier findings were fixed, so they are reported as remaining. */
export function uncheckedLine(n: number): string {
  return `Prosegate · ${n === 1 ? "1 finding" : `${n} findings`} could not be re-checked (the revision has no prose) · shipped as is`;
}

/** N9: a reply longer than the review limit was only partly read; the user is told, in every mode but headless. */
export function truncatedLine(): string {
  return "Prosegate · only the first 100 KB of prose in this reply was reviewed";
}

/** N9: so long that none of its prose was within the part that could be read (for instance 1 MB of code first). */
export function tooLongLine(): string {
  return "Prosegate · this reply is too long to review; its prose was not checked";
}

/** ADR-18, ADR-28 (N8): shown once per session when `required` made the adapter ignore local files. */
export function overlaysIgnoredLine(orgName: string): string {
  return `Prosegate · your local profiles and rule changes are not used in this session · ${orgName} requires enforcement`;
}

/** `--debug` is on: the user is told once per session, because hook stderr is not visible (ADR-30). */
export function debugNoticeLine(dir: string): string {
  return `Prosegate · debug is on: each turn's text is written to ${dir}`;
}

/** UX S6: the first problem found in the user's own files, with a count of the rest. */
export function resolutionIssueLine(issues: readonly Issue[]): string | null {
  const [first] = issues;
  if (first === undefined) return null;
  const more = issues.length - 1;
  const what =
    first.path === null
      ? first.reason
      : first.fellBack
        ? `${first.path} could not be used (${first.reason}); using local/base instead`
        : `ignoring ${first.path} (${first.reason})`;
  return `Prosegate · ${what}${more > 0 ? ` (+${more} more)` : ""} · fix it, then run prosegate reload`;
}

/**
 * The model-bound block (ADR-28). The profile-derived fields (name, description, tone, format) are
 * filtered as ONE string, joined by a space, so a word cannot be assembled across two fields; the labels
 * around them are ours and fixed. If the filter objects, only the guard goes in (and nothing at all if
 * the id itself fails the id denylist).
 */
export function buildInject(resolved: ResolvedProfile): string {
  const id = resolved.id;
  if (idDenylistViolation(id) !== null) return "";
  const register = resolved.reviewer.register;
  const description = resolved.trigger.description;
  const dynamic = [resolved.name, description, register.tone, register.format].filter((x): x is string => typeof x === "string" && x !== "");
  const violation = injectedTextViolation(dynamic.join(" "), DYNAMIC_MAX);
  if (violation !== null) return GUARD_LINE;
  const lines: string[] = [
    GUARD_LINE,
    "Use list_profiles to see the available styles, select_profile to choose one before writing, and review_prose to check a draft once per turn.",
    `Active profile: ${resolved.name}.`,
  ];
  if (description !== null && description !== "") lines.push(`Applies to: ${description}`);
  if (register.tone !== undefined) lines.push(`Tone: ${register.tone}`);
  if (register.format !== undefined) lines.push(`Format: ${register.format}`);
  if (register.max_words !== undefined) lines.push(`Aim for at most ${register.max_words} words of prose; code and quoted output do not count.`);
  return lines.join("\n");
}
