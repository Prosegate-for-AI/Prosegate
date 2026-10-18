// Proof that the eval:rules gates bite. Each test runs the real CLI as a subprocess against a fixture
// corpus (eval/runners/test-fixtures/build.ts) and asserts the exit code and the failing rule id, so a
// green suite means a planted breach really turns the run red and the clean fixture really turns it
// green. No assertion here depends on wall-clock speed; the latency gate is tested with an injected clock.
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runEval } from "./rules-run.js";
import type { Report } from "./rules-run.js";
import { validateGold } from "./rules-corpus.js";
import { compareToBaseline, gateFalsePositive, gatePrecision, gateRecall, percentile, spansOverlap, type MetricResult } from "./rules-gates.js";
import { FixtureCorpora, doc, HUMAN_META } from "./test-fixtures/build.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..", "..");
const CLI = join(HERE, "eval-rules.ts");
const EXAMPLES = join(REPO, "eval", "corpora", "rule-examples");
const FIXTURES = join(HERE, "test-fixtures");
const TSX = import.meta.resolve("tsx");

const HEDGE = "It's worth noting that the cache is per tenant.";
const ROBUST = "The retry path is robust.";

interface Run {
  code: number;
  stdout: string;
  stderr: string;
  report: Report | null;
  reports: string;
}

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `prosegate-evalrules-${prefix}-`));
}

/** Runs `pnpm eval:rules` equivalent (tsx on the CLI) as a subprocess; reports go to a private temp directory. */
function harness(args: string[], corpora: FixtureCorpora | string | null, baseline: string | null = join(FIXTURES, "baselines", "empty.json")): Promise<Run> {
  const reports = tmp("reports");
  const all = ["--reports", reports, "--rule-examples", EXAMPLES];
  if (corpora !== null) all.push("--corpora", typeof corpora === "string" ? corpora : corpora.root);
  if (baseline !== null) all.push("--baseline", baseline);
  all.push(...args);
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, ["--import", TSX, CLI, ...all], { cwd: REPO });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("error", fail);
    child.on("close", (code) => {
      const files = existsSync(reports) ? readdirSync(reports).filter((f) => f.endsWith(".json")) : [];
      const report = files.length === 1 ? (JSON.parse(readFileSync(join(reports, files[0] as string), "utf8")) as Report) : null;
      done({ code: code ?? -1, stdout, stderr, report, reports });
    });
  });
}

function rule(run: Run, id: string) {
  const r = run.report?.packs.flatMap((p) => p.rules).find((x) => x.id === id);
  if (r === undefined) throw new Error(`rule ${id} not in report`);
  return r;
}

const failingIds = (run: Run): string[] => [...new Set((run.report?.failures ?? []).map((f) => f.id))].sort();

describe("eval:rules gates (subprocess, fixture corpora)", { timeout: 120_000 }, () => {
  it.concurrent("planted false-positive breach: 2 of 40 human docs trip hedge.001 (block, budget 1%) -> exit 1 naming core.hedge.001", async () => {
    const run = await harness([], new FixtureCorpora().humanSet(40, HEDGE, [3, 17]));
    expect(run.code, run.stdout + run.stderr).toBe(1);
    expect(failingIds(run)).toEqual(["core.hedge.001"]);
    const fp = rule(run, "core.hedge.001").false_positive;
    expect([fp.num, fp.den, fp.status]).toEqual([2, 40, "fail"]);
    expect(run.stdout).toContain("core.hedge.001");
    expect(run.stdout).toContain("RESULT: FAIL");
  });

  it.concurrent("the same fixture without the planted sentences passes with the false-positive gate measured on every rule", async () => {
    const run = await harness([], new FixtureCorpora().humanSet(40));
    expect(run.code, run.stdout + run.stderr).toBe(0);
    expect(run.report?.failures).toEqual([]);
    const rules = run.report?.packs[0]?.rules ?? [];
    expect(rules).toHaveLength(23);
    // Not vacuous: 40 documents reached every rule, zero findings, status pass (not n/a).
    for (const r of rules) expect([r.id, r.false_positive.den, r.false_positive.num, r.false_positive.status]).toEqual([r.id, 40, 0, "pass"]);
  });

  it.concurrent("planted precision loss: 6 of 10 vocab.003 hits have no gold span (40% < 80%) -> exit 1 naming core.vocab.003", async () => {
    const run = await harness([], new FixtureCorpora().aiSet(30, 10, 4, ROBUST, "robust", "core.vocab.003", "vocab"));
    expect(run.code, run.stdout + run.stderr).toBe(1);
    expect(failingIds(run)).toEqual(["core.vocab.003"]);
    const p = rule(run, "core.vocab.003").precision;
    expect([p.confirmed, p.hits, p.status]).toEqual([4, 10, "fail"]);
    expect(run.stdout).toContain("core.vocab.003");
  });

  it.concurrent("the same AI corpus with every hit confirmed passes, precision measured", async () => {
    const run = await harness([], new FixtureCorpora().aiSet(30, 10, 10, ROBUST, "robust", "core.vocab.003", "vocab"));
    expect(run.code, run.stdout + run.stderr).toBe(0);
    const p = rule(run, "core.vocab.003").precision;
    expect([p.confirmed, p.hits, p.status]).toEqual([10, 10, "pass"]);
  });

  it.concurrent("baseline regression: precision 96% -> 90% (6 points) -> exit 1; 94% -> 90% (4 points) -> exit 0", async () => {
    const ai = (): FixtureCorpora => new FixtureCorpora().aiSet(30, 10, 9, ROBUST, "robust", "core.vocab.003", "vocab");
    const [bad, ok] = await Promise.all([harness([], ai(), join(FIXTURES, "baselines", "vocab003-precision-96.json")), harness([], ai(), join(FIXTURES, "baselines", "vocab003-precision-94.json"))]);
    expect(bad.code, bad.stdout + bad.stderr).toBe(1);
    expect(bad.report?.failures.map((f) => [f.scope, f.id])).toEqual([["baseline", "core.vocab.003"]]);
    expect(bad.stdout).toContain("precision fell 6.0 points");
    expect(ok.code, ok.stdout + ok.stderr).toBe(0);
    // Both runs measured the same 90% precision; only the baseline differs.
    expect(rule(ok, "core.vocab.003").precision.value).toBeCloseTo(0.9, 10);
  });

  it.concurrent("a failing example: a pack whose miss example fires -> exit 1 naming the rule; the clean pack passes", async () => {
    const empty = tmp("empty");
    const bad = await harness(["--no-bundled", "--pack", join(FIXTURES, "packs", "failing-example.yaml")], empty);
    expect(bad.code, bad.stdout + bad.stderr).toBe(1);
    expect(failingIds(bad)).toEqual(["fx.filler.001"]);
    expect(bad.report?.failures[0]?.metric).toBe("example");
    expect(bad.stdout).toContain("miss example fires");
    const good = await harness(["--no-bundled", "--pack", join(FIXTURES, "packs", "clean.yaml")], empty);
    expect(good.code, good.stdout + good.stderr).toBe(0);
    expect(good.report?.packs[0]?.examples).toMatchObject({ rules_pass: 1, rules_total: 1, status: "pass" });
  });

  it.concurrent("a hit example that cannot fire fails the example gate as well", async () => {
    // Same gate, different path: a literal hit example that cannot fire.
    const dir = tmp("pack");
    const yaml = readFileSync(join(FIXTURES, "packs", "clean.yaml"), "utf8").replace("This sentence carries needless filler.", "This sentence carries nothing.");
    const file = join(dir, "hit-misses.yaml");
    writeFileSync(file, yaml);
    const run = await harness(["--no-bundled", "--pack", file], tmp("empty"));
    expect(run.code, run.stdout + run.stderr).toBe(1);
    expect(run.stdout).toContain("hit example does not fire");
  });

  describe("a bad corpus is a harness error (exit 2), never a pass", () => {
    const base = (): FixtureCorpora => new FixtureCorpora().humanSet(2);
    const cases: Array<[string, (c: FixtureCorpora) => FixtureCorpora, string]> = [
      ["missing licence", (c) => c.human("base", "x", doc(50).text, { source: "s", date: "2019-01-01" }), "LICENSING GATE: 'licence'"],
      ["empty licence", (c) => c.human("base", "x", doc(50).text, { ...HUMAN_META, licence: "  " }), "LICENSING GATE: 'licence'"],
      ["missing date", (c) => c.human("base", "x", doc(50).text, { source: "s", licence: "CC0-1.0" }), "LICENSING GATE: 'date'"],
      ["impossible date", (c) => c.human("base", "x", doc(50).text, { ...HUMAN_META, date: "2019-02-30" }), "'date' must be"],
      ["unknown meta field", (c) => c.human("base", "x", doc(50).text, { ...HUMAN_META, extra: 1 }), "unknown field 'extra'"],
      ["unknown profile directory", (c) => c.human("nonesuch", "x", doc(50).text), "no bundled profile 'local/nonesuch'"],
      ["AI meta missing a field", (c) => c.ai("base", "x", doc(50).text, [], { model: "m" }), "missing required field 'model_version'"],
      ["gold text that is not its slice", (c) => c.ai("base", "x", doc(50).text, [{ category: "vocab", start: 0, end: 5, text: "wrong" }]), "does not equal the slice"],
      ["gold span out of range", (c) => c.ai("base", "x", doc(50).text, [{ category: "vocab", start: 0, end: 99999 }]), "out of range"],
      ["gold rule_id of another category", (c) => c.ai("base", "x", doc(50).text, [{ category: "hedge", rule_id: "core.vocab.003", start: 0, end: 3 }]), "belongs to a different category"],
    ];
    for (const [name, build, message] of cases) {
      it.concurrent(name, async () => {
        const run = await harness([], build(base()));
        expect(run.code, run.stdout + run.stderr).toBe(2);
        expect(run.stderr).toContain(message);
        expect(run.report).toBeNull();
      });
    }

    it.concurrent("a human item with no .meta.json at all", async () => {
      const c = base();
      writeFileSync(join(c.root, "human-control", "base", "orphan.md"), doc(60).text);
      const run = await harness([], c);
      expect(run.code).toBe(2);
      expect(run.stderr).toContain("orphan");
      expect(run.stderr).toContain("licensing gate");
    });

    it.concurrent("a missing baseline file", async () => {
      const run = await harness([], new FixtureCorpora(), join(tmp("nobase"), "baseline.json"));
      expect(run.code).toBe(2);
      expect(run.stderr).toContain("not found");
    });

    it.concurrent("an unknown argument", async () => {
      const run = await harness(["--frobnicate"], new FixtureCorpora());
      expect(run.code).toBe(2);
    });
  });

  it.concurrent("fewer than 30 items: 1 of 20 human docs trips hedge.001 -> insufficient, shown, not gated, exit 0", async () => {
    const run = await harness([], new FixtureCorpora().humanSet(20, HEDGE, [5]));
    expect(run.code, run.stdout + run.stderr).toBe(0);
    const fp = rule(run, "core.hedge.001").false_positive;
    expect([fp.num, fp.den, fp.status]).toEqual([1, 20, "insufficient"]);
    expect(run.report?.failures).toEqual([]);
    expect(run.report?.metric_coverage.false_positive).toEqual({ insufficient: 23 });
    expect(run.stdout).toContain("insufficient");
    expect(run.stdout).toContain("1/20 5.0% (insufficient)");
    expect(run.stdout).toContain("could not be measured");
  });

  it.concurrent("empty corpora: every corpus metric is n/a (never pass), exit 0, and the report and the table say so", async () => {
    const c = new FixtureCorpora(); // an empty directory
    const run = await harness([], c);
    expect(run.code, run.stdout + run.stderr).toBe(0);
    const rep = run.report as Report;
    expect(rep.metric_coverage.false_positive).toEqual({ "n/a": 23 });
    expect(rep.metric_coverage.precision).toEqual({ "n/a": 23 });
    expect(rep.metric_coverage.recall).toEqual({ "n/a": 6 });
    for (const r of rep.packs[0]?.rules ?? []) {
      expect(r.false_positive.status).toBe("n/a");
      expect(r.false_positive.value).toBeNull();
      expect(rep.packs[0]?.rule_verdicts[r.id]).toBe("PARTIAL"); // not PASS
    }
    expect(run.stdout).toContain("n/a (0 items)");
    expect(run.stdout).toContain("could not be measured");
    const passRows = run.stdout.split(/\r?\n/).filter((l) => l.startsWith("core.") && / PASS *$/.test(l));
    expect(passRows).toEqual([]);
    // Examples are real and still gate: the bundled pack's 23 rules pass them.
    expect(rep.packs[0]?.examples).toMatchObject({ rules_pass: 23, rules_total: 23, status: "pass" });
  });

  it.concurrent("--update-baseline: refused on a failing run (file untouched); written on a passing run", async () => {
    const dir = tmp("bl");
    const path = join(dir, "baseline.json");
    const original = readFileSync(join(FIXTURES, "baselines", "vocab003-precision-94.json"), "utf8");
    writeFileSync(path, original);
    const failing = await harness(["--update-baseline"], new FixtureCorpora().aiSet(30, 10, 4, ROBUST, "robust", "core.vocab.003", "vocab"), path);
    expect(failing.code).toBe(1);
    expect(failing.report?.baseline.status).toBe("update_refused");
    expect(readFileSync(path, "utf8")).toBe(original);

    const passing = await harness(["--update-baseline"], new FixtureCorpora().aiSet(30, 10, 10, ROBUST, "robust", "core.vocab.003", "vocab"), path);
    expect(passing.code, passing.stdout + passing.stderr).toBe(0);
    expect(passing.report?.baseline.status).toBe("updated");
    const written = JSON.parse(readFileSync(path, "utf8")) as { rules: Record<string, { precision: number | null; fp_rate: number | null }> };
    expect(Object.keys(written.rules)).toHaveLength(23);
    expect(written.rules["core.vocab.003"]).toEqual({ precision: 1, fp_rate: null });
    expect(written.rules["core.hedge.001"]).toEqual({ precision: null, fp_rate: null }); // unmeasured stays null, not 0
  });

  it.concurrent("a baseline that held a measured precision fails a run that can no longer measure it (a shrunk corpus is not a pass)", async () => {
    const run = await harness([], new FixtureCorpora(), join(FIXTURES, "baselines", "vocab003-precision-96.json"));
    expect(run.code, run.stdout + run.stderr).toBe(1);
    expect(run.report?.failures.map((f) => f.id)).toEqual(["core.vocab.003"]);
    expect(run.stdout).toContain("was measured, this run has none");
  });

  it.concurrent("the real repo: examples pass, FP / precision / recall are n/a, exit 0", async () => {
    const run = await harness([], join(REPO, "eval", "corpora"), join(REPO, "eval", "baseline.json"));
    expect(run.code, run.stdout + run.stderr).toBe(0);
    const rep = run.report as Report;
    expect(rep.packs[0]?.examples).toMatchObject({ rules_pass: 23, rules_total: 23, pass: 46, total: 46 });
    expect(rep.metric_coverage.false_positive).toEqual({ "n/a": 23 });
    expect(rep.packs[0]?.latency.source).toBe("engine-fixture");
    expect(rep.packs[0]?.latency.note).toContain("fallback");
    expect(rep.engine.version).toBeTruthy();
    expect(rep.wall_ms).toBeGreaterThan(0);
  });
});

describe("latency gate (in process, injected clock; no wall-clock dependence)", () => {
  function inProcess(clock: () => number): ReturnType<typeof runEval> {
    return runEval({
      repoRoot: REPO,
      corporaDir: tmp("lat-corpora"),
      ruleExamplesDir: EXAMPLES,
      packPaths: [],
      useBundled: true,
      baselinePath: join(FIXTURES, "baselines", "empty.json"),
      reportsDir: tmp("lat-reports"),
      updateBaseline: false,
      local: false,
      clock,
      git: { sha: "test", dirty: false },
    });
  }

  it("a clock that makes the pack take > 200 ms per review fails the gate and names the pack", () => {
    let t = 0;
    const out = inProcess(() => (t += 30)); // every engine clock read advances 30 ms
    expect(out.exitCode).toBe(1);
    const lat = out.report?.failures.filter((f) => f.metric === "latency") ?? [];
    expect(lat.map((f) => [f.scope, f.id])).toEqual([["pack", "core"]]);
    expect(out.report?.packs[0]?.latency.p95_ms).toBeGreaterThan(200);
    expect(out.report?.packs[0]?.latency.status).toBe("fail");
  });

  it("a fast clock passes the gate and meets ADR-10's 50 ms target", () => {
    let t = 0;
    const out = inProcess(() => (t += 0.01));
    expect(out.exitCode, out.text).toBe(0);
    const lat = out.report?.packs[0]?.latency;
    expect(lat?.status).toBe("pass");
    expect(lat?.meets_target).toBe(true);
    expect(lat?.p95_ms).toBeGreaterThan(0);
  });
});

describe("gate arithmetic (pure)", () => {
  const s = (m: MetricResult): string => m.status;

  it("false-positive budgets are inclusive and use integer counts", () => {
    expect(s(gateFalsePositive(1, 100, "block"))).toBe("pass"); // exactly 1%
    expect(s(gateFalsePositive(2, 100, "block"))).toBe("fail");
    expect(s(gateFalsePositive(3, 100, "warn"))).toBe("pass");
    expect(s(gateFalsePositive(4, 100, "warn"))).toBe("fail");
    expect(s(gateFalsePositive(10, 100, "info"))).toBe("pass");
    expect(s(gateFalsePositive(11, 100, "info"))).toBe("fail");
    expect(s(gateFalsePositive(1, 30, "block"))).toBe("fail"); // 30 items is enough to gate
  });

  it("fewer than 30 items is insufficient, zero is n/a", () => {
    expect(s(gateFalsePositive(5, 29, "block"))).toBe("insufficient");
    expect(s(gateFalsePositive(0, 0, "block"))).toBe("n/a");
    expect(s(gatePrecision(0, 0, 100, "warn"))).toBe("n/a"); // documents but no hits
    expect(s(gatePrecision(0, 0, 0, "warn"))).toBe("n/a");
    expect(s(gatePrecision(1, 10, 29, "warn"))).toBe("insufficient");
    expect(s(gateRecall(0, 0, "block"))).toBe("n/a");
    expect(s(gateRecall(1, 29, "block"))).toBe("insufficient");
  });

  it("precision and recall floors", () => {
    expect(s(gatePrecision(9, 10, 30, "block"))).toBe("pass");
    expect(s(gatePrecision(8, 10, 30, "block"))).toBe("fail");
    expect(s(gatePrecision(8, 10, 30, "warn"))).toBe("pass");
    expect(s(gatePrecision(7, 10, 30, "warn"))).toBe("fail");
    expect(s(gatePrecision(6, 10, 30, "info"))).toBe("pass");
    expect(s(gatePrecision(5, 10, 30, "info"))).toBe("fail");
    expect(s(gateRecall(21, 30, "block"))).toBe("pass");
    expect(s(gateRecall(20, 30, "block"))).toBe("fail");
    expect(s(gateRecall(18, 30, "warn"))).toBe("pass");
    expect(s(gateRecall(17, 30, "warn"))).toBe("fail");
    expect(s(gateRecall(0, 30, "info"))).toBe("ungated");
  });

  it("baseline: more than 5 points fails, exactly 5 passes, null baseline is not compared", () => {
    const at = (value: number): MetricResult => gatePrecision(Math.round(value * 100), 100, 100, "info");
    expect(compareToBaseline("r", { precision: 0.95, fp_rate: null }, at(0.9)).ok).toBe(true);
    expect(compareToBaseline("r", { precision: 0.96, fp_rate: null }, at(0.9)).ok).toBe(false);
    expect(compareToBaseline("r", { precision: null, fp_rate: null }, at(0.1)).ok).toBe(true);
    expect(compareToBaseline("r", undefined, at(0.1)).ok).toBe(true);
    expect(compareToBaseline("r", { precision: 0.5, fp_rate: null }, gatePrecision(0, 0, 0, "info")).ok).toBe(false);
  });

  it("percentile is nearest-rank; spans overlap needs a shared unit", () => {
    expect(percentile([5, 1, 3, 2, 4], 0.95)).toBe(5);
    expect(percentile([5, 1, 3, 2, 4], 0.5)).toBe(3);
    expect(spansOverlap({ start: 0, end: 5 }, { start: 5, end: 9 })).toBe(false);
    expect(spansOverlap({ start: 0, end: 6 }, { start: 5, end: 9 })).toBe(true);
  });

  it("gold validation: a span may not split a surrogate pair", () => {
    const text = "a\u{1F600}b";
    const problems: string[] = [];
    expect(validateGold([{ category: "vocab", start: 1, end: 3 }], text, "g", problems)).toHaveLength(1);
    expect(problems).toEqual([]);
    validateGold([{ category: "vocab", start: 2, end: 4 }], text, "g", problems);
    expect(problems.join()).toContain("splits a surrogate pair");
  });
});
