// Orchestration for `pnpm eval:rules`: load packs and corpora, measure, apply the baseline, write the
// report. In-process so tests can inject the clock; eval-rules.ts is the thin CLI around it.
//
// Exit codes: 0 every gate that could be evaluated passed; 1 a gate failed; 2 harness error (bad meta,
// unreadable corpus, pack that does not compile, missing baseline).
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseRulePackYaml, BUNDLED_PACK_YAML } from "@prosegate/profiles";
import { STOP_WORDS_VERSION } from "@prosegate/engine";
import { BUNDLED_PROFILE_NAMES, loadPack, measure, type EvalMeasurements, type FpSource, type GateFailure, type LoadedPack, type PackReport, type ReviewFn, type RuleReport } from "./rules-eval.js";
import { HarnessError, loadCorpora } from "./rules-corpus.js";
import { compareToBaseline, type Baseline, type BaselineRule } from "./rules-gates.js";
import { formatReport } from "./rules-report.js";
import { annotationSummary } from "../src/annotations.js";

export interface RunOptions {
  repoRoot: string;
  corporaDir: string;
  ruleExamplesDir: string;
  /** Extra packs: YAML file paths (--pack). */
  packPaths: string[];
  /** Evaluate the packs found in `bundledPacksDir` (default true). */
  useBundled: boolean;
  /** Where bundled packs are discovered; it must hold exactly the packs the bundled registry holds. */
  bundledPacksDir: string;
  /** null: no baseline comparison at all (never the default). */
  baselinePath: string | null;
  reportsDir: string;
  updateBaseline: boolean;
  /** Write `<date>-<sha>.local.json` (gitignored) instead of `<date>-<sha>.json`. */
  local: boolean;
  /** Engine clock (tests inject a fake one); default performance.now. */
  clock?: (() => number) | undefined;
  /** Test hook: replaces the engine entry point. */
  review?: ReviewFn | undefined;
  /** Repository identity override (tests); default read from the repo. */
  git?: { sha: string; dirty: boolean } | undefined;
  today?: (() => Date) | undefined;
}

export type Verdict = "PASS" | "PARTIAL" | "FAIL";

export interface Report {
  schema: "prosegate.eval-rules-report/1";
  generated_at: string;
  wall_ms: number;
  /** pass: every rule PASS. partial: nothing failed, but some rule has an unmeasured gate. fail: a gate failed. */
  result: "pass" | "partial" | "fail";
  exit_code: 0 | 1;
  /** Where false positives were counted: the engine's raw candidates, or the post-overlap findings. */
  fp_source: FpSource;
  git: { sha: string; dirty: boolean | null };
  engine: { package: string; version: string; stop_words_version: string | number; node: string };
  corpora_root: string;
  corpora: EvalMeasurements["corpora"];
  packs: Array<PackReport & { rule_verdicts: Record<string, Verdict> }>;
  /** How many rules ended in each state per metric, so "n/a" and "insufficient" are visible without reading rules. */
  metric_coverage: Record<"example" | "false_positive" | "precision" | "recall", Record<string, number>>;
  baseline: { path: string | null; status: "compared" | "none" | "updated" | "update_refused" | "missing_created"; entries: number };
  failures: GateFailure[];
  notes: string[];
  annotations: ReturnType<typeof annotationSummary>;
}

export interface RunOutcome {
  exitCode: 0 | 1 | 2;
  /** Printable text: the table, or the harness error. */
  text: string;
  report: Report | null;
  reportPath: string | null;
}

// ---- baseline ----------------------------------------------------------------------------------------

function readBaseline(path: string): Baseline {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch (e) {
    throw new HarnessError(`baseline ${path} is unreadable: ${e instanceof Error ? e.message : String(e)}`);
  }
  const bad = (why: string): never => {
    throw new HarnessError(`baseline ${path} is invalid: ${why}`);
  };
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return bad("not an object");
  const o = raw as Record<string, unknown>;
  for (const k of Object.keys(o)) if (k !== "schema" && k !== "rules") bad(`unknown field '${k}'`);
  if (o.schema !== "prosegate.eval-baseline/1") bad("schema must be 'prosegate.eval-baseline/1'");
  if (typeof o.rules !== "object" || o.rules === null || Array.isArray(o.rules)) return bad("'rules' must be an object");
  const rules: Record<string, BaselineRule> = {};
  for (const [id, v] of Object.entries(o.rules as Record<string, unknown>)) {
    if (typeof v !== "object" || v === null || Array.isArray(v)) return bad(`rule ${id} is not an object`);
    const e = v as Record<string, unknown>;
    for (const k of Object.keys(e)) if (k !== "precision" && k !== "fp_rate") bad(`rule ${id}: unknown field '${k}'`);
    const num = (x: unknown, name: string): number | null => {
      if (x === null) return null;
      if (typeof x !== "number" || !Number.isFinite(x) || x < 0 || x > 1) return bad(`rule ${id}: '${name}' must be null or a number in [0, 1]`);
      return x;
    };
    if (!("precision" in e) || !("fp_rate" in e)) bad(`rule ${id}: needs precision and fp_rate (null when unmeasured)`);
    rules[id] = { precision: num(e.precision, "precision"), fp_rate: num(e.fp_rate, "fp_rate") };
  }
  return { schema: "prosegate.eval-baseline/1", rules };
}

const round6 = (x: number): number => Math.round(x * 1e6) / 1e6;

/** A value enters the baseline only when it was measured and sufficient (status pass or fail). */
function baselineEntry(r: RuleReport): BaselineRule {
  const measured = (s: string): boolean => s === "pass" || s === "fail";
  return {
    precision: measured(r.precision.status) && r.precision.value !== null ? round6(r.precision.value) : null,
    fp_rate: measured(r.false_positive.status) && r.false_positive.value !== null ? round6(r.false_positive.value) : null,
  };
}

function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(join(path, ".."), { recursive: true });
  // The temp name is unique per process so concurrent runs never interleave writes.
  const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(tmp, path);
}

// ---- helpers -----------------------------------------------------------------------------------------

function gitInfo(repoRoot: string): { sha: string; dirty: boolean | null } {
  try {
    const sha = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    if (!/^[0-9a-f]{4,40}$/.test(sha)) return { sha: "nosha", dirty: null };
    let dirty: boolean | null = null;
    try {
      dirty = execFileSync("git", ["status", "--porcelain"], { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() !== "";
    } catch {
      dirty = null;
    }
    return { sha, dirty };
  } catch {
    return { sha: "nosha", dirty: null };
  }
}

function engineVersion(repoRoot: string): string {
  try {
    const p = JSON.parse(readFileSync(join(repoRoot, "packages", "engine", "package.json"), "utf8")) as { version?: string };
    return p.version ?? "unknown";
  } catch {
    return "unknown";
  }
}

function loadPacks(opts: RunOptions): LoadedPack[] {
  const packs: LoadedPack[] = [];
  const add = (yaml: string, source: string): void => {
    const parsed = parseRulePackYaml(yaml);
    if (!parsed.ok) throw new HarnessError(`pack ${source} does not parse: ${parsed.error.message}`);
    packs.push(loadPack(parsed.value, source));
  };
  if (opts.useBundled) {
    // Discover the packs on disk rather than trusting the generated registry, then require the two to
    // agree: a pack added to packages/profiles/bundled/packs but not registered (or the reverse) would
    // otherwise be shipped, or silently skipped, without ever being evaluated.
    if (!existsSync(opts.bundledPacksDir)) throw new HarnessError(`bundled packs directory not found: ${opts.bundledPacksDir}`);
    const files = readdirSync(opts.bundledPacksDir).filter((f) => /\.ya?ml$/.test(f)).sort();
    const found: string[] = [];
    for (const file of files) {
      const yaml = readFileSync(join(opts.bundledPacksDir, file), "utf8");
      const parsed = parseRulePackYaml(yaml);
      if (!parsed.ok) throw new HarnessError(`bundled pack ${file} does not parse: ${parsed.error.message}`);
      found.push(`${parsed.value.id}@${parsed.value.version}`);
      packs.push(loadPack(parsed.value, `bundled:${file}`));
    }
    const registered = Object.keys(BUNDLED_PACK_YAML).sort();
    const same = found.length === registered.length && [...found].sort().every((k, i) => k === registered[i]);
    if (!same) {
      throw new HarnessError(
        `bundled packs on disk (${found.length}: ${found.join(", ") || "none"}) do not match the bundled registry (${registered.length}: ${registered.join(", ")}); run pnpm --filter @prosegate/profiles gen:bundled, or register or remove the pack`,
      );
    }
  }
  for (const path of opts.packPaths) {
    if (!existsSync(path)) throw new HarnessError(`--pack ${path}: file not found`);
    add(readFileSync(path, "utf8"), path);
  }
  if (packs.length === 0) throw new HarnessError("no rule packs to evaluate (pass --pack <file>, or drop --no-bundled)");
  const seen = new Set<string>();
  for (const p of packs) {
    if (seen.has(p.parsed.id)) throw new HarnessError(`two packs share the id '${p.parsed.id}'; evaluate one at a time`);
    seen.add(p.parsed.id);
  }
  return packs;
}

/** PASS: the rule's example, false-positive and precision gates were all measured and passed. FAIL: any of its gates failed. PARTIAL: nothing failed but some gate could not be measured. */
function verdicts(pack: PackReport, failures: readonly GateFailure[]): Record<string, Verdict> {
  const out: Record<string, Verdict> = {};
  for (const r of pack.rules) {
    const failed = failures.some((f) => f.scope !== "pack" && f.scope !== "category" && f.id === r.id);
    if (failed) {
      out[r.id] = "FAIL";
      continue;
    }
    const cat = pack.categories.find((c) => c.category === r.category);
    const recallOk = cat === undefined || cat.recall.status === "pass" || cat.recall.status === "ungated";
    out[r.id] = r.false_positive.status === "pass" && r.precision.status === "pass" && recallOk ? "PASS" : "PARTIAL";
  }
  return out;
}

export function runEval(opts: RunOptions): RunOutcome {
  const t0 = performance.now();
  try {
    const packs = loadPacks(opts);
    const corpora = loadCorpora(opts.corporaDir, BUNDLED_PROFILE_NAMES);

    let baseline: Baseline | null = null;
    let baselineStatus: Report["baseline"]["status"] = "none";
    if (opts.baselinePath !== null) {
      if (existsSync(opts.baselinePath)) {
        baseline = readBaseline(opts.baselinePath);
        baselineStatus = "compared";
      } else if (opts.updateBaseline) {
        baseline = { schema: "prosegate.eval-baseline/1", rules: {} };
        baselineStatus = "missing_created";
      } else {
        throw new HarnessError(`baseline ${opts.baselinePath} not found; a missing baseline would disable the regression check. Create it with: pnpm eval:rules -- --update-baseline`);
      }
    }

    const m = measure({ packs, corpora, ruleExamplesDir: opts.ruleExamplesDir, clock: opts.clock, review: opts.review });
    const annotations = annotationSummary(opts.corporaDir, corpora.ai);
    const ungated = new Set(annotations.paired > 0 ? Object.entries(annotations.categories).filter(([, a]) => !a.gate_eligible).map(([c]) => c) : []);
    const failures = m.failures.filter((f) => {
      if (f.metric !== "precision" && f.metric !== "recall") return true;
      const category = f.scope === "category" ? f.id.split(":")[1] : m.packs.flatMap((p) => p.rules).find((r) => r.id === f.id)?.category;
      return category === undefined || !ungated.has(category);
    });
    const notes = [...m.notes];
    if (annotations.adjudicated < corpora.ai.length) notes.push("Some AI gold lacks independent annotation/adjudication. Rule measurements are exploratory; eval:corpus must pass before qualification.");
    for (const category of ungated) notes.push(`${category}: annotation agreement is undefined or below 0.6; precision/recall gates and baseline comparisons are withheld until guidelines are repaired.`);
    for (const pack of m.packs) {
      for (const rule of pack.rules) if (ungated.has(rule.category)) rule.precision.status = "insufficient";
      for (const category of pack.categories) if (ungated.has(category.category)) category.recall.status = "insufficient";
    }

    const newRules: string[] = [];
    if (baseline !== null) {
      const measured = (s: string): boolean => s === "pass" || s === "fail";
      for (const pack of m.packs) {
        for (const r of pack.rules) {
          if (ungated.has(r.category)) continue;
          const entry = baseline.rules[r.id];
          const v = compareToBaseline(r.id, entry, r.precision);
          if (!v.ok) failures.push({ scope: "baseline", id: r.id, metric: "baseline", message: v.message });
          else if (entry === undefined) {
            // A rule with a measured metric and no baseline entry would escape the regression check
            // for ever. It must be recorded in the same PR (--update-baseline adds it). A rule with
            // nothing measured yet has nothing to protect.
            if (!opts.updateBaseline && (measured(r.precision.status) || measured(r.false_positive.status))) {
              failures.push({ scope: "baseline", id: r.id, metric: "baseline", message: `${r.id}: new rule with a measured metric and no baseline entry; run --update-baseline in this PR` });
            } else newRules.push(r.id);
          }
        }
        const ids = new Set(pack.rules.map((r) => r.id));
        for (const id of Object.keys(baseline.rules)) {
          if (id.startsWith(`${pack.id}.`) && !ids.has(id)) notes.push(`${id}: in the baseline but no longer in pack ${pack.id}; --update-baseline drops it`);
        }
      }
    }

    if (newRules.length > 0) notes.push(`${newRules.length} rule${newRules.length === 1 ? " is" : "s are"} not in the baseline, so no precision regression check applies (${newRules.slice(0, 3).join(", ")}${newRules.length > 3 ? ", ..." : ""}); --update-baseline adds them`);

    const passed = failures.length === 0;
    const exitCode: 0 | 1 = passed ? 0 : 1;

    let baselineEntries = Object.keys(baseline?.rules ?? {}).length;
    if (opts.updateBaseline && opts.baselinePath !== null) {
      if (passed) {
        const rules: Record<string, BaselineRule> = {};
        const evaluated = new Set(m.packs.map((p) => p.id));
        // Entries of packs not evaluated in this run are kept as they are.
        for (const [id, v] of Object.entries(baseline?.rules ?? {})) if (!evaluated.has(id.slice(0, id.indexOf(".")))) rules[id] = v;
        for (const p of m.packs) for (const r of p.rules) rules[r.id] = ungated.has(r.category) ? (baseline?.rules[r.id] ?? { precision: null, fp_rate: null }) : baselineEntry(r);
        const sorted = Object.fromEntries(Object.entries(rules).sort(([a], [b]) => (a < b ? -1 : 1)));
        writeJsonAtomic(opts.baselinePath, { schema: "prosegate.eval-baseline/1", rules: sorted });
        baselineEntries = Object.keys(sorted).length;
        baselineStatus = "updated";
      } else {
        baselineStatus = "update_refused";
        notes.push("--update-baseline refused: the run has gate failures, and the baseline is only rewritten from a passing run");
      }
    }

    const coverage: Report["metric_coverage"] = { example: {}, false_positive: {}, precision: {}, recall: {} };
    const bump = (bucket: Record<string, number>, key: string): void => {
      bucket[key] = (bucket[key] ?? 0) + 1;
    };
    for (const p of m.packs) {
      for (const r of p.rules) {
        bump(coverage.example, r.example.status);
        bump(coverage.false_positive, r.false_positive.status);
        bump(coverage.precision, r.precision.status);
      }
      for (const c of p.categories) bump(coverage.recall, c.recall.status);
    }

    const verdictsByPack = m.packs.map((p) => verdicts(p, failures));
    const allPass = verdictsByPack.every((v) => Object.values(v).every((x) => x === "PASS"));
    const git = opts.git ?? gitInfo(opts.repoRoot);
    const now = (opts.today ?? (() => new Date()))();
    const report: Report = {
      schema: "prosegate.eval-rules-report/1",
      generated_at: now.toISOString(),
      wall_ms: 0,
      result: !passed ? "fail" : allPass && annotations.adjudicated === corpora.ai.length ? "pass" : "partial",
      exit_code: exitCode,
      fp_source: m.fp_source,
      git,
      engine: { package: "@prosegate/engine", version: engineVersion(opts.repoRoot), stop_words_version: STOP_WORDS_VERSION, node: process.version },
      corpora_root: opts.corporaDir,
      corpora: m.corpora,
      packs: m.packs.map((p, i) => ({ ...p, rule_verdicts: verdictsByPack[i] as Record<string, Verdict> })),
      metric_coverage: coverage,
      baseline: { path: opts.baselinePath, status: baselineStatus, entries: baselineEntries },
      failures,
      notes,
      annotations,
    };
    report.wall_ms = Math.round(performance.now() - t0);

    const date = now.toISOString().slice(0, 10);
    const reportPath = join(opts.reportsDir, `${date}-${git.sha}${opts.local ? ".local" : ""}.json`);
    writeJsonAtomic(reportPath, report);
    return { exitCode, text: formatReport(report, reportPath), report, reportPath };
  } catch (e) {
    if (e instanceof HarnessError) {
      const lines = [`eval:rules: HARNESS ERROR: ${e.message}`, ...e.problems.slice(0, 40).map((p) => `  - ${p}`)];
      if (e.problems.length > 40) lines.push(`  ... and ${e.problems.length - 40} more`);
      return { exitCode: 2, text: lines.join("\n"), report: null, reportPath: null };
    }
    throw e;
  }
}
