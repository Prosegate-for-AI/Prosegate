import type { Hono } from "hono";
import { z } from "zod";
import { REVIEWER_MODELS } from "@prosegate/schema";
import type { App, Env } from "./types.js";
import { all, audit, commit, dashboard, device, Empty, fail, id, one, parse, response, revision, stage, stmt } from "./util.js";
import { authenticate } from "./auth.js";
import { quota } from "./devices.js";

const DAY = 86400000;
const Vend = z.strictObject({ provider: z.enum(["openai", "anthropic"]) });
const Provisioned = z.strictObject({ key: z.string().min(16).max(4096), project_id: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/) });
const Usage = z.strictObject({ usage_cents: z.number().int().nonnegative(), daily_cents: z.number().int().nonnegative(), trailing_daily_cents: z.number().finite().nonnegative() });
interface KeyRow {
  key_id: string; account_id: string; device_id: string; provider: string; project_id: string;
  status: string; cap_cents: number; usage_cents: number; daily_cents: number;
  trailing_daily_cents: number; polled_at: number; created_at: number; expires_at: number;
}
export function vendingEnabled(env: Env): boolean {
  // Merely providing an admin credential cannot opt an installation into financial exposure.
  return env.VENDING_EXPOSURE_ACCEPTED === "accepted-s2" && !!env.REVIEWER_ADMIN;
}
async function admin(env: Env, path: string, method: string, body?: unknown): Promise<Response> {
  if (!env.REVIEWER_ADMIN) return fail(503, "provider_admin_unconfigured");
  try {
    const result = await env.REVIEWER_ADMIN.fetch(`https://reviewer-admin.internal/v1/${path}`, {
      method, headers: { "Content-Type": "application/json" }, signal: AbortSignal.timeout(10000),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!result.ok) return fail(503, "provider_admin_unavailable");
    return result;
  } catch { return fail(503, "provider_admin_unavailable"); }
}
export function keyRoutes(app: Hono<App>): void {
  app.post("/v1/reviewer-keys/vend", async (c) => {
    const deviceId = device(c), body = parse(c, Vend), p = c.get("principal");
    if (p.account.plan !== "paid") return fail(402, "paid_plan_required");
    if (p.account.flagged) return fail(403, "account_confirmation_required");
    if (p.policy?.byok_required || (p.policy?.allowed_providers && !p.policy.allowed_providers.includes(body.provider))) return fail(403, "provider_forbidden");
    if (!vendingEnabled(c.env) || body.provider !== "openai") return fail(503, "vending_disabled");
    if (await one(c.env, "SELECT key_id FROM reviewer_keys WHERE device_id=? AND status!='revoked'", deviceId)) return fail(409, "device_key_exists");
    const now = Date.now(), day = Math.floor(now / DAY), keyId = id(), expires = now + 30 * DAY;
    await quota(c, `vends:${p.account.id}:${day}`, 3, (day + 1) * DAY);
    // Durable reservation exists BEFORE contacting the administrative bridge. Its operation id
    // is also the bridge's idempotency id, so crashes/unknown outcomes can always be revoked.
    stage(c, "INSERT INTO reviewer_keys(key_id,account_id,device_id,provider,project_id,status,cap_cents,polled_at,created_at,expires_at) VALUES(?,?,?,?,?,'provisioning',500,?,?,?)",
      keyId, p.account.id, deviceId, body.provider, p.account.id, now, now, expires);
    audit(c, "key.reserve", keyId);
    await commit(c.env, c.get("tx"));
    c.set("tx", { revision: await revision(c.env), statements: [], sensitive: true });
    const created = Provisioned.safeParse(await (await admin(c.env, `keys/${keyId}`, "PUT", {
      account_id: p.account.id, device_id: deviceId, provider: body.provider, cap_cents: 500,
      expires_at: expires, model: REVIEWER_MODELS[0],
    })).json());
    if (!created.success) return fail(503, "provider_admin_invalid");
    // Re-authorize against the same revision we will commit: logout/policy/plan changes while
    // provisioning cannot expose a key. Failed final commits leave a recoverable reservation.
    const fresh = await authenticate(c);
    if (fresh.account.plan !== "paid" || fresh.account.flagged || fresh.policy?.byok_required ||
        (fresh.policy?.allowed_providers && !fresh.policy.allowed_providers.includes(body.provider))) return fail(403, "vending_authorization_changed");
    const reserved = await one<KeyRow>(c.env, "SELECT * FROM reviewer_keys WHERE key_id=?", keyId);
    if (reserved?.status !== "provisioning") return fail(409, "vending_cancelled");
    stage(c, "UPDATE reviewer_keys SET status='active',project_id=? WHERE key_id=?", created.data.project_id, keyId);
    audit(c, "key.vend", keyId);
    return response({ key: created.data.key, key_id: keyId, cap_cents: 500, expires_at: expires }, 201);
  });
  app.get("/v1/reviewer-keys", async (c) => {
    const p = c.get("principal");
    const keys = await all<KeyRow>(c.env, "SELECT * FROM reviewer_keys WHERE account_id=? ORDER BY created_at DESC LIMIT 200", p.account.id);
    return response({ keys: keys.filter((k) => p.kind === "dashboard" || k.device_id === p.device_id).map((k) => ({
      key_id: k.key_id, provider: k.provider,
      status: k.status === "active" && Date.now() - k.polled_at > 2 * 3600000 ? "suspended" : k.status,
      usage_pct: Math.round(k.usage_cents / k.cap_cents * 100), expires_at: k.expires_at,
    })) });
  });
  app.post("/v1/reviewer-keys/:id/revoke", async (c) => {
    parse(c, Empty); const p = c.get("principal");
    const key = await one<KeyRow>(c.env, "SELECT * FROM reviewer_keys WHERE key_id=? AND account_id=?", c.req.param("id"), p.account.id);
    if (!key || (p.kind === "device" && key.device_id !== p.device_id)) return fail(404, "not_found");
    if (key.status !== "revoked") stage(c, "UPDATE reviewer_keys SET status='revoking' WHERE key_id=?", key.key_id);
    audit(c, "key.revoke_requested", key.key_id);
    return response(null, 204);
  });
  app.post("/v1/reviewer-keys/confirm-account", async (c) => {
    dashboard(c); parse(c, Empty);
    stage(c, "UPDATE accounts SET flagged=0 WHERE id=?", c.get("principal").account.id);
    audit(c, "account.confirm", c.get("principal").account.id);
    return response(null, 204);
  });
}

async function lifecycleWrite(env: Env, statements: D1PreparedStatement[]): Promise<void> {
  await env.DB.batch([...statements, stmt(env, "UPDATE state_revision SET revision=revision+1 WHERE id=1")]);
}
async function batches<T>(rows: T[], work: (row: T) => Promise<void>): Promise<void> {
  // Bound both provider concurrency and worst-case cron wall time during an outage.
  for (let start = 0; start < rows.length; start += 5) {
    const results = await Promise.allSettled(rows.slice(start, start + 5).map(work));
    if (results.some((r) => r.status === "rejected")) throw new Error("key_maintenance_failed");
  }
}
export async function revokePending(env: Env): Promise<void> {
  if (!env.REVIEWER_ADMIN) return;
  await batches(await all<KeyRow>(env, "SELECT * FROM reviewer_keys WHERE status='revoking' OR (status='provisioning' AND created_at<?) LIMIT 100", Date.now() - 15 * 60000), async (key) => {
    try {
      await admin(env, `keys/${key.key_id}`, "DELETE");
      await lifecycleWrite(env, [
        stmt(env, "UPDATE reviewer_keys SET status='revoked' WHERE key_id=? AND status IN ('provisioning','revoking')", key.key_id),
        stmt(env, "INSERT INTO audit_log VALUES(?,?,?,?,?,?)", id(), key.account_id, "usage-poller", "key.revoked", key.key_id, Date.now()),
      ]);
    } catch { /* Keep the durable revocation request for the next cron; never mark a failed revoke done. */ }
  });
}
export async function pollKeys(env: Env, now = Date.now()): Promise<void> {
  if (!env.REVIEWER_ADMIN) return;
  await revokePending(env);
  const keys = await all<KeyRow>(env, "SELECT * FROM reviewer_keys WHERE status IN ('active','suspended') ORDER BY polled_at LIMIT 100");
  await batches(keys, async (key) => {
    try {
      const usage = Usage.parse(await (await admin(env, `keys/${key.key_id}/usage`, "GET")).json());
      const anomaly = (usage.trailing_daily_cents > 0 && usage.daily_cents > 3 * usage.trailing_daily_cents) ||
        (usage.usage_cents > .8 * key.cap_cents && new Date(now).getUTCDate() < 20);
      const revoke = anomaly || usage.usage_cents >= key.cap_cents || key.expires_at <= now;
      const statements = [
        stmt(env, "UPDATE reviewer_keys SET usage_cents=?,daily_cents=?,trailing_daily_cents=?,polled_at=?,status=? WHERE key_id=? AND status IN ('active','suspended')",
          usage.usage_cents, usage.daily_cents, usage.trailing_daily_cents, now, revoke ? "revoking" : "active", key.key_id),
      ];
      if (anomaly) {
        statements.push(stmt(env, "UPDATE accounts SET flagged=1 WHERE id=?", key.account_id));
        // Deduplicate notification across keys belonging to the same account/project/month.
        statements.push(stmt(env, "INSERT OR IGNORE INTO notifications(id,account_id,code,target,created_at) VALUES(?,?,?,?,?)", `burn:${key.account_id}:${new Date(now).toISOString().slice(0, 7)}`, key.account_id, "key_burn_revoked", key.project_id, now));
        statements.push(stmt(env, "UPDATE reviewer_keys SET status='revoking' WHERE account_id=? AND status!='revoked'", key.account_id));
        statements.push(stmt(env, "INSERT INTO audit_log VALUES(?,?,?,?,?,?)", id(), key.account_id, "usage-poller", "account.flagged", key.key_id, now));
      }
      await lifecycleWrite(env, statements);
    } catch {
      if (now - key.polled_at > 2 * 3600000 || key.expires_at <= now) await lifecycleWrite(env, [
        stmt(env, "UPDATE reviewer_keys SET status=? WHERE key_id=? AND status IN ('active','suspended')", key.expires_at <= now ? "revoking" : "suspended", key.key_id),
      ]);
    }
  });
  await revokePending(env);
}
export async function deliverNotifications(env: Env): Promise<void> {
  if (!env.NOTIFICATIONS) return;
  const delivery = env.NOTIFICATIONS;
  await batches(await all<{ id: string; account_id: string; code: string; target: string }>(env, "SELECT id,account_id,code,target FROM notifications WHERE delivered_at IS NULL LIMIT 100"), async (note) => {
    try {
      const sent = await delivery.fetch("https://notifications.internal/v1/send", {
        method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": note.id },
        body: JSON.stringify(note), signal: AbortSignal.timeout(10000),
      });
      if (sent.ok) await stmt(env, "UPDATE notifications SET delivered_at=? WHERE id=?", Date.now(), note.id).run();
    } catch { /* Delivery is retried with the same idempotency id; no response/body is logged. */ }
  });
}
