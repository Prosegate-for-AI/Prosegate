import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { parseArgs } from "node:util";
import { z } from "zod";
import { bundledProfileSources, bundledPackSources, resolveProfile, BUNDLED_PACK_YAML, parseRulePackYaml } from "@prosegate/profiles";
import { compilePack, reviewRulesDetailed } from "@prosegate/engine";
import { reviewDraft, PROMPT_VERSION, SYSTEM_PROMPT } from "@prosegate/reviewer";
import { REVIEWER_MODEL_BY_PROVIDER, findKeyShapedStrings } from "@prosegate/schema";
import { Spend, ModelSchema, apiKey, rawFindings } from "../src/provider.js";
import { writingCases, writingRequest, writingSummary, type WritingRow } from "../src/writing-eval.js";

async function main() {
  const { values } = parseArgs({ options: { live: { type: "boolean" }, model: { type: "string" }, out: { type: "string" }, name: { type: "string" },
    "cap-usd": { type: "string" }, set: { type: "string", default: "all" }, repeat: { type: "string", default: "1" }, "ids-file": { type: "string" } } });
  if (!values.live || !values.model || !values.out || !values.name || !values["cap-usd"]) throw new Error("Required: --live --model PRICING.json --out DIR --name RUN --cap-usd N [--set all|exceptions|holdout|support-actors] [--repeat N]");
  const name = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/).parse(values.name);
  const set = z.enum(["all", "exceptions", "holdout", "support-actors"]).parse(values.set);
  const repeat = z.coerce.number().int().min(1).max(10).parse(values.repeat);
  const cap = z.coerce.number().positive().max(1000).parse(values["cap-usd"]);
  const model = ModelSchema.parse(JSON.parse(readFileSync(values.model, "utf8")) as unknown);
  if (model.id !== REVIEWER_MODEL_BY_PROVIDER[model.provider]) throw new Error("Use the exact production reviewer model.");
  const key = apiKey(model);
  let cases = writingCases(set);
  if (values["ids-file"]) {
    const ids = z.array(z.string()).min(1).parse(JSON.parse(readFileSync(values["ids-file"], "utf8")) as unknown);
    if (ids.some((id) => !cases.some((c) => c.id === id)) || new Set(ids).size !== ids.length) throw new Error("Unknown or duplicate selected case ID");
    cases = cases.filter((c) => ids.includes(c.id));
  }
  const dir = resolve(values.out); mkdirSync(dir, { recursive: true });
  // A shared report directory has one cumulative reservation budget across sequential runs.
  // Fail closed on malformed ledgers. Do not run concurrent writers against this directory.
  const priorReserved = readdirSync(dir).filter((f) => f.endsWith(".ledger.jsonl")).reduce((sum, file) =>
    sum + readFileSync(resolve(dir, file), "utf8").trim().split("\n").reduce((n, line) => {
      const entry = z.object({ event: z.string().optional(), usd: z.number().nonnegative().finite().optional() }).parse(JSON.parse(line) as unknown);
      if (entry.event === "reserve") return n + z.number().nonnegative().finite().parse(entry.usd);
      return n;
    }, 0), 0);
  if (priorReserved >= cap) throw new Error("Cumulative reservation cap reached.");
  const path = resolve(dir, `${name}.json`);
  const p = resolveProfile("local/writing-review", { profiles: bundledProfileSources(), packs: bundledPackSources() });
  const packs = p.packs.map((pin) => {
    const yaml = BUNDLED_PACK_YAML[`${pin.id}@${pin.version}`];
    if (!yaml) throw new Error("Missing bundled pack");
    const pack = parseRulePackYaml(yaml); if (!pack.ok) throw new Error("Invalid bundled pack");
    return compilePack(pack.value);
  });
  writeFileSync(path, "{}\n", { flag: "wx", mode: 0o600 });
  const spend = new Spend(cap - priorReserved, [model], resolve(dir, `${name}.ledger.jsonl`));
  const rows: WritingRow[] = [];
  const started = new Date().toISOString();
  const hash = (text: string) => createHash("sha256").update(text).digest("hex");
  const save = () => writeFileSync(path, JSON.stringify({ started, exploratory: true, prompt_version: PROMPT_VERSION, system_prompt: SYSTEM_PROMPT,
    prompt_hash: hash(SYSTEM_PROMPT), cases_hash: hash(JSON.stringify(cases)), model: model.id, set, repeat,
    planned_cases: cases.length * repeat, prior_reserved_usd: priorReserved, cumulative_cap_usd: cap,
    spend: spend.summary(), summary: writingSummary(rows), rows }, null, 2) + "\n");
  save();
  outer: for (let iteration = 1; iteration <= repeat; iteration++) for (const c of cases) {
    const request = writingRequest(c);
    const local = reviewRulesDetailed({ request, resolved: p, packs, enforce: false });
    if (local.diagnostics.budget_exceeded || local.diagnostics.truncated || local.diagnostics.rules_unfinished.length) throw new Error("Local rule review was incomplete.");
    const start = spend.attempts.length;
    const outcome = await reviewDraft({ request, resolved: p, provider: model.provider, key, fetch: spend.fetch, localFindings: local.result.findings });
    const raw = spend.attempts.slice(start).map((a) => rawFindings(a.response, model.provider));
    const row = { ...c, iteration, request, local: local.result.findings, outcome, raw };
    if (JSON.stringify(row).includes(key) || findKeyShapedStrings(row).length) throw new Error("Refused to persist credential-shaped evaluation output.");
    rows.push(row); save();
    console.log(JSON.stringify({ id: c.id, iteration, expected: c.expected, findings: row.local.length + outcome.findings.length, error: outcome.error, skipped: outcome.skipped }));
    if (outcome.error === "reviewer_http_error" || spend.exhausted) break outer;
  }
  console.log(JSON.stringify({ report: path, summary: writingSummary(rows), spend: spend.summary() }));
  if (rows.length !== cases.length * repeat || rows.some((r) => r.outcome.error || r.outcome.skipped)) process.exitCode = 2;
}
main().catch(() => { console.error("Writing evaluation failed. Check arguments, the pricing file, environment key and report directory. Provider bodies and credentials are not logged."); process.exitCode = 2; });
