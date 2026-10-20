import type { Hono } from "hono";
import { z } from "zod";
import { parseRulePackYaml } from "@prosegate/profiles";
import { REVIEWER_MODELS, RULE_ID_RE } from "@prosegate/schema";
import type { App } from "./types.js";
import { all, audit, dashboard, digest, Empty, fail, id, one, parse, random, response, sign, stage, Token } from "./util.js";

interface Job { id: string; pack_id: string; version: string; publisher_id: string; yaml: string; content_hash: string; status: string; lease_until: number | null; lease_token_hash: string | null; report_json: string | null }
const PackBody = z.strictObject({ yaml: z.string().max(262144).refine((s) => new TextEncoder().encode(s).length <= 262144) });
const PublishResult = z.strictObject({
  lease_token: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  content_hash: z.string().regex(/^[a-f0-9]{64}$/),
  passed: z.boolean(),
  examples_pass: z.number().int().nonnegative(),
  examples_total: z.number().int().positive(),
  latency_p95_ms: z.number().finite().nonnegative(),
  engine_version: z.string().max(64).regex(/^[a-zA-Z0-9.+-]+$/),
  failed_rule_ids: z.array(z.string().regex(RULE_ID_RE)).max(500).optional(),
});
const PromptBody = z.strictObject({ text: z.string().min(1).max(32000), supported_models: z.array(z.enum(REVIEWER_MODELS)).min(1).max(2) });
export function packRoutes(app: Hono<App>): void {
  app.get("/v1/rule-packs", async (c) => {
    const rows = await all<{ id: string; version: string; publisher_id: string }>(c.env, "SELECT id,version,publisher_id FROM rule_packs ORDER BY id,version LIMIT 5000");
    const grouped = new Map<string, { id: string; versions: string[]; publisher: string }>();
    for (const row of rows) {
      const entry = grouped.get(row.id) ?? { id: row.id, versions: [], publisher: row.publisher_id };
      entry.versions.push(row.version); grouped.set(row.id, entry);
    }
    return response({ rule_packs: [...grouped.values()] });
  });
  app.get("/v1/rule-packs/:id/:version", async (c) => {
    const row = await one<{ yaml: string; signature: string }>(c.env, "SELECT yaml,signature FROM rule_packs WHERE id=? AND version=?", c.req.param("id"), c.req.param("version"));
    return row ? response(row) : fail(404, "not_found");
  });
  app.put("/v1/rule-packs/:id/:version", async (c) => {
    dashboard(c);
    const body = parse(c, PackBody), p = c.get("principal");
    if (!p.account.publisher) return fail(403, "publisher_required");
    const parsed = parseRulePackYaml(body.yaml);
    if (!parsed.ok || parsed.value.id !== c.req.param("id") || parsed.value.version !== c.req.param("version")) return fail(422, "pack_invalid");
    if (["core", "local", "prosegate"].includes(parsed.value.id)) return fail(403, "reserved_pack");
    const owner = await one<{ account_id: string }>(c.env, "SELECT account_id FROM publishers WHERE pack_id=?", parsed.value.id);
    if (owner && owner.account_id !== p.account.id) return fail(403, "publisher_mismatch");
    if (await one(c.env, "SELECT id FROM publish_jobs WHERE pack_id=? AND version=?", parsed.value.id, parsed.value.version)) return fail(409, "immutable_version");
    if (!owner) stage(c, "INSERT INTO publishers VALUES(?,?)", parsed.value.id, p.account.id);
    const jobId = id();
    stage(c, "INSERT INTO publish_jobs(id,pack_id,version,publisher_id,yaml,content_hash,status,created_at) VALUES(?,?,?,?,?,?,'pending',?)",
      jobId, parsed.value.id, parsed.value.version, p.account.id, body.yaml, await digest(body.yaml), Date.now());
    audit(c, "pack.submit", `${parsed.value.id}@${parsed.value.version}`);
    return response({ job_id: jobId, status: "pending" }, 202);
  });
  app.get("/v1/publish-jobs/:id", async (c) => {
    dashboard(c);
    const job = await one<Job>(c.env, "SELECT * FROM publish_jobs WHERE id=? AND publisher_id=?", c.req.param("id"), c.get("principal").account.id);
    if (!job) return fail(404, "not_found");
    return response({ job_id: job.id, status: job.status, eval_report: job.report_json ? JSON.parse(job.report_json) as unknown : null });
  });
  // This token is supplied only to the separate, trusted CI publisher. It is not a dashboard role.
  app.post("/v1/internal/publish-jobs/claim", async (c) => {
    parse(c, Empty);
    const job = await one<Job>(c.env, "SELECT * FROM publish_jobs WHERE status='pending' OR (status='running' AND lease_until<?) ORDER BY created_at LIMIT 1", Date.now());
    if (!job) return response({ job: null });
    const lease = random();
    stage(c, "UPDATE publish_jobs SET status='running',lease_until=?,lease_token_hash=? WHERE id=?", Date.now() + 600000, await digest(lease), job.id);
    c.get("tx").sensitive = true;
    return response({ job: { id: job.id, yaml: job.yaml, content_hash: job.content_hash, lease_token: lease } });
  });
  app.post("/v1/internal/publish-jobs/:id/result", async (c) => {
    const body = parse(c, PublishResult), job = await one<Job>(c.env, "SELECT * FROM publish_jobs WHERE id=?", c.req.param("id"));
    if (!job || job.status !== "running" || (job.lease_until ?? 0) <= Date.now() || job.lease_token_hash !== await digest(body.lease_token)) return fail(409, "publish_lease_invalid");
    if (job.content_hash !== body.content_hash) return fail(409, "publish_content_changed");
    const parsed = parseRulePackYaml(job.yaml);
    if (!parsed.ok) return fail(422, "pack_invalid");
    const expected = parsed.value.rules.reduce((n, r) => n + r.examples.hit.length + r.examples.miss.length, 0);
    const passed = body.passed && body.examples_total === expected && body.examples_pass === expected && body.latency_p95_ms <= 200 && !body.failed_rule_ids?.length;
    const { lease_token: _lease, ...report } = body;
    void _lease;
    stage(c, "UPDATE publish_jobs SET status=?,report_json=?,lease_token_hash=NULL WHERE id=?", passed ? "passed" : "failed", JSON.stringify(report), job.id);
    if (passed) stage(c, "INSERT INTO rule_packs VALUES(?,?,?,?,?,?)", job.pack_id, job.version, job.publisher_id, job.yaml, await sign(c.env, job.yaml), JSON.stringify(report));
    stage(c, "INSERT INTO audit_log VALUES(?,?,?,?,?,?)", id(), job.publisher_id, "publish-ci", passed ? "pack.publish" : "pack.reject", `${job.pack_id}@${job.version}`, Date.now());
    return response({ status: passed ? "passed" : "failed" });
  });
  app.get("/v1/reviewer-prompts/:version", async (c) => {
    const row = await one<{ text: string; signature: string; supported_models_json: string }>(c.env, "SELECT * FROM reviewer_prompts WHERE version=?", c.req.param("version"));
    if (!row) return fail(404, "not_found");
    return response({ text: row.text, signature: row.signature, supported_models: JSON.parse(row.supported_models_json) as unknown });
  });
  app.put("/v1/internal/reviewer-prompts/:version", async (c) => {
    const body = parse(c, PromptBody), version = Token.parse(c.req.param("version"));
    if (await one(c.env, "SELECT version FROM reviewer_prompts WHERE version=?", version)) return fail(409, "immutable_version");
    stage(c, "INSERT INTO reviewer_prompts VALUES(?,?,?,?)", version, body.text, await sign(c.env, body.text), JSON.stringify(body.supported_models));
    stage(c, "INSERT INTO audit_log VALUES(?,?,?,?,?,?)", id(), "service", "publish-ci", "prompt.publish", version, Date.now());
    return response({ version }, 201);
  });
}
