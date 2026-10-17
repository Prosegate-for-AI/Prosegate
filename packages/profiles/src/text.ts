/**
 * Text that ends up in a model's context must be plain. 07 threat 3: a rule pack or profile that
 * arrives from sync can steer the user's model, so instruction text is limited to short plain
 * sentences. This file is the single definition of "plain"; the schemas call it, and
 * instruction-constraints.security.test.ts pins every forbidden form.
 */

export type TextViolation = "control_character" | "backtick" | "url";

// Cc: C0/C1 controls (NUL, newline, tab, DEL, U+0085). Cf: format characters (zero-width space and
// joiner, bidi overrides, BOM, soft hyphen), the usual carriers for hidden or reordered text.
// Zl/Zp: U+2028/U+2029, which some renderers treat as line breaks.
// Side effect: emoji built with a zero-width joiner are rejected. Accepted.
const CONTROL = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

// Any `scheme://` (covers https?://, ftp://, file://), `www.`, and a bare domain whose TLD is
// directly followed by `/`. A bare domain with nothing after it ("example.com") is NOT flagged: 04/07
// say "a bare domain with a TLD followed by /". Reported as a candidate spec question.
const SCHEME = /\b[a-z][a-z0-9+.-]*:\/\//i;
const WWW = /\bwww\./i;
const BARE_DOMAIN = /\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}\//i;

function hasUrl(text: string): boolean {
  return SCHEME.test(text) || WWW.test(text) || BARE_DOMAIN.test(text);
}

/**
 * Returns the first violation, or null for plain text. Checks the text as written and its NFKC
 * form, so fullwidth or compatibility look-alikes (fullwidth "https://", a fullwidth grave accent)
 * cannot slip past a check that only looks at ASCII.
 *
 * Callers must bound the length first (the regexes are polynomial in the worst case); the schemas
 * only call this for strings already within their maximum.
 */
export function findTextViolation(text: string): TextViolation | null {
  if (CONTROL.test(text)) return "control_character";
  const folded = text.normalize("NFKC");
  for (const form of folded === text ? [text] : [text, folded]) {
    if (form.includes("`")) return "backtick";
    if (hasUrl(form)) return "url";
  }
  return null;
}

export const TEXT_VIOLATION_MESSAGE: Record<TextViolation, string> = {
  control_character: "must not contain control, invisible or line-break characters",
  backtick: "must not contain a backtick",
  url: "must not contain a URL (a scheme://, www., or a domain followed by /)",
};
