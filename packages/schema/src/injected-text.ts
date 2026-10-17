// The filter for model-injected text (ADR-19, ADR-20; 07 threats 3 and 4).
//
// Every string Prosegate puts into a coding agent's context passes `injectedTextViolation`: rule
// `instruction.text`, profile `name`, `trigger.description`, `reviewer.register.tone` and `format`, the org
// name, and reviewer-written `register` instructions. The pack and profile text comes from third parties
// and reaches an agent that holds shell tools, so this is the last control before the model. It lives in
// `@prosegate/schema`, the lowest package, so the profile and pack loaders, the findings validator and the
// reviewer client share one implementation. It uses no Node API: it runs in a Cloudflare Worker.
//
// Fields that NEVER reach a model are exempt and must stay that way: phrases, regex and `starts_with`
// patterns, `sentence_exclude`, `examples`, `trigger.patterns`, `trigger.harness_hints`, `allow_terms`, and
// rule-pack range strings. If one of them is ever rendered into a prompt it must be passed through here.
// Ids reach the model too (the profile id in the session banner, rule ids in findings), so they get the
// narrower `idDenylistViolation`.
//
// Two passes.
//
// 1. ALLOWLIST (text mode only), on the text as written and on its NFKC form: letters, digits (`\p{Nd}`),
//    ASCII space, at most two consecutive combining marks, currency symbols, and a short list of
//    punctuation (see ALLOWED_PUNCTUATION; `#` before a digit, `@` before a letter, `~` before a digit).
//    A word may not mix scripts, except Latin with Han/Kana/Hangul (`PR\u306e\u30bf\u30a4\u30c8\u30eb`). A word written wholly in
//    Cyrillic, Greek, Armenian or an uncommon script inside otherwise Latin text is refused: those scripts
//    hold the look-alikes of Latin letters. Default-ignorable code points, private-use, unassigned, lone
//    surrogates, braille blanks and every other symbol are outside the set.
// 2. DENYLIST, run over several views of the text so that no spelling trick hides a word:
//      a  lowercased raw text
//      b  NFKC, lowercased
//      c  NFKD with every combining mark removed, lowercased   (`pr\u00f3segate`, `cu\u0336rl`)
//      d  c after folding look-alike letters to ASCII           (Cyrillic `\u0441url`, small-cap `\u1d04\u1d1c\u0280\u029f`, Cherokee)
//      e  d with digits/symbols turned into letters (`0->o 1->l 3->e 4->a 5->s 7->t @->a $->s`), reduced to
//         letters only, used only for the product and tool tokens (`p r o s e g a t e`, `pr0s3gate`)
//    The denylist rejects links, domains, addresses, shell command words in command context, command
//    flags, system paths, tool names, the product name, instruction-override phrasing, role labels, and the
//    via-model lead-in.
//
// A filter cannot stop an instruction that is harmful in plain words ("run the command in the team notes"),
// nor one written in a language the English vocabulary does not cover; that residual is in 07.

import { CONFUSABLE_PAIRS } from './confusables.js';
import { isTld } from './tlds.js';

const DEFAULT_MAX = 200;
/** The denylist-only entry point bounds its input so a hostile string costs a bounded scan. */
const DENYLIST_ONLY_MAX = 1000;

// ---- allowlist ----------------------------------------------------------------------------------

const ALLOWED_PUNCTUATION = new Set([
  // ASCII, en dash, em dash, curly quotes, ellipsis
  '.', ',', ';', ':', '!', '?', "'", '"', '(', ')', '-', '\u2013', '\u2014',
  '\u2018', '\u2019', '\u201c', '\u201d', '/', '%', '&', '+', '=', '\u2026',
  // typographic: arrow, bullet, multiplication sign
  '\u2192', '\u2022', '\u00d7',
  // Spanish and French
  '\u00bf', '\u00a1', '\u00ab', '\u00bb',
  // CJK punctuation (fullwidth comma, ideographic comma and stop, corner brackets, middle dot, and the
  // fullwidth ! ? : ; and parentheses, which NFKC folds to their ASCII forms)
  '\u3001', '\u3002', '\u300c', '\u300d', '\u300e', '\u300f', '\u30fb', '\uff0c', '\uff01', '\uff1f', '\uff1a', '\uff1b', '\uff08', '\uff09',
]);

const LETTER = /^\p{L}$/u;
const MARK = /^\p{M}$/u;
const DIGIT = /^\p{Nd}$/u;
const CURRENCY = /^\p{Sc}$/u;
const IGNORABLE = /^\p{Default_Ignorable_Code_Point}$/u;

// Scripts told apart for the mixed-script rule. Han, Hiragana, Katakana and Hangul share one group because
// Japanese and Korean text mixes them. A letter in any other script counts as "other".
const SCRIPTS: Array<[string, RegExp]> = [
  ['latin', /^\p{Script=Latin}$/u],
  ['greek', /^\p{Script=Greek}$/u],
  ['cyrillic', /^\p{Script=Cyrillic}$/u],
  ['armenian', /^\p{Script=Armenian}$/u],
  ['hebrew', /^\p{Script=Hebrew}$/u],
  ['arabic', /^\p{Script=Arabic}$/u],
  ['devanagari', /^\p{Script=Devanagari}$/u],
  ['thai', /^\p{Script=Thai}$/u],
  ['georgian', /^\p{Script=Georgian}$/u],
  // Script_Extensions, not Script: the prolonged sound mark ー and the iteration marks are script "Common"
  // but belong to Kana words (フォーム).
  ['cjk', /^[\p{scx=Han}\p{scx=Hiragana}\p{scx=Katakana}\p{scx=Hangul}]$/u],
];

/** Scripts whose letters include look-alikes of Latin letters. A whole word in one of these, in Latin text, is refused. */
const LOOKALIKE_SCRIPTS = new Set(['greek', 'cyrillic', 'armenian']);

function scriptOf(ch: string): string {
  for (const [name, re] of SCRIPTS) if (re.test(ch)) return name;
  // Scripts not listed above are told apart by 128-code-point block, so a word that joins two of them
  // (Cherokee and Lisu look-alikes) still counts as mixed.
  return `other:${(ch.codePointAt(0) as number) >>> 7}`;
}

/** Allowlist pass: returns a reason or null. `s` is already length-bounded. */
function checkAllowlist(s: string): string | null {
  const chars = Array.from(s);
  let marks = 0;
  let afterLetter = false;
  let token = new Map<string, number>();
  let latinLetters = 0;
  let lookalikeWordLetters = 0;
  let lookalikeWords = 0;
  const endToken = (): string | null => {
    if (token.size === 0) return null;
    const scripts = [...token.keys()];
    const letters = [...token.values()].reduce((a, b) => a + b, 0);
    const latinCount = token.get('latin') ?? 0;
    token = new Map();
    if (scripts.length > 1) {
      // Latin may share a word with Han/Kana/Hangul (`PR\u306e\u30bf\u30a4\u30c8\u30eb`); nothing else may mix.
      if (scripts.every((x) => x === 'latin' || x === 'cjk')) {
        latinLetters += latinCount;
        return null;
      }
      return 'mixes scripts within one word';
    }
    const only = scripts[0] as string;
    if (only === 'latin') latinLetters += letters;
    else if ((LOOKALIKE_SCRIPTS.has(only) || only.startsWith('other:')) && letters >= 2) {
      lookalikeWords += 1;
      lookalikeWordLetters += letters;
    }
    return null;
  };
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i] as string;
    if (IGNORABLE.test(ch)) return 'contains an invisible character';
    if (LETTER.test(ch)) {
      marks = 0;
      afterLetter = true;
      const sc = scriptOf(ch);
      token.set(sc, (token.get(sc) ?? 0) + 1);
      continue;
    }
    if (MARK.test(ch)) {
      marks += 1;
      if (marks > 2) return 'stacks more than two combining marks';
      // A mark after a space, digit or punctuation has nothing to combine with and renders as a stray glyph.
      if (!afterLetter) return 'has a combining mark with no letter to attach to';
      continue;
    }
    marks = 0;
    afterLetter = false;
    const boundary = endToken();
    if (boundary !== null) return boundary;
    if (ch === ' ' || DIGIT.test(ch) || CURRENCY.test(ch) || ALLOWED_PUNCTUATION.has(ch)) continue;
    const next = chars[i + 1] ?? '';
    if (ch === '#' && DIGIT.test(next)) continue; // #123
    if (ch === '~' && DIGIT.test(next)) continue; // ~5
    if (ch === '@' && LETTER.test(next)) continue; // @mention; an email is caught by the denylist
    return 'contains a character outside the allowed set';
  }
  const last = endToken();
  if (last !== null) return last;
  // Whole words of a look-alike script inside otherwise Latin text. A text that is mostly Cyrillic or Greek
  // (a Russian instruction that names "API") is not "otherwise Latin" and passes.
  if (lookalikeWords > 0 && latinLetters >= lookalikeWordLetters) {
    return 'mixes a whole word in another script into Latin text';
  }
  return null;
}

// ---- views --------------------------------------------------------------------------------------

let foldMap: Map<string, string> | null = null;

// Punctuation look-alikes folded in the skeleton view (slash, dot, colon, hyphen, at-sign, backslash).
const PUNCTUATION_FOLD: Array<[string, string]> = [
  ['\u2044\u2215\u29f8\u2571\uff0f', '/'],
  ['\u3002\uff61\u2024\u2027\ufe52\uff0e', '.'],
  ['\ua789\u02d0\u2236\u0589\ufe13\ufe55\uff1a', ':'],
  ['\u2010\u2011\u2012\u2212\ufe58\ufe63\uff0d', '-'],
  ['\uff20\ufe6b', '@'],
  ['\u2216\u29f5\ufe68\uff3c', '\\'],
];

function foldTable(): Map<string, string> {
  if (foldMap === null) {
    foldMap = new Map();
    for (const run of CONFUSABLE_PAIRS) {
      for (let i = 0; i + 1 < run.length; i += 2) foldMap.set(run[i] as string, run[i + 1] as string);
    }
    for (const [from, to] of PUNCTUATION_FOLD) for (const ch of from) foldMap.set(ch, to);
  }
  return foldMap;
}

/** Folds letters that merely look like ASCII letters (and a few punctuation look-alikes) to ASCII. */
function skeleton(s: string): string {
  if (!/\P{ASCII}/u.test(s)) return s;
  const table = foldTable();
  let out = '';
  for (const ch of s) out += table.get(ch) ?? ch;
  return out;
}

const LEET: Record<string, string> = { '0': 'o', '1': 'l', '3': 'e', '4': 'a', '5': 's', '7': 't', '@': 'a', $: 's' };

function leetify(s: string): string {
  return s.replace(/[013457@$]/g, (c) => LEET[c] as string);
}

interface Views {
  /** Distinct lowercase views a-d. */
  forms: string[];
  /** View d (skeleton). */
  d: string;
}

function buildViews(s: string): Views {
  const a = s.toLowerCase();
  const b = s.normalize('NFKC').toLowerCase();
  const stripped = s.normalize('NFKD').replace(/\p{M}/gu, '');
  const c = stripped.toLowerCase();
  const d = skeleton(stripped).toLowerCase();
  return { forms: [...new Set([a, b, c, d])], d };
}

// ---- denylist: patterns --------------------------------------------------------------------------

// Schemes that count as a link when written `scheme:` directly followed by a non-space character. A scheme
// word followed by a colon and a space ("Data: cite where...") is prose.
const SCHEMES = [
  'https?', 'ftps?', 'sftp', 'wss?', 'file', 'data', 'javascript', 'vbscript', 'mailto', 'tel', 'sms', 'ssh', 'git',
  'blob', 'about', 'chrome', 'view-source', 'jar', 'ldap', 'gopher', 'irc', 'magnet', 'news', 'nntp', 'telnet', 'urn',
  'intent', 'smb', 'nfs', 'rtsp', 'rtmp', 'sips?', 'vscode(?:-insiders)?', 'cursor', 'claude', 'slack', 'steam', 'tg',
  'whatsapp', 'skype', 'facetime', 'itms', 'ms-[a-z-]+', 'search-ms', 'shell', 'zoommtg',
].join('|');
const SCHEME_COLON = new RegExp(`(?<![a-z])(?:${SCHEMES}):(?=\\S)`);
const PERCENT_ENCODED = /%(?:2f|3a|5c|2e|40)/;

/** Spoken or bracketed dots. Only unambiguous TLD words follow a spoken "dot" ("dot in" is a sentence). */
const SPOKEN_TLDS =
  'com|org|net|io|dev|ai|app|edu|gov|info|biz|xyz|ly|sh|tv|cc|uk|ru|cn|jp|zip|mov|online|site|tech|cloud|link|page|top|club|store|shop|live|rest|su|tk|ml|ga|cf|gq|pw|ws|sx';
const SPOKEN_DOT = new RegExp(`(?<=[a-z0-9-])\\s+dot\\s+(?=(?:${SPOKEN_TLDS})(?![a-z0-9-]))`, 'g');
const BRACKET_DOT = /\s*[([{<]\s*(?:dot|\.)\s*[)\]}>]\s*/g;
const CANDIDATE_DOMAIN = /[a-z0-9-]+(?:\.[a-z0-9-]+)+/g;

/**
 * Names that look like domains but are product names or file names. Exempt only as a whole token not
 * followed by a path, query, fragment or port. `.md` file names (README.md) are exempt as a class because
 * Markdown file names are far commoner in style guides than Moldovan domains.
 */
const DOMAIN_EXEMPT = new Set([
  'asp.net', 'vb.net', 'socket.io', 'deno.land', 'go.dev', 'web.dev', 'fly.io',
  // the .js family never collides with a TLD, listed so the exemption is documented in one place
  'node.js', 'vue.js', 'next.js', 'nuxt.js', 'react.js', 'express.js', 'chart.js', 'three.js', 'd3.js', 'p5.js',
]);

const DOTTED_QUAD = /(?<![0-9a-z.])\d{1,3}(?:\s*\.\s*\d{1,3}){3}(?![0-9]|\.\d)/;
// IPv6: a compressed form with `::` and at least one hex group beside it, or a full eight-group form.
const IPV6 = /(?<![0-9a-z:])(?:(?:[0-9a-f]{1,4}:){1,7}:(?:[0-9a-f]{1,4}(?::[0-9a-f]{1,4}){0,6})?|::(?:[0-9a-f]{1,4}:){0,6}[0-9a-f]{1,4}|(?:[0-9a-f]{1,4}:){7}[0-9a-f]{1,4})(?![0-9a-z:])/;
const IPV6_BRACKET = /\[[0-9a-f:.]*:[0-9a-f:.]*:[0-9a-f:.]*\]/;

const NON_ASCII_DOTTED = /[\p{L}\p{M}\p{Nd}-]{2,}(?:\.[\p{L}\p{M}\p{Nd}-]{2,})+/gu;

// Characters that render as nothing or carry a hidden payload. Line breaks (Cc, Zl, Zp) are included: the
// vague_claim parenthetical must stay on one line.
const HIDDEN_CHARACTER = /[\p{Default_Ignorable_Code_Point}\p{Cc}\p{Zl}\p{Zp}\p{Co}\p{Cn}\p{Cs}]/u;

const EMAIL =/[^\s(["'\u201c\u2018]@/;

// Command flags: `rm -rf`, `--force`, `python -c`, with ASCII, en or em dashes (and look-alikes).
const FLAG = /(?:^|\s)[-\u2010-\u2015\u2212\ufe58\ufe63\uff0d]{1,2}[a-z]/;
const PIPE_LIKE = /[|<>`]|&&|\$\(|\$\{/;
const COMMAND_SUBSTITUTION = /\$[({]/;
// A path: `~/`, `./`, `../`, `/etc`, `C:\`, `\\server`. Only used to decide whether a shell word is in command context.
const PATH_LIKE = /(?:^|[\s("'])(?:~\/|\.{1,2}\/|\/[a-z0-9._~$-])|[a-z]:[\\/]|\\[a-z\\]/;
// Paths that are never prose: system roots, parent traversal, key files.
const SYSTEM_PATH =
  /(?:^|[\s("'=])\/(?:etc|usr|bin|sbin|var|tmp|home|root|proc|dev|sys|opt|mnt|lib|boot|srv)(?:\/|(?![a-z0-9]))|~\/|\.\.[\\/]|\bid_rsa\b|\bauthorized_keys\b|(?:\.ssh|\.aws|\.gnupg)[\\/]/;

// Shell commands that no style rule has a reason to name (they have no everyday prose sense): rejected
// wherever they appear, in any context, as one word or spaced out ("cu rl", "cur1").
const HARD_SHELL_WORDS = new Set([
  'curl', 'wget', 'sudo', 'chmod', 'chown', 'chgrp', 'pwsh', 'iex', 'iwr', 'irm', 'ncat', 'netcat', 'scp', 'mshta',
  'regsvr32', 'rundll32', 'bitsadmin', 'xargs',
]);
// Shell commands that are also ordinary words or product names in prose ("SSH key", "exec summary", "Bash
// version", "eval runs"): rejected only in command context (see commandViolation).
const SHELL_WORDS = new Set([
  'bash', 'zsh', 'ksh', 'sh', 'ssh', 'sftp', 'nc', 'telnet', 'eval', 'exec', 'base64', 'powershell', 'cmd', 'rm', 'dd',
  'certutil', 'wscript', 'cscript', 'printenv', 'crontab',
]);
// Developer tools: ordinary nouns in prose, so only a strong verb ("run npm") makes them a command.
const DEV_TOOLS = new Set([
  'npm', 'npx', 'pnpm', 'yarn', 'pip', 'pip3', 'pipx', 'git', 'python', 'python3', 'node', 'deno', 'bun', 'docker',
  'kubectl', 'cargo', 'brew', 'apt', 'composer', 'perl', 'ruby', 'php',
]);
// Everyday commands, rejected only directly after run, execute, invoke, type, enter or paste ("run whoami").
// The ambiguous ones (id, find, type, head, top, kill, source) are left out: "run id" is a CI run id.
const COMMON_COMMANDS = new Set([
  'ls', 'cat', 'echo', 'whoami', 'pwd', 'cd', 'mv', 'cp', 'tar', 'unzip', 'pkill', 'grep', 'awk', 'sed', 'tail', 'nano',
  'vim', 'touch', 'mkdir', 'rmdir', 'ping', 'nslookup', 'netstat', 'ipconfig', 'tasklist', 'taskkill', 'wmic', 'ifconfig',
  'uname', 'hostname', 'nmap', 'tcpdump', 'openssl', 'gpg', 'ssh-keygen', 'sshkeygen',
]);
const DIRECT_VERBS = new Set(['run', 'runs', 'running', 'execute', 'executes', 'executing', 'invoke', 'type', 'enter', 'paste']);
const STRONG_VERBS = new Set([
  'run', 'runs', 'running', 'ran', 'execute', 'executes', 'executing', 'invoke', 'invokes', 'invoking', 'type', 'enter',
  'paste', 'pipe', 'piped', 'piping', 'call', 'calls',
]);
const USE_VERBS = new Set(['use', 'using', 'open', 'launch']);
const DETERMINERS = new Set(['the', 'a', 'an', 'your', 'this', 'that']);

// Product and tool tokens, matched on the letters-only view (e).
const PRODUCT_TOKENS = ['prosegate', 'webfetch', 'websearch', 'notebookedit'];
const MCP = /(?<![a-z0-9])m[^a-z0-9]{0,2}c[^a-z0-9]{0,2}p(?![a-z0-9])/;
// "Use the Read tool", "call the Task tool". The harness tool names are ordinary words, so they count only
// right after a verb that invokes them ("Write tool names in code format" is prose).
const TOOL_PHRASE =
  /(?<![a-z0-9])(?:use|using|call|calls|invoke|run|with|via)\s+(?:the\s+|your\s+|a\s+)?(?:read|write|edit|multiedit|task|agent|bash|glob|grep|powershell|todowrite)\s+tools?(?![a-z0-9])/;
const INVOKE_CMDLET = /(?<![a-z0-9])invoke[-\s](?:expression|webrequest|restmethod|command)/;

// Injection phrasing.
const OVERRIDE_VERBS = new Set([
  'ignore', 'ignores', 'ignoring', 'disregard', 'disregards', 'disregarding', 'forget', 'forgets', 'forgetting',
  'override', 'overrides', 'overriding', 'bypass', 'bypasses', 'bypassing',
]);
const OVERRIDE_TARGETS = new Set(['instructions', 'instruction', 'rules', 'prompt', 'prompts', 'guidelines']);
// "Forget the above template" is a style note; "ignore the above" is an override. A noun right after
// "the above" that names a piece of a document keeps the first reading.
const BENIGN_AFTER_ABOVE = new Set([
  'template', 'format', 'example', 'examples', 'list', 'table', 'section', 'paragraph', 'sentence', 'heading',
  'headings', 'wording', 'layout', 'structure',
]);
const ROLE_LABEL = /(?:^|[.!?;"\u201c\u201d([]|\n)\s*(?:system|assistant|user|human|developer)\s*:/;
// Matched against the words of the text joined by single spaces. Includes the ADR-20 via-model lead-in
// ("Begin your revised response with this line"), persona switches, a new-instructions header, a request to
// repeat the system prompt, blanket tool approval, and a scheme spelled out in words.
const PHRASES = new RegExp(
  '(?<![a-z0-9])(?:' +
    [
      'from now on you',
      'you are now',
      'you re now',
      'act as',
      'begin your (?:revised )?(?:response|reply|answer) with this line',
      '(?:begin|start) your revised (?:response|reply|answer)',
      '(?:repeat|reveal|print|show|output|leak|expose|dump|display|echo) (?:your|the) (?:system|hidden|initial|original) (?:prompt|instructions)',
      '(?:approve|allow|grant|permit|enable|trust|auto approve) (?:all|every|any|each) (?:of the )?(?:tool|tools|commands?|permissions?)',
      '(?:https?|ftps?|file|data|javascript) colon',
    ].join('|') +
    ')(?![a-z0-9])',
);
// A header that introduces replacement instructions: "New instructions: ..." (but "write new instructions" is prose).
const NEW_INSTRUCTIONS = /(?<![a-z])(?:new|updated|additional|revised|real)\s+(?:system\s+)?instructions?\s*:/;
// A scheme with a space before the colon, for the schemes that are never prose.
const SPACED_SCHEME = /(?<![a-z])(?:java\s*script|vb\s*script|mailto)\s+:/;
// A slash command typed into the harness: "Type /advisory".
const SLASH_COMMAND = /(?<![a-z0-9])(?:run|type|enter|execute|invoke|send)\s+\/[a-z]/;

function wordsOf(v: string): string[] {
  return v.match(/[a-z0-9]+/g) ?? [];
}

function overridePhrase(words: readonly string[]): boolean {
  for (let i = 0; i < words.length; i++) {
    if (!OVERRIDE_VERBS.has(words[i] as string)) continue;
    for (let j = i + 1; j <= i + 5 && j < words.length; j++) {
      const w = words[j] as string;
      if (OVERRIDE_TARGETS.has(w)) return true;
      if (w === 'everything' && words[j + 1] === 'before') return true;
      if (w === 'above') {
        const direct = j === i + 1 || words[j - 1] === 'the' || words[j - 1] === 'all';
        if (direct && !BENIGN_AFTER_ABOVE.has(words[j + 1] ?? '')) return true;
      }
    }
  }
  return false;
}

// ---- denylist: checks -----------------------------------------------------------------------------

type Mode = 'text' | 'id';

/** URL, domain, address and link forms. Runs in both modes. */
function linkViolation(v: string): string | null {
  const squeezed = v.replace(/\s+/g, '');
  if (v.includes('://') || squeezed.includes(':/') || v.includes('//')) return 'contains a link';
  if (SCHEME_COLON.test(v) || SPACED_SCHEME.test(v) || PERCENT_ENCODED.test(v)) return 'contains a link';
  if (EMAIL.test(v)) return 'contains an email address';
  if (/(?<![a-z0-9])www\.(?=[a-z0-9])/.test(v) || /(?<![a-z0-9])xn--[a-z0-9-]/.test(v)) return 'contains a domain name';
  const closed = v
    .replace(BRACKET_DOT, '.')
    .replace(/\s+\.\s*(?=[a-z0-9-])/g, '.')
    .replace(SPOKEN_DOT, '.');
  for (const m of closed.matchAll(CANDIDATE_DOMAIN)) {
    const name = m[0];
    const labels = name.split('.');
    const tld = labels[labels.length - 1] as string;
    if (!isTld(tld)) continue;
    const next = closed[(m.index ?? 0) + name.length] ?? '';
    if (DOMAIN_EXEMPT.has(name) && !/[/?#:@\\]/.test(next)) continue;
    if (tld === 'md' && labels.length === 2 && !/[/?#:@\\]/.test(next)) continue;
    return 'contains a domain name';
  }
  if (DOTTED_QUAD.test(closed)) return 'contains an IP address';
  if (IPV6.test(v) || IPV6_BRACKET.test(v)) return 'contains an IP address';
  if (/\P{ASCII}/u.test(closed)) {
    for (const m of closed.matchAll(NON_ASCII_DOTTED)) {
      if (/\P{ASCII}/u.test(m[0])) return 'contains a dotted name with non-ASCII letters';
    }
  }
  return null;
}

/** Injection phrasing: override verbs, role labels, persona switches, the via-model lead-in. Runs in both modes. */
function injectionViolation(v: string, words: readonly string[]): string | null {
  if (overridePhrase(words)) return 'contains an instruction-override phrase';
  if (ROLE_LABEL.test(v) || NEW_INSTRUCTIONS.test(v)) return 'contains a role label';
  if (PHRASES.test(words.join(' '))) return 'contains an instruction-override phrase';
  return null;
}

/** Product and tool tokens on the letters-only view (e). Runs in both modes. */
function tokenViolation(d: string): string | null {
  const leet = leetify(d);
  // Segments split at sentence punctuation followed by space, so "write prose. Gate the ..." is not "prosegate".
  for (const seg of leet.split(/[.!?;:]\s+|\n/)) {
    const blob = seg.replace(/[^a-z]/g, '');
    for (const t of PRODUCT_TOKENS) if (blob.includes(t)) return 'contains command or tool vocabulary';
  }
  if (MCP.test(leet)) return 'contains command or tool vocabulary';
  return null;
}

function strongVerbBefore(words: readonly string[], i: number): boolean {
  for (let k = Math.max(0, i - 3); k < i; k++) if (STRONG_VERBS.has(words[k] as string)) return true;
  return false;
}

/** Shell words in command context, flags, system paths, tool phrases. Text mode only. */
function commandViolation(v: string, nonEnglish: boolean): string | null {
  if (FLAG.test(v)) return 'contains a command flag';
  if (COMMAND_SUBSTITUTION.test(v) || /&&|\|\|/.test(v)) return 'contains command or tool vocabulary';
  if (SYSTEM_PATH.test(v)) return 'contains a system path';
  if (TOOL_PHRASE.test(v)) return 'contains command or tool vocabulary';
  if (INVOKE_CMDLET.test(v) || SLASH_COMMAND.test(v)) return 'contains command or tool vocabulary';
  // Command context for shell words: a pipe-like token, a path or `&&` anywhere, or (when the text is not
  // English, so the verb list cannot apply) any shell word at all.
  const pipe = PIPE_LIKE.test(v);
  const path = PATH_LIKE.test(v);
  // The words as written, and with digits read as letters ("cur1", "b4sh"; four letters or more, so "5h" is
  // not "sh").
  const plain = wordsOf(v);
  for (const words of new Set([plain, wordsOf(leetify(v))])) {
    const leeted = words !== plain;
    // Single words, plus adjacent pairs that spell a command when joined ("w get", "ba sh", "power shell").
    const tokens: Array<[string, number]> = words.map((w, i) => [w, i]);
    for (let i = 0; i + 1 < words.length; i++) {
      const joined = (words[i] as string) + (words[i + 1] as string);
      if (joined.length >= 4) tokens.push([joined, i]);
    }
    for (const [tok, i] of tokens) {
      if (leeted && tok.length < 4) continue;
      if (HARD_SHELL_WORDS.has(tok)) return 'contains command or tool vocabulary';
      if (SHELL_WORDS.has(tok)) {
        const prev = words[i - 1] ?? '';
        const useAdjacent = USE_VERBS.has(prev) || (DETERMINERS.has(prev) && USE_VERBS.has(words[i - 2] ?? ''));
        if (strongVerbBefore(words, i) || useAdjacent || pipe || path || nonEnglish) return 'contains command or tool vocabulary';
      } else if (DEV_TOOLS.has(tok)) {
        if (strongVerbBefore(words, i) || pipe) return 'contains command or tool vocabulary';
      } else if (COMMON_COMMANDS.has(tok) && DIRECT_VERBS.has(words[i - 1] ?? '')) {
        return 'contains command or tool vocabulary';
      }
    }
  }
  return null;
}

function denylist(s: string, mode: Mode): string | null {
  const { forms, d } = buildViews(s);
  const nonEnglish = /(?!\p{ASCII})\p{L}/u.test(s);
  for (const v of forms) {
    const link = linkViolation(v);
    if (link !== null) return link;
  }
  const tok = tokenViolation(d);
  if (tok !== null) return tok;
  for (const v of forms) {
    const inj = injectionViolation(v, wordsOf(v));
    if (inj !== null) return inj;
    if (mode === 'text') {
      const cmd = commandViolation(v, nonEnglish);
      if (cmd !== null) return cmd;
    }
  }
  return null;
}

// ---- public API ---------------------------------------------------------------------------------

/**
 * Returns why `text` may not be shown to a model, or null when it may. `maxGraphemes` is the length cap
 * (200 for instruction text and descriptions, 100 for names, 160 for reviewer register instructions);
 * it is counted in code points, which bounds the work on hostile input. The text must be non-empty after
 * trimming. Runs the allowlist, then the denylist.
 */
export function injectedTextViolation(s: string, maxGraphemes: number = DEFAULT_MAX): string | null {
  if (typeof s !== 'string') return 'is not text';
  if (s.trim() === '') return 'is empty';
  // Count code points without building an array for hostile input: stop once past the cap.
  let points = 0;
  for (let i = 0; i < s.length; i++) {
    points += 1;
    if (points > maxGraphemes) return `is longer than ${maxGraphemes} characters`;
    const code = s.codePointAt(i);
    if (code !== undefined && code > 0xffff) i += 1;
  }
  if (/^\p{M}/u.test(s)) return 'starts with a combining mark';
  for (const form of new Set([s, s.normalize('NFKC')])) {
    const reason = checkAllowlist(form);
    if (reason !== null) return reason;
  }
  return denylist(s, 'text');
}

/**
 * The denylist without the allowlist, for text that legitimately carries a user's own words, such as
 * the filled middle of the `vague_claim` fork (the file, the number, the name). Still rejects links,
 * domains, addresses, command context, flags, system paths, tool vocabulary and injection phrasing, and
 * (because the allowlist that normally catches them is skipped) invisible, control, private-use and
 * unassigned code points and stacks of combining marks, which could carry a hidden payload.
 */
export function injectedTextDenylistViolation(s: string): string | null {
  if (typeof s !== 'string') return 'is not text';
  if (s.length > DENYLIST_ONLY_MAX) return `is longer than ${DENYLIST_ONLY_MAX} characters`;
  if (HIDDEN_CHARACTER.test(s)) return 'contains an invisible character';
  if (/\p{M}{3}/u.test(s)) return 'stacks more than two combining marks';
  return denylist(s, 'text');
}

/**
 * Ids (profile ids, pack ids, rule ids) reach the model in banners and findings. They are `[a-z0-9-]`
 * strings, so only three families apply: product and tool tokens (with `-` read as a space, so
 * `run-prosegate-advisory-now` is caught), injection phrasing, and URL or domain forms. Shell words are
 * not checked: `acme/ssh-guide` stays legal.
 */
export function idDenylistViolation(id: string): string | null {
  if (typeof id !== 'string') return 'is not text';
  if (id.length > 200) return 'is longer than 200 characters';
  // `prosegate/` is a reserved namespace (06, ADR-19): the product's own, refused for synced content by the
  // namespace rule, so the product token is not a violation in that one position.
  const body = id.startsWith('prosegate/') ? id.slice('prosegate/'.length) : id;
  return denylist(body.replace(/-/g, ' '), 'id');
}
