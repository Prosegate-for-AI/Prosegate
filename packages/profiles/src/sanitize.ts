import { clip, type Issue } from "./errors.js";
import { formatPath } from "./yaml.js";

const MAX_DEPTH = 32;

/**
 * Fields kept byte-for-byte: regex patterns (normalising could change what a pattern matches) and
 * examples (they are test inputs, and the engine checks them against the text as written). Every
 * other string is free text or a term, and is NFC-normalised.
 */
const VERBATIM_KEYS = new Set(["pattern", "sentence_exclude", "examples"]);

/**
 * Pre-pass over every value that enters a schema, whether it came from YAML or JSON:
 *  - free-text strings and terms are NFC-normalised, so NFC and NFD spellings of one field compare,
 *    dedupe and hash alike (patterns and examples are left verbatim, see VERBATIM_KEYS);
 *  - an own key named `__proto__` is reported, not dropped. zod's records skip such a key silently,
 *    which would let a document carry it past validation; JSON.parse creates it as an own key;
 *  - nesting deeper than the schemas can use is rejected before any recursive code sees it.
 * Returns a copy; the input is not mutated.
 */
export function sanitizeInput(value: unknown): { value: unknown; issues: Issue[] } {
  const issues: Issue[] = [];
  const walk = (v: unknown, path: PropertyKey[], depth: number, verbatim: boolean): unknown => {
    if (typeof v === "string") return verbatim ? v : v.normalize("NFC");
    if (v === null || typeof v !== "object") return v;
    if (depth > MAX_DEPTH) {
      if (issues.length < 50) issues.push({ path: formatPath(path), message: "nested too deeply" });
      return null;
    }
    if (Array.isArray(v)) return v.map((item, index) => walk(item, [...path, index], depth + 1, verbatim));
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(v)) {
      if (key === "__proto__") {
        if (issues.length < 50) issues.push({ path: formatPath([...path, clip(key, 60)]), message: "reserved key" });
        continue;
      }
      out[key] = walk((v as Record<string, unknown>)[key], [...path, key], depth + 1, verbatim || VERBATIM_KEYS.has(key));
    }
    return out;
  };
  return { value: walk(value, [], 0, false), issues };
}
