/**
 * Typed errors for everything this package rejects. The `code` is stable (the config service maps
 * it onto `application/problem+json`, 06); the message is for humans and names the offending ids
 * but never echoes a whole YAML document.
 */

export type ResolutionErrorCode =
  | "cycle"
  | "depth_exceeded"
  | "missing_parent"
  | "range_conflict"
  | "no_pack_version"
  | "pack_conflict_local_synced"
  | "invalid_profile"
  | "invalid_pack"
  | "unsupported_findings_schema";

/** One problem found in a document. `path` is "" for the document root. */
export interface Issue {
  path: string;
  message: string;
}

const MAX_MESSAGE_ISSUES = 5;
const MAX_ISSUE_TEXT = 200;

/** Shortens text that may contain user-supplied content; never lets one issue grow unbounded. */
export function clip(text: string, max = MAX_ISSUE_TEXT): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

export class ResolutionError extends Error {
  readonly code: ResolutionErrorCode;
  /** Profile ids and pack ids the error is about, for the 06 problem+json body. */
  readonly ids: readonly string[];
  /** Per-field problems for the invalid_* codes; empty otherwise. */
  readonly issues: readonly Issue[];

  constructor(code: ResolutionErrorCode, message: string, ids: readonly string[] = [], issues: readonly Issue[] = []) {
    super(message);
    this.name = "ResolutionError";
    this.code = code;
    this.ids = ids;
    this.issues = issues;
  }
}

/** "path: message; path: message (and N more)" for the first few issues. */
export function summariseIssues(issues: readonly Issue[]): string {
  const shown = issues.slice(0, MAX_MESSAGE_ISSUES).map((i) => (i.path === "" ? i.message : `${i.path}: ${i.message}`));
  const more = issues.length - shown.length;
  return more > 0 ? `${shown.join("; ")} (and ${more} more)` : shown.join("; ");
}

export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: ResolutionError };
