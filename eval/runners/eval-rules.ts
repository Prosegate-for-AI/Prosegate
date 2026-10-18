// `pnpm eval:rules`: the rule-pack regression harness (docs/10 "Regression harness").
// Exit 0: every gate that could be evaluated passed. 1: a gate failed. 2: harness error.
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runEval, type RunOptions } from "./rules-run.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

const USAGE = `usage: pnpm eval:rules [options]
  --pack <file>           also evaluate this rule pack YAML (repeatable)
  --no-bundled            skip the bundled packs
  --bundled-packs <dir>   where bundled packs are discovered (default packages/profiles/bundled/packs); must match the registry
  --corpora <dir>         corpora root (default eval/corpora)
  --rule-examples <dir>   where <eval corpus ref: pack/name> files live (default <corpora>/rule-examples)
  --baseline <file>       baseline JSON (default eval/baseline.json)
  --reports <dir>         where the report is written (default eval/reports)
  --update-baseline       rewrite the baseline from this run, only if the run passes
  --local                 write <date>-<sha>.local.json (gitignored)
`;

function parseArgs(argv: string[]): RunOptions | string {
  const o: RunOptions = {
    repoRoot: REPO_ROOT,
    corporaDir: resolve(REPO_ROOT, "eval", "corpora"),
    ruleExamplesDir: "",
    packPaths: [],
    useBundled: true,
    bundledPacksDir: resolve(REPO_ROOT, "packages", "profiles", "bundled", "packs"),
    baselinePath: resolve(REPO_ROOT, "eval", "baseline.json"),
    reportsDir: resolve(REPO_ROOT, "eval", "reports"),
    updateBaseline: false,
    local: false,
  };
  let examples: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    const value = (): string | undefined => argv[++i];
    switch (a) {
      case "--":
        break;
      case "--pack": {
        const v = value();
        if (v === undefined) return "--pack needs a file";
        o.packPaths.push(resolve(v));
        break;
      }
      case "--bundled-packs": {
        const v = value();
        if (v === undefined) return "--bundled-packs needs a directory";
        o.bundledPacksDir = resolve(v);
        break;
      }
      case "--no-bundled":
        o.useBundled = false;
        break;
      case "--corpora": {
        const v = value();
        if (v === undefined) return "--corpora needs a directory";
        o.corporaDir = resolve(v);
        break;
      }
      case "--rule-examples": {
        const v = value();
        if (v === undefined) return "--rule-examples needs a directory";
        examples = resolve(v);
        break;
      }
      case "--baseline": {
        const v = value();
        if (v === undefined) return "--baseline needs a file";
        o.baselinePath = resolve(v);
        break;
      }
      case "--reports": {
        const v = value();
        if (v === undefined) return "--reports needs a directory";
        o.reportsDir = resolve(v);
        break;
      }
      case "--update-baseline":
        o.updateBaseline = true;
        break;
      case "--local":
        o.local = true;
        break;
      case "--help":
      case "-h":
        return "";
      default:
        return `unknown argument ${a}`;
    }
  }
  o.ruleExamplesDir = examples ?? resolve(o.corporaDir, "rule-examples");
  return o;
}

const parsed = parseArgs(process.argv.slice(2));
if (typeof parsed === "string") {
  if (parsed !== "") console.error(`eval:rules: ${parsed}`);
  console.error(USAGE);
  process.exit(parsed === "" ? 0 : 2);
}
try {
  const outcome = runEval(parsed);
  (outcome.exitCode === 2 ? console.error : console.log)(outcome.text);
  process.exit(outcome.exitCode);
} catch (e) {
  console.error(`eval:rules: unexpected error: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
  process.exit(2);
}
