// The measurements behind `pnpm eval:rules` (docs/10 "Per-rule metrics and budgets", "Regression harness").
//
// Definitional choices that docs/10 leaves open are numbered D1.. in the comments below and listed in
// eval/corpora/README.md.
import {
  bundledPackSources,
  bundledProfileSources,
  BUNDLED_PROFILE_YAML,
  effectiveRule,
  resolveProfile,
  type ResolvedProfile,
  type RulePack,
} from "@prosegate/profiles";
import { compilePack, reviewRulesDetailed, type CompiledPack, type DetailedReview } from "@prosegate/engine";
import type { Category, Finding, ReviewRequest } from "@prosegate/schema";
import { analyse } from "@prosegate/segmenter";
import { HarnessError, isCorpusRef, readExampleRef, type Corpora, type CorpusDoc } from "./rules-corpus.js";
import {
  LATENCY_DOC_WORDS,
  LATENCY_GATE_MS,
  LATENCY_MIN_DOCS,
  LATENCY_TARGET_MS,
  gateFalsePositive,
  gatePrecision,
  gateRecall,
  median,
  percentile,
  spansOverlap,
  strictest,
  type MetricResult,
  type Severity,
} from "./rules-gates.js";
import { realisticDoc } from "./rules-perf-doc.js";

export interface LoadedPack {
  parsed: RulePack;
  compiled: CompiledPack;
  /** `bundled` or the path given to --pack. */
  source: string;
}

export interface ExampleReport {
  hit: { pass: number; total: number };
  miss: { pass: number; total: number };
  status: "pass" | "fail";
  failures: string[];
}

export interface FpReport extends MetricResult {
  hit_docs: number;
  by_profile: Record<string, { docs: number; hit_docs: number }>;
}

export interface PrecisionReport extends MetricResult {
  hits: number;
  confirmed: number;
}

export interface RuleReport {
  id: string;
  category: Category;
  /** The pack severity: what docs/10 gates on. */
  severity: Severity;
  /** Effective severity per bundled profile; `disabled` when the profile switches the rule off. */
  effective_severity: Record<string, Severity | "disabled">;
  severity_differs_by_profile: boolean;
  example: ExampleReport;
  false_positive: FpReport;
  precision: PrecisionReport;
  /** Informational: how often the rule fires on the adversarial corpora. Not gated. */
  adversarial: {
    human_machinelike: { docs: number; hit_docs: number };
    ai_passed: { docs: number; hit_docs: number };
  };
  /** p95 over the latency sample of this rule's own wall time, ms. */
  latency_p95_ms: number | null;
}

export interface CategoryReport {
  category: Category;
  /** Strictest pack severity among the category's rules in this pack. */
  severity: Severity;
  rules: string[];
  recall: MetricResult & { caught: number; spans: number };
}

export interface LatencyReport {
  source: "ai-corpus" | "engine-fixture";
  documents: number;
  words: number;
  samples: number;
  p50_ms: number;
  p95_ms: number;
  max_ms: number;
  gate_ms: number;
  target_ms: number;
  status: "pass" | "fail";
  meets_target: boolean;
  note: string;
}

export interface PackReport {
  id: string;
  version: string;
  source: string;
  rules: RuleReport[];
  categories: CategoryReport[];
  examples: { pass: number; total: number; rules_pass: number; rules_total: number; status: "pass" | "fail" };
  latency: LatencyReport;
  skipped_below_floor: { human_control: number; ai: number };
}

export interface GateFailure {
  scope: "rule" | "category" | "pack" | "baseline";
  id: string;
  metric: "example" | "false_positive" | "precision" | "recall" | "latency" | "baseline";
  message: string;
}

export interface EvalInput {
  packs: LoadedPack[];
  corpora: Corpora;
  ruleExamplesDir: string;
  /** Test hook: the clock handed to the engine (default performance.now). */
  clock?: (() => number) | undefined;
}

export interface EvalMeasurements {
  packs: PackReport[];
  failures: GateFailure[];
  notes: string[];
  corpora: {
    human_control: { docs: number; by_profile: Record<string, number> };
    ai: { docs: number; gold_spans: number; gold_spans_in_rule_categories: number; by_profile: Record<string, number> };
    adversarial: { human_machinelike: number; ai_passed: number };
  };
}

// ---- profiles ----------------------------------------------------------------------------------------

const SOURCES = { profiles: bundledProfileSources(), packs: bundledPackSources() };

export const BUNDLED_PROFILE_NAMES: string[] = Object.keys(BUNDLED_PROFILE_YAML)
  .filter((id) => id.startsWith("local/"))
  .map((id) => id.slice("local/".length))
  .sort();

function pinPack(resolved: ResolvedProfile, pack: LoadedPack): ResolvedProfile {
  if (resolved.packs.some((p) => p.id === pack.parsed.id)) return resolved;
  // D2: a pack no bundled profile pins (a --pack under test) is added to every profile, so its rules
  // run under that profile's overrides. Packs are always evaluated alone (D3), so this changes nothing
  // for the packs the profiles do pin.
  const entry = { id: pack.parsed.id, range: pack.parsed.version, version: pack.parsed.version, pinned_by: resolved.id, signed: false, origin: "bundled" as const };
  return { ...resolved, packs: [...resolved.packs, entry].sort((a, b) => (a.id < b.id ? -1 : 1)) };
}

class ProfileCache {
  private readonly resolved = new Map<string, ResolvedProfile>();
  private readonly effective = new Map<string, ReturnType<typeof effectiveRule>>();

  /** The real profile, floors included. */
  profile(name: string, pack: LoadedPack): ResolvedProfile {
    const key = `${name}|${pack.parsed.id}`;
    let r = this.resolved.get(key);
    if (r === undefined) {
      r = pinPack(resolveProfile(`local/${name}`, SOURCES), pack);
      this.resolved.set(key, r);
    }
    return r;
  }

  rule(name: string, pack: LoadedPack, rule: RulePack["rules"][number]): ReturnType<typeof effectiveRule> {
    const key = `${name}|${rule.id}`;
    let e = this.effective.get(key);
    if (e === undefined) {
      e = effectiveRule(this.profile(name, pack), rule);
      this.effective.set(key, e);
    }
    return e;
  }
}

function request(text: string): ReviewRequest {
  return {
    schema: "prosegate.review/1",
    text,
    context: { user_message: "", style_constraints: "", mode: "interactive" },
    profile_id: "local/base",
    pass: 1,
    stages: ["rules"],
    session_id: "eval",
    turn_id: "eval",
    prior_findings: [],
  };
}

function review(pack: LoadedPack, resolved: ResolvedProfile, text: string, clock: (() => number) | undefined): DetailedReview {
  return reviewRulesDetailed({ request: request(text), resolved, packs: [pack.compiled], enforce: true, now: clock });
}

// ---- loading packs -----------------------------------------------------------------------------------

export function loadPack(parsed: RulePack, source: string): LoadedPack {
  try {
    return { parsed, compiled: compilePack(parsed), source };
  } catch (e) {
    throw new HarnessError(`pack ${parsed.id}@${parsed.version} (${source}) does not compile: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// ---- the run -----------------------------------------------------------------------------------------

interface RuleAcc {
  fpDocs: number;
  fpHitDocs: number;
  fpBy: Record<string, { docs: number; hit_docs: number }>;
  aiDocs: number;
  hits: number;
  confirmed: number;
  advHuman: { docs: number; hit_docs: number };
  advAi: { docs: number; hit_docs: number };
  ms: number[];
}

function newAcc(): RuleAcc {
  return { fpDocs: 0, fpHitDocs: 0, fpBy: {}, aiDocs: 0, hits: 0, confirmed: 0, advHuman: { docs: 0, hit_docs: 0 }, advAi: { docs: 0, hit_docs: 0 }, ms: [] };
}

function evaluateExamples(pack: LoadedPack, ruleExamplesDir: string, clock: (() => number) | undefined): Map<string, ExampleReport> {
  // Same semantics as packages/engine/test/examples.test.ts: each example is a standalone document, the
  // token floor is bypassed, the profile is local/base, and only this pack runs. A hit must produce a
  // finding of the rule (any severity); a miss must produce none.
  const base = new ProfileCache().profile("base", pack);
  const standalone: ResolvedProfile = { ...base, thresholds: { ...base.thresholds, token_floor_words: 0 } };
  const out = new Map<string, ExampleReport>();
  for (const rule of pack.parsed.rules) {
    const fires = (example: string): boolean => {
      const text = isCorpusRef(example) ? readExampleRef(example, ruleExamplesDir) : example;
      return review(pack, standalone, text, clock).diagnostics.all_findings.some((f) => f.rule_id === rule.id);
    };
    const rep: ExampleReport = { hit: { pass: 0, total: rule.examples.hit.length }, miss: { pass: 0, total: rule.examples.miss.length }, status: "pass", failures: [] };
    for (const ex of rule.examples.hit) {
      if (fires(ex)) rep.hit.pass++;
      else rep.failures.push(`hit example does not fire: ${ex.slice(0, 70)}`);
    }
    for (const ex of rule.examples.miss) {
      if (!fires(ex)) rep.miss.pass++;
      else rep.failures.push(`miss example fires: ${ex.slice(0, 70)}`);
    }
    if (rep.failures.length > 0) rep.status = "fail";
    out.set(rule.id, rep);
  }
  return out;
}

function proseWords(text: string): number {
  return analyse(text).prose_words;
}

function measureLatency(pack: LoadedPack, corpora: Corpora, cache: ProfileCache, clock: (() => number) | undefined, rulesMs: Map<string, number[]>): LatencyReport {
  // D7: warm latency (ADR-10). Each sample is stats.rules_latency_ms, the pack's total rule time, from
  // a review whose pack and segmenter paths have already run. Real floors, the document's own profile.
  const long = corpora.ai.filter((d) => proseWords(d.text) >= LATENCY_DOC_WORDS);
  const gather = (r: DetailedReview): void => {
    for (const [id, ms] of Object.entries(r.diagnostics.per_rule_ms)) {
      const list = rulesMs.get(id) ?? [];
      list.push(ms);
      rulesMs.set(id, list);
    }
  };
  let source: LatencyReport["source"];
  let samples: number[];
  let documents: number;
  let words: number;
  let note: string;
  if (long.length >= LATENCY_MIN_DOCS) {
    source = "ai-corpus";
    documents = long.length;
    words = Math.round(median(long.map((d) => proseWords(d.text))));
    note = `${long.length} AI-corpus documents of at least ${LATENCY_DOC_WORDS} words; per document the median of 5 warm runs after 2 warm-ups`;
    samples = long.map((d) => {
      const resolved = cache.profile(d.profile, pack);
      for (let i = 0; i < 2; i++) review(pack, resolved, d.text, clock);
      const runs: number[] = [];
      for (let i = 0; i < 5; i++) {
        const r = review(pack, resolved, d.text, clock);
        gather(r);
        runs.push(r.result.stats.rules_latency_ms);
      }
      return median(runs);
    });
  } else {
    source = "engine-fixture";
    const doc = realisticDoc(LATENCY_DOC_WORDS);
    documents = 1;
    words = proseWords(doc);
    note = `fallback: ${long.length} AI-corpus documents of at least ${LATENCY_DOC_WORDS} words (need ${LATENCY_MIN_DOCS}); measured on the engine's 2,000-word perf fixture (realisticDoc, seed 7) under local/base: 20 warm-ups, then 5 trials of 25 runs, the trial with the median p95`;
    const resolved = cache.profile("base", pack);
    for (let i = 0; i < 20; i++) review(pack, resolved, doc, clock);
    const trials: number[][] = [];
    for (let t = 0; t < 5; t++) {
      const ts: number[] = [];
      for (let i = 0; i < 25; i++) {
        const r = review(pack, resolved, doc, clock);
        gather(r);
        ts.push(r.result.stats.rules_latency_ms);
      }
      trials.push(ts);
    }
    trials.sort((a, b) => percentile(a, 0.95) - percentile(b, 0.95));
    samples = trials[2] as number[];
  }
  const p95 = percentile(samples, 0.95);
  return {
    source,
    documents,
    words,
    samples: samples.length,
    p50_ms: percentile(samples, 0.5),
    p95_ms: p95,
    max_ms: Math.max(...samples),
    gate_ms: LATENCY_GATE_MS,
    target_ms: LATENCY_TARGET_MS,
    status: p95 <= LATENCY_GATE_MS ? "pass" : "fail",
    meets_target: p95 <= LATENCY_TARGET_MS,
    note,
  };
}

export function measure(input: EvalInput): EvalMeasurements {
  const { corpora, ruleExamplesDir, clock } = input;
  const failures: GateFailure[] = [];
  const notes: string[] = [];
  const packs: PackReport[] = [];

  const goldSpans = corpora.ai.flatMap((d) => d.gold);
  const ruleCategories = new Set<string>(input.packs.flatMap((p) => p.parsed.rules.map((r) => r.category)));

  for (const pack of input.packs) {
    const cache = new ProfileCache();
    const examples = evaluateExamples(pack, ruleExamplesDir, clock);
    const acc = new Map<string, RuleAcc>(pack.parsed.rules.map((r) => [r.id, newAcc()]));
    const catRules = new Map<Category, RulePack["rules"][number][]>();
    for (const r of pack.parsed.rules) catRules.set(r.category, [...(catRules.get(r.category) ?? []), r]);
    const recall = new Map<Category, { caught: number; spans: number }>([...catRules.keys()].map((c) => [c, { caught: 0, spans: 0 }]));
    const skipped = { human_control: 0, ai: 0 };

    const ran = (d: CorpusDoc): { r: DetailedReview; findings: Finding[]; skipped: boolean } => {
      const r = review(pack, cache.profile(d.profile, pack), d.text, clock);
      return { r, findings: r.diagnostics.all_findings, skipped: r.result.verdict === "skipped" };
    };
    // A rule "ran" on a document when the document reached the rule stage, the profile has the rule on,
    // and the rule finished inside the budget.
    const ruleRan = (d: CorpusDoc, r: DetailedReview, rule: RulePack["rules"][number]): boolean =>
      cache.rule(d.profile, pack, rule).enabled && !r.diagnostics.rules_unfinished.includes(rule.id);

    // D4 (false positives): a human-control document counts for a rule when it reached the rule stage
    // (not skipped below the floor or as non-prose) and the rule was enabled and finished. Skipped
    // documents are counted in `skipped_below_floor` and left out of the denominator: they say nothing
    // about the rule. The hit test is "at least one finding of the rule in all_findings", info included,
    // after overlap resolution (a finding another rule outranks is not a finding the user would see).
    for (const d of corpora.humanControl) {
      const { r, findings, skipped: skip } = ran(d);
      if (skip) {
        skipped.human_control++;
        continue;
      }
      for (const rule of pack.parsed.rules) {
        if (!ruleRan(d, r, rule)) continue;
        const a = acc.get(rule.id) as RuleAcc;
        const hit = findings.some((f) => f.rule_id === rule.id);
        a.fpDocs++;
        if (hit) a.fpHitDocs++;
        const bp = (a.fpBy[d.profile] ??= { docs: 0, hit_docs: 0 });
        bp.docs++;
        if (hit) bp.hit_docs++;
      }
    }

    // D5 (precision and recall). A finding is confirmed when a gold span overlaps it (at least one shared
    // UTF-16 unit) and either carries the finding's rule_id, or carries no rule_id and the finding's
    // category. A gold span naming another rule never confirms. Hits are findings (not documents), info
    // included. D6 (recall): a gold span is caught when any finding of its category overlaps it; the
    // rule_id of the gold span is ignored, the finding may come from any rule of the category in this pack.
    // Gold spans in skipped documents count as missed, since the product would not lint those documents.
    for (const d of corpora.ai) {
      const { r, findings, skipped: skip } = ran(d);
      if (skip) skipped.ai++;
      for (const g of d.gold) {
        const rc = recall.get(g.category);
        if (rc === undefined) continue;
        rc.spans++;
        if (findings.some((f) => f.category === g.category && spansOverlap(f.span, g))) rc.caught++;
      }
      if (skip) continue;
      for (const rule of pack.parsed.rules) {
        if (!ruleRan(d, r, rule)) continue;
        const a = acc.get(rule.id) as RuleAcc;
        a.aiDocs++;
        for (const f of findings) {
          if (f.rule_id !== rule.id) continue;
          a.hits++;
          const confirmed = d.gold.some((g) => (g.rule_id === undefined ? g.category === f.category : g.rule_id === f.rule_id) && spansOverlap(f.span, g));
          if (confirmed) a.confirmed++;
        }
      }
    }

    for (const [docs, field] of [[corpora.advHumanMachinelike, "advHuman"], [corpora.advAiPassed, "advAi"]] as const) {
      for (const d of docs) {
        const { r, findings, skipped: skip } = ran(d);
        if (skip) continue;
        for (const rule of pack.parsed.rules) {
          if (!ruleRan(d, r, rule)) continue;
          const a = acc.get(rule.id) as RuleAcc;
          a[field].docs++;
          if (findings.some((f) => f.rule_id === rule.id)) a[field].hit_docs++;
        }
      }
    }

    const rulesMs = new Map<string, number[]>();
    const latency = measureLatency(pack, corpora, cache, clock, rulesMs);
    if (latency.status === "fail") {
      failures.push({ scope: "pack", id: pack.parsed.id, metric: "latency", message: `${pack.parsed.id}: rules_latency_ms p95 ${latency.p95_ms.toFixed(1)} ms exceeds the ${LATENCY_GATE_MS} ms gate (${latency.source})` });
    }

    const rules: RuleReport[] = pack.parsed.rules.map((rule) => {
      const a = acc.get(rule.id) as RuleAcc;
      const ex = examples.get(rule.id) as ExampleReport;
      const effective: Record<string, Severity | "disabled"> = {};
      for (const name of BUNDLED_PROFILE_NAMES) {
        const e = cache.rule(name, pack, rule);
        effective[name] = e.enabled ? e.severity : "disabled";
      }
      // The gate uses the pack severity (D1): docs/10 gates the rule as published, so a profile that
      // softens it cannot launder a rule over budget.
      const fp = gateFalsePositive(a.fpHitDocs, a.fpDocs, rule.severity);
      const precision = gatePrecision(a.confirmed, a.hits, a.aiDocs, rule.severity);
      const ms = rulesMs.get(rule.id);
      if (ex.status === "fail") {
        failures.push({ scope: "rule", id: rule.id, metric: "example", message: `${rule.id}: ${ex.hit.total - ex.hit.pass} hit and ${ex.miss.total - ex.miss.pass} miss examples fail (${ex.failures.join("; ")})` });
      }
      if (fp.status === "fail") {
        failures.push({ scope: "rule", id: rule.id, metric: "false_positive", message: `${rule.id}: false-positive rate ${a.fpHitDocs}/${a.fpDocs} = ${((a.fpHitDocs / a.fpDocs) * 100).toFixed(1)}% exceeds the ${fp.budget?.pct}% budget for ${rule.severity} (a rule over budget is pulled from the pack, not softened)` });
      }
      if (precision.status === "fail") {
        failures.push({ scope: "rule", id: rule.id, metric: "precision", message: `${rule.id}: precision ${a.confirmed}/${a.hits} = ${((a.confirmed / a.hits) * 100).toFixed(1)}% is under the ${precision.budget?.pct}% floor for ${rule.severity}` });
      }
      return {
        id: rule.id,
        category: rule.category,
        severity: rule.severity,
        effective_severity: effective,
        severity_differs_by_profile: Object.values(effective).some((s) => s !== rule.severity),
        example: ex,
        false_positive: { ...fp, hit_docs: a.fpHitDocs, by_profile: a.fpBy },
        precision: { ...precision, hits: a.hits, confirmed: a.confirmed },
        adversarial: { human_machinelike: a.advHuman, ai_passed: a.advAi },
        latency_p95_ms: ms === undefined ? null : percentile(ms, 0.95),
      };
    });

    // D6: a category is judged by the strictest pack severity of its rules.
    const categories: CategoryReport[] = [...catRules.entries()].map(([category, rs]) => {
      const severity = strictest(rs.map((r) => r.severity));
      const t = recall.get(category) as { caught: number; spans: number };
      const metric = gateRecall(t.caught, t.spans, severity);
      if (metric.status === "fail") {
        failures.push({ scope: "category", id: `${pack.parsed.id}:${category}`, metric: "recall", message: `category ${category} (${pack.parsed.id}, strictest severity ${severity}): recall ${t.caught}/${t.spans} = ${((t.caught / t.spans) * 100).toFixed(1)}% is under the ${metric.budget?.pct}% floor` });
      }
      return { category, severity, rules: rs.map((r) => r.id), recall: { ...metric, caught: t.caught, spans: t.spans } };
    });

    const exPass = rules.reduce((n, r) => n + r.example.hit.pass + r.example.miss.pass, 0);
    const exTotal = rules.reduce((n, r) => n + r.example.hit.total + r.example.miss.total, 0);
    packs.push({
      id: pack.parsed.id,
      version: pack.parsed.version,
      source: pack.source,
      rules,
      categories,
      examples: { pass: exPass, total: exTotal, rules_pass: rules.filter((r) => r.example.status === "pass").length, rules_total: rules.length, status: exPass === exTotal ? "pass" : "fail" },
      latency,
      skipped_below_floor: skipped,
    });
  }

  const skippedHuman = packs[0]?.skipped_below_floor.human_control ?? 0;
  const skippedAi = packs[0]?.skipped_below_floor.ai ?? 0;
  if (skippedHuman > 0) notes.push(`${skippedHuman} human-control documents were skipped by the profile's token floor or as non-prose; they are left out of every false-positive denominator`);
  if (skippedAi > 0) notes.push(`${skippedAi} AI documents were skipped by the profile's token floor or as non-prose; their gold spans count as missed`);
  const byProfile = (docs: CorpusDoc[]): Record<string, number> => {
    const m: Record<string, number> = {};
    for (const d of docs) m[d.profile] = (m[d.profile] ?? 0) + 1;
    return m;
  };
  return {
    packs,
    failures,
    notes,
    corpora: {
      human_control: { docs: corpora.humanControl.length, by_profile: byProfile(corpora.humanControl) },
      ai: {
        docs: corpora.ai.length,
        gold_spans: goldSpans.length,
        gold_spans_in_rule_categories: goldSpans.filter((g) => ruleCategories.has(g.category)).length,
        by_profile: byProfile(corpora.ai),
      },
      adversarial: { human_machinelike: corpora.advHumanMachinelike.length, ai_passed: corpora.advAiPassed.length },
    },
  };
}

