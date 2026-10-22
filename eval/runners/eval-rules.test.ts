// Proof that the eval:rules gates bite. Each test runs the real CLI as a subprocess against a fixture
// corpus (eval/runners/test-fixtures/build.ts) and asserts the exit code and the failing rule id, so a
// green suite means a planted breach really turns the run red and the clean fixture really turns it
// green. No assertion here depends on wall-clock speed; the latency, unfinished-rule and engine-drop
// gates are tested in process with an injected clock or engine wrapper.
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { reviewRulesDetailed } from "@prosegate/engine";
import { describe, expect, it } from "vitest";
import { runEval } from "./rules-run.js";
import type { Report, RunOptions } from "./rules-run.js";
import { validateGold } from "./rules-corpus.js";
import { compareToBaseline, confirms, gateFalsePositive, gatePrecision, gateRecall, percentile, spansOverlap, type MetricResult } from "./rules-gates.js";
import { realisticDoc } from "./rules-perf-doc.js";
import { FixtureCorpora, baselineFile, coreExampleCount, doc, HUMAN_META } from "./test-fixtures/build.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..", "..");
const CLI = join(HERE, "eval-rules.ts");
const EXAMPLES = join(REPO, "eval", "corpora", "rule-examples");
const BUNDLED = join(REPO, "packages", "profiles", "bundled", "packs");
const FIXTURES = join(HERE, "test-fixtures");
const TSX = import.meta.resolve("tsx");

const HEDGE = "It's worth noting that the cache is per tenant.";
const ROBUST = "The retry path is robust.";
const WHETHER = "Whether it's staging or production, the cache is per tenant.";
const COMPREHENSIVE = "A comprehensive review is pending.";

interface Run {
  code: number;
  stdout: string;
  stderr: string;
  report: Report | null;
}

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `prosegate-evalrules-${prefix}-`));
}

/** Runs the CLI (tsx on eval-rules.ts) as a subprocess; the report goes to a private temp directory. */
function harness(args: string[], corpora: FixtureCorpora | string | null, baseline: string | null = baselineFile(), allBundled = false): Promise<Run> {
  const reports = tmp("reports");
  const all = ["--reports", reports, "--rule-examples", EXAMPLES];
  // These planted gold labels and baselines target core. Other packs must not be
  // graded against core's labels; discovery and full-repository cases opt in below.
  if (!allBundled && !args.includes("--bundled-packs") && !args.includes("--no-bundled")) {
    all.push("--no-bundled", "--pack", join(BUNDLED, "core.yaml"));
  }
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
      done({ code: code ?? -1, stdout, stderr, report });
    });
  });
}

function rule(run: Run, id: string) {
  const r = run.report?.packs.flatMap((p) => p.rules).find((x) => x.id === id);
  if (r === undefined) throw new Error(`rule ${id} not in report`);
  return r;
}

function category(run: Run, name: string) {
  const c = run.report?.packs.flatMap((p) => p.categories).find((x) => x.category === name);
  if (c === undefined) throw new Error(`category ${name} not in report`);
  return c;
}

const failingIds = (run: Run): string[] => [...new Set((run.report?.failures ?? []).map((f) => f.id))].sort();
const ok = (run: Run): void => expect(run.code, run.stdout + run.stderr).toBe(0);

describe("eval:rules gates (subprocess, fixture corpora)", { timeout: 180_000 }, () => {
  it.concurrent("planted false-positive breach: 2 of 40 human docs trip hedge.001 (block, budget 1%) -> exit 1 naming core.hedge.001", async () => {
    const run = await harness([], new FixtureCorpora().humanSet(40, HEDGE, [3, 17]));
    expect(run.code, run.stdout + run.stderr).toBe(1);
    expect(run.report?.exit_code).toBe(1);
    expect(run.report?.result).toBe("fail");
    expect(failingIds(run)).toEqual(["core.hedge.001"]);
    const fp = rule(run, "core.hedge.001").false_positive;
    expect([fp.num, fp.den, fp.status]).toEqual([2, 40, "fail"]);
    expect(run.stdout).toContain("core.hedge.001");
    expect(run.stdout).toContain("RESULT: FAIL");
  });

  it.concurrent("the same fixture without the planted sentences is PARTIAL (exit 0), with the false-positive gate measured on every rule", async () => {
    const run = await harness([], new FixtureCorpora().humanSet(40));
    ok(run);
    expect(run.report?.exit_code).toBe(0);
    expect(run.report?.failures).toEqual([]);
    // Precision and recall are unmeasured here, so the headline is partial, not pass.
    expect(run.report?.result).toBe("partial");
    expect(run.stdout).toContain("RESULT: PARTIAL");
    expect(run.report?.fp_source).toBe("raw_candidates");
    expect(run.report?.notes.join(" ")).not.toContain("fp_source: post_overlap");
    const rules = run.report?.packs[0]?.rules ?? [];
    expect(rules).toHaveLength(23);
    // Not vacuous: 40 documents reached every rule, zero findings, status pass (not n/a).
    for (const r of rules) expect([r.id, r.false_positive.den, r.false_positive.num, r.false_positive.status]).toEqual([r.id, 40, 0, "pass"]);
  });

  it.concurrent("planted precision loss: 10 of 25 vocab.003 hits confirmed (40% < 80%) -> exit 1 naming core.vocab.003", async () => {
    const run = await harness([], new FixtureCorpora().aiSet(40, 25, 10, ROBUST, "robust", "core.vocab.003", "vocab"));
    expect(run.code, run.stdout + run.stderr).toBe(1);
    expect(failingIds(run)).toEqual(["core.vocab.003"]);
    const p = rule(run, "core.vocab.003").precision;
    expect([p.confirmed, p.hits, p.status]).toEqual([10, 25, "fail"]);
    expect(run.stdout).toContain("core.vocab.003");
  });

  it.concurrent("the same AI corpus with every hit confirmed passes, precision measured", async () => {
    const run = await harness([], new FixtureCorpora().aiSet(40, 25, 25, ROBUST, "robust", "core.vocab.003", "vocab"));
    ok(run);
    const p = rule(run, "core.vocab.003").precision;
    expect([p.confirmed, p.hits, p.status]).toEqual([25, 25, "pass"]);
  });

  it.concurrent("precision needs 20 hits: 19 unconfirmed hits are insufficient (exit 0), 20 fail", async () => {
    const [few, enough] = await Promise.all([
      harness([], new FixtureCorpora().aiSet(40, 19, 0, ROBUST, "robust", "core.vocab.003", "vocab")),
      harness([], new FixtureCorpora().aiSet(40, 20, 0, ROBUST, "robust", "core.vocab.003", "vocab")),
    ]);
    ok(few);
    expect(rule(few, "core.vocab.003").precision).toMatchObject({ hits: 19, confirmed: 0, status: "insufficient" });
    expect(enough.code, enough.stdout + enough.stderr).toBe(1);
    expect(failingIds(enough)).toEqual(["core.vocab.003"]);
  });

  describe("confirmation: 50% coverage, category-only reported, other rule_id never confirms", () => {
    // 20 `robust` hits (6 chars). `cover` is how many characters of it the gold span covers.
    const run = (cover: number, goldRule: string | undefined): Promise<Run> =>
      harness(
        [],
        new FixtureCorpora().aiPlanted(40, 20, ROBUST, "robust", (i, span) =>
          span === undefined ? [] : [{ category: "vocab", ...(goldRule === undefined ? {} : { rule_id: goldRule }), start: span.start, end: span.start + cover }],
        ),
      );

    it.concurrent("half of the finding (3 of 6 characters) confirms, by rule_id", async () => {
      const r = await run(3, "core.vocab.003");
      ok(r);
      expect(rule(r, "core.vocab.003").precision).toMatchObject({ hits: 20, confirmed: 20, confirmed_by_category: 0, status: "pass" });
    });
    it.concurrent("under half (2 of 6) does not confirm", async () => {
      const r = await run(2, "core.vocab.003");
      expect(r.code, r.stdout + r.stderr).toBe(1);
      expect(rule(r, "core.vocab.003").precision).toMatchObject({ hits: 20, confirmed: 0, status: "fail" });
    });
    it.concurrent("a gold span without rule_id confirms by category and the report says how many", async () => {
      const r = await run(6, undefined);
      ok(r);
      expect(rule(r, "core.vocab.003").precision).toMatchObject({ hits: 20, confirmed: 20, confirmed_by_category: 20, status: "pass" });
    });
    it.concurrent("a gold rule_id for a different rule never confirms", async () => {
      const r = await run(6, "core.vocab.001");
      expect(r.code, r.stdout + r.stderr).toBe(1);
      expect(rule(r, "core.vocab.003").precision).toMatchObject({ confirmed: 0, status: "fail" });
    });
  });

  it.concurrent("baseline regression: precision 96% -> 90% (6 points) -> exit 1; 94% -> 90% (4 points) -> exit 0; an improvement passes", async () => {
    const ai = (): FixtureCorpora => new FixtureCorpora().aiSet(40, 20, 18, ROBUST, "robust", "core.vocab.003", "vocab");
    const at = (precision: number): string => baselineFile({ "core.vocab.003": { precision } });
    const [bad, small, better] = await Promise.all([harness([], ai(), at(0.96)), harness([], ai(), at(0.94)), harness([], ai(), at(0.8))]);
    expect(bad.code, bad.stdout + bad.stderr).toBe(1);
    expect(bad.report?.failures.map((f) => [f.scope, f.id])).toEqual([["baseline", "core.vocab.003"]]);
    expect(bad.stdout).toContain("precision fell 6.0 points");
    ok(small);
    ok(better);
    expect(rule(better, "core.vocab.003").precision.value).toBeCloseTo(0.9, 10);
    expect(better.report?.failures).toEqual([]);
  });

  it.concurrent("a rule with a measured metric and no baseline entry fails; --update-baseline then adds it", async () => {
    const corpora = (): FixtureCorpora => new FixtureCorpora().aiSet(40, 20, 20, ROBUST, "robust", "core.vocab.003", "vocab");
    const missing = baselineFile({}, { omit: ["core.vocab.003"] });
    const bad = await harness([], corpora(), missing);
    expect(bad.code, bad.stdout + bad.stderr).toBe(1);
    expect(bad.report?.failures.map((f) => [f.scope, f.id])).toEqual([["baseline", "core.vocab.003"]]);
    expect(bad.stdout).toContain("run --update-baseline in this PR");
    const fixed = await harness(["--update-baseline"], corpora(), missing);
    ok(fixed);
    const written = JSON.parse(readFileSync(missing, "utf8")) as { rules: Record<string, { precision: number | null }> };
    expect(written.rules["core.vocab.003"]?.precision).toBe(1);
  });

  it.concurrent("a failing example: a pack whose miss example fires -> exit 1 naming the rule; the clean pack passes", async () => {
    const empty = tmp("empty");
    const bl = baselineFile({}, { ids: ["fx.filler.001"] });
    const bad = await harness(["--no-bundled", "--pack", join(FIXTURES, "packs", "failing-example.yaml")], empty, bl);
    expect(bad.code, bad.stdout + bad.stderr).toBe(1);
    expect(failingIds(bad)).toEqual(["fx.filler.001"]);
    expect(bad.report?.failures[0]?.metric).toBe("example");
    expect(bad.stdout).toContain("miss example fires");
    const good = await harness(["--no-bundled", "--pack", join(FIXTURES, "packs", "clean.yaml")], empty, bl);
    ok(good);
    expect(good.report?.packs[0]?.examples).toMatchObject({ rules_pass: 1, rules_total: 1, status: "pass" });
  });

  it.concurrent("a hit example that cannot fire fails the example gate as well", async () => {
    const dir = tmp("pack");
    const yaml = readFileSync(join(FIXTURES, "packs", "clean.yaml"), "utf8").replace("This sentence carries needless filler.", "This sentence carries nothing.");
    const file = join(dir, "hit-misses.yaml");
    writeFileSync(file, yaml);
    const run = await harness(["--no-bundled", "--pack", file], tmp("empty"), baselineFile({}, { ids: ["fx.filler.001"] }));
    expect(run.code, run.stdout + run.stderr).toBe(1);
    expect(run.stdout).toContain("hit example does not fire");
  });

  it.concurrent("an unexpected crash is exit 2, not a pass and not exit 1", async () => {
    // A corpus ref that resolves to a directory makes readFileSync throw EISDIR: no HarnessError wraps it.
    const dir = tmp("crash");
    mkdirSync(join(dir, "fx", "filler-001-hit-01.md"), { recursive: true });
    const yaml = readFileSync(join(FIXTURES, "packs", "clean.yaml"), "utf8").replace("This sentence carries needless filler.", "<eval corpus ref: fx/filler-001-hit-01>");
    const file = join(dir, "pack.yaml");
    writeFileSync(file, yaml);
    const run = await harness(["--no-bundled", "--pack", file, "--rule-examples", dir], tmp("empty"), baselineFile({}, { ids: ["fx.filler.001"] }));
    expect(run.code, run.stdout + run.stderr).toBe(2);
    expect(run.stderr).toContain("unexpected error");
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
      ["AI meta missing a field", (c) => c.ai("base", "x", doc(50).text, [], { model: "m" }), "model_version"],
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

  it.concurrent("bundled pack discovery: an unregistered pack on disk is a harness error; the registered set alone passes", async () => {
    const withExtra = tmp("packs-extra");
    copyFileSync(join(BUNDLED, "core.yaml"), join(withExtra, "core.yaml"));
    copyFileSync(join(FIXTURES, "packs", "clean.yaml"), join(withExtra, "extra.yaml"));
    const bad = await harness(["--bundled-packs", withExtra], new FixtureCorpora());
    expect(bad.code, bad.stdout + bad.stderr).toBe(2);
    expect(bad.stderr).toContain("do not match the bundled registry");
    expect(bad.stderr).toContain("fx@0.1.0");
    const same = tmp("packs-same");
    copyFileSync(join(BUNDLED, "core.yaml"), join(same, "core.yaml"));
    copyFileSync(join(BUNDLED, "writing.yaml"), join(same, "writing.yaml"));
    ok(await harness(["--bundled-packs", same], new FixtureCorpora()));
    // A registered pack missing from disk is the other half of the same drift.
    const none = tmp("packs-none");
    const gone = await harness(["--bundled-packs", none], new FixtureCorpora());
    expect(gone.code).toBe(2);
  });

  it.concurrent("fewer than 30 items: 1 of 20 human docs trips hedge.001 -> insufficient, shown, not gated, exit 0", async () => {
    const run = await harness([], new FixtureCorpora().humanSet(20, HEDGE, [5]));
    ok(run);
    const fp = rule(run, "core.hedge.001").false_positive;
    expect([fp.num, fp.den, fp.status]).toEqual([1, 20, "insufficient"]);
    expect(run.report?.failures).toEqual([]);
    expect(run.report?.metric_coverage.false_positive).toEqual({ insufficient: 23 });
    expect(run.stdout).toContain("1/20 5.0% (insufficient)");
    expect(run.stdout).toContain("could not be measured");
  });

  it.concurrent("empty corpora: every corpus metric is n/a (never pass), exit 0, headline PARTIAL, and the report and the table say so", async () => {
    const run = await harness([], new FixtureCorpora());
    ok(run);
    const rep = run.report as Report;
    expect(rep.result).toBe("partial");
    expect(rep.metric_coverage.false_positive).toEqual({ "n/a": 23 });
    expect(rep.metric_coverage.precision).toEqual({ "n/a": 23 });
    expect(rep.metric_coverage.recall).toEqual({ "n/a": 6 });
    expect(rep.fp_source).toBe("n/a"); // no human docs: neither source was used, and no misleading note
    expect(rep.notes.some((n: string) => n.startsWith("fp_source: post_overlap"))).toBe(false);
    for (const r of rep.packs[0]?.rules ?? []) {
      expect(r.false_positive.status).toBe("n/a");
      expect(r.false_positive.value).toBeNull();
      expect(rep.packs[0]?.rule_verdicts[r.id]).toBe("PARTIAL"); // not PASS
    }
    expect(run.stdout).toContain("n/a (0 items)");
    expect(run.stdout).toContain("could not be measured");
    expect(run.stdout).toContain("RESULT: PARTIAL");
    const passRows = run.stdout.split(/\r?\n/).filter((l) => l.startsWith("core.") && / PASS *$/.test(l));
    expect(passRows).toEqual([]);
    expect(rep.packs[0]?.examples).toMatchObject({ rules_pass: 23, rules_total: 23, status: "pass" });
  });

  // ---- false-positive gate details ------------------------------------------------------------------

  describe("false-positive gate through the real path", () => {
    it.concurrent("an info-only rule counts: triad.003 (info, budget 10%) fails at 4 of 30, passes at 3 of 30", async () => {
      const [bad, good] = await Promise.all([harness([], new FixtureCorpora().humanSet(30, WHETHER, [1, 2, 3, 4])), harness([], new FixtureCorpora().humanSet(30, WHETHER, [1, 2, 3]))]);
      expect(bad.code, bad.stdout + bad.stderr).toBe(1);
      expect(failingIds(bad)).toEqual(["core.triad.003"]);
      expect(rule(bad, "core.triad.003").false_positive).toMatchObject({ num: 4, den: 30, status: "fail", gate_severity: "info" });
      ok(good);
      expect(rule(good, "core.triad.003").false_positive).toMatchObject({ num: 3, den: 30, status: "pass" });
    });

    it.concurrent("a warn rule through the real path: vocab.003 (budget 3%) fails at 1 of 33 (3.03%), passes at 1 of 34", async () => {
      const [bad, good] = await Promise.all([harness([], new FixtureCorpora().humanSet(33, ROBUST, [0])), harness([], new FixtureCorpora().humanSet(34, ROBUST, [0]))]);
      expect(bad.code, bad.stdout + bad.stderr).toBe(1);
      expect(failingIds(bad)).toEqual(["core.vocab.003"]);
      expect(rule(bad, "core.vocab.003").false_positive.gate_severity).toBe("warn");
      ok(good);
    });

    it.concurrent("skipped short documents are excluded from the denominator and counted", async () => {
      const run = await harness([], new FixtureCorpora().humanSet(29).humanShort(5));
      ok(run);
      const fp = rule(run, "core.hedge.001").false_positive;
      expect([fp.den, fp.status]).toEqual([29, "insufficient"]); // 34 documents would gate
      expect(run.report?.packs[0]?.skipped_below_floor.human_control).toBe(5);
      expect(run.report?.notes.join("\n")).toContain("5 human-control documents were skipped");
    });

    it.concurrent("each document is reviewed under its own profile: design-doc allows 'comprehensive', base does not", async () => {
      const dd = new FixtureCorpora().humanSet(30, COMPREHENSIVE, [...Array(30).keys()], "design-doc");
      const base = new FixtureCorpora().humanSet(30, COMPREHENSIVE, [...Array(30).keys()], "base");
      const [underDesign, underBase] = await Promise.all([harness([], dd), harness([], base)]);
      ok(underDesign);
      expect(rule(underDesign, "core.vocab.003").false_positive).toMatchObject({ num: 0, den: 30, status: "pass" });
      expect(rule(underDesign, "core.vocab.003").false_positive.by_profile["design-doc"]).toMatchObject({ den: 30, hit_docs: 0 });
      expect(underBase.code, underBase.stdout + underBase.stderr).toBe(1);
      expect(rule(underBase, "core.vocab.003").false_positive).toMatchObject({ num: 30, den: 30, status: "fail" });
    });

    it.concurrent("gate severity is the strictest effective severity: structure.001 is warn in the pack but block under pr-description, so 2 of 100 fails", async () => {
      const hitDoc = readFileSync(join(EXAMPLES, "core", "structure-001-hit-01.md"), "utf8");
      const c = new FixtureCorpora().humanSet(98);
      c.human("base", "z1", hitDoc).human("base", "z2", hitDoc);
      const run = await harness([], c);
      expect(run.code, run.stdout + run.stderr).toBe(1);
      expect(failingIds(run)).toEqual(["core.structure.001"]);
      const r = rule(run, "core.structure.001");
      expect([r.severity, r.gate_severity]).toEqual(["warn", "block"]);
      expect(r.false_positive).toMatchObject({ num: 2, den: 100, status: "fail", gate_severity: "block" });
      // Under base itself the rule is warn: 2% would pass a 3% budget, so only the strictest-severity gate fails it.
      expect(r.false_positive.by_profile["base"]).toMatchObject({ effective_severity: "warn", status: "pass" });
      expect(run.stdout).toContain("warn>block");
    });

    it.concurrent("per profile: 1 of 30 email documents at the email severity (block) fails although the pooled rate passes", async () => {
      const hitDoc = readFileSync(join(EXAMPLES, "core", "structure-001-hit-01.md"), "utf8");
      const corpora = (plant: boolean): FixtureCorpora => {
        const c = new FixtureCorpora().humanSet(100, undefined, [], "base", "b").humanSet(29, undefined, [], "email", "e");
        return plant ? c.human("email", "e-hit", hitDoc) : c.human("email", "e-clean", doc(500).text);
      };
      const [bad, good] = await Promise.all([harness([], corpora(true)), harness([], corpora(false))]);
      expect(bad.code, bad.stdout + bad.stderr).toBe(1);
      expect(rule(bad, "core.structure.001").false_positive).toMatchObject({ num: 1, den: 130, status: "pass" }); // pooled 0.8% <= 1%
      expect(rule(bad, "core.structure.001").false_positive.by_profile["email"]).toMatchObject({ den: 30, hit_docs: 1, effective_severity: "block", status: "fail" });
      expect((bad.report?.failures ?? []).map((f) => f.message).join("\n")).toContain("[profile email]");
      ok(good);
    });
  });

  // ---- recall, end to end ----------------------------------------------------------------------------

  describe("recall through the real path", () => {
    // The first `caught` documents have a gold span on the finding; the next `decoys` have a finding too, but
    // their gold span sits on another sentence (a finding of the category in the document must not count as a
    // catch); the rest are plain documents with a gold span on their first sentence.
    const vocab = (caught: number, decoys = 0, total = 35): FixtureCorpora =>
      new FixtureCorpora().aiPlanted(total, caught + decoys, ROBUST, "robust", (i, span, first) =>
        span !== undefined && i < caught ? [{ category: "vocab", start: span.start, end: span.end }] : [{ category: "vocab", start: first.start, end: first.end }],
      );
    const hedge = (caught: number, total = 30): FixtureCorpora =>
      new FixtureCorpora().aiPlanted(total, caught, HEDGE, "It's worth noting that", (_i, span, first) =>
        span === undefined ? [{ category: "hedge", start: first.start, end: first.end }] : [{ category: "hedge", start: span.start, end: span.end }],
      );

    it.concurrent("warn category (vocab, floor 60%): 35 of 35 caught passes; 12 of 35 fails (7 more documents have a finding but no gold on it) and names the category", async () => {
      const [good, bad] = await Promise.all([harness([], vocab(35)), harness([], vocab(12, 7))]);
      ok(good);
      expect(category(good, "vocab").recall).toMatchObject({ caught: 35, spans: 35, status: "pass" });
      expect(bad.code, bad.stdout + bad.stderr).toBe(1);
      expect(bad.report?.failures.map((f) => [f.scope, f.id])).toEqual([["category", "core:vocab"]]);
      expect(category(bad, "vocab").recall).toMatchObject({ caught: 12, spans: 35, status: "fail" });
    });

    it.concurrent("block category (hedge, floor 70%): 21 of 30 (70%) passes, 20 of 30 (66.7%) fails although a warn category would pass", async () => {
      const [good, bad] = await Promise.all([harness([], hedge(21)), harness([], hedge(20))]);
      ok(good);
      expect(category(good, "hedge")).toMatchObject({ severity: "block", recall: { caught: 21, spans: 30, status: "pass" } });
      expect(bad.code, bad.stdout + bad.stderr).toBe(1);
      expect(bad.report?.failures.map((f) => [f.scope, f.id])).toEqual([["category", "core:hedge"]]);
      expect(category(bad, "hedge").recall).toMatchObject({ caught: 20, spans: 30, status: "fail" });
    });

    it.concurrent("a finding of another category under the gold span does not catch it", async () => {
      // 30 `robust` findings (vocab); every gold span sits on them but is labelled hedge.
      const c = new FixtureCorpora().aiPlanted(30, 30, ROBUST, "robust", (_i, span) => (span === undefined ? [] : [{ category: "hedge", start: span.start, end: span.end }]));
      const run = await harness([], c);
      expect(run.code, run.stdout + run.stderr).toBe(1);
      expect(category(run, "hedge").recall).toMatchObject({ caught: 0, spans: 30, status: "fail" });
    });

    it.concurrent("under 30 gold spans recall is insufficient and does not gate", async () => {
      const run = await harness([], hedge(5, 29));
      ok(run);
      expect(category(run, "hedge").recall).toMatchObject({ caught: 5, spans: 29, status: "insufficient" });
    });
  });

  // ---- baseline writes -------------------------------------------------------------------------------

  it.concurrent("--update-baseline: refused on a failing run (file untouched); written on a passing run", async () => {
    const path = baselineFile({ "core.vocab.003": { precision: 0.94 } });
    const original = readFileSync(path, "utf8");
    const failing = await harness(["--update-baseline"], new FixtureCorpora().aiSet(40, 25, 10, ROBUST, "robust", "core.vocab.003", "vocab"), path);
    expect(failing.code).toBe(1);
    expect(failing.report?.baseline.status).toBe("update_refused");
    expect(readFileSync(path, "utf8")).toBe(original);

    const passing = await harness(["--update-baseline"], new FixtureCorpora().aiSet(40, 25, 25, ROBUST, "robust", "core.vocab.003", "vocab"), path);
    ok(passing);
    expect(passing.report?.baseline.status).toBe("updated");
    const written = JSON.parse(readFileSync(path, "utf8")) as { rules: Record<string, { precision: number | null; fp_rate: number | null }> };
    expect(Object.keys(written.rules)).toHaveLength(23);
    expect(written.rules["core.vocab.003"]).toEqual({ precision: 1, fp_rate: null });
    expect(written.rules["core.hedge.001"]).toEqual({ precision: null, fp_rate: null }); // unmeasured stays null, not 0
  });

  it.concurrent("--update-baseline writes measured values only: an insufficient rate stays null, a measured 0 is written as 0", async () => {
    const small = baselineFile();
    const big = baselineFile();
    const [a, b] = await Promise.all([harness(["--update-baseline"], new FixtureCorpora().humanSet(20), small), harness(["--update-baseline"], new FixtureCorpora().humanSet(40), big)]);
    ok(a);
    ok(b);
    const read = (p: string) => (JSON.parse(readFileSync(p, "utf8")) as { rules: Record<string, { fp_rate: number | null }> }).rules;
    expect(read(small)["core.hedge.001"]?.fp_rate).toBeNull(); // 20 documents: insufficient
    expect(read(big)["core.hedge.001"]?.fp_rate).toBe(0); // 40 documents: measured, zero
  });

  it.concurrent("a baseline that held a measured precision fails a run that can no longer measure it (a shrunk corpus is not a pass)", async () => {
    const run = await harness([], new FixtureCorpora(), baselineFile({ "core.vocab.003": { precision: 0.96 } }));
    expect(run.code, run.stdout + run.stderr).toBe(1);
    expect(run.report?.failures.map((f) => f.id)).toEqual(["core.vocab.003"]);
    expect(run.stdout).toContain("was measured, this run has none");
  });

  it.concurrent("the real repo: examples pass, FP / precision / recall are n/a, headline PARTIAL, exit 0", async () => {
    const run = await harness([], join(REPO, "eval", "corpora"), join(REPO, "eval", "baseline.json"), true);
    ok(run);
    const rep = run.report as Report;
    expect(rep.exit_code).toBe(0);
    expect(rep.result).toBe("partial");
    expect(rep.packs[0]?.examples).toMatchObject({ rules_pass: 23, rules_total: 23, pass: coreExampleCount(), total: coreExampleCount() });
    expect(rep.packs[1]).toMatchObject({ id: "writing", examples: { rules_pass: 2, rules_total: 2, pass: 8, total: 8, status: "pass" } });
    expect(rep.metric_coverage.false_positive).toEqual({ "n/a": 25 });
    expect(rep.packs[0]?.latency.source).toBe("engine-fixture");
    expect(rep.packs[0]?.latency.note).toContain("fallback");
    expect(rep.packs[0]?.invalid_findings_dropped).toBe(0);
    expect(rep.engine.version).toBeTruthy();
    expect(rep.wall_ms).toBeGreaterThan(0);
  });
});

// ---- in process: injected clock and engine wrapper ----------------------------------------------------

function inProcess(corpora: FixtureCorpora, extra: Partial<RunOptions> = {}): ReturnType<typeof runEval> {
  return runEval({
    repoRoot: REPO,
    corporaDir: corpora.root,
    ruleExamplesDir: EXAMPLES,
    packPaths: [join(BUNDLED, "core.yaml")],
    useBundled: false,
    bundledPacksDir: BUNDLED,
    baselinePath: baselineFile(),
    reportsDir: tmp("ip-reports"),
    updateBaseline: false,
    local: false,
    git: { sha: "test", dirty: false },
    ...extra,
  });
}

/** AI corpus of `n` documents of at least 2,000 words (distinct seeds), no gold. */
function longAi(n: number): FixtureCorpora {
  const c = new FixtureCorpora();
  for (let i = 0; i < n; i++) c.ai("base", `long${String(i).padStart(2, "0")}`, realisticDoc(2000, 0.05, 100 + i));
  return c;
}

describe("latency gate (in process, injected clock; no wall-clock dependence)", () => {
  it("a clock that makes the pack take > 200 ms per review fails the gate and names the pack", () => {
    let t = 0;
    // Every engine clock read advances 150 ms. The engine's budget runs from the start of the review, so the
    // rules stop at their first deadline check and rules_latency_ms is then two reads (check + end) = 300 ms > 200.
    const out = inProcess(new FixtureCorpora(), { clock: () => (t += 150) });
    expect(out.exitCode).toBe(1);
    const lat = out.report?.failures.filter((f) => f.metric === "latency") ?? [];
    expect(lat.map((f) => [f.scope, f.id])).toEqual([["pack", "core"]]);
    expect(out.report?.packs[0]?.latency.p95_ms).toBeGreaterThan(200);
    expect(out.report?.packs[0]?.latency.status).toBe("fail");
  });

  it("a fast clock passes the gate and meets ADR-10's 50 ms target", () => {
    let t = 0;
    const out = inProcess(new FixtureCorpora(), { clock: () => (t += 0.01) });
    expect(out.exitCode, out.text).toBe(0);
    const lat = out.report?.packs[0]?.latency;
    expect(lat?.status).toBe("pass");
    expect(lat?.meets_target).toBe(true);
    expect(lat?.p95_ms).toBeGreaterThan(0);
  });

  it("with 10 AI documents of 2,000+ words the AI-corpus branch is measured; with 9 it falls back to the engine fixture", () => {
    let t = 0;
    const ten = inProcess(longAi(10), { clock: () => (t += 0.01) });
    expect(ten.report?.packs[0]?.latency).toMatchObject({ source: "ai-corpus", documents: 10, status: "pass" });
    expect(ten.report?.packs[0]?.latency.words).toBeGreaterThanOrEqual(2000);
    let u = 0;
    const nine = inProcess(longAi(9), { clock: () => (u += 0.01) });
    expect(nine.report?.packs[0]?.latency).toMatchObject({ source: "engine-fixture", documents: 1 });
    expect(nine.report?.packs[0]?.latency.note).toContain("9 AI-corpus documents");
  });

  it("the AI-corpus branch gates too: slow injected timings fail it", () => {
    let t = 0;
    const out = inProcess(longAi(10), { clock: () => (t += 150) });
    expect(out.report?.packs[0]?.latency).toMatchObject({ source: "ai-corpus", status: "fail" });
    expect(out.report?.failures.some((f) => f.metric === "latency")).toBe(true);
  });
});

describe("hidden false positives (in process)", () => {
  it("a rule that does not finish on a document fails; it never shrinks its own denominator", () => {
    let t = 0;
    const out = inProcess(new FixtureCorpora().humanSet(30), { clock: () => (t += 30) });
    expect(out.exitCode).toBe(1);
    const r = out.report?.packs[0]?.rules.find((x) => x.id === "core.vocab.005");
    expect(r?.false_positive.unfinished_docs).toBe(30);
    const f = out.report?.failures.find((x) => x.id === "core.vocab.005" && x.metric === "unfinished");
    expect(f?.message).toContain("rule did not finish on 30 docs");
    expect(out.report?.packs[0]?.rule_verdicts["core.vocab.005"]).toBe("FAIL");
  });

  it("raw candidates count a hit that overlap resolution dropped (fp_source: raw_candidates); post_overlap is the fallback", () => {
    // One document's hedge.001 finding is removed from all_findings (as if another rule outranked it) but
    // stays in candidates, in the engine's RuleCandidate shape: 1 of 30 = 3.3% > 1% (block), so the rule fails.
    const withCandidates = (input: Parameters<typeof reviewRulesDetailed>[0]) => {
      const r = reviewRulesDetailed(input);
      const d = r.diagnostics;
      const all = d.all_findings;
      if (input.request.text.includes("Ticket 1004 ")) d.all_findings = all.filter((f) => f.rule_id !== "core.hedge.001");
      (d as unknown as { candidates: unknown[] }).candidates = [...all]
        .sort((a, b) => a.span.start - b.span.start || (a.rule_id ?? "").localeCompare(b.rule_id ?? ""))
        .map((f) => ({ rule_id: f.rule_id, category: f.category, severity: f.severity, start: f.span.start, end: f.span.end, scope: "span" }));
      return r;
    };
    const out = inProcess(new FixtureCorpora().humanSet(30, HEDGE, [4]), { review: withCandidates });
    expect(out.exitCode, out.text).toBe(1);
    expect(out.report?.fp_source).toBe("raw_candidates");
    expect([...new Set(out.report?.failures.map((f) => f.id))]).toEqual(["core.hedge.001"]);
    expect(out.report?.packs[0]?.rules.find((x) => x.id === "core.hedge.001")?.false_positive).toMatchObject({ num: 1, den: 30, status: "fail" });
    // The same corpus on post-overlap findings, with the finding dropped and no candidates, would not see the hit.
    const blind = inProcess(new FixtureCorpora().humanSet(30, HEDGE, [4]), {
      review: (input) => {
        const r = reviewRulesDetailed(input);
        (r.diagnostics as unknown as { candidates?: unknown }).candidates = undefined; // an engine without candidates
        if (input.request.text.includes("Ticket 1004 ")) r.diagnostics.all_findings = r.diagnostics.all_findings.filter((f) => f.rule_id !== "core.hedge.001");
        return r;
      },
    });
    expect(blind.report?.fp_source).toBe("post_overlap");
    expect(blind.report?.packs[0]?.rules.find((x) => x.id === "core.hedge.001")?.false_positive).toMatchObject({ num: 0, status: "pass" });
    const plain = inProcess(new FixtureCorpora().humanSet(30));
    expect(plain.exitCode, plain.text).toBe(0);
    expect(plain.report?.fp_source).toBe("raw_candidates"); // the real engine now supplies them
    expect(plain.report?.notes.join(" ")).not.toContain("fp_source: post_overlap");
    const stripped = inProcess(new FixtureCorpora().humanSet(30), {
      review: (input) => {
        const r = reviewRulesDetailed(input);
        (r.diagnostics as unknown as { candidates?: unknown }).candidates = undefined;
        return r;
      },
    });
    expect(stripped.report?.fp_source).toBe("post_overlap");
    expect(stripped.report?.notes.join(" ")).toContain("fp_source: post_overlap");
  });

  it("a candidates value that is not an array is a harness error (exit 2)", () => {
    const bad = (input: Parameters<typeof reviewRulesDetailed>[0]) => {
      const r = reviewRulesDetailed(input);
      (r.diagnostics as unknown as { candidates: unknown }).candidates = { "core.vocab.003": 1 };
      return r;
    };
    const out = inProcess(new FixtureCorpora().humanSet(30), { review: bad });
    expect(out.exitCode).toBe(2);
    expect(out.text).toContain("diagnostics.candidates must be an array");
  });
});

describe("engine self-check drops (in process)", () => {
  it("a non-zero invalid_findings_dropped fails the pack and is reported", () => {
    const dropping = (input: Parameters<typeof reviewRulesDetailed>[0]) => {
      const r = reviewRulesDetailed(input);
      r.diagnostics.invalid_findings_dropped = 1;
      return r;
    };
    const out = inProcess(new FixtureCorpora(), { review: dropping });
    expect(out.exitCode).toBe(1);
    const f = out.report?.failures.find((x) => x.metric === "engine_drops");
    expect(f?.scope).toBe("pack");
    expect(out.report?.packs[0]?.invalid_findings_dropped).toBeGreaterThan(0);
  });

  it("zero drops (the normal case) is reported as 0", () => {
    const out = inProcess(new FixtureCorpora());
    expect(out.report?.packs[0]?.invalid_findings_dropped).toBe(0);
  });
});

describe("perf fixture copy", () => {
  it("rules-perf-doc.ts produces the same 2,000-word document as the engine's perf fixture", () => {
    // The engine fixture cannot be imported (check:deps forbids a relative import out of the package),
    // so a child process loads it by file URL and prints the hash of its documents.
    const engine = pathToFileURL(join(REPO, "packages", "engine", "test", "fixtures.ts")).href;
    const script = `import { createHash } from "node:crypto"; import { realisticDoc } from ${JSON.stringify(engine)};
      const h = (s) => createHash("sha256").update(s).digest("hex");
      console.log(JSON.stringify([h(realisticDoc(2000)), h(realisticDoc(2000, 0.35, 11))]));`;
    const r = spawnSync(process.execPath, ["--import", TSX, "--input-type=module", "-e", script], { cwd: REPO, encoding: "utf8" });
    expect(r.status, r.stderr).toBe(0);
    const sha = (s: string): string => createHashHex(s);
    expect(JSON.parse(r.stdout) as string[]).toEqual([sha(realisticDoc(2000)), sha(realisticDoc(2000, 0.35, 11))]);
  });
});

// ---- gate arithmetic ----------------------------------------------------------------------------------------

const createHashHex = (s: string): string => createHash("sha256").update(s).digest("hex");

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
    expect(s(gatePrecision(1, 25, 29, "warn"))).toBe("insufficient");
    expect(s(gateRecall(0, 0, "block"))).toBe("n/a");
    expect(s(gateRecall(1, 29, "block"))).toBe("insufficient");
  });

  it("precision floors, at the boundary, with 20 hits needed", () => {
    expect(s(gatePrecision(90, 100, 100, "block"))).toBe("pass"); // exactly 90%
    expect(s(gatePrecision(89, 100, 100, "block"))).toBe("fail");
    expect(s(gatePrecision(80, 100, 100, "warn"))).toBe("pass");
    expect(s(gatePrecision(79, 100, 100, "warn"))).toBe("fail");
    expect(s(gatePrecision(60, 100, 100, "info"))).toBe("pass");
    expect(s(gatePrecision(59, 100, 100, "info"))).toBe("fail");
    expect(s(gatePrecision(18, 20, 100, "block"))).toBe("pass");
    expect(s(gatePrecision(17, 20, 100, "block"))).toBe("fail");
    expect(s(gatePrecision(0, 19, 100, "block"))).toBe("insufficient"); // 19 hits: not enough
    expect(s(gatePrecision(0, 20, 100, "block"))).toBe("fail");
  });

  it("recall floors", () => {
    expect(s(gateRecall(21, 30, "block"))).toBe("pass");
    expect(s(gateRecall(20, 30, "block"))).toBe("fail");
    expect(s(gateRecall(18, 30, "warn"))).toBe("pass");
    expect(s(gateRecall(17, 30, "warn"))).toBe("fail");
    expect(s(gateRecall(0, 30, "info"))).toBe("ungated");
  });

  it("baseline: more than 5 points fails, exactly 5 passes, an improvement passes, null baseline is not compared", () => {
    const at = (value: number): MetricResult => gatePrecision(Math.round(value * 100), 100, 100, "info");
    expect(compareToBaseline("r", { precision: 0.95, fp_rate: null }, at(0.9)).ok).toBe(true);
    expect(compareToBaseline("r", { precision: 0.96, fp_rate: null }, at(0.9)).ok).toBe(false);
    expect(compareToBaseline("r", { precision: 0.8, fp_rate: null }, at(0.9)).ok).toBe(true);
    expect(compareToBaseline("r", { precision: null, fp_rate: null }, at(0.1)).ok).toBe(true);
    expect(compareToBaseline("r", undefined, at(0.1)).ok).toBe(true);
    expect(compareToBaseline("r", { precision: 0.5, fp_rate: null }, gatePrecision(0, 0, 0, "info")).ok).toBe(false);
  });

  it("percentile is nearest-rank; overlap needs a shared unit; confirmation needs half of the finding", () => {
    expect(percentile([5, 1, 3, 2, 4], 0.95)).toBe(5);
    expect(percentile([5, 1, 3, 2, 4], 0.5)).toBe(3);
    expect(spansOverlap({ start: 0, end: 5 }, { start: 5, end: 9 })).toBe(false);
    expect(spansOverlap({ start: 0, end: 6 }, { start: 5, end: 9 })).toBe(true);
    expect(confirms({ start: 10, end: 20 }, { start: 15, end: 40 })).toBe(true); // 5 of 10
    expect(confirms({ start: 10, end: 20 }, { start: 16, end: 40 })).toBe(false); // 4 of 10
    expect(confirms({ start: 10, end: 20 }, { start: 0, end: 100 })).toBe(true);
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
