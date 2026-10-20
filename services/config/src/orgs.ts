import type { Hono } from "hono";
import { z } from "zod";
import { canonicalJson, OrgPolicyBodySchema } from "@prosegate/profiles";
import type { App, Account } from "./types.js";
import { all, audit, Empty, fail, one, orgAdmin, parse, response, sign, stage, digest, Token } from "./util.js";

const Role = z.strictObject({ role: z.enum(["admin", "member"]) });
export function orgRoutes(app: Hono<App>): void {
  app.get("/v1/orgs/:id/members", async (c) => {
    orgAdmin(c, c.req.param("id"));
    return response({ members: await all(c.env, "SELECT account_id,role FROM org_members WHERE org_id=? ORDER BY account_id", c.req.param("id")) });
  });
  app.put("/v1/orgs/:id/members/:user", async (c) => {
    const org = c.req.param("id"), user = Token.parse(c.req.param("user"));
    orgAdmin(c, org); const body = parse(c, Role);
    const account = await one<Account>(c.env, "SELECT * FROM accounts WHERE id=?", user);
    if (!account) return fail(404, "not_found");
    if (account.org_id && account.org_id !== org) return fail(409, "different_org");
    const current = await one<{ role: string }>(c.env, "SELECT role FROM org_members WHERE org_id=? AND account_id=?", org, user);
    if (current?.role === "admin" && body.role !== "admin" && (await one<{ n: number }>(c.env, "SELECT COUNT(*) AS n FROM org_members WHERE org_id=? AND role='admin'", org))?.n === 1) return fail(409, "last_admin");
    stage(c, "INSERT INTO org_members VALUES(?,?,?) ON CONFLICT(org_id,account_id) DO UPDATE SET role=excluded.role", org, user, body.role);
    stage(c, "UPDATE accounts SET org_id=? WHERE id=?", org, user);
    if (c.get("principal").policy?.byok_required || c.get("principal").policy?.allowed_providers) stage(c, "UPDATE reviewer_keys SET status='revoking' WHERE account_id=? AND status!='revoked'", user);
    audit(c, "org.member", user);
    return response({ account_id: user, role: body.role });
  });
  app.delete("/v1/orgs/:id/members/:user", async (c) => {
    const org = c.req.param("id"), user = c.req.param("user");
    orgAdmin(c, org); parse(c, Empty);
    const member = await one<{ role: string }>(c.env, "SELECT role FROM org_members WHERE org_id=? AND account_id=?", org, user);
    if (!member) return fail(404, "not_found");
    if (member.role === "admin" && (await one<{ n: number }>(c.env, "SELECT COUNT(*) AS n FROM org_members WHERE org_id=? AND role='admin'", org))?.n === 1) return fail(409, "last_admin");
    stage(c, "DELETE FROM org_members WHERE org_id=? AND account_id=?", org, user);
    stage(c, "UPDATE accounts SET org_id=NULL WHERE id=?", user);
    audit(c, "org.remove_member", user);
    return response(null, 204);
  });
  app.get("/v1/orgs/:id/policy", async (c) => {
    if (c.get("principal").account.org_id !== c.req.param("id")) return fail(404, "not_found");
    const row = await one<{ policy_json: string; signature: string | null; etag: string | null }>(c.env, "SELECT * FROM orgs WHERE id=?", c.req.param("id"));
    if (!row) return fail(404, "not_found");
    const policy = c.get("principal").policy;
    const bytes = canonicalJson(policy);
    const signature = await sign(c.env, bytes), etag = `"${await digest(bytes)}"`;
    if (c.req.header("If-None-Match") === etag) return response(null, 304, { ETag: etag });
    return response({ policy, signature, etag }, 200, { ETag: etag });
  });
  app.put("/v1/orgs/:id/policy", async (c) => {
    const org = c.req.param("id"); orgAdmin(c, org);
    const body = parse(c, OrgPolicyBodySchema);
    const current = c.get("principal").policy;
    if (c.req.header("If-Match") && c.req.header("If-Match") !== `"${await digest(canonicalJson(current))}"`) return fail(412, "etag_mismatch");
    const policy = { org_id: org, org_name: current?.org_name, namespace: current?.namespace, ...body };
    const bytes = canonicalJson(policy), signature = await sign(c.env, bytes), etag = `"${await digest(bytes)}"`;
    stage(c, "UPDATE orgs SET policy_json=?,signature=?,etag=? WHERE id=?", canonicalJson(body), signature, etag, org);
    if (body.byok_required) stage(c, "UPDATE reviewer_keys SET status='revoking' WHERE account_id IN (SELECT account_id FROM org_members WHERE org_id=?) AND status!='revoked'", org);
    else if (body.allowed_providers) {
      for (const provider of ["openai", "anthropic"]) if (!body.allowed_providers.includes(provider)) stage(c, "UPDATE reviewer_keys SET status='revoking' WHERE account_id IN (SELECT account_id FROM org_members WHERE org_id=?) AND provider=? AND status!='revoked'", org, provider);
    }
    audit(c, "org.policy", org);
    return response({ policy, signature, etag }, 200, { ETag: etag });
  });
}
