import type { Hono } from "hono";
import { z } from "zod";
import { stringify } from "yaml";
import { bundledPackSources, bundledProfileSources, OrgPolicyInputSchema, parseProfileYaml, resolveProfile, ResolutionError, type ResolutionSources } from "@prosegate/profiles";
import { PROFILE_ID_RE } from "@prosegate/schema";
import type { App, Ctx, Env, ProfileRow } from "./types.js";
import { all, audit, dashboard, digest, Empty, fail, namespaceAccess, one, parse, response, sign, stage } from "./util.js";

const Body = z.strictObject({ yaml: z.string().max(65536).refine((s) => new TextEncoder().encode(s).length <= 65536) });
const Sharing = z.strictObject({ enabled: z.boolean() });
export function profileId(c: Ctx): string {
  const value = `${c.req.param("namespace")}/${c.req.param("slug")}`;
  if (!PROFILE_ID_RE.test(value)) return fail(404, "not_found");
  return value;
}
export async function getProfile(c: Ctx, write = false): Promise<ProfileRow> {
  const target = profileId(c);
  if (!namespaceAccess(c, target.split("/")[0] as string, write)) return fail(404, "not_found");
  return await one<ProfileRow>(c.env, "SELECT * FROM profiles WHERE id=?", target) ?? fail(404, "not_found");
}
export async function sources(c: Ctx): Promise<ResolutionSources> {
  const p = c.get("principal");
  return sourcesFor(c.env, p.account.namespace, p.policy?.namespace ?? "");
}
async function sourcesFor(env: Env, namespace: string, org: string): Promise<ResolutionSources> {
  const rows = await all<ProfileRow>(env, "SELECT * FROM profiles WHERE namespace IN (?,?) LIMIT 501", namespace, org);
  if (rows.length > 500) return fail(409, "profile_limit");
  const profiles = bundledProfileSources();
  for (const row of rows) profiles[row.id] = { yaml: row.yaml, signed: true, origin: "synced" };
  const packs = bundledPackSources();
  for (const row of await all<{ id: string; version: string }>(env, "SELECT id,version FROM rule_packs LIMIT 5000")) (packs[row.id] ??= []).push({ version: row.version, signed: true, origin: "synced" });
  return { profiles, packs };
}
function resolved(c: Ctx, target: string, input: ResolutionSources) {
  try { return resolveProfile(target, input, { policy: c.get("principal").policy }); }
  catch { return fail(422, "profile_resolution_failed"); }
}
export function profileRoutes(app: Hono<App>): void {
  app.get("/v1/profiles", async (c) => {
    const p = c.get("principal"), ns = c.req.query("namespace");
    if (ns && !namespaceAccess(c, ns)) return fail(404, "not_found");
    const allowed = p.policy?.enforcement_default === "required" ? [p.policy.namespace, p.policy.namespace] : [p.account.namespace, p.policy?.namespace ?? ""];
    const rows = await all<ProfileRow>(c.env, "SELECT * FROM profiles WHERE namespace IN (?,?) ORDER BY id LIMIT 500", allowed[0] as string, allowed[1] as string);
    return response({ profiles: rows.filter((r) => !ns || r.namespace === ns).map(({ id, name, version, etag, updated_at }) => ({ id, name, version, etag, updated_at })) });
  });
  app.get("/v1/profiles/:namespace/:slug/resolved", async (c) => {
    const row = await getProfile(c);
    return response(resolved(c, row.id, await sources(c)));
  });
  app.post("/v1/profiles/:namespace/:slug/preview", async (c) => {
    dashboard(c);
    const body = parse(c, Body), target = profileId(c), ns = target.split("/")[0] as string;
    if (!namespaceAccess(c, ns, true)) return fail(403, "namespace_forbidden");
    const parsed = parseProfileYaml(body.yaml);
    const invalid = (code: string, issues: readonly { path: string; message: string }[]) =>
      response({ type: `urn:prosegate:problem:${code}`, title: code.replaceAll("_", " "), status: 422, code,
        issues: issues.slice(0, 10).map((i) => ({ path: i.path.slice(0, 200), message: i.message.slice(0, 200) })) }, 422,
      { "Content-Type": "application/problem+json" });
    if (!parsed.ok) return invalid("profile_invalid", parsed.error.issues);
    if (parsed.value.id !== target) return invalid("profile_invalid", [{ path: "id", message: "Must match the profile ID being edited." }]);
    const policy = c.get("principal").policy;
    if (ns === policy?.namespace && parsed.value.extends &&
        !parsed.value.extends.startsWith("local/") && !parsed.value.extends.startsWith(`${ns}/`)) return fail(422, "org_parent_private");
    const currentSources = await sources(c);
    const input: ResolutionSources = { ...currentSources, profiles: { ...currentSources.profiles, [target]: { yaml: body.yaml, signed: true, origin: "synced" } } };
    try { return response(resolveProfile(target, input, { policy })); }
    catch (error) {
      if (error instanceof ResolutionError) return invalid("profile_resolution_failed", [{ path: "", message: error.code }, ...error.issues]);
      throw error;
    }
  });
  app.get("/v1/profiles/:namespace/:slug", async (c) => {
    const row = await getProfile(c);
    if (c.req.header("If-None-Match") === row.etag) return response(null, 304, { ETag: row.etag });
    return response({ yaml: row.yaml, version: row.version, signature: row.signature, etag: row.etag, sharing_enabled: Boolean(row.sharing_enabled) }, 200, { ETag: row.etag });
  });
  app.put("/v1/profiles/:namespace/:slug", async (c) => {
    dashboard(c);
    const body = parse(c, Body), target = profileId(c), ns = target.split("/")[0] as string;
    if (!namespaceAccess(c, ns, true)) return fail(403, "namespace_forbidden");
    const parsed = parseProfileYaml(body.yaml);
    if (!parsed.ok || parsed.value.id !== target) return fail(422, "profile_invalid");
    const policy = c.get("principal").policy;
    // An org profile must resolve for every member, so it cannot depend on a private namespace.
    if (ns === policy?.namespace && parsed.value.extends &&
        !parsed.value.extends.startsWith("local/") && !parsed.value.extends.startsWith(`${ns}/`)) return fail(422, "org_parent_private");
    const previous = await one<ProfileRow>(c.env, "SELECT * FROM profiles WHERE id=?", target);
    if (c.req.header("If-None-Match") === "*" && previous) return fail(412, "etag_mismatch");
    if (c.req.header("If-Match") && c.req.header("If-Match") !== previous?.etag) return fail(412, "etag_mismatch");
    const version = ((await one<{ version: number }>(c.env, "SELECT MAX(version) AS version FROM profile_versions WHERE id=?", target))?.version ?? 0) + 1;
    const yaml = stringify({ ...parsed.value, version }, { lineWidth: 0 });
    const currentSources = await sources(c);
    const input: ResolutionSources = { ...currentSources, profiles: { ...currentSources.profiles, [target]: { yaml, signed: true, origin: "synced" } } };
    const resolution = resolved(c, target, input);
    // Include descendants owned by OTHER org members; checking only this editor's namespace
    // would let an org parent edit break another member's private child.
    const descendants = await all<ProfileRow>(c.env, `WITH RECURSIVE affected(id) AS (
      SELECT id FROM profiles WHERE parent_id=? UNION SELECT p.id FROM profiles p JOIN affected a ON p.parent_id=a.id
    ) SELECT p.* FROM profiles p JOIN affected a ON p.id=a.id LIMIT 501`, target);
    if (descendants.length > 500) return fail(409, "profile_limit");
    for (const other of descendants) {
      if (namespaceAccess(c, other.namespace)) {
        if (policy?.enforcement_default !== "required" || other.namespace === policy.namespace) resolved(c, other.id, input);
      } else {
        const owner = await one<{ org_id: string | null; org_name: string | null; org_namespace: string | null; policy_json: string | null }>(c.env,
          "SELECT a.org_id,o.name AS org_name,o.namespace AS org_namespace,o.policy_json FROM accounts a LEFT JOIN orgs o ON o.id=a.org_id WHERE a.namespace=?", other.namespace);
        if (!owner) return fail(422, "profile_owner_invalid");
        if (owner.org_namespace !== ns) continue; // Former members already lost access to this parent.
        const ownerPolicy = owner.org_id ? OrgPolicyInputSchema.parse({
          ...JSON.parse(owner.policy_json ?? "{}") as object, org_id: owner.org_id, org_name: owner.org_name, namespace: owner.org_namespace,
        }) : null;
        if (ownerPolicy?.enforcement_default === "required") continue; // This private leaf is already unavailable under policy.
        const ownerSources = await sourcesFor(c.env, other.namespace, owner.org_namespace ?? "");
        const updated: ResolutionSources = { ...ownerSources, profiles: { ...ownerSources.profiles, [target]: { yaml, signed: true, origin: "synced" } } };
        try { resolveProfile(other.id, updated, { policy: ownerPolicy }); }
        catch { return fail(422, "profile_resolution_failed"); }
      }
    }
    const signature = await sign(c.env, yaml), etag = `"${await digest(yaml)}"`, now = Date.now();
    const parent = parsed.value.extends && !parsed.value.extends.startsWith("local/") ? parsed.value.extends : null;
    stage(c, "INSERT INTO profiles(id,namespace,version,name,yaml,signature,etag,parent_id,updated_at) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET version=excluded.version,name=excluded.name,yaml=excluded.yaml,signature=excluded.signature,etag=excluded.etag,parent_id=excluded.parent_id,updated_at=excluded.updated_at",
      target, ns, version, parsed.value.name, yaml, signature, etag, parent, now);
    stage(c, "INSERT INTO profile_versions VALUES(?,?,?,?,?)", target, version, yaml, signature, now);
    audit(c, "profile.edit", target);
    return response({ version, signature, resolution, etag }, 200, { ETag: etag });
  });
  app.delete("/v1/profiles/:namespace/:slug", async (c) => {
    dashboard(c); parse(c, Empty);
    const row = await getProfile(c, true);
    if (c.req.header("If-Match") && c.req.header("If-Match") !== row.etag) return fail(412, "etag_mismatch");
    if (await one(c.env, "SELECT id FROM profiles WHERE parent_id=? LIMIT 1", row.id)) return fail(409, "profile_extended");
    stage(c, "DELETE FROM profiles WHERE id=?", row.id);
    stage(c, "DELETE FROM profile_versions WHERE id=?", row.id);
    stage(c, "UPDATE accounts SET default_profile=NULL WHERE default_profile=?", row.id);
    audit(c, "profile.delete", row.id);
    return response(null, 204);
  });
  app.put("/v1/profiles/:namespace/:slug/sharing", async (c) => {
    dashboard(c); const body = parse(c, Sharing), row = await getProfile(c, true);
    if (body.enabled && c.get("principal").policy?.sharing_allowed === false) return fail(403, "sharing_forbidden");
    stage(c, "UPDATE profiles SET sharing_enabled=? WHERE id=?", Number(body.enabled), row.id);
    audit(c, "profile.sharing", row.id);
    return response({ enabled: body.enabled });
  });
}
