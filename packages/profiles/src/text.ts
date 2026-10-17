/**
 * The filter for model-injected text (ADR-19, 07 threat 3).
 *
 * Every string Prosegate puts into a model's context passes `injectedTextViolation`:
 * rule `instruction.text`, profile `name`, `trigger.description`, `reviewer.register.tone` and
 * `format`, the org name, and (in the reviewer client, which imports this function) reviewer-written
 * `register` instructions. The pack and profile text comes from third-party publishers and reaches an
 * agent that holds shell tools, so this is the last control before the model.
 *
 * Fields that NEVER reach a model are exempt, and must stay that way: phrases, regex and
 * `starts_with` patterns, `sentence_exclude`, `examples`, `trigger.patterns`, `trigger.harness_hints`,
 * `allow_terms`, ids, and rule-pack range strings. They are matched against text by the engine or
 * by the adapter's heuristics and are never rendered into a prompt. If one of them is ever rendered
 * into a prompt, it must be passed through this filter first.
 *
 * The check is an allowlist plus a denylist, run on the text as written and on its NFKC form, so
 * fullwidth look-alikes cannot hide a link or a command. The allowlist is:
 * letters, ASCII digits, ASCII space, at most two consecutive combining marks, and the punctuation
 * `. , ; : ! ? ' " ( ) - en-dash em-dash curly quotes / % & + = ellipsis`. Tokens may not mix scripts.
 * Default-ignorable code points (variation selectors, zero-width, Hangul fillers, tag characters),
 * private-use, unassigned, lone surrogates, braille blanks and every other symbol fall outside it.
 * The denylist then rejects links, domains, addresses, command and tool vocabulary, the product
 * name, and injection phrases.
 *
 * A filter cannot stop an instruction that is harmful in plain words; that residual is in 07.
 */

const DEFAULT_MAX = 200;

const PUNCTUATION = new Set([
  ".", ",", ";", ":", "!", "?", "'", '"', "(", ")", "-", "\u{2013}", "\u{2014}",
  "\u{2018}", "\u{2019}", "\u{201c}", "\u{201d}", "/", "%", "&", "+", "=", "\u{2026}",
]);

const LETTER = /^\p{L}$/u;
const MARK = /^\p{M}$/u;
const IGNORABLE = /^\p{Default_Ignorable_Code_Point}$/u;

// Scripts told apart for the mixed-script rule. Han, Hiragana, Katakana and Hangul share one group
// because Japanese and Korean text mixes them. A letter in any other script counts as "other".
const SCRIPTS: Array<[string, RegExp]> = [
  ["latin", /^\p{Script=Latin}$/u],
  ["greek", /^\p{Script=Greek}$/u],
  ["cyrillic", /^\p{Script=Cyrillic}$/u],
  ["armenian", /^\p{Script=Armenian}$/u],
  ["hebrew", /^\p{Script=Hebrew}$/u],
  ["arabic", /^\p{Script=Arabic}$/u],
  ["devanagari", /^\p{Script=Devanagari}$/u],
  ["thai", /^\p{Script=Thai}$/u],
  ["georgian", /^\p{Script=Georgian}$/u],
  ["cjk", /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]$/u],
];

function scriptOf(ch: string): string {
  for (const [name, re] of SCRIPTS) if (re.test(ch)) return name;
  return "other";
}

/** Allowlist pass: returns a reason or null. `s` is already length-bounded. */
function checkAllowlist(s: string): string | null {
  let marks = 0;
  let token = new Set<string>();
  const endToken = (): string | null => {
    const mixed = token.size > 1;
    token = new Set();
    return mixed ? "mixes scripts within one word" : null;
  };
  for (const ch of s) {
    if (IGNORABLE.test(ch)) return "contains an invisible character";
    if (LETTER.test(ch)) {
      marks = 0;
      token.add(scriptOf(ch));
      continue;
    }
    if (MARK.test(ch)) {
      marks += 1;
      if (marks > 2) return "stacks more than two combining marks";
      continue;
    }
    marks = 0;
    const boundary = endToken();
    if (boundary !== null) return boundary;
    if (ch === " " || (ch >= "0" && ch <= "9") || PUNCTUATION.has(ch)) continue;
    return "contains a character outside the allowed set";
  }
  return endToken();
}

const TLDS = [
  "com", "org", "net", "io", "dev", "ai", "app", "co", "edu", "gov", "info", "biz", "xyz", "me", "ly",
  "sh", "tv", "cc", "us", "uk", "de", "fr", "ru", "cn", "jp", "in", "br", "au", "ca", "nl", "es", "it",
  "se", "no", "ch", "eu", "online", "site", "tech", "cloud", "link", "page", "top", "club", "store",
  "shop", "live", "rest", "zip", "mov", "su", "tk", "ml", "ga", "cf", "gq", "pw", "ws", "to", "gl", "sx",
].join("|");
const SCHEMES =
  "https?|ftps?|sftp|wss?|file|data|javascript|vbscript|mailto|tel|sms|ssh|git|blob|about|chrome|view-source|jar|ldap|gopher|irc|magnet|news|nntp|telnet|urn|intent";

const DOMAIN = new RegExp(`(?<![a-z0-9-])(?:[a-z0-9-]+\\.)+(?:${TLDS})(?![a-z0-9-])`);
const DOT_WORD = new RegExp(`(?<![a-z0-9-])dot\\s+(?:${TLDS})(?![a-z0-9-])`);
const SCHEME_COLON = new RegExp(`(?<![a-z])(?:${SCHEMES}):`);
const DOTTED_QUAD = /(?<![0-9])\d{1,3}(?:\s*\.\s*\d{1,3}){3}(?![0-9])/;
const NON_ASCII_DOTTED = /[\p{L}\p{M}]{2,}\.[\p{L}\p{M}]{2,}/u;
const COMMAND_WORDS =
  /(?<![a-z0-9])(?:curl|wget|sudo|chmod|chown|bash|zsh|powershell|pwsh|eval|exec|base64|nc|ncat|netcat|ssh|scp|telnet|mcp|prosegate)(?![a-z0-9])/;
const COMMAND_PHRASES = /(?<![a-z0-9])(?:rm\s+-|sh\s+-|&&)/;
const TOOL_NAMES = /(?<![A-Za-z0-9])(?:Bash|WebFetch|WebSearch|NotebookEdit)(?![A-Za-z0-9])/;
const INJECTION = /(?<![a-z])(?:(?:ignore|disregard|forget)\s+(?:all\s+|the\s+|any\s+|your\s+)?(?:previous|prior|above|earlier)|(?:system|assistant)\s*:)/;

/** Denylist pass over one allowlisted form. */
function checkDenylist(form: string): string | null {
  const lower = form.toLowerCase();
  const squeezed = lower.replace(/\s+/g, "");
  if (lower.includes(":/") || squeezed.includes(":/")) return "contains a link";
  if (SCHEME_COLON.test(lower)) return "contains a link";
  // "evil . com": a space before a dot is not prose punctuation, so close it up before matching.
  const closed = lower.replace(/\s+\.\s*/g, ".");
  if (DOMAIN.test(closed) || DOT_WORD.test(lower)) return "contains a domain name";
  if (DOTTED_QUAD.test(lower)) return "contains an IP address";
  if (/\P{ASCII}/u.test(form) && NON_ASCII_DOTTED.test(form)) return "contains a dotted name with non-ASCII letters";
  if (COMMAND_WORDS.test(lower) || COMMAND_PHRASES.test(lower)) return "contains command or tool vocabulary";
  if (TOOL_NAMES.test(form)) return "contains command or tool vocabulary";
  if (INJECTION.test(lower)) return "contains an instruction-override phrase";
  return null;
}

/**
 * Returns why `text` may not be shown to a model, or null when it may. `max` is the length cap in
 * code points (200 for instruction text and descriptions, 100 for names). The text must be
 * non-empty after trimming.
 */
export function injectedTextViolation(text: string, max: number = DEFAULT_MAX): string | null {
  if (typeof text !== "string") return "is not text";
  if (text.trim() === "") return "is empty";
  // Count code points without building an array for hostile input: stop once past the cap.
  let points = 0;
  for (let i = 0; i < text.length; i++) {
    points += 1;
    if (points > max) return `is longer than ${max} characters`;
    const code = text.codePointAt(i);
    if (code !== undefined && code > 0xffff) i += 1;
  }
  const forms = new Set([text, text.normalize("NFKC")]);
  for (const form of forms) {
    const reason = checkAllowlist(form) ?? checkDenylist(form);
    if (reason !== null) return reason;
  }
  return null;
}
