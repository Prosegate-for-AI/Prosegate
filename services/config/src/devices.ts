import type { Hono } from "hono";
import { z } from "zod";
import { findKeyShapedStrings } from "@prosegate/schema";
import type { App, Ctx } from "./types.js";
import { all, audit, dashboard, digest, Empty, fail, id, one, parse, problem, random, response, stage, Token } from "./util.js";

const Name = z.string().min(1).max(64).regex(/^[\x20-\x7e]+$/).refine((v) => !findKeyShapedStrings(v).length);
const Create = z.strictObject({ name: Name, platform: z.enum(["win32", "darwin", "linux"]), adapter_version: z.string().regex(/^\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?$/).max(64) });
const Claim = z.strictObject({ device_code: z.string().regex(/^[A-Za-z0-9_-]{43}$/) });
const Approve = z.strictObject({ user_code: z.string().regex(/^[A-Z2-9]{4}-?[A-Z2-9]{4}$/) });
interface Code { code_hash: string; name: string; account_id: string | null; expires_at: number; next_poll: number; claimed_at: number | null }
export async function quota(c: Ctx, bucket: string, limit: number, expires: number): Promise<void> {
  const count = await one<{ count: number }>(c.env, "SELECT count FROM request_limits WHERE bucket=? AND expires_at>?", bucket, Date.now());
  if ((count?.count ?? 0) >= limit) fail(429, "rate_limited");
  stage(c, "INSERT INTO request_limits VALUES(?,1,?) ON CONFLICT(bucket) DO UPDATE SET count=CASE WHEN expires_at<=? THEN 1 ELSE count+1 END,expires_at=excluded.expires_at", bucket, expires, Date.now());
}
export function deviceRoutes(app: Hono<App>): void {
  app.post("/v1/device-codes", async (c) => {
    const body = parse(c, Create);
    const hour = Math.floor(Date.now() / 3600000);
    await quota(c, `device-code:${await digest(c.req.header("CF-Connecting-IP") ?? "local")}:${hour}`, 20, (hour + 1) * 3600000);
    const code = random();
    const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    const bytes = crypto.getRandomValues(new Uint8Array(8));
    const user = [...bytes].map((b) => alphabet[b % alphabet.length]).join("");
    stage(c, "INSERT INTO device_codes(code_hash,user_code_hash,name,platform,adapter_version,expires_at,next_poll) VALUES(?,?,?,?,?,?,?)",
      await digest(code), await digest(user), body.name, body.platform, body.adapter_version, Date.now() + 600000, 0);
    const origin = new URL(c.env.DASHBOARD_ORIGIN);
    if (origin.username || origin.password || origin.search || origin.hash || origin.pathname !== "/" ||
      !(origin.protocol === "https:" || (origin.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname)))) fail(503, "dashboard_unconfigured");
    c.get("tx").sensitive = true;
    return response({ device_code: code, user_code: `${user.slice(0, 4)}-${user.slice(4)}`, verification_url: `${origin.origin}/devices/approve`, expires_in: 600, interval: 5 }, 201);
  });
  app.post("/v1/device-codes/approve", async (c) => {
    dashboard(c);
    const body = parse(c, Approve);
    const minute = Math.floor(Date.now() / 60000);
    await quota(c, `approve:${c.get("principal").account.id}:${minute}`, 10, (minute + 1) * 60000);
    const code = await one<Code>(c.env, "SELECT * FROM device_codes WHERE user_code_hash=?", await digest(body.user_code.replace("-", "")));
    if (!code || code.expires_at <= Date.now()) return problem(410, "device_code_expired");
    if (code.claimed_at || code.account_id) return problem(409, "device_code_used");
    stage(c, "UPDATE device_codes SET account_id=? WHERE code_hash=?", c.get("principal").account.id, code.code_hash);
    audit(c, "device.approve", code.code_hash.slice(0, 16));
    return response({ approved: true });
  });
  app.post("/v1/devices/claim", async (c) => {
    const body = parse(c, Claim);
    const code = await one<Code>(c.env, "SELECT * FROM device_codes WHERE code_hash=?", await digest(body.device_code));
    if (!code || code.expires_at <= Date.now()) return problem(410, "device_code_expired");
    if (code.claimed_at) return problem(410, "device_code_used");
    if (code.next_poll > Date.now()) {
      const result = problem(429, "slow_down");
      result.headers.set("Retry-After", "5");
      return result;
    }
    stage(c, "UPDATE device_codes SET next_poll=? WHERE code_hash=?", Date.now() + 5000, code.code_hash);
    if (!code.account_id) return problem(400, "authorization_pending");
    const deviceId = id(), key = `pgd_${random()}`;
    stage(c, "INSERT INTO devices(id,account_id,name,key_hash,created_at,last_seen) VALUES(?,?,?,?,?,?)", deviceId, code.account_id, code.name, await digest(key), Date.now(), Date.now());
    stage(c, "UPDATE device_codes SET claimed_at=? WHERE code_hash=?", Date.now(), code.code_hash);
    stage(c, "INSERT INTO audit_log VALUES(?,?,?,?,?,?)", id(), code.account_id, deviceId, "device.claim", deviceId, Date.now());
    c.get("tx").sensitive = true;
    return response({ device_key: key, account_id: code.account_id, device_id: deviceId });
  });
  app.get("/v1/devices", async (c) => {
    dashboard(c);
    return response({ devices: await all(c.env, "SELECT id,name,created_at,last_seen,revoked_at FROM devices WHERE account_id=? ORDER BY created_at DESC LIMIT 200", c.get("principal").account.id) });
  });
  app.delete("/v1/devices/:id", async (c) => {
    dashboard(c); parse(c, Empty);
    const target = Token.parse(c.req.param("id"));
    const d = await one(c.env, "SELECT id FROM devices WHERE id=? AND account_id=?", target, c.get("principal").account.id);
    if (!d) return fail(404, "not_found");
    stage(c, "UPDATE devices SET revoked_at=? WHERE id=?", Date.now(), target);
    stage(c, "UPDATE reviewer_keys SET status='revoking' WHERE device_id=? AND status!='revoked'", target);
    audit(c, "device.revoke", target);
    return response(null, 204);
  });
}
