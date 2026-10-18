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
import { compilePack, reviewRulesDetailed, type CompiledPack, type DetailedReview, type ReviewRulesInput } from "@prosegate/engine";
import type { Category, Finding, ReviewRequest } from "@prosegate/schema";
import { analyse } from "@prosegate/segmenter";
import { HarnessError, isCorpusRef, readExampleRef, type Corpora, type CorpusDoc } from "./rules-corpus.js";
import {
  LATENCY_DOC_WORDS,
  LATENCY_GATE_MS,
  LATENCY_MIN_DOCS,
  LATENCY_TARGET_MS,
  confirms,
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

export interface FpProfileReport extends MetricResult {
  hit_docs: number;
  /** The rule's effective severity in this profile: the severity its per-profile gate uses. */
  effective_severity: Severity;
}

export interface FpReport extends MetricResult {
  hit_docs: number;
  /** The severity the pooled gate used: the strictest effective severity across the bundled profiles. */
  gate_severity: Severity;
  /** Documents on which the rule did not finish inside the engine's budget. Any non-zero count fails the rule. */
  unfinished_docs: number;
  /** Per profile that has human-control documents; gated at the profile's effective severity from 30 documents. */
  by_profile: Record<string, FpProfileReport>;
}

export interface PrecisionReport extends MetricResult {
  hits: number;
  confirmed: number;
  /** Of `confirmed`: confirmations by a gold span with no rule_id, matched on category alone. */
  confirmed_by_category: number;
}

export interface RuleReport {
  id: string;
  category: Category;
  /** The severity the pack publishes. */
  severity: Severity;
  /** The strictest effective severity in any bundled profile: what the gates use (D1). */
  gate_severity: Severity;
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
  /** Strictest gate severity among the category's rules in this pack. */
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
  /** Findings the engine dropped on its own span self-check. Expected 0; non-zero fails the pack. */
  invalid_findings_dropped: number;
}

export interface GateFailure {
  scope: "rule" | "category" | "pack" | "baseline";
  id: string;
  metric: "example" | "false_positive" | "precision" | "recall" | "latency" | "baseline" | "unfinished" | "engine_drops";
  message: string;
}

export type FpSource = "raw_candidates" | "post_overlap";

/** The engine entry point; tests inject a wrapper to simulate engine diagnostics. */
export type ReviewFn = (input: ReviewRulesInput) => DetailedReview;

export interface EvalInput {
  packs: LoadedPack[];
  corpora: Corpora;
  ruleExamplesDir: string;
  /** Test hook: the clock handed to the engine (default performance.now). */
  clock?: (() => number) | undefined;
  /** Test hook: replaces reviewRulesDetailed. */
  review?: ReviewFn | undefined;
}

export interface EvalMeasurements {
  packs: PackReport[];
  failures: GateFailure[];
  notes: string[];
  /** Where the false-positive hits came from: the engine's raw candidates, or (until it offers them) the post-overlap findings. */
  fp_source: FpSource;
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

// ---- engine access -----------------------------------------------------------------------------------

interface Env {
  clock: (() => number) | undefined;
  reviewFn: ReviewFn;
  /** Findings the engine dropped on its span self-check, summed over every review of the current pack. */
  dropped: number;
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

function review(env: Env, pack: LoadedPack, resolved: ResolvedProfile, text: string): DetailedReview {
  const r = env.reviewFn({ request: request(text), resolved, packs: [pack.compiled], enforce: true, now: env.clock });
  env.dropped += r.diagnostics.invalid_findings_dropped;
  return r;
}

/**
 * One raw rule match, as the engine will emit it in `diagnostics.candidates`: before overlap resolution
 * and before caps, at the rule's effective severity under the resolved profile, info included, sorted by
 * start then rule_id. A local copy of the engine's `RuleCandidate` type until the engine exports it; swap
 * this for the import then.
 */
export interface RuleCandidate {
  rule_id: string;
  category: Category;
  severity: Severity;
  start: number;
  end: number;
  scope: "span" | "document";
}

/**
 * The rule ids with at least one raw hit in a review (docs/10: "documents with at least one hit"). When
 * the engine supplies `diagnostics.candidates` they are read (source `raw_candidates`); until then the
 * post-overlap `all_findings` stand in and the report says `fp_source: post_overlap`. This is the one
 * place that changes when the engine lands it. A `candidates` value of any other shape is a harness error.
 */
export function rawHitRules(d: DetailedReview): { rules: Set<string>; source: FpSource } {
  const candidates = (d.diagnostics as unknown as { candidates?: unknown }).candidates;
  if (candidates === undefined) {
    return { rules: new Set(d.diagnostics.all_findings.map((f) => f.rule_id ?? "")), source: "post_overlap" };
  }
  if (!Array.isArray(candidates)) throw new HarnessError("diagnostics.candidates must be an array of RuleCandidate");
  const rules = new Set<string>();
  for (const c of candidates as Array<Partial<RuleCandidate> | null>) {
    if (c === null || typeof c !== "object" || typeof c.rule_id !== "string") throw new HarnessError("diagnostics.candidates holds an entry without a string rule_id");
    rules.add(c.rule_id);
  }
  return { rules, source: "raw_candidates" };
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
  unfinished: number;
  aiDocs: number;
  hits: number;
  confirmed: number;
  confirmedByCategory: number;
  advHuman: { docs: number; hit_docs: number };
  advAi: { docs: number; hit_docs: number };
}

function newAcc(): RuleAcc {
  return { fpDocs: 0, fpHitDocs: 0, fpBy: {}, unfinished: 0, aiDocs: 0, hits: 0, confirmed: 0, confirmedByCategory: 0, advHuman: { docs: 0, hit_docs: 0 }, advAi: { docs: 0, hit_docs: 0 } };
}

function evaluateExamples(env: Env, pack: LoadedPack, ruleExamplesDir: string): Map<string, ExampleReport> {
  // Same semantics as packages/engine/test/examples.test.ts: each example is a standalone document, the
  // token floor is bypassed, the profile is local/base, and only this pack runs. A hit must produce a
  // finding of the rule (any severity); a miss must produce none.
  const base = new ProfileCache().profile("base", pack);
  const standalone: ResolvedProfile = { ...base, thresholds: { ...base.thresholds, token_floor_words: 0 } };
  const out = new Map<string, ExampleReport>();
  for (const rule of pack.parsed.rules) {
    const fires = (example: string): boolean => {
      const text = isCorpusRef(example) ? readExampleRef(example, ruleExamplesDir) : example;
      return review(env, pack, standalone, text).diagnostics.all_findings.some((f) => f.rule_id === rule.id);
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

function measureLatency(env: Env, pack: LoadedPack, corpora: Corpora, cache: ProfileCache, rulesMs: Map<string, number[]>): LatencyReport {
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
      for (let i = 0; i < 2; i++) review(env, pack, resolved, d.text);
      const runs: number[] = [];
      for (let i = 0; i < 5; i++) {
        const r = review(env, pack, resolved, d.text);
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
    for (let i = 0; i < 20; i++) review(env, pack, resolved, doc);
    const trials: number[][] = [];
    for (let t = 0; t < 5; t++) {
      const ts: number[] = [];
      for (let i = 0; i < 25; i++) {
        const r = review(env, pack, resolved, doc);
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

const pct1 = (num: number, den: number): string => `${((num / den) * 100).toFixed(1)}%`;

export function measure(input: EvalInput): EvalMeasurements {
  const { corpora, ruleExamplesDir } = input;
  const failures: GateFailure[] = [];
  const notes: string[] = [];
  const packs: PackReport[] = [];
  let postOverlap = false;

  const goldSpans = corpora.ai.flatMap((d) => d.gold);
  const ruleCategories = new Set<string>(input.packs.flatMap((p) => p.parsed.rules.map((r) => r.category)));

  for (const pack of input.packs) {
    const env: Env = { clock: input.clock, reviewFn: input.review ?? reviewRulesDetailed, dropped: 0 };
    const cache = new ProfileCache();
    const examples = evaluateExamples(env, pack, ruleExamplesDir);
    const acc = new Map<string, RuleAcc>(pack.parsed.rules.map((r) => [r.id, newAcc()]));
    const catRules = new Map<Category, RulePack["rules"][number][]>();
    for (const r of pack.parsed.rules) catRules.set(r.category, [...(catRules.get(r.category) ?? []), r]);
    const recall = new Map<Category, { caught: number; spans: number }>([...catRules.keys()].map((c) => [c, { caught: 0, spans: 0 }]));
    const skipped = { human_control: 0, ai: 0 };

    const ran = (d: CorpusDoc): { r: DetailedReview; findings: Finding[]; skipped: boolean } => {
      const r = review(env, pack, cache.profile(d.profile, pack), d.text);
      return { r, findings: r.diagnostics.all_findings, skipped: r.result.verdict === "skipped" };
    };
    // Whether the rule is switched on for the document's profile.
    const enabled = (d: CorpusDoc, rule: RulePack["rules"][number]): boolean => cache.rule(d.profile, pack, rule).enabled;
    // D8: a rule that did not finish on a document must not shrink its own denominator by being slow. Each
    // such document is counted, the document is left out of the rule's measures, and any count fails the rule.
    const finished = (d: CorpusDoc, r: DetailedReview, rule: RulePack["rules"][number]): boolean => {
      if (!r.diagnostics.rules_unfinished.includes(rule.id)) return true;
      (acc.get(rule.id) as RuleAcc).unfinished++;
      return false;
    };

    // D4 (false positives): a human-control document counts for a rule when it reached the rule stage
    // (not skipped below the floor or as non-prose) and the rule was enabled and finished. Skipped
    // documents are counted in `skipped_below_floor` and left out of the denominator: they say nothing
    // about the rule. The hit test is "at least one raw hit of the rule" (any severity, info included):
    // `diagnostics.candidates` when the engine offers it, else the post-overlap `all_findings` (rawHitRules).
    for (const d of corpora.humanControl) {
      const { r, skipped: skip } = ran(d);
      if (skip) {
        skipped.human_control++;
        continue;
      }
      const raw = rawHitRules(r);
      if (raw.source === "post_overlap") postOverlap = true;
      for (const rule of pack.parsed.rules) {
        if (!enabled(d, rule) || !finished(d, r, rule)) continue;
        const a = acc.get(rule.id) as RuleAcc;
        const hit = raw.rules.has(rule.id);
        a.fpDocs++;
        if (hit) a.fpHitDocs++;
        const bp = (a.fpBy[d.profile] ??= { docs: 0, hit_docs: 0 });
        bp.docs++;
        if (hit) bp.hit_docs++;
      }
    }

    // D5 (precision). A finding is confirmed when a gold span covers at least half of the finding's span
    // (UTF-16 units) and either carries the finding's rule_id, or carries no rule_id and the finding's
    // category. A gold span naming another rule never confirms. A confirmation that only a rule_id-less
    // gold span supports is also counted in `confirmed_by_category`. Hits are findings (not documents),
    // info included, after overlap resolution: what the user would see.
    // D6 (recall): a gold span is caught when any finding of its category overlaps it; the rule_id of the
    // gold span is ignored, the finding may come from any rule of the category in this pack. Gold spans in
    // skipped documents count as missed, since the product would not lint those documents.
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
        if (!enabled(d, rule) || !finished(d, r, rule)) continue;
        const a = acc.get(rule.id) as RuleAcc;
        a.aiDocs++;
        for (const f of findings) {
          if (f.rule_id !== rule.id) continue;
          a.hits++;
          const byRule = d.gold.some((g) => g.rule_id === f.rule_id && confirms(f.span, g));
          const byCategory = d.gold.some((g) => g.rule_id === undefined && g.category === f.category && confirms(f.span, g));
          if (byRule || byCategory) a.confirmed++;
          if (!byRule && byCategory) a.confirmedByCategory++;
        }
      }
    }

    for (const [docs, field] of [[corpora.advHumanMachinelike, "advHuman"], [corpora.advAiPassed, "advAi"]] as const) {
      for (const d of docs) {
        const { r, findings, skipped: skip } = ran(d);
        if (skip) continue;
        for (const rule of pack.parsed.rules) {
          if (!enabled(d, rule) || !finished(d, r, rule)) continue;
          const a = acc.get(rule.id) as RuleAcc;
          a[field].docs++;
          if (findings.some((f) => f.rule_id === rule.id)) a[field].hit_docs++;
        }
      }
    }

    const rulesMs = new Map<string, number[]>();
    const latency = measureLatency(env, pack, corpora, cache, rulesMs);
    if (latency.status === "fail") {
      failures.push({ scope: "pack", id: pack.parsed.id, metric: "latency", message: `${pack.parsed.id}: rules_latency_ms p95 ${latency.p95_ms.toFixed(1)} ms exceeds the ${LATENCY_GATE_MS} ms gate (${latency.source})` });
    }
    if (env.dropped > 0) {
      failures.push({ scope: "pack", id: pack.parsed.id, metric: "engine_drops", message: `${pack.parsed.id}: the engine dropped ${env.dropped} finding${env.dropped === 1 ? "" : "s"} on its own span self-check (invalid_findings_dropped; expected 0)` });
    }

    const rules: RuleReport[] = pack.parsed.rules.map((rule) => {
      const a = acc.get(rule.id) as RuleAcc;
      const ex = examples.get(rule.id) as ExampleReport;
      const effective: Record<string, Severity | "disabled"> = {};
      for (const name of BUNDLED_PROFILE_NAMES) {
        const e = cache.rule(name, pack, rule);
        effective[name] = e.enabled ? e.severity : "disabled";
      }
      // D1: the gates use the strictest effective severity the rule has in any bundled profile. Profiles
      // promote rules (email: structure.001 -> block), and a rule that ships as block somewhere must meet
      // the block budget on the pooled corpus. Docs/10 gates the rule as users run it.
      const live = Object.values(effective).filter((s): s is Severity => s !== "disabled");
      const gateSeverity = live.length === 0 ? rule.severity : strictest(live);
      const fp = gateFalsePositive(a.fpHitDocs, a.fpDocs, gateSeverity);
      const precision = gatePrecision(a.confirmed, a.hits, a.aiDocs, gateSeverity);
      const ms = rulesMs.get(rule.id);
      // Per-profile: a profile with at least 30 documents gates at its own effective severity.
      const byProfile: Record<string, FpProfileReport> = {};
      for (const [name, t] of Object.entries(a.fpBy)) {
        const sev = effective[name];
        const profSeverity: Severity = sev === undefined || sev === "disabled" ? rule.severity : sev;
        const m = gateFalsePositive(t.hit_docs, t.docs, profSeverity);
        byProfile[name] = { ...m, hit_docs: t.hit_docs, effective_severity: profSeverity };
        if (m.status === "fail") {
          failures.push({ scope: "rule", id: rule.id, metric: "false_positive", message: `${rule.id} [profile ${name}]: false-positive rate ${t.hit_docs}/${t.docs} = ${pct1(t.hit_docs, t.docs)} exceeds the ${m.budget?.pct}% budget for ${profSeverity}, the rule's severity in ${name}` });
        }
      }
      if (ex.status === "fail") {
        failures.push({ scope: "rule", id: rule.id, metric: "example", message: `${rule.id}: ${ex.hit.total - ex.hit.pass} hit and ${ex.miss.total - ex.miss.pass} miss examples fail (${ex.failures.join("; ")})` });
      }
      if (fp.status === "fail") {
        failures.push({ scope: "rule", id: rule.id, metric: "false_positive", message: `${rule.id}: false-positive rate ${a.fpHitDocs}/${a.fpDocs} = ${pct1(a.fpHitDocs, a.fpDocs)} exceeds the ${fp.budget?.pct}% budget for ${gateSeverity}${gateSeverity === rule.severity ? "" : ` (pack severity ${rule.severity}; a bundled profile promotes it)`}; a rule over budget is pulled from the pack, not softened` });
      }
      if (a.unfinished > 0) {
        failures.push({ scope: "rule", id: rule.id, metric: "unfinished", message: `${rule.id}: rule did not finish on ${a.unfinished} docs (engine budget exceeded); those documents are not counted, so the rule's rates cannot be trusted` });
      }
      if (precision.status === "fail") {
        failures.push({ scope: "rule", id: rule.id, metric: "precision", message: `${rule.id}: precision ${a.confirmed}/${a.hits} = ${pct1(a.confirmed, a.hits)} is under the ${precision.budget?.pct}% floor for ${gateSeverity}` });
      }
      return {
        id: rule.id,
        category: rule.category,
        severity: rule.severity,
        gate_severity: gateSeverity,
        effective_severity: effective,
        severity_differs_by_profile: Object.values(effective).some((s) => s !== rule.severity),
        example: ex,
        false_positive: { ...fp, hit_docs: a.fpHitDocs, gate_severity: gateSeverity, unfinished_docs: a.unfinished, by_profile: byProfile },
        precision: { ...precision, hits: a.hits, confirmed: a.confirmed, confirmed_by_category: a.confirmedByCategory },
        adversarial: { human_machinelike: a.advHuman, ai_passed: a.advAi },
        latency_p95_ms: ms === undefined ? null : percentile(ms, 0.95),
      };
    });

    // D6: a category is judged by the strictest gate severity of its rules.
    const categories: CategoryReport[] = [...catRules.entries()].map(([category, rs]) => {
      const severity = strictest(rs.map((r) => (rules.find((x) => x.id === r.id) as RuleReport).gate_severity));
      const t = recall.get(category) as { caught: number; spans: number };
      const metric = gateRecall(t.caught, t.spans, severity);
      if (metric.status === "fail") {
        failures.push({ scope: "category", id: `${pack.parsed.id}:${category}`, metric: "recall", message: `category ${category} (${pack.parsed.id}, strictest severity ${severity}): recall ${t.caught}/${t.spans} = ${pct1(t.caught, t.spans)} is under the ${metric.budget?.pct}% floor` });
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
      invalid_findings_dropped: env.dropped,
    });
  }

  const skippedHuman = packs[0]?.skipped_below_floor.human_control ?? 0;
  const skippedAi = packs[0]?.skipped_below_floor.ai ?? 0;
  if (skippedHuman > 0) notes.push(`${skippedHuman} human-control documents were skipped by the profile's token floor or as non-prose; they are left out of every false-positive denominator`);
  if (skippedAi > 0) notes.push(`${skippedAi} AI documents were skipped by the profile's token floor or as non-prose; their gold spans count as missed`);
  const fpSource: FpSource = postOverlap ? "post_overlap" : corpora.humanControl.length === 0 ? "post_overlap" : "raw_candidates";
  if (fpSource === "post_overlap") {
    notes.push("fp_source: post_overlap. False positives are counted on the engine's post-overlap findings because diagnostics.candidates is not available yet; a rule whose hit another rule outranks is not counted as a hit.");
  }
  const byProfile = (docs: CorpusDoc[]): Record<string, number> => {
    const m: Record<string, number> = {};
    for (const d of docs) m[d.profile] = (m[d.profile] ?? 0) + 1;
    return m;
  };
  return {
    packs,
    failures,
    notes,
    fp_source: fpSource,
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
