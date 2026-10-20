import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { z } from "zod";
import { REVIEWER_MODEL_BY_PROVIDER } from "@prosegate/schema";
import { HarnessError } from "./rules-corpus.js";
import { args, cliError, json, report, required } from "../src/common.js";
import { corpusAudit } from "../src/corpus.js";
import { GenerationPlan, generate } from "../src/generate.js";
import { ModelSchema, Spend } from "../src/provider.js";
import { evaluateReviewer } from "../src/reviewer-eval.js";
import { evaluateE2e, scoreE2e } from "../src/e2e.js";
import { importCorpus } from "../src/import.js";

async function main() {
  const command = process.argv[2];
  const o = args(process.argv.slice(3), ["corpora", "reports", "plan", "output", "cap-usd", "models", "model", "judge", "seed", "sample-per-profile", "score", "human", "require-pass", "source", "private"]);
  if (o.help) {
    console.log(`Evaluation commands:
  pnpm eval:corpus [--corpora dir] [--require-pass true]
  pnpm eval:generate --plan plan.json --output NEW-staging-dir --cap-usd N
  pnpm eval:import --source staging-dir --corpora corpus-dir [--private true]
  pnpm eval:reviewer --models prices.json --model EXACT-ID --cap-usd N [--corpora dir]
  pnpm eval:e2e --models prices.json --model EXACT-ID|all --judge EXACT-ID --cap-usd N
    [--seed text] [--sample-per-profile 50|all] [--corpora dir]
  pnpm eval:e2e --score previous-report.json --human judgements.json
  pnpm eval:release --models prices.json --model all --judge EXACT-ID --cap-usd N
Reports default to eval/reports. API keys come only from OPENAI_API_KEY / ANTHROPIC_API_KEY.
Live commands require current, explicitly supplied pricing. No calls are made by --help or eval:corpus.`);
    return;
  }
  const root = resolve(o.corpora ?? "eval/corpora");
  const reports = resolve(o.reports ?? "eval/reports");
  let result: { result: string; [key: string]: unknown };
  if (command === "corpus") result = corpusAudit(root, o.private === "true");
  else if (command === "import") result = importCorpus(resolve(required(o, "source")), root, o.private === "true");
  else if (command === "e2e" && o.score) {
    const previous = z.object({ evidence: z.unknown().optional(), e2e: z.object({ evidence: z.unknown() }).optional() }).parse(json(o.score));
    const evidence = previous.evidence ?? previous.e2e?.evidence;
    result = { ...scoreE2e(evidence, json(required(o, "human"))), evidence };
  } else if (command === "generate") {
    const plan = GenerationPlan.parse(json(required(o, "plan")));
    const spend = new Spend(Number(required(o, "cap-usd")), plan.models, resolve(reports, `spend-${randomUUID()}.jsonl`));
    result = await generate(plan, resolve(required(o, "output")), spend);
  } else if (command === "reviewer" || command === "e2e" || command === "release") {
    const models = z.array(ModelSchema).min(1).parse(json(required(o, "models")));
    const id = required(o, "model");
    const model = models.find((m) => m.id === id);
    const writers = id === "all" && command !== "reviewer" ? models : model;
    const judge = command !== "reviewer" ? models.find((m) => m.id === required(o, "judge")) : model;
    if (!writers || !judge) throw new HarnessError("Requested model is missing from the pricing manifest.");
    const spend = new Spend(Number(required(o, "cap-usd")), models, resolve(reports, `spend-${randomUUID()}.jsonl`));
    const sample = o["sample-per-profile"] === "all" ? Number.MAX_SAFE_INTEGER : Number(o["sample-per-profile"] ?? 50);
    if (!Number.isSafeInteger(sample) || sample < 1) throw new HarnessError("Sample size must be a positive integer or 'all'.");
    if (command === "release") {
      const candidates = Object.values(REVIEWER_MODEL_BY_PROVIDER).map((candidate) => models.find((m) => m.id === candidate));
      if (candidates.some((m) => !m)) throw new HarnessError("A release evaluation must price both production reviewer candidates.");
      const reviewers = [];
      for (const candidate of candidates) if (candidate) reviewers.push(await evaluateReviewer(root, candidate, spend));
      const e2e = await evaluateE2e(root, writers, judge, spend, o.seed ?? "prosegate-e2e-v1", Number.MAX_SAFE_INTEGER);
      const states = [...reviewers.map((r) => r.result), e2e.result];
      result = { result: states.includes("fail") ? "fail" : states.every((s) => s === "pass") ? "pass" : "partial", reviewers, e2e, spend: spend.summary() };
    } else if (command === "reviewer") {
      if (!model) throw new HarnessError("Reviewer evaluation needs one exact model ID.");
      result = await evaluateReviewer(root, model, spend);
    } else result = await evaluateE2e(root, writers, judge, spend, o.seed ?? "prosegate-e2e-v1", sample);
  } else throw new HarnessError("Unknown evaluation command.");
  const path = report(reports, command as string, result);
  console.log(`${command}: ${result.result.toUpperCase()}\nReport: ${path}`);
  if (result.result === "fail" || (o["require-pass"] === "true" && result.result !== "pass")) process.exitCode = 1;
}
main().catch(cliError);
