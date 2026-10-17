import { LineCounter, isAlias, isCollection, isMap, isScalar, parseDocument, visit } from "yaml";
import { z } from "zod";
import { clip, type Issue } from "./errors.js";

/** 06: `PUT /profiles` accepts `yaml` up to 64 KB; `PUT /rule-packs` up to 256 KB. UTF-8 bytes. */
export const MAX_PROFILE_BYTES = 64 * 1024;
export const MAX_PACK_BYTES = 256 * 1024;
/** ADR-19: node-count caps, checked on a pre-scan before the document is parsed. */
export const MAX_PROFILE_NODES = 5_000;
export const MAX_PACK_NODES = 25_000;

const MAX_ISSUES = 50;
const MAX_FLOW_DEPTH = 64;

/** UTF-8 length of a string without allocating; stops counting once past `limit`. */
export function utf8Length(text: string, limit = Number.POSITIVE_INFINITY): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 0x80) bytes += 1;
    else if (c < 0x800) bytes += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < text.length) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        i++;
      } else bytes += 3;
    } else bytes += 3;
    if (bytes > limit) return bytes;
  }
  return bytes;
}

export type YamlResult = { ok: true; value: unknown } | { ok: false; issues: Issue[] };

/**
 * Upper bound on the number of YAML nodes, from characters alone, so a hostile document is rejected
 * in one linear pass before the parser sees it. Every node is introduced by a line break, a comma, an
 * opening bracket, a colon, or a `- ` / `? ` indicator; overcounting (those characters inside quoted text) only makes the bound
 * safer. Also bounds flow-collection depth, which the parser handles recursively.
 */
function scanNodes(text: string, maxNodes: number): { nodes: number; problem: string | null } {
  let nodes = 1;
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    switch (text.charCodeAt(i)) {
      case 10: // \n
      case 44: // ,
      case 58: // :
        nodes += 1;
        break;
      case 45: // "- " sequence indicator: a single line of "- - - -" opens one node per indicator
      case 63: {
        // "? " complex-key indicator
        const next = text.charCodeAt(i + 1);
        if (next === 32 || next === 10 || next === 13 || i + 1 >= text.length) nodes += 1;
        break;
      }
      case 91: // [
      case 123: // {
        nodes += 1;
        depth += 1;
        if (depth > MAX_FLOW_DEPTH) return { nodes, problem: "flow collections are nested too deeply" };
        break;
      case 93: // ]
      case 125: // }
        if (depth > 0) depth -= 1;
        break;
      default:
    }
    if (nodes > maxNodes) return { nodes, problem: `document has more than ${maxNodes} nodes` };
  }
  return { nodes, problem: null };
}

function prescan(text: string, maxNodes: number): string | null {
  return scanNodes(text, maxNodes).problem;
}

/** The node estimate the pre-scan uses, for sizing documents against the caps (not a parse). */
export function estimateNodes(text: string): number {
  return scanNodes(text, Number.POSITIVE_INFINITY).nodes;
}

/**
 * Parses one YAML document into plain JS, or returns `{path, message}` issues.
 *
 * Rules, applied before any schema runs:
 *  - input must be a string; size limit (06) and a node-count pre-scan (ADR-19) come first, so a
 *    hostile body is never handed to the parser;
 *  - any `%` directive is rejected (a `%YAML 1.1` directive re-enabled merge keys and 1.1 typing);
 *  - exactly one document, with duplicate keys detected here in O(n) with a per-map Set (the
 *    library's own check is quadratic: 20-80 s of CPU on a legal 256 KB pack);
 *  - map keys must be scalars (a collection key is unusable and made the library stringify it);
 *  - anchors, aliases and explicit tags (custom or not) are rejected. Profiles and packs are plain
 *    data; none of those features is needed to write one, and rejecting them removes alias
 *    expansion and tag-driven type tricks as an attack surface for content that arrives from sync;
 *  - non-decimal integers (`0x10`, `0o7`, `1e3`) are rejected, so a number reads one way only;
 *  - parsing stops at the first YAML error, and messages are a fixed string per error code plus the
 *    line number, never library text, which can echo the source.
 */
export function parseYamlStrict(text: unknown, maxBytes: number, maxNodes: number): YamlResult {
  if (typeof text !== "string") return { ok: false, issues: [{ path: "", message: "the document must be text" }] };
  if (utf8Length(text, maxBytes) > maxBytes) {
    return { ok: false, issues: [{ path: "", message: `document is larger than the ${maxBytes}-byte limit` }] };
  }
  if (/(?:^|[\r\n])\u{feff}?%/u.test(text)) {
    return { ok: false, issues: [{ path: "", message: "YAML directives (%) are not allowed" }] };
  }
  const heavy = prescan(text, maxNodes);
  if (heavy !== null) return { ok: false, issues: [{ path: "", message: heavy }] };

  const lineCounter = new LineCounter();
  let doc;
  try {
    doc = parseDocument(text, { lineCounter, uniqueKeys: false, version: "1.2", merge: false, prettyErrors: false });
  } catch {
    return { ok: false, issues: [{ path: "", message: "the document could not be parsed" }] };
  }

  const first = doc.errors[0];
  if (first !== undefined) {
    const line = first.pos[0] === undefined ? undefined : lineCounter.linePos(first.pos[0]).line;
    return { ok: false, issues: [{ path: "", message: `YAML error ${first.code}${line === undefined ? "" : ` at line ${line}`}` }] };
  }

  const banned: Issue[] = [];
  const at = (range: readonly number[] | null | undefined): string => {
    const start = range?.[0];
    return start === undefined ? "" : ` (line ${lineCounter.linePos(start).line})`;
  };
  const add = (message: string, range: readonly number[] | null | undefined): void => {
    if (banned.length < MAX_ISSUES) banned.push({ path: "", message: `${message}${at(range)}` });
  };
  visit(doc, (_key, node) => {
    if (banned.length >= MAX_ISSUES) return visit.BREAK;
    if (isAlias(node)) {
      add("YAML aliases are not allowed", node.range);
    } else if (isScalar(node) || isCollection(node)) {
      if (node.anchor !== undefined) add("YAML anchors are not allowed", node.range);
      if (node.tag !== undefined) add("YAML tags are not allowed", node.range);
      if (isScalar(node) && typeof node.value === "number" && node.format !== undefined) {
        add("only plain decimal numbers are allowed", node.range);
      }
      if (isMap(node)) {
        const keys = new Set<string>();
        for (const pair of node.items) {
          if (!isScalar(pair.key)) {
            add("map keys must be plain scalars", node.range);
            continue;
          }
          // `~`, `null` and an empty key are all the empty key; 1 and "1" are one key too.
          const name = pair.key.value === null ? "" : String(pair.key.value);
          if (keys.has(name)) add("duplicate map key", pair.key.range);
          keys.add(name);
        }
      }
    }
    return undefined;
  });
  if (banned.length > 0) return { ok: false, issues: banned };

  const value: unknown = doc.toJS({ maxAliasCount: 0 });
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, issues: [{ path: "", message: "the document must be a mapping at the top level" }] };
  }
  return { ok: true, value };
}

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** `rules[0].match.phrases[2]`, with quoted keys for anything that is not a plain identifier. Segments are clipped. */
export function formatPath(path: readonly PropertyKey[]): string {
  let out = "";
  for (const seg of path) {
    if (typeof seg === "number") out += `[${seg}]`;
    else {
      const s = String(seg);
      out += IDENT.test(s) ? (out === "" ? clip(s, 60) : `.${clip(s, 60)}`) : `[${JSON.stringify(clip(s, 60))}]`;
    }
  }
  return out;
}

/** zod issues to `{path, message}`; an unknown field becomes one issue per field. At most 50 issues. */
export function zodToIssues(error: z.ZodError): Issue[] {
  const out: Issue[] = [];
  for (const issue of error.issues) {
    if (out.length >= MAX_ISSUES) break;
    if (issue.code === "unrecognized_keys") {
      for (const key of issue.keys) {
        if (out.length >= MAX_ISSUES) break;
        out.push({ path: formatPath([...issue.path, key]), message: "unknown field" });
      }
    } else {
      out.push({ path: formatPath(issue.path), message: clip(issue.message) });
    }
  }
  return out;
}
