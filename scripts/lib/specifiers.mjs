// Static module specifiers in JS/TS source or in a bundle: `import x from "m"`, `export * from "m"`,
// side-effect `import "m"`, dynamic `import("m")`, `require("m")` and esbuild's `__require("m")`.
//
// Regex based on purpose (no parser dependency), but run on a masked copy of the text: comments are
// blanked, and so are the contents of string, template and regular-expression literals that are not
// themselves an import/require/export-from specifier. Without that, prose inside a bundled
// dependency ("... inherit from `Object` ...") reads as an import of a module called `Object`.
//
// The masking lexer is a heuristic (the regex-versus-division ambiguity is guessed from the previous
// token). To keep a lexer slip from hiding a real import, the specifiers found by the line-anchored
// pattern on the raw text (`import ... from "m"` and `} from "m"` at the start of a line) are
// unioned in; a look-alike there can only false-positive, which is the safe direction for a guard.
const RE = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*|\b__require\s*\(\s*)(["'`])([^"'`\n]+)\1/g;
const LINE_RE = /^[ \t]*(?:\}|(?:import|export)\b[^\n"'`]*?)\s*\bfrom\s*(["'`])([^"'`\n]+)\1/gm;
/** What may directly precede the opening quote of a specifier. */
const PREFIX_RE = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*|\b__require\s*\(\s*)$/;

const REGEX_AFTER_WORDS = new Set(["return", "typeof", "case", "do", "else", "in", "of", "new", "delete", "void", "throw", "yield", "await", "instanceof"]);
const REGEX_AFTER_CHARS = "(,=:[!&|?{};+-*%<>~^";
const IDENT_START = /[A-Za-z_$]/;
const IDENT_PART = /[A-Za-z0-9_$]/;

/**
 * Same length as `text`, with comments and non-specifier literal contents replaced by spaces
 * (newlines kept, so offsets and line numbers still line up).
 */
export function maskNonCode(text) {
  const out = text.split("");
  const n = text.length;
  const blank = (from, to) => {
    for (let k = from; k < to; k++) if (out[k] !== "\n") out[k] = " ";
  };
  const isSpecifierPosition = (quoteIndex) => PREFIX_RE.test(out.slice(Math.max(0, quoteIndex - 40), quoteIndex).join(""));

  let i = 0;
  let prev = "";
  let prevWord = "";
  /** One entry per open `${` of a template literal: the brace depth inside it. */
  const templates = [];

  const scanTemplateBody = (start) => {
    // `start` is just after a backtick or after the `}` that closed an interpolation.
    let k = start;
    while (k < n) {
      const c = text[k];
      if (c === "\\") k += 2;
      else if (c === "`") {
        blank(start, k);
        return k + 1;
      } else if (c === "$" && text[k + 1] === "{") {
        blank(start, k);
        templates.push(0);
        return k + 2;
      } else k += 1;
    }
    blank(start, n);
    return n;
  };

  while (i < n) {
    const c = text[i];
    if (c === "\n" || c === " " || c === "\t" || c === "\r") {
      i += 1;
    } else if (c === "/" && text[i + 1] === "/") {
      const end = text.indexOf("\n", i);
      const stop = end === -1 ? n : end;
      blank(i, stop);
      i = stop;
    } else if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      const stop = end === -1 ? n : end + 2;
      blank(i, stop);
      i = stop;
    } else if (c === '"' || c === "'") {
      let k = i + 1;
      while (k < n && text[k] !== c && text[k] !== "\n") k += text[k] === "\\" ? 2 : 1;
      if (!isSpecifierPosition(i)) blank(i + 1, Math.min(k, n));
      i = Math.min(k + 1, n);
      prev = c;
      prevWord = "";
    } else if (c === "`") {
      const specifier = isSpecifierPosition(i);
      const bodyEnd = (() => {
        let k = i + 1;
        while (k < n && text[k] !== "`" && !(text[k] === "$" && text[k + 1] === "{")) k += text[k] === "\\" ? 2 : 1;
        return k;
      })();
      if (specifier && text[bodyEnd] === "`") {
        i = bodyEnd + 1;
      } else {
        i = scanTemplateBody(i + 1);
      }
      prev = "`";
      prevWord = "";
    } else if (c === "{") {
      if (templates.length > 0) templates[templates.length - 1] += 1;
      prev = c;
      prevWord = "";
      i += 1;
    } else if (c === "}") {
      if (templates.length > 0 && templates[templates.length - 1] === 0) {
        templates.pop();
        i = scanTemplateBody(i + 1);
        prev = "`";
      } else {
        if (templates.length > 0) templates[templates.length - 1] -= 1;
        prev = c;
        i += 1;
      }
      prevWord = "";
    } else if (c === "/") {
      const regexAllowed = prev === "" || REGEX_AFTER_CHARS.includes(prev) || REGEX_AFTER_WORDS.has(prevWord);
      if (regexAllowed) {
        let k = i + 1;
        let inClass = false;
        while (k < n && text[k] !== "\n") {
          const d = text[k];
          if (d === "\\") k += 2;
          else {
            if (d === "[") inClass = true;
            else if (d === "]") inClass = false;
            else if (d === "/" && !inClass) break;
            k += 1;
          }
        }
        blank(i + 1, Math.min(k, n));
        i = Math.min(k + 1, n);
        prev = "/";
        prevWord = "";
      } else {
        prev = c;
        prevWord = "";
        i += 1;
      }
    } else if (IDENT_START.test(c)) {
      let k = i + 1;
      while (k < n && IDENT_PART.test(text[k])) k += 1;
      prevWord = text.slice(i, k);
      prev = "a";
      i = k;
    } else {
      prev = c;
      prevWord = "";
      i += 1;
    }
  }
  return out.join("");
}

/** @returns {{ spec: string, index: number }[]} */
export function extractSpecifiers(text) {
  const masked = maskNonCode(text);
  const seen = new Set();
  const out = [];
  const add = (m) => {
    if (m[2] === undefined) return;
    const index = m.index;
    const key = `${index}:${m[2]}`;
    // the line-anchored match may start earlier than the masked one for the same specifier
    const specIndex = m[0].lastIndexOf(m[2]) + index;
    const k2 = `${specIndex}:${m[2]}`;
    if (seen.has(k2) || seen.has(key)) return;
    seen.add(k2);
    out.push({ spec: m[2], index });
  };
  for (const m of masked.matchAll(RE)) add(m);
  for (const m of text.matchAll(LINE_RE)) add(m);
  return out;
}

export function lineOf(text, index) {
  let line = 1;
  for (let i = 0; i < index; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}
