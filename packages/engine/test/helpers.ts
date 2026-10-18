import { bundledPackSources, bundledProfileSources, BUNDLED_PACK_YAML, parseRulePackYaml, resolveProfile, type ResolvedProfile, type RulePack } from "@prosegate/profiles";
import { ReviewResultSchema, type ReviewRequest, type ReviewResult } from "@prosegate/schema";
import { compilePack, reviewRulesDetailed, type CompiledPack, type DetailedReview } from "../src/index.js";

export const sources = { profiles: bundledProfileSources(), packs: bundledPackSources() };

export const CORE: RulePack = (() => {
  const r = parseRulePackYaml(BUNDLED_PACK_YAML["core@0.1.0"]);
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
})();

export const CORE_COMPILED: CompiledPack = compilePack(CORE);

export function profile(id = "local/base", tweak?: (p: ResolvedProfile) => ResolvedProfile): ResolvedProfile {
  const p = resolveProfile(id, sources);
  return tweak === undefined ? p : tweak(p);
}

/** One rule of a test pack as YAML; `match` is a YAML flow mapping such as `{ kind: phrase, phrases: ["x"] }`. */
export function ruleYaml(id: string, match: string, severity: "block" | "warn" | "info" = "warn"): string {
  const category = id.split(".")[1] ?? "filler";
  return [
    `  - id: ${id}`,
    `    category: ${category}`,
    `    severity: ${severity}`,
    `    match: ${match}`,
    `    instruction: { action: remove, text: "Remove it." }`,
    `    examples: { hit: ["x"], miss: ["y"] }`,
  ].join("\n");
}

/** A compiled pack with id `core` (so the bundled profiles pin it) from rule YAML entries. */
export function packOf(...rules: string[]): CompiledPack {
  const yaml = ["schema: prosegate.rulepack/1", "id: core", "version: 0.0.1", "findings_schema: 1", "rules:", ...rules].join("\n");
  const parsed = parseRulePackYaml(yaml);
  if (!parsed.ok) throw new Error(parsed.error.message);
  return compilePack(parsed.value);
}

/** The profile with the token floor at 0 (examples are standalone documents of any length). */
export function noFloor(p: ResolvedProfile): ResolvedProfile {
  return { ...p, thresholds: { ...p.thresholds, token_floor_words: 0 } };
}

export function request(text: string, over: Partial<ReviewRequest> = {}): ReviewRequest {
  return {
    schema: "prosegate.review/1",
    text,
    context: { user_message: "", style_constraints: "", mode: "interactive" },
    profile_id: "local/base",
    pass: 1,
    stages: ["rules"],
    session_id: "sess",
    turn_id: "turn",
    prior_findings: [],
    ...over,
  };
}

export interface RunOptions {
  profile?: ResolvedProfile;
  packs?: CompiledPack[];
  enforce?: boolean;
  capCheck?: boolean;
  /** Keep the profile's own token floor (default: floor bypassed, token_floor_words 0). */
  keepFloor?: boolean;
  pass?: 1 | 2;
  prior?: string[];
  now?: () => number;
  budgetMs?: number;
}

/** Reviews `text` and asserts the result passes the strict ReviewResult schema. */
export function run(text: string, o: RunOptions = {}): DetailedReview {
  const resolved = o.profile ?? profile();
  const detailed = reviewRulesDetailed({
    request: request(text, { pass: o.pass ?? 1, prior_findings: o.prior ?? [] }),
    resolved: o.keepFloor === true ? resolved : noFloor(resolved),
    packs: o.packs ?? [CORE_COMPILED],
    enforce: o.enforce ?? true,
    capCheck: o.capCheck,
    now: o.now,
    budgetMs: o.budgetMs,
  });
  const parsed = ReviewResultSchema.safeParse(detailed.result);
  if (!parsed.success) throw new Error(`result fails ReviewResultSchema: ${JSON.stringify(parsed.error.issues.slice(0, 5))}`);
  return detailed;
}

export function review(text: string, o: RunOptions = {}): ReviewResult {
  return run(text, o).result;
}

/** Findings of every severity (info included) as [rule_id, span text]. */
export function hits(text: string, o: RunOptions = {}): Array<[string, string]> {
  return run(text, o).diagnostics.all_findings.map((f) => [f.rule_id ?? "", f.span.text]);
}
