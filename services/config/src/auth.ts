import { createLocalJWKSet, createRemoteJWKSet, jwtVerify, type JSONWebKeySet } from "jose";
import { OrgPolicyInputSchema } from "@prosegate/profiles";
import type { Account, Ctx, Env, Principal } from "./types.js";
import { digest, fail, one, Problem } from "./util.js";

const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();
export async function authenticate(c: Ctx): Promise<Principal> {
  const token = /^Bearer ([^\s]+)$/.exec(c.req.header("Authorization") ?? "")?.[1];
  if (!token || token.length > 16000) return fail(401, "unauthorized");
  let account: Account | null;
  let deviceId: string | null = null;
  let kind: Principal["kind"] = "dashboard";
  if (token.startsWith("pgd_")) {
    const d = await one<{ id: string; account_id: string }>(c.env, "SELECT id,account_id FROM devices WHERE key_hash=? AND revoked_at IS NULL", await digest(token));
    if (!d) return fail(401, "unauthorized");
    account = await one<Account>(c.env, "SELECT * FROM accounts WHERE id=?", d.account_id);
    deviceId = d.id; kind = "device";
  } else {
    const subject = await verifyDashboard(token, c.env);
    account = await one<Account>(c.env, "SELECT * FROM accounts WHERE auth_subject=?", subject);
  }
  if (!account) return fail(403, "account_not_registered");
  let policy: Principal["policy"] = null;
  let role: Principal["role"] = null;
  if (account.org_id) {
    const org = await one<{ namespace: string; name: string; policy_json: string; role: "admin" | "member" }>(c.env,
      "SELECT o.namespace,o.name,o.policy_json,m.role FROM orgs o JOIN org_members m ON m.org_id=o.id WHERE o.id=? AND m.account_id=?", account.org_id, account.id);
    if (!org) return fail(403, "membership_invalid");
    policy = OrgPolicyInputSchema.parse({ ...JSON.parse(org.policy_json) as object, org_id: account.org_id, org_name: org.name, namespace: org.namespace });
    role = org.role;
  }
  return { account, device_id: deviceId, kind, policy, role };
}
export async function verifyDashboard(token: string, env: Env): Promise<string> {
  if (!env.OIDC_ISSUER || !env.OIDC_AUDIENCE || (!env.OIDC_JWKS && !env.OIDC_JWKS_URL)) return fail(503, "dashboard_auth_unconfigured");
  try {
    let keys;
    if (env.OIDC_JWKS) keys = createLocalJWKSet(JSON.parse(env.OIDC_JWKS) as JSONWebKeySet);
    else {
      const url = new URL(env.OIDC_JWKS_URL as string);
      if (url.protocol !== "https:" || url.username || url.password) throw new Error("Invalid JWKS endpoint");
      keys = jwksCache.get(url.href);
      if (!keys) { keys = createRemoteJWKSet(url, { timeoutDuration: 5000, cooldownDuration: 30000 }); jwksCache.set(url.href, keys); }
    }
    const { payload } = await jwtVerify(token, keys, { issuer: env.OIDC_ISSUER, audience: env.OIDC_AUDIENCE, algorithms: ["RS256", "ES256"], requiredClaims: ["sub", "exp", "iat"], maxTokenAge: "1h" });
    if (!payload.sub || payload.sub.length > 255 || !Array.isArray(payload.amr) || !payload.amr.includes("mfa")) return fail(403, "mfa_required");
    return payload.sub;
  } catch (error) { if (error instanceof Problem) throw error; return fail(401, "unauthorized"); }
}
