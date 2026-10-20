// Trusted CI process only. The API Worker cannot import this module or the engine.
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { z } from "zod";
import { parseRulePackYaml } from "@prosegate/profiles";
import { runEval } from "./rules-run.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const Job = z.strictObject({ id: z.string().uuid(), yaml: z.string().max(262144), content_hash: z.string().regex(/^[a-f0-9]{64}$/), lease_token: z.string().regex(/^[A-Za-z0-9_-]{43}$/) });
export function validatePublication(yaml: string) {
  const parsed = parseRulePackYaml(yaml);
  if (!parsed.ok) throw new Error("invalid_pack");
  const tempRoot = resolve(tmpdir()), temp = mkdtempSync(join(tempRoot, "prosegate-publish-"));
  try {
    const packPath = join(temp, "pack.yaml"); writeFileSync(packPath, yaml);
    const result = runEval({
      repoRoot, corporaDir: join(repoRoot, "eval/corpora"), ruleExamplesDir: join(repoRoot, "eval/corpora/rule-examples"),
      packPaths: [packPath], useBundled: false, bundledPacksDir: join(repoRoot, "packages/profiles/bundled/packs"),
      baselinePath: null, reportsDir: join(temp, "reports"), updateBaseline: false, local: true,
    });
    const pack = result.report?.packs[0];
    const total = parsed.value.rules.reduce((n, r) => n + r.examples.hit.length + r.examples.miss.length, 0);
    return {
      passed: !!pack && pack.examples.status === "pass" && pack.latency.status === "pass" && pack.invalid_findings_dropped === 0,
      examples_pass: pack?.examples.pass ?? 0, examples_total: total,
      latency_p95_ms: pack?.latency.p95_ms ?? 201, engine_version: result.report?.engine.version ?? "unknown",
      failed_rule_ids: pack ? pack.rules.filter((r) => r.example.status !== "pass").map((r) => r.id) : parsed.value.rules.map((r) => r.id),
    };
  } finally {
    // The only recursive removal is the uniquely-created directory within the OS temp root.
    if (resolve(temp).startsWith(tempRoot + sep) && dirname(temp) === tempRoot) rmSync(temp, { recursive: true, force: true });
  }
}
async function main(): Promise<void> {
  if (process.argv.includes("--help")) {
    console.log("pnpm eval:publish-pack — claim and validate one pack using PROSEGATE_CONFIG_URL and PROSEGATE_PUBLISH_TOKEN. No model calls.");
    return;
  }
  const origin = new URL(process.env.PROSEGATE_CONFIG_URL ?? "");
  if (origin.protocol !== "https:" || origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash) throw new Error("invalid_service_origin");
  const token = process.env.PROSEGATE_PUBLISH_TOKEN;
  if (!token) throw new Error("publisher_token_required");
  const call = async (path: string, body: unknown): Promise<unknown> => {
    const result = await fetch(new URL(`/v1/internal/publish-jobs/${path}`, origin), {
      method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "Idempotency-Key": randomUUID() },
      body: JSON.stringify(body), signal: AbortSignal.timeout(30000), redirect: "error",
    });
    if (!result.ok) throw new Error("publish_service_rejected");
    return result.json();
  };
  const { job } = z.strictObject({ job: Job.nullable() }).parse(await call("claim", {}));
  if (!job) { console.log("No pending pack."); return; }
  if (createHash("sha256").update(job.yaml).digest("hex") !== job.content_hash) throw new Error("publish_content_changed");
  const report = validatePublication(job.yaml);
  await call(`${job.id}/result`, { ...report, lease_token: job.lease_token, content_hash: job.content_hash });
  console.log(report.passed ? "Pack published after example and latency checks." : "Pack rejected by example or latency checks.");
  if (!report.passed) process.exitCode = 1;
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch(() => { console.error("Pack publication failed. Inspect the job status; an expired lease can be reclaimed."); process.exitCode = 2; });
}
