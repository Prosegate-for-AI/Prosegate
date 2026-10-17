// Static module specifiers in JS/TS source or in a bundle: `import x from "m"`, `export * from "m"`,
// side-effect `import "m"`, dynamic `import("m")`, `require("m")` and esbuild's `__require("m")`.
// Regex based on purpose (no parser dependency); string/comment look-alikes can false-positive,
// which is the safe direction for a guard.
const RE = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*|\b__require\s*\(\s*)(["'`])([^"'`\n]+)\1/g;

/** @returns {{ spec: string, index: number }[]} */
export function extractSpecifiers(text) {
  const out = [];
  for (const m of text.matchAll(RE)) {
    if (m[2] !== undefined) out.push({ spec: m[2], index: m.index });
  }
  return out;
}

export function lineOf(text, index) {
  let line = 1;
  for (let i = 0; i < index; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}
