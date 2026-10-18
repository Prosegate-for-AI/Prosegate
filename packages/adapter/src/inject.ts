// What the adapter says to the model at session start (05 `inject`), and the once-per-session lines
// that go with it (09). Everything here is either fixed text of ours or a profile-derived field that
// passed the injected-text filter (ADR-19, ADR-20, obligation 18).

import type { ResolvedProfile } from "@prosegate/profiles";
import { idDenylistViolation, injectedTextViolation } from "@prosegate/schema";

/** Longest assembled profile-derived text: name 100 + description 200 + tone 200 + format 200, plus separators. */
const DYNAMIC_MAX = 760;

export function profileSlug(id: string): string {
  const i = id.lastIndexOf("/");
  return i === -1 ? id : id.slice(i + 1);
}

/** 09: `Prosegate · profile <slug> updated to v<N> (<k> rules changed) · prosegate profile diff to see`. */
export function profileUpdatedLine(profileId: string, version: string, changes: number): string {
  const int = version.split("+")[0] ?? version;
  const what = changes === 0 ? "" : changes === 1 ? " (1 rule changed)" : ` (${changes} rules changed)`;
  return `Prosegate · profile ${profileSlug(profileId)} updated to v${int}${what} · prosegate profile diff to see`;
}

/** ADR-18: shown once per session when `required` made the adapter ignore local files. */
export function overlaysIgnoredLine(orgName: string): string {
  return `Prosegate · local profiles and rule overlays are ignored in this session · enforcement is required by ${orgName}`;
}

/** The first problem found in the user's own files, with a count of the rest (09: tell the user which file is wrong). */
export function resolutionIssueLine(issues: readonly string[]): string | null {
  const [first] = issues;
  if (first === undefined) return null;
  const more = issues.length - 1;
  return `Prosegate · ${first}${more > 0 ? ` (+${more} more)` : ""}`;
}

/**
 * The model-bound block. The profile-derived fields (name, description, tone, format) are filtered as
 * ONE string, joined by a space, so a word cannot be assembled across two fields; the labels around
 * them are ours and fixed. If the filter objects, only the profile id goes in (and nothing if the id
 * itself fails the id denylist).
 */
export function buildInject(resolved: ResolvedProfile, extraLines: readonly string[] = []): string {
  const id = resolved.id;
  if (idDenylistViolation(id) !== null) return "";
  const register = resolved.reviewer.register;
  const description = resolved.trigger.description;
  const dynamic = [resolved.name, description, register.tone, register.format].filter((x): x is string => typeof x === "string" && x !== "");
  const lines: string[] = [
    "Prosegate checks the prose of your replies at the end of each turn.",
    `Active profile: ${resolved.name} (${id}).`,
  ];
  if (description !== null && description !== "") lines.push(`Applies to: ${description}`);
  if (register.tone !== undefined) lines.push(`Tone: ${register.tone}`);
  if (register.format !== undefined) lines.push(`Format: ${register.format}`);
  if (register.max_words !== undefined) lines.push(`Length: at most ${register.max_words} words.`);
  lines.push("Tools: list_profiles lists the profiles; select_profile switches to the one that fits the task.");
  const violation = injectedTextViolation(dynamic.join(" "), DYNAMIC_MAX);
  if (violation !== null) return [`Prosegate profile: ${id}`, ...extraLines].join("\n");
  return [...lines, ...extraLines].join("\n");
}
