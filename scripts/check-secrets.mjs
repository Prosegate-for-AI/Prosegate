// check:secrets - fails if anything that is, or would be, committed contains a key-like string
// (plan section 7; doc 07 threat 8). It scans two views of the repo:
//   * the index: every staged blob, so "git add f; scrub f" or "git add f; rm f" cannot hide a key;
//   * the working tree: tracked-and-modified plus untracked files that are not ignored.
// Output is file:line plus a redacted label; a matched value is never printed.
// pnpm-lock.yaml is excluded as a whole file (integrity hashes only).
//
// Usage: node scripts/check-secrets.mjs [repo-root]     exit 0 clean, 1 findings, 2 cannot scan

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isMain } from "./lib/is-main.mjs";

// A key must not be glued to a preceding word character, which keeps "task-...", "disk-..." out.
// Escaped separators are the exception: JSON "\n"/"\t", "\u000a", "\x0a" and URL "%0A"/"%20" leave a
// letter or digit right before the key, and a key after them is still a key.
const START = String.raw`(?:(?<![A-Za-z0-9])|(?<=\\[nrtbfv])|(?<=\\u[0-9A-Fa-f]{4})|(?<=\\x[0-9A-Fa-f]{2})|(?<=%[0-9A-Fa-f]{2}))`;
const TAIL = "[A-Za-z0-9_-]{20,}";
const key = (prefix) => new RegExp(`${START}${prefix}${TAIL}`, "g");

// Order matters: the first pattern to match at a position names the match.
export const PATTERNS = [
  { label: "sk-ant-…", re: key("sk-ant-") },
  { label: "sk-proj-…", re: key("sk-proj-") },
  { label: "sk-svcacct-…", re: key("sk-svcacct-") },
  { label: "sk-admin-…", re: key("sk-admin-") },
  { label: "sk-…", re: key("sk-") },
  { label: "pgd_…", re: key("pgd_") },
  { label: "PEM private key…", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g },
];

export const EXCLUDED_FILES = new Set(["pnpm-lock.yaml"]);

const BINARY_EXT = new Set(
  ".png .jpg .jpeg .gif .ico .webp .bmp .pdf .zip .gz .tgz .bz2 .xz .7z .woff .woff2 .ttf .otf .eot .wasm .exe .dll .so .dylib .node .mp3 .mp4 .mov .webm".split(
    " ",
  ),
);
const MAGIC = [
  [0x89, 0x50, 0x4e, 0x47], // PNG
  [0xff, 0xd8, 0xff], // JPEG
  [0x47, 0x49, 0x46, 0x38], // GIF
  [0x25, 0x50, 0x44, 0x46], // PDF
  [0x50, 0x4b, 0x03, 0x04], // ZIP
  [0x1f, 0x8b], // gzip
  [0x00, 0x61, 0x73, 0x6d], // wasm
  [0x7f, 0x45, 0x4c, 0x46], // ELF
  [0x4d, 0x5a], // MZ (exe, dll)
];
const startsWith = (buf, bytes) => bytes.every((b, i) => buf[i] === b);

/** Decodes file bytes for scanning, or returns null for known binary formats. */
export function decode(buf, path = "") {
  if (BINARY_EXT.has(extname(path).toLowerCase())) return null;
  if (MAGIC.some((m) => startsWith(buf, m))) return null;
  if (buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString("utf16le");
  if (buf[0] === 0xfe && buf[1] === 0xff) return Buffer.from(buf.subarray(2)).swap16().toString("utf16le");
  // No BOM: UTF-16 of mostly-ASCII text has a NUL in every other byte.
  const n = Math.min(buf.length, 4096) & ~1;
  if (n >= 4) {
    let even = 0;
    let odd = 0;
    for (let i = 0; i < n; i += 2) {
      if (buf[i] === 0) even++;
      if (buf[i + 1] === 0) odd++;
    }
    const pairs = n / 2;
    if (odd / pairs > 0.3 && even / pairs < 0.05) return buf.toString("utf16le");
    if (even / pairs > 0.3 && odd / pairs < 0.05) return Buffer.from(buf).swap16().toString("utf16le");
  }
  // Everything else (UTF-8, legacy encodings, stray NULs): keys are ASCII, so latin1 loses nothing.
  return buf.toString("latin1");
}

/** Returns [{ line, redacted }] for one file's text (1-based lines). Never returns the value. */
export function scanText(text) {
  const hits = [];
  text.split(/\r\n|\n|\r/).forEach((lineText, i) => {
    const seen = new Set();
    for (const { label, re } of PATTERNS) {
      re.lastIndex = 0;
      for (const m of lineText.matchAll(re)) {
        if (seen.has(m.index)) continue;
        seen.add(m.index);
        hits.push({ line: i + 1, redacted: `${label}(redacted)` });
      }
    }
  });
  return hits;
}

const git = (root, args, input) =>
  execFileSync("git", args, { cwd: root, input, maxBuffer: 1024 * 1024 * 1024 });

/** Index entries as [{ path, sha }] (skips submodules). */
function indexEntries(root) {
  const out = git(root, ["ls-files", "-s", "-z"]).toString("latin1");
  const entries = [];
  for (const rec of out.split("\0")) {
    if (!rec) continue;
    const m = /^(\d+) ([0-9a-f]+) (\d)\t([\s\S]*)$/.exec(rec);
    if (m && m[1] !== "160000") entries.push({ path: Buffer.from(m[4], "latin1").toString("utf8"), sha: m[2] });
  }
  return entries;
}

/** Reads blobs with one `git cat-file --batch` call. Returns Map<sha, Buffer>. */
function readBlobs(root, shas) {
  const unique = [...new Set(shas)];
  const blobs = new Map();
  if (unique.length === 0) return blobs;
  const out = git(root, ["cat-file", "--batch"], `${unique.join("\n")}\n`);
  let pos = 0;
  while (pos < out.length) {
    const eol = out.indexOf(0x0a, pos);
    const [sha, type, size] = out.toString("latin1", pos, eol).split(" ");
    if (type === "missing" || size === undefined) {
      pos = eol + 1;
      continue;
    }
    const len = Number(size);
    blobs.set(sha, out.subarray(eol + 1, eol + 1 + len));
    pos = eol + 1 + len + 1;
  }
  return blobs;
}

export function collectFindings(root) {
  const findings = [];
  let scanned = 0;
  const add = (path, view, buf) => {
    const text = decode(buf, path);
    if (text === null) return;
    scanned++;
    for (const h of scanText(text)) findings.push(`${path}:${h.line}  ${h.redacted}  (${view})`);
  };

  const entries = indexEntries(root).filter((e) => !EXCLUDED_FILES.has(e.path));
  const blobs = readBlobs(root, entries.map((e) => e.sha));
  const shaByPath = new Map(entries.map((e) => [e.path, e.sha]));
  for (const e of entries) {
    const buf = blobs.get(e.sha);
    if (buf) add(e.path, "staged", buf);
  }

  const working = git(root, ["ls-files", "-co", "--exclude-standard", "-z"])
    .toString("utf8")
    .split("\0")
    .filter((f) => f && !EXCLUDED_FILES.has(f));
  for (const file of working) {
    let buf;
    try {
      buf = readFileSync(join(root, file));
    } catch {
      continue; // in the index but deleted (or unreadable) in the working tree
    }
    // Skip when the working copy is byte-identical to the staged blob already scanned above.
    const stagedBuf = blobs.get(shaByPath.get(file) ?? "");
    if (stagedBuf && stagedBuf.equals(buf)) continue;
    add(file, "working tree", buf);
  }
  return { findings, scanned };
}

function main() {
  const root = resolve(process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), ".."));
  let result;
  try {
    result = collectFindings(root);
  } catch (e) {
    console.error(`check:secrets: cannot scan ${root}: ${e.message}`);
    process.exitCode = 2;
    return;
  }
  if (result.findings.length > 0) {
    console.error("check:secrets: FAILED - key-like strings found (values not shown):");
    for (const f of result.findings) console.error(`  ${f}`);
    process.exitCode = 1;
    return;
  }
  console.log(`check:secrets: ok (${result.scanned} file views scanned)`);
}

if (isMain(import.meta.url)) main();
