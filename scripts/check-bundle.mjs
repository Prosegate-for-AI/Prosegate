// check:bundle - verifies the adapter bundle is self-contained (plan section 3; doc 05 packaging).
//   (1) every import / require specifier is a node builtin or the one allowed native module;
//   (2) the file stays under a size budget;
//   (3) dist/ holds no other JS next to it (no code splitting, no stray chunks).
// Usage: node scripts/check-bundle.mjs [bundle-path] [--max-bytes N]

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { builtinModules } from "node:module";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isMain } from "./lib/is-main.mjs";
import { extractSpecifiers } from "./lib/specifiers.mjs";

export const MAX_BYTES = 2 * 1024 * 1024; // 2 MB uncompressed, revisited once real code lands
export const ALLOWED_NATIVE = ["@napi-rs/keyring"]; // future optional native dependency (S3)

const BUILTINS = new Set(builtinModules);

export function isAllowedSpecifier(spec) {
  if (spec.startsWith("node:")) return true;
  if (BUILTINS.has(spec)) return true;
  return ALLOWED_NATIVE.some((n) => spec === n || spec.startsWith(`${n}/`));
}

/** Returns the sorted, de-duplicated specifiers in `text` that are not allowed. */
export function disallowedSpecifiers(text) {
  const bad = new Set();
  for (const { spec } of extractSpecifiers(text)) if (!isAllowedSpecifier(spec)) bad.add(spec);
  return [...bad].sort();
}

function main() {
  const args = process.argv.slice(2);
  let max = MAX_BYTES;
  let file = resolve(dirname(fileURLToPath(import.meta.url)), "../packages/adapter/dist/prosegate.mjs");
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--max-bytes") max = Number(args[++i]);
    else if (args[i] !== undefined) file = resolve(args[i]);
  }
  if (!Number.isFinite(max)) {
    console.error("check:bundle: --max-bytes needs a number");
    process.exitCode = 2;
    return;
  }
  if (!existsSync(file)) {
    console.error(`check:bundle: ${file} does not exist (run \`pnpm build\` first)`);
    process.exitCode = 2;
    return;
  }

  const problems = [];
  const bad = disallowedSpecifiers(readFileSync(file, "utf8"));
  if (bad.length > 0) {
    problems.push(`bundle imports modules that are not inlined: ${bad.join(", ")}`);
  }
  const size = statSync(file).size;
  if (size > max) problems.push(`bundle is ${size} bytes, over the budget of ${max} bytes`);
  const strays = readdirSync(dirname(file)).filter(
    (f) => f !== basename(file) && /\.(?:[cm]?js)$/.test(f),
  );
  if (strays.length > 0) problems.push(`extra JS files next to the bundle: ${strays.join(", ")}`);

  if (problems.length > 0) {
    console.error("check:bundle: FAILED");
    for (const p of problems) console.error(`  ${p}`);
    process.exitCode = 1;
    return;
  }
  console.log(`check:bundle: ok (${basename(file)} ${size} bytes, budget ${max})`);
}

if (isMain(import.meta.url)) main();
