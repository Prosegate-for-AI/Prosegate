import type { Hono } from "hono";
import { z } from "zod";
import { FindingSchema, PROFILE_ID_RE, ServerStoredEventSchema, WireBatchSchema, isTimestampWithinBounds } from "@prosegate/schema";
import type { App, Env, ProfileRow } from "./types.js";
import { all, audit, dashboard, device, Empty, fail, id, namespaceAccess, one, parse, response, stage, stmt } from "./util.js";
import { quota } from "./devices.js";

const DAY = 86400000;
const SampleFinding = z.strictObject({
  ...FindingSchema.shape,
  span: z.strictObject({ segment_id: FindingSchema.shape.span.shape.segment_id, text: z.string().min(1).max(600) }),
}).superRefine((f, ctx) => {
  if (!FindingSchema.safeParse({ ...f, span: { ...f.span, start: 0, end: f.span.text.length } }).success) ctx.addIssue({ code: "custom", message: "invalid finding" });
});
const Sample = z.strictObject({
  profile_id: z.string().regex(PROFILE_ID_RE), pass: z.union([z.literal(1), z.literal(2)]),
  finding: SampleFinding, excerpt: z.string().min(1).max(600),
});
/** Defence in depth: also redact text inside the finding, not only the excerpt. */
export function redact(text: string): string {
  return text
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[email]")
    .replace(/\b(?:https?:\/\/|www\.)[^\s<>]+/gi, "[url]")
    .replace(/(?:sk-|sk_|pk_|xox[abprs]-|ghp_|AKIA|pgd_)[A-Za-z0-9_-]{16,}/g, "[secret]")
    .replace(/[A-Za-z0-9_+/=-]{40,}/g, "[secret]")
    .replace(/\d{5,}/g, "[number]");
}
export function telemetryRoutes(app: Hono<App>): void {
  app.post("/v1/telemetry", async (c) => {
    const deviceId = device(c), body = parse(c, WireBatchSchema), account = c.get("principal").account.id;
    if (body.events.some((e) => !isTimestampWithinBounds(e.ts, Date.now()))) return fail(422, "timestamp_out_of_bounds");
    // Resolve attribution from the authenticated principal, never from a client field.
    const events = body.events.map((e) => ServerStoredEventSchema.parse({ ...e, account_id: account, device_id: deviceId }));
    if (events.length) stage(c, "INSERT INTO telemetry_outbox VALUES(?,?,?,?,?)", id(), account, deviceId, JSON.stringify(events), Date.now());
    stage(c, "UPDATE devices SET last_seen=? WHERE id=?", Date.now(), deviceId);
    return response({ accepted: events.length }, 202);
  });
  app.post("/v1/samples", async (c) => {
    const deviceId = device(c), body = parse(c, Sample), p = c.get("principal");
    const ns = body.profile_id.split("/")[0] as string;
    if (!namespaceAccess(c, ns)) return fail(404, "not_found");
    const profile = await one<ProfileRow>(c.env, "SELECT * FROM profiles WHERE id=?", body.profile_id);
    if (!profile?.sharing_enabled || p.policy?.sharing_allowed === false) return fail(403, "sharing_disabled");
    if (body.finding.severity !== "block") return fail(422, "block_finding_required");
    const day = Math.floor(Date.now() / DAY);
    await quota(c, `samples:${deviceId}:${day}`, 20, (day + 1) * DAY);
    const finding = {
      ...body.finding, span: { ...body.finding.span, text: redact(body.finding.span.text) },
      instruction: { ...body.finding.instruction, text: redact(body.finding.instruction.text) },
      evidence: body.finding.evidence === null ? null : redact(body.finding.evidence),
    };
    stage(c, "INSERT INTO samples VALUES(?,?,?,?,?,?,?,?)", id(), p.account.id, deviceId, body.profile_id, body.pass, redact(body.excerpt), JSON.stringify(finding), Date.now());
    return response({ accepted: true }, 202);
  });
  app.get("/v1/samples", async (c) => {
    dashboard(c);
    const rows = await all<{ finding_json: string } & Record<string, unknown>>(c.env, "SELECT id,profile_id,pass,excerpt,finding_json,created_at FROM samples WHERE account_id=? ORDER BY created_at DESC LIMIT 200", c.get("principal").account.id);
    return response({ samples: rows.map(({ finding_json, ...r }) => ({ ...r, finding: JSON.parse(finding_json) as unknown })) });
  });
  app.delete("/v1/samples/:id", async (c) => {
    dashboard(c); parse(c, Empty);
    const account = c.get("principal").account.id, target = c.req.param("id");
    if (!await one(c.env, "SELECT id FROM samples WHERE id=? AND account_id=?", target, account)) return fail(404, "not_found");
    stage(c, "DELETE FROM samples WHERE id=? AND account_id=?", target, account);
    audit(c, "sample.delete", target);
    return response(null, 204);
  });
  app.get("/v1/dashboard/usage", async (c) => {
    dashboard(c);
    const from = c.req.query("from") ?? new Date(Date.now() - 30 * DAY).toISOString().slice(0, 10);
    const to = c.req.query("to") ?? new Date().toISOString().slice(0, 10);
    const valid = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && Number.isFinite(Date.parse(s)) && new Date(s).toISOString().slice(0, 10) === s;
    if (!valid(from) || !valid(to) || from > to || Date.parse(to) - Date.parse(from) > 366 * DAY) return fail(422, "invalid_date_range");
    return response({ usage: await all(c.env, "SELECT day,profile_id,category,count FROM telemetry_daily WHERE account_id=? AND day>=? AND day<=? ORDER BY day,profile_id,category", c.get("principal").account.id, from, to) });
  });
}

/** Queue carries only a durable outbox id. A send crash can duplicate delivery, never a count. */
export async function flushTelemetry(env: Env): Promise<void> {
  for (const row of await all<{ id: string }>(env, "SELECT id FROM telemetry_outbox ORDER BY created_at LIMIT 100")) {
    await env.TELEMETRY.send({ id: row.id });
  }
}
export async function ingestTelemetry(batch: MessageBatch<unknown>, env: Env): Promise<void> {
  for (const message of batch.messages) {
    try {
      const parsed = z.strictObject({ id: z.string().uuid() }).safeParse(message.body);
      if (!parsed.success) { message.ack(); continue; }
      const row = await one<{ payload: string }>(env, "SELECT payload FROM telemetry_outbox WHERE id=?", parsed.data.id);
      if (!row) { message.ack(); continue; }
      const events = z.array(ServerStoredEventSchema).max(50).parse(JSON.parse(row.payload) as unknown);
      // D1 batch transaction: a retry sees either the complete batch or no batch.
      await env.DB.batch([
        ...events.map((e, i) => stmt(env, "INSERT OR IGNORE INTO telemetry_events VALUES(?,?,?,?,?)", `${parsed.data.id}:${i}`, e.account_id, e.device_id, e.ts, JSON.stringify(e))),
        ...[...new Set(events.map((e) => new Date(e.ts).toISOString().slice(0, 10)))].map((day) =>
          stmt(env, "INSERT INTO aggregate_days VALUES(?,0) ON CONFLICT(day) DO UPDATE SET processed_at=0", day)),
        stmt(env, "DELETE FROM telemetry_outbox WHERE id=?", parsed.data.id),
      ]);
      message.ack();
    } catch { message.retry(); }
  }
}
export async function aggregateAndRetain(env: Env, now = Date.now()): Promise<void> {
  // Rebuild recent days to incorporate +/-1-day client timestamps and late queue deliveries.
  // Older aggregates survive raw-row expiry; retries cannot add counts twice.
  const day = new Date(now - 2 * DAY).toISOString().slice(0, 10);
  await env.DB.batch([
    stmt(env, "DELETE FROM telemetry_daily WHERE day>=? OR day IN (SELECT day FROM aggregate_days WHERE processed_at=0)", day),
    stmt(env, `INSERT INTO telemetry_daily(account_id,day,profile_id,category,count)
      SELECT account_id,date(ts/1000,'unixepoch'),json_extract(event_json,'$.profile_id'),j.key,SUM(j.value)
      FROM telemetry_events,json_each(event_json,'$.by_category') j
      WHERE json_extract(event_json,'$.t')='review' AND (date(ts/1000,'unixepoch')>=? OR date(ts/1000,'unixepoch') IN (SELECT day FROM aggregate_days WHERE processed_at=0))
      GROUP BY account_id,date(ts/1000,'unixepoch'),json_extract(event_json,'$.profile_id'),j.key`, day),
    stmt(env, "UPDATE aggregate_days SET processed_at=? WHERE processed_at=0", now),
    stmt(env, "DELETE FROM telemetry_events WHERE ts<?", now - 180 * DAY),
    stmt(env, "DELETE FROM telemetry_outbox WHERE created_at<?", now - 180 * DAY),
    stmt(env, "DELETE FROM samples WHERE created_at<?", now - 90 * DAY),
    stmt(env, "DELETE FROM device_codes WHERE expires_at<?", now),
    stmt(env, "DELETE FROM request_limits WHERE expires_at<?", now),
    stmt(env, "DELETE FROM idempotency WHERE expires_at<?", now),
    stmt(env, "UPDATE state_revision SET revision=revision+1 WHERE id=1"),
  ]);
}
