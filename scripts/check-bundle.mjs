// check:bundle - verifies the adapter bundle is self-contained (plan section 3; doc 05 packaging).
//   (1) every import / require specifier is a node builtin or the one allowed native module;
//   (2) the file stays under a size budget;
//   (3) dist/ holds no other JS next to it (no code splitting, no stray chunks);
//   (4) the bundle EXECUTES: a real session-start, a turn-end that revises and a turn-end that passes, in
//       a temp HOME, through the same stdin/stdout contract a harness shim uses. Scanning specifiers
//       cannot see a runtime failure such as the "Dynamic require of process" that an inlined
//       dependency throws when the bundle lacks a createRequire banner (DEBT D-17).
// Usage: node scripts/check-bundle.mjs [bundle-path] [--max-bytes N] [--no-exec]

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
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

/** Prose with a hedge and a filler opener (block findings) and over the 60-word floor. */
const TIC_TEXT =
  "It's worth noting that the cache sits in front of the catalog reads and keeps one entry per tenant. " +
  "Great question! A read checks the entry first and falls back to the database on a miss. " +
  "The entry expires after sixty seconds, so a price change reaches every tenant within a minute. " +
  "On the staging dataset the median read dropped from 410 ms to 95 ms. " +
  "Writes bypass the cache and delete the tenant's entry, which keeps the two copies from drifting apart. " +
  "The change touches the catalog service and its tests, and it adds one configuration key for the expiry time.";
const CLEAN_TEXT =
  "The cache sits in front of the catalog reads and keeps one entry per tenant. " +
  "A read checks the entry first and falls back to the database on a miss. " +
  "The entry expires after sixty seconds, so a price change reaches every tenant within a minute. " +
  "On the staging dataset the median read dropped from 410 ms to 95 ms. " +
  "Writes bypass the cache and delete the tenant's entry, which keeps the two copies from drifting apart. " +
  "The change touches the catalog service and its tests, and it adds one configuration key for the expiry time.";

function clip(text, n = 600) {
  const t = String(text ?? "").trim();
  return t.length > n ? `${t.slice(0, n)}...` : t;
}

/**
 * Runs the bundle for real: session-start, then a turn-end that must continue the model, then a
 * turn-end that must pass silently, all in a temp HOME. Returns the list of problems (empty = ok).
 */
export function executeRoundTrip(file, { timeoutMs = 60_000 } = {}) {
  const home = mkdtempSync(join(tmpdir(), "pg-check-bundle-"));
  // No CI, no agent marker, no Prosegate switch: the round trip must not change with where it runs.
  const scrub = /^(CI|CLAUDECODE|CLAUDE_CODE_.*|PROSEGATE_.*)$/i;
  const env = {
    ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !scrub.test(k))),
    PROSEGATE_HOME: join(home, ".prosegate"),
    HOME: home,
    USERPROFILE: home,
  };
  const problems = [];
  const call = (name, input) => {
    const r = spawnSync(process.execPath, [file, name], { input: JSON.stringify(input), encoding: "utf8", env, timeout: timeoutMs });
    if (r.error || r.status !== 0) {
      problems.push(`${name} did not run: exit ${r.status ?? "none"}${r.error ? ` (${r.error.message})` : ""}; stderr: ${clip(r.stderr)}`);
      return null;
    }
    try {
      return JSON.parse(r.stdout);
    } catch {
      problems.push(`${name} printed something that is not JSON: ${clip(r.stdout, 200)}`);
      return null;
    }
  };
  try {
    const session_id = "check-bundle";
    const started = call("session-start", { harness: "claude-code", session_id, cwd: home, mode: "interactive" });
    if (started !== null) {
      if (started.active_profile !== "local/base" || started.offline !== true || typeof started.inject !== "string" || !started.inject.startsWith("If a later message starts with [Prosegate]") || !started.inject.includes("Active profile: Base.") || started.notice !== null) {
        problems.push(`session-start returned an unexpected payload: ${clip(JSON.stringify(started), 300)}`);
      }
    }
    const turn = { session_id, turn_id: "t1", assistant_text: TIC_TEXT, user_message: "", tool_calls: [], continuation: false };
    const revised = call("turn-end", turn);
    if (revised !== null && (revised.decision !== "continue" || !String(revised.feedback_text).startsWith("[Prosegate]") || revised.result?.verdict !== "revise")) {
      problems.push(`turn-end did not revise a text full of tics: ${clip(JSON.stringify(revised), 300)}`);
    }
    const passed = call("turn-end", { ...turn, turn_id: "t2", assistant_text: CLEAN_TEXT });
    if (passed !== null && (passed.decision !== "allow" || passed.feedback_text !== "" || passed.notice !== null || passed.result?.verdict !== "pass")) {
      problems.push(`turn-end did not pass a clean text silently: ${clip(JSON.stringify(passed), 300)}`);
    }
    // ADR-45: bundled JSON no longer initializes YAML. Exercise a custom profile
    // too, and require its distinct name so a fail-open fallback cannot pass.
    const profiles = join(env.PROSEGATE_HOME, "profiles");
    mkdirSync(profiles, { recursive: true });
    writeFileSync(join(profiles, "base.yaml"), "schema: prosegate.profile/1\nid: local/base\nversion: 1\nname: Bundle Check\n");
    const custom = call("session-start", { harness: "claude-code", session_id: "check-custom-profile", cwd: home, mode: "interactive" });
    if (custom === null || typeof custom.inject !== "string" || !custom.inject.includes("Active profile: Bundle Check.")) {
      problems.push("custom profile did not resolve through the bundled YAML parser");
    }
  } finally {
    rmSync(home, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
  return problems;
}

function main() {
  const args = process.argv.slice(2);
  let exec = true;
  let max = MAX_BYTES;
  let file = resolve(dirname(fileURLToPath(import.meta.url)), "../packages/adapter/dist/prosegate.mjs");
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--max-bytes") max = Number(args[++i]);
    else if (args[i] === "--no-exec") exec = false;
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

  if (exec && problems.length === 0) problems.push(...executeRoundTrip(file).map((p) => `execution: ${p}`));

  if (problems.length > 0) {
    console.error("check:bundle: FAILED");
    for (const p of problems) console.error(`  ${p}`);
    process.exitCode = 1;
    return;
  }
  console.log(`check:bundle: ok (${basename(file)} ${size} bytes, budget ${max}${exec ? "; session-start and turn-end executed" : ""})`);
}

if (isMain(import.meta.url)) main();
