import { LineCounter, isAlias, isCollection, isScalar, parseDocument, visit } from "yaml";
import { z } from "zod";
import { clip, type Issue } from "./errors.js";

/** 06: `PUT /profiles` accepts `yaml` up to 64 KB; `PUT /rule-packs` up to 256 KB. UTF-8 bytes. */
export const MAX_PROFILE_BYTES = 64 * 1024;
export const MAX_PACK_BYTES = 256 * 1024;

/** UTF-8 length of a string without allocating; stops counting once past `limit`. */
function utf8LengthUpTo(text: string, limit: number): number {
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
 * Parses one YAML document into plain JS, or returns `{path, message}` issues.
 *
 * Safety rules, applied before any schema runs:
 *  - size limit first (06), so an oversized body is never parsed;
 *  - exactly one document, no duplicate keys;
 *  - anchors, aliases and explicit tags (custom or not) are rejected. Profiles and packs are plain
 *    data; none of those features is needed to write one, and rejecting them removes alias
 *    expansion and tag-driven type tricks as an attack surface for content that arrives from sync.
 *    The `yaml` core schema does no code execution either way; this is a cheap defence in depth.
 *
 * Messages are built from the parser's error code and position, never from the source text, so a
 * rejected document is not echoed back.
 */
export function parseYamlStrict(text: string, maxBytes: number): YamlResult {
  const size = utf8LengthUpTo(text, maxBytes);
  if (size > maxBytes) {
    return { ok: false, issues: [{ path: "", message: `document is larger than the ${maxBytes}-byte limit` }] };
  }

  const lineCounter = new LineCounter();
  const doc = parseDocument(text, { lineCounter, uniqueKeys: true, version: "1.2", merge: false });

  if (doc.errors.length > 0) {
    return {
      ok: false,
      issues: doc.errors.slice(0, 10).map((e) => {
        const first = (e.message.split("\n")[0] ?? "invalid YAML").replace(/:$/, "");
        return { path: "", message: clip(`YAML error (${e.code}): ${first}`) };
      }),
    };
  }

  const banned: Issue[] = [];
  const at = (range: readonly number[] | null | undefined): string => {
    const start = range?.[0];
    return start === undefined ? "" : ` (line ${lineCounter.linePos(start).line})`;
  };
  visit(doc, (_key, node) => {
    if (isAlias(node)) {
      banned.push({ path: "", message: `YAML aliases are not allowed${at(node.range)}` });
    } else if (isScalar(node) || isCollection(node)) {
      if (node.anchor !== undefined) banned.push({ path: "", message: `YAML anchors are not allowed${at(node.range)}` });
      if (node.tag !== undefined) banned.push({ path: "", message: `YAML tags are not allowed${at(node.range)}` });
    }
  });
  if (banned.length > 0) return { ok: false, issues: banned.slice(0, 10) };

  const value: unknown = doc.toJS({ maxAliasCount: 0 });
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, issues: [{ path: "", message: "the document must be a mapping at the top level" }] };
  }
  return { ok: true, value };
}

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** `rules[0].match.phrases[2]`, with quoted keys for anything that is not a plain identifier. */
export function formatPath(path: readonly PropertyKey[]): string {
  let out = "";
  for (const seg of path) {
    if (typeof seg === "number") out += `[${seg}]`;
    else {
      const s = String(seg);
      out += IDENT.test(s) ? (out === "" ? s : `.${s}`) : `[${JSON.stringify(clip(s, 60))}]`;
    }
  }
  return out;
}

/** zod issues to `{path, message}`; an unknown field becomes one issue per field. */
export function zodToIssues(error: z.ZodError): Issue[] {
  const out: Issue[] = [];
  for (const issue of error.issues) {
    if (issue.code === "unrecognized_keys") {
      for (const key of issue.keys) {
        out.push({ path: formatPath([...issue.path, key]), message: "unknown field" });
      }
    } else {
      out.push({ path: formatPath(issue.path), message: clip(issue.message) });
    }
    if (out.length >= 50) break;
  }
  return out;
}
