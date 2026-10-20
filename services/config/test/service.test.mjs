import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Miniflare } from "miniflare";
import { generateKeyPair, exportJWK, SignJWT } from "jose";
import { createHash, randomUUID, webcrypto } from "node:crypto";
import { readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parse, stringify } from "yaml";
import { FindingSchema, findingId } from "@prosegate/schema";
import { aggregateAndRetain, ingestTelemetry } from "../src/telemetry.ts";
import { pollKeys, revokePending, deliverNotifications, vendingEnabled } from "../src/keys.ts";
import { scheduled } from "../src/index.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const hash = (s) => createHash("sha256").update(s).digest("hex");
const json = (body, status = 200) => new globalThis.Response(JSON.stringify(body), { status });
let mf, db, signing, oidc, publicJwk, a, b, org, key, deviceId, jwt, otherJwt, adminCalls, secrets, usage, adminFails;
async function sql(query, ...args) { return db.prepare(query).bind(...args).run(); }
async function first(query, ...args) { return db.prepare(query).bind(...args).first(); }
async function token(subject, claims = { amr: ["mfa"] }) {
  return new SignJWT(claims).setProtectedHeader({ alg: "ES256", kid: "test" }).setSubject(subject).setIssuer("https://auth.test").setAudience("prosegate").setIssuedAt().setExpirationTime("10m").sign(oidc.privateKey);
}
async function fakeAdmin(req) {
  const path = new URL(req.url).pathname; adminCalls.push({ method: req.method, path });
  if (adminFails) return json({}, 503);
  if (req.method === "PUT") {
    const body = await req.json(), secret = randomUUID() + randomUUID(); secrets.push(secret);
    expect(body.cap_cents).toBe(500);
    expect(body.model).toBe("gpt-5.4-mini-2026-03-17");
    return json({ key: secret, project_id: `project_${body.account_id}` });
  }
  if (req.method === "DELETE") return new globalThis.Response(null, { status: 204 });
  if (path.endsWith("/usage")) return json(usage);
  return json({}, 404);
}
function req(path, { method = "GET", body, auth = jwt, idem = randomUUID(), headers = {} } = {}) {
  return mf.dispatchFetch(`https://config.test/v1${path}`, {
    method, headers: { ...(auth ? { Authorization: `Bearer ${auth}` } : {}),
      ...(method !== "GET" ? { "Content-Type": "application/json", "Idempotency-Key": idem } : {}), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
function yaml(profileId, extra = {}) { return stringify({ schema: "prosegate.profile/1", id: profileId, version: 1, name: "Team prose", extends: "local/pr-description", ...extra }); }
async function putProfile(profileId = `${a}/docs`, extra = {}) {
  const r = await req(`/profiles/${profileId}`, { method: "PUT", body: { yaml: yaml(profileId, extra) } });
  expect(await r.clone().json()).not.toHaveProperty("code"); expect(r.status).toBe(200); return r;
}
const env = () => ({ DB: db, REVIEWER_ADMIN: { fetch: (url, options) => fakeAdmin(new globalThis.Request(url, options)) } });
beforeAll(async () => {
  execFileSync(process.execPath, ["build.mjs"], { cwd: root });
  signing = await webcrypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]);
  oidc = await generateKeyPair("ES256", { extractable: true });
  publicJwk = { ...await exportJWK(oidc.publicKey), kid: "test" };
  mf = new Miniflare({
    modules: true, scriptPath: `${root}/dist/worker.js`, compatibilityDate: "2026-07-30",
    d1Databases: { DB: "config-test" }, queueProducers: { TELEMETRY: "telemetry" },
    serviceBindings: { REVIEWER_ADMIN: fakeAdmin },
    bindings: { DASHBOARD_ORIGIN: "https://dashboard.test", OIDC_ISSUER: "https://auth.test",
      OIDC_AUDIENCE: "prosegate", OIDC_JWKS: JSON.stringify({ keys: [publicJwk] }),
      SIGNING_KEY: JSON.stringify(await webcrypto.subtle.exportKey("jwk", signing.privateKey)),
      PUBLISH_TOKEN: "test-publisher-token", VENDING_EXPOSURE_ACCEPTED: "accepted-s2" },
  });
  db = await mf.getD1Database("DB");
  const migration = await readFile(`${root}/migrations/0001_config.sql`, "utf8");
  for (const statement of migration.split(";").filter((s) => s.trim())) await db.prepare(statement).run();
}, 60000);
afterAll(async () => { await mf?.dispose(); });
beforeEach(async () => {
  a = `a${randomUUID().slice(0, 8)}`; b = `b${randomUUID().slice(0, 8)}`; org = `o${randomUUID().slice(0, 8)}`;
  adminCalls = []; secrets = []; adminFails = false; usage = { usage_cents: 10, daily_cents: 2, trailing_daily_cents: 10 };
  for (const name of [a, b, org]) await sql("INSERT INTO namespaces VALUES(?,?)", name, name);
  await sql("INSERT INTO orgs(id,namespace,name) VALUES(?,?,?)", org, org, "Team");
  for (const name of [a, b]) await sql("INSERT INTO accounts(id,auth_subject,namespace,plan,org_id,publisher) VALUES(?,?,?,'paid',?,1)", name, name, name, name === a ? org : null);
  await sql("INSERT INTO org_members VALUES(?,?,'admin')", org, a);
  key = `pgd_${randomUUID()}${randomUUID()}`; deviceId = randomUUID();
  await sql("INSERT INTO devices VALUES(?,?,?,?,?,?,NULL)", deviceId, a, "Laptop", hash(key), Date.now(), Date.now());
  jwt = await token(a); otherJwt = await token(b);
});

describe("real Worker + D1 integration", () => {
  it("authenticates device hashes and signed MFA sessions, rejects missing/revoked/foreign identity", async () => {
    expect((await req("/me", { auth: key })).status).toBe(200);
    expect((await req("/me", { auth: "" })).status).toBe(401);
    expect((await req("/me", { auth: await token(a, { amr: ["pwd"] }) })).status).toBe(403);
    expect((await req("/me", { auth: await token("unregistered") })).status).toBe(403);
    expect((await req("/me", { headers: { Origin: "https://other.test" } })).status).toBe(403);
    const cors = await req("/me", { headers: { Origin: "https://dashboard.test" } });
    expect(cors.headers.get("Access-Control-Allow-Origin")).toBe("https://dashboard.test");
    expect(cors.headers.get("X-Content-Type-Options")).toBe("nosniff");
    const corsError = await req("/me", { auth: "", headers: { Origin: "https://dashboard.test" } });
    expect(corsError.status).toBe(401); expect(corsError.headers.get("Access-Control-Allow-Origin")).toBe("https://dashboard.test");
    expect((await req("/me", { method: "OPTIONS", auth: "", headers: { Origin: "https://dashboard.test" } })).status).toBe(204);
    expect((await req(`/devices/${deviceId}`, { method: "DELETE", auth: otherJwt })).status).toBe(404);
    expect((await req(`/devices/${deviceId}`, { method: "DELETE" })).status).toBe(204);
    expect((await req("/me", { auth: key })).status).toBe(401);
  });
  it("enforces body size, JSON content type, idempotency headers and strict fields", async () => {
    const body = { name: "Laptop", platform: "win32", adapter_version: "0.1.0" };
    expect((await req("/device-codes", { method: "POST", body: { ...body, draft: "no" }, auth: "" })).status).toBe(422);
    expect((await req("/device-codes", { method: "POST", body, auth: "", idem: "" })).status).toBe(422);
    expect((await req("/device-codes", { method: "POST", body, auth: "", headers: { "Content-Type": "text/plain" } })).status).toBe(415);
    expect((await req("/device-codes", { method: "POST", body: { ...body, name: "x".repeat(360 * 1024) }, auth: "" })).status).toBe(413);
  });
  it("rejects unknown fields on every mutating route before making any change", async () => {
    const internal = "test-publisher-token";
    const routes = [
      ["POST", "/device-codes", "", { name: "Laptop", platform: "linux", adapter_version: "0.1.0" }],
      ["POST", "/devices/claim", "", { device_code: "a".repeat(43) }],
      ["POST", "/device-codes/approve", jwt, { user_code: "ABCD-EFGH" }],
      ["DELETE", `/devices/${deviceId}`, jwt, {}],
      ["PUT", `/profiles/${a}/docs`, jwt, { yaml: yaml(`${a}/docs`) }],
      ["POST", `/profiles/${a}/docs/preview`, jwt, { yaml: yaml(`${a}/docs`) }],
      ["DELETE", `/profiles/${a}/docs`, jwt, {}],
      ["PUT", `/profiles/${a}/docs/sharing`, jwt, { enabled: true }],
      ["PUT", `/rule-packs/${a}/1.0.0`, jwt, { yaml: "invalid" }],
      ["POST", "/internal/publish-jobs/claim", internal, {}],
      ["POST", `/internal/publish-jobs/${randomUUID()}/result`, internal, {}],
      ["PUT", "/internal/reviewer-prompts/v1", internal, { text: "Review.", supported_models: ["gpt-5.4-mini-2026-03-17"] }],
      ["PUT", `/orgs/${org}/members/${b}`, jwt, { role: "member" }],
      ["DELETE", `/orgs/${org}/members/${b}`, jwt, {}],
      ["PUT", `/orgs/${org}/policy`, jwt, {}],
      ["POST", "/reviewer-keys/vend", key, { provider: "openai" }],
      ["POST", `/reviewer-keys/${randomUUID()}/revoke`, key, {}],
      ["POST", "/reviewer-keys/confirm-account", jwt, {}],
      ["POST", "/telemetry", key, { events: [] }],
      ["POST", "/samples", key, {}],
      ["DELETE", `/samples/${randomUUID()}`, jwt, {}],
    ];
    const before = await first("SELECT revision FROM state_revision");
    for (const [method, path, auth, body] of routes) {
      const result = await req(path, { method, auth, body: { ...body, unexpected_draft: "private words" } });
      expect(result.status, `${method} ${path}`).toBe(422);
      expect(await result.text()).not.toContain("private words");
    }
    expect(await first("SELECT revision FROM state_revision")).toEqual(before);
  });
  it("completes device approval, throttles polling, and never stores or replays its one-time key", async () => {
    const idem = randomUUID(), body = { name: "Laptop", platform: "win32", adapter_version: "0.1.0" };
    const created = await req("/device-codes", { method: "POST", body, auth: "", idem });
    expect(created.status).toBe(201); const code = await created.json();
    expect((await req("/device-codes", { method: "POST", body, auth: "", idem })).status).toBe(409);
    expect((await req("/devices/claim", { method: "POST", body: { device_code: code.device_code }, auth: "" })).status).toBe(400);
    const throttled = await req("/devices/claim", { method: "POST", body: { device_code: code.device_code }, auth: "" });
    expect(throttled.status).toBe(429); expect(throttled.headers.get("Retry-After")).toBe("5");
    expect(await throttled.json()).toMatchObject({ type: "urn:prosegate:problem:slow_down", code: "slow_down", status: 429 });
    expect((await req("/device-codes/approve", { method: "POST", body: { user_code: code.user_code } })).status).toBe(200);
    await sql("UPDATE device_codes SET next_poll=0 WHERE code_hash=?", hash(code.device_code));
    const claimId = randomUUID(), claimed = await req("/devices/claim", { method: "POST", auth: "", idem: claimId, body: { device_code: code.device_code } });
    expect(claimed.status).toBe(200); const credential = await claimed.json();
    expect((await req("/me", { auth: credential.device_key })).status).toBe(200);
    expect((await req("/devices/claim", { method: "POST", auth: "", idem: claimId, body: { device_code: code.device_code } })).status).toBe(409);
    expect((await first("SELECT key_hash FROM devices WHERE id=?", credential.device_id)).key_hash).toBe(hash(credential.device_key));
    const cache = await db.prepare("SELECT response_body FROM idempotency").all();
    expect(JSON.stringify(cache)).not.toContain(credential.device_key);
    expect((await req("/devices")).status).toBe(200);
  });
  it("previews unsaved profiles without persistence and protects dashboard edits with preconditions", async () => {
    const target = `${a}/draft`, path = `/profiles/${target}`;
    const before = await first("SELECT revision FROM state_revision");
    const preview = await req(`${path}/preview`, { method: "POST", body: { yaml: yaml(target) } });
    expect(preview.status).toBe(200);
    expect(await first("SELECT revision FROM state_revision")).toEqual(before);
    expect(await first("SELECT id FROM profiles WHERE id=?", target)).toBeNull();
    const bad = await req(`${path}/preview`, { method: "POST", body: { yaml: yaml(target, { version: 0 }) } });
    expect(bad.status).toBe(422); expect((await bad.json()).issues.length).toBeGreaterThan(0);
    expect((await req(`${path}/preview`, { method: "POST", auth: otherJwt, body: { yaml: yaml(target) } })).status).toBe(403);
    expect((await req(`${path}/preview`, { method: "POST", auth: key, body: { yaml: yaml(target) } })).status).toBe(403);
    const body = { yaml: yaml(target) }, idem = randomUUID();
    expect((await req(path, { method: "PUT", body, idem, headers: { "If-None-Match": "*" } })).status).toBe(200);
    expect((await req(path, { method: "PUT", body, headers: { "If-None-Match": "*" } })).status).toBe(412);
    expect((await req(path, { method: "PUT", body, idem })).status).toBe(409);
    expect((await req(path, { method: "DELETE", headers: { "If-Match": '"stale"' } })).status).toBe(412);
    expect(await (await req(path)).json()).toMatchObject({ sharing_enabled: false });
    expect(await (await req("/me")).json()).toMatchObject({ org: { role: "admin" }, account_flagged: false });
    const original = await (await req(`/orgs/${org}/policy`)).json();
    expect((await req(`/orgs/${org}/policy`, { method: "PUT", body: { sharing_allowed: false }, headers: { "If-Match": original.etag } })).status).toBe(200);
    expect((await req(`/orgs/${org}/policy`, { method: "PUT", body: { sharing_allowed: true }, headers: { "If-Match": original.etag } })).status).toBe(412);
  });
  it("expires unclaimed device codes and rejects a modified dashboard signature", async () => {
    const created = await req("/device-codes", { method: "POST", auth: "", body: { name: "Laptop", platform: "linux", adapter_version: "0.1.0" } });
    const code = await created.json();
    await sql("UPDATE device_codes SET expires_at=0 WHERE code_hash=?", hash(code.device_code));
    expect((await req("/devices/claim", { method: "POST", auth: "", body: { device_code: code.device_code } })).status).toBe(410);
    expect((await req("/device-codes/approve", { method: "POST", body: { user_code: code.user_code } })).status).toBe(410);
    const parts = jwt.split("."); parts[2] = (parts[2].startsWith("a") ? "b" : "a") + parts[2].slice(1);
    expect((await req("/me", { auth: parts.join(".") })).status).toBe(401);
  });
  it("signs exact stored profile bytes, honors ETags and idempotency without incrementing twice", async () => {
    const target = `${a}/docs`, idem = randomUUID(), body = { yaml: yaml(target) };
    expect((await req(`/profiles/${target}`, { method: "PUT", body, idem })).status).toBe(200);
    expect((await req(`/profiles/${target}`, { method: "PUT", body, idem })).status).toBe(200);
    const fetched = await req(`/profiles/${target}`), stored = await fetched.json();
    expect(stored.version).toBe(1);
    expect(await webcrypto.subtle.verify("Ed25519", signing.publicKey, Buffer.from(stored.signature, "base64"), Buffer.from(stored.yaml))).toBe(true);
    expect((await req(`/profiles/${target}`, { headers: { "If-None-Match": stored.etag } })).status).toBe(304);
    expect((await req(`/profiles/${target}`, { method: "PUT", body, headers: { "If-Match": '"wrong"' } })).status).toBe(412);
    expect((await req(`/profiles/${target}`, { method: "PUT", body: { yaml: yaml(target, { name: "Other" }) }, idem })).status).toBe(409);
    expect((await req(`/profiles/${target}/resolved`)).status).toBe(200);
    expect((await req(`/profiles/${target}`, { auth: otherJwt })).status).toBe(404);
    expect((await req(`/profiles/${target}`, { method: "PUT", auth: key, body })).status).toBe(403);
    expect((await (await req("/profiles", { auth: otherJwt })).json()).profiles).toEqual([]);
  });
  it("rejects cycles, unresolved packs, private org parents and deleting extended profiles", async () => {
    await putProfile(`${a}/docs`, { extends: "local/base" }); await putProfile(`${a}/child`, { extends: `${a}/docs` });
    expect((await req(`/profiles/${a}/docs`, { method: "DELETE" })).status).toBe(409);
    expect((await req(`/profiles/${a}/docs`, { method: "PUT", body: { yaml: yaml(`${a}/docs`, { extends: `${a}/child` }) } })).status).toBe(422);
    expect((await req(`/profiles/${org}/docs`, { method: "PUT", body: { yaml: yaml(`${org}/docs`, { extends: `${a}/docs` }) } })).status).toBe(422);
    expect((await req(`/profiles/${a}/missing`, { method: "PUT", body: { yaml: yaml(`${a}/missing`, { rule_packs: [{ id: "unknown", version: "^1.0.0" }] }) } })).status).toBe(422);
    expect((await req(`/profiles/${a}/child`, { method: "DELETE" })).status).toBe(204);
    expect((await req(`/profiles/${a}/docs`, { method: "DELETE" })).status).toBe(204);
    expect((await first("SELECT COUNT(*) AS n FROM profile_versions WHERE id=?", `${a}/docs`)).n).toBe(0);
  });
  it("serializes concurrent profile writes with no lost version or partial audit", async () => {
    const target = `${a}/docs`;
    const responses = await Promise.all(Array.from({ length: 4 }, () => req(`/profiles/${target}`, { method: "PUT", body: { yaml: yaml(target) } })));
    const successes = responses.filter((r) => r.status === 200).length;
    expect(successes).toBeGreaterThan(0);
    expect(responses.every((r) => [200, 409].includes(r.status))).toBe(true);
    expect((await first("SELECT COUNT(*) AS n FROM profile_versions WHERE id=?", target)).n).toBe(successes);
    expect((await first("SELECT COUNT(*) AS n FROM audit_log WHERE target=? AND action='profile.edit'", target)).n).toBe(successes);
  });
  it("validates another member's private descendants when editing an org parent", async () => {
    await req(`/orgs/${org}/members/${b}`, { method: "PUT", body: { role: "member" } });
    await putProfile(`${org}/parent`, { extends: "local/base" });
    const child = await req(`/profiles/${b}/child`, { method: "PUT", auth: otherJwt, body: { yaml: yaml(`${b}/child`, { extends: `${org}/parent` }) } });
    expect(child.status).toBe(200);
    // This would push the other member's chain beyond the three-profile maximum.
    expect((await req(`/profiles/${org}/parent`, { method: "PUT", body: { yaml: yaml(`${org}/parent`) } })).status).toBe(422);
    expect((await first("SELECT version FROM profiles WHERE id=?", `${org}/parent`)).version).toBe(1);
  });
  it("runs publish leases separately and only distributes packs that pass every declared example and latency", async () => {
    const pack = parse(await readFile(`${root}/../../packages/profiles/bundled/packs/core.yaml`, "utf8"));
    pack.id = a; pack.rules = [pack.rules[0]]; pack.rules[0].id = `${a}.filler.001`;
    expect((await req(`/rule-packs/${a}/0.1.0`, { method: "PUT", body: { yaml: stringify(pack), draft: "private words" } })).status).toBe(422);
    const submitted = await req(`/rule-packs/${a}/0.1.0`, { method: "PUT", body: { yaml: stringify(pack) } });
    expect(submitted.status).toBe(202); const jobId = (await submitted.json()).job_id;
    expect((await req(`/rule-packs/${a}/0.1.0`)).status).toBe(404);
    const job = (await (await req("/internal/publish-jobs/claim", { method: "POST", auth: "test-publisher-token" })).json()).job;
    const count = pack.rules[0].examples.hit.length + pack.rules[0].examples.miss.length;
    const report = { lease_token: job.lease_token, content_hash: job.content_hash, passed: true, examples_pass: count, examples_total: count, latency_p95_ms: 2, engine_version: "0.0.0" };
    expect((await req(`/internal/publish-jobs/${jobId}/result`, { method: "POST", auth: "test-publisher-token", body: { ...report, extra: "private words" } })).status).toBe(422);
    expect((await req(`/internal/publish-jobs/${jobId}/result`, { method: "POST", auth: "test-publisher-token", body: { ...report, content_hash: "0".repeat(64) } })).status).toBe(409);
    expect((await req(`/internal/publish-jobs/${jobId}/result`, { method: "POST", auth: "test-publisher-token", body: report })).status).toBe(200);
    const published = await (await req(`/rule-packs/${a}/0.1.0`)).json();
    expect(await webcrypto.subtle.verify("Ed25519", signing.publicKey, Buffer.from(published.signature, "base64"), Buffer.from(published.yaml))).toBe(true);
    expect((await (await req(`/publish-jobs/${jobId}`)).json()).status).toBe("passed");
    expect((await req(`/publish-jobs/${jobId}`, { auth: otherJwt })).status).toBe(404);
    expect((await req(`/rule-packs/${a}/0.1.0`, { method: "PUT", body: { yaml: stringify(pack) } })).status).toBe(409);
    expect((await req("/rule-packs")).status).toBe(200);
  });
  it("publishes immutable signed prompts through the internal credential only", async () => {
    const version = randomUUID(), body = { text: "Review the supplied prose.", supported_models: ["gpt-5.4-mini-2026-03-17"] };
    expect((await req(`/internal/reviewer-prompts/${version}`, { method: "PUT", body })).status).toBe(401);
    expect((await req(`/internal/reviewer-prompts/${version}`, { method: "PUT", auth: "test-publisher-token", body })).status).toBe(201);
    expect((await req(`/internal/reviewer-prompts/${version}`, { method: "PUT", auth: "test-publisher-token", body })).status).toBe(409);
    const prompt = await (await req(`/reviewer-prompts/${version}`, { auth: key })).json();
    expect(await webcrypto.subtle.verify("Ed25519", signing.publicKey, Buffer.from(prompt.signature, "base64"), Buffer.from(prompt.text))).toBe(true);
  });
  it("does not publish a pack when the trusted evaluator reports a missed example or excessive latency", async () => {
    const pack = parse(await readFile(`${root}/../../packages/profiles/bundled/packs/core.yaml`, "utf8"));
    pack.id = a; pack.rules = [pack.rules[0]]; pack.rules[0].id = `${a}.filler.001`;
    for (const [version, ms, missed] of [["1.0.0", 201, 0], ["1.0.1", 1, 1]]) {
      pack.version = version;
      const submitted = await req(`/rule-packs/${a}/${version}`, { method: "PUT", body: { yaml: stringify(pack) } });
      expect(submitted.status).toBe(202);
      const job = (await (await req("/internal/publish-jobs/claim", { method: "POST", auth: "test-publisher-token" })).json()).job;
      const total = pack.rules[0].examples.hit.length + pack.rules[0].examples.miss.length;
      const result = await req(`/internal/publish-jobs/${job.id}/result`, { method: "POST", auth: "test-publisher-token",
        body: { lease_token: job.lease_token, content_hash: job.content_hash, passed: true, examples_pass: total - missed, examples_total: total, latency_p95_ms: ms, engine_version: "0.0.0" } });
      expect((await result.json()).status).toBe("failed");
      expect((await req(`/rule-packs/${a}/${version}`)).status).toBe(404);
    }
  });
  it("restricts members and policy to admins, protects the last admin, signs identity with policy", async () => {
    expect((await req(`/orgs/${org}/members`, { auth: otherJwt })).status).toBe(403);
    expect((await req(`/orgs/${org}/members/${a}`, { method: "PUT", body: { role: "member" } })).status).toBe(409);
    expect((await req(`/orgs/${org}/members/${a}`, { method: "DELETE" })).status).toBe(409);
    expect((await req(`/orgs/${org}/members/${b}`, { method: "PUT", body: { role: "member" } })).status).toBe(200);
    expect((await req(`/orgs/${org}/policy`, { method: "PUT", body: { byok_required: true, sharing_allowed: false, allowed_providers: ["openai"] } })).status).toBe(200);
    const policy = await (await req(`/orgs/${org}/policy`, { auth: key })).json();
    expect(policy.policy.org_id).toBe(org); expect(policy.policy.byok_required).toBe(true);
    expect((await req(`/orgs/${org}/policy`, { method: "PUT", auth: otherJwt, body: {} })).status).toBe(403);
    expect((await req(`/orgs/${org}/policy`, { method: "PUT", body: { extra: "text" } })).status).toBe(422);
    expect((await req(`/orgs/${org}/policy`, { headers: { "If-None-Match": policy.etag } })).status).toBe(304);
    expect((await req(`/orgs/${org}/members/${b}`, { method: "DELETE" })).status).toBe(204);
  });
  it("rejects injected telemetry fields and timestamps, stamps identity, deduplicates Queue retries", async () => {
    const event = { ts: Math.floor(Date.now() / 60000) * 60000, t: "review", profile_id: "local", pass: 1, verdict: "pass", prose_words_bucket: 100, by_category: { filler: 2 }, rule_ids: [], cleared: 0, cleared_categories: [] };
    for (const body of [{ events: [event], text: "draft" }, { events: [{ ...event, account_id: b }] }, { events: [{ ...event, by_category: { filler: 1, text: "draft" } }] }, { events: [{ ...event, ts: event.ts - 2 * 86400000 }] }]) {
      expect((await req("/telemetry", { method: "POST", auth: key, body })).status).toBe(422);
    }
    expect((await req("/telemetry", { method: "POST", body: { events: [event] } })).status).toBe(403);
    expect((await req("/telemetry", { method: "POST", auth: key, body: { events: [event] } })).status).toBe(202);
    const row = await first("SELECT * FROM telemetry_outbox WHERE account_id=?", a);
    expect(JSON.parse(row.payload)[0].account_id).toBe(a);
    const ack = vi.fn(), retry = vi.fn(), batch = { messages: [{ body: { id: row.id }, ack, retry }] };
    await ingestTelemetry(batch, { DB: db }); await ingestTelemetry(batch, { DB: db });
    expect(ack).toHaveBeenCalledTimes(2); expect(retry).not.toHaveBeenCalled();
    expect((await first("SELECT COUNT(*) AS n FROM telemetry_events WHERE account_id=?", a)).n).toBe(1);
    await aggregateAndRetain({ DB: db }); await aggregateAndRetain({ DB: db });
    const data = await (await req("/dashboard/usage")).json();
    expect(data.usage.find((r) => r.category === "filler").count).toBe(2);
    expect((await req("/dashboard/usage?from=2026-02-30")).status).toBe(422);
    expect((await (await req("/dashboard/usage", { auth: otherJwt })).json()).usage).toEqual([]);
  });
  it("keeps samples off by default, redacts every free-text field, enforces quota and account deletion rights", async () => {
    await putProfile();
    const span = "Great question";
    const finding = { id: findingId("filler", "core.filler.001", span), span: { segment_id: "s1", text: span }, category: "filler", source: "rule", rule_id: "core.filler.001", severity: "block", confidence: 1, instruction: { action: "remove", text: "Remove the preamble." }, evidence: null, profile_origin: `${a}/docs` };
    expect(FindingSchema.safeParse({ ...finding, span: { ...finding.span, start: 0, end: span.length } }).success).toBe(true);
    const body = { profile_id: `${a}/docs`, pass: 1, finding, excerpt: `Great question alice@example.test https://example.test 123456 ${"pg" + "d_"}${"x".repeat(32)}` };
    expect((await req("/samples", { method: "POST", auth: key, body: { ...body, extra: "private words" } })).status).toBe(422);
    expect((await req("/samples", { method: "POST", auth: key, body })).status).toBe(403);
    expect((await req(`/profiles/${a}/docs/sharing`, { method: "PUT", body: { enabled: true } })).status).toBe(200);
    expect((await req("/samples", { method: "POST", auth: key, body: { ...body, finding: { ...finding, span: { ...finding.span, start: 0 } } } })).status).toBe(422);
    expect((await req("/samples", { method: "POST", auth: key, body })).status).toBe(202);
    const sample = (await (await req("/samples")).json()).samples[0];
    expect(sample.excerpt).toBe("Great question [email] [url] [number] [secret]");
    expect((await req(`/samples/${sample.id}`, { method: "DELETE", auth: otherJwt })).status).toBe(404);
    await sql("UPDATE request_limits SET count=20 WHERE bucket LIKE ?", `samples:${deviceId}:%`);
    expect((await req("/samples", { method: "POST", auth: key, body })).status).toBe(429);
    expect((await req(`/samples/${sample.id}`, { method: "DELETE" })).status).toBe(204);
  });
  it("vends once through the gated admin binding; replay, metadata and D1 never expose a second copy", async () => {
    expect(vendingEnabled({})).toBe(false);
    const idem = randomUUID(), body = { provider: "openai" };
    const r = await req("/reviewer-keys/vend", { method: "POST", auth: key, idem, body });
    expect(r.status).toBe(201); const value = await r.json();
    expect(value.key).toBe(secrets[0]);
    expect((await req("/reviewer-keys/vend", { method: "POST", auth: key, idem, body })).status).toBe(409);
    expect((await req("/reviewer-keys/vend", { method: "POST", auth: key, body })).status).toBe(409);
    expect(adminCalls.filter((r) => r.method === "PUT")).toHaveLength(1);
    expect(JSON.stringify(await (await req("/reviewer-keys")).json())).not.toContain(value.key);
    expect(JSON.stringify(await first("SELECT * FROM reviewer_keys WHERE key_id=?", value.key_id))).not.toContain(value.key);
    expect(JSON.stringify(await db.prepare("SELECT * FROM idempotency").all())).not.toContain(value.key);
    expect((await req(`/reviewer-keys/${value.key_id}/revoke`, { method: "POST", auth: otherJwt })).status).toBe(404);
    expect((await req(`/reviewer-keys/${value.key_id}/revoke`, { method: "POST", auth: key })).status).toBe(204);
    await revokePending(env());
    expect((await first("SELECT status FROM reviewer_keys WHERE key_id=?", value.key_id)).status).toBe("revoked");
  });
  it("blocks free plans, BYOK policy, unsupported vending providers and excess daily vends", async () => {
    const vend = (provider = "openai") => req("/reviewer-keys/vend", { method: "POST", auth: key, body: { provider } });
    expect((await vend("anthropic")).status).toBe(503);
    await sql("UPDATE accounts SET plan='free' WHERE id=?", a);
    expect((await vend()).status).toBe(402);
    await sql("UPDATE accounts SET plan='paid' WHERE id=?", a);
    await req(`/orgs/${org}/policy`, { method: "PUT", body: { byok_required: true } });
    expect((await vend()).status).toBe(403);
    await req(`/orgs/${org}/policy`, { method: "PUT", body: {} });
    await sql("INSERT INTO request_limits VALUES(?,3,?)", `vends:${a}:${Math.floor(Date.now() / 86400000)}`, Date.now() + 86400000);
    expect((await vend()).status).toBe(429);
  });
  it("allows only one provider create when concurrent vends race for the same device", async () => {
    const results = await Promise.all(Array.from({ length: 3 }, () => req("/reviewer-keys/vend", { method: "POST", auth: key, body: { provider: "openai" } })));
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.every((r) => [201, 409].includes(r.status))).toBe(true);
    expect(adminCalls.filter((r) => r.method === "PUT")).toHaveLength(1);
    // Keep this test's key out of later tests' scheduled polling.
    await sql("UPDATE reviewer_keys SET status='revoking' WHERE account_id=?", a);
    await revokePending(env());
  });
  it("recovers an unknown provider outcome by revoking its durable reservation", async () => {
    adminFails = true;
    expect((await req("/reviewer-keys/vend", { method: "POST", auth: key, body: { provider: "openai" } })).status).toBe(503);
    const reservation = await first("SELECT * FROM reviewer_keys WHERE account_id=?", a);
    expect(reservation.status).toBe("provisioning");
    await sql("UPDATE reviewer_keys SET created_at=? WHERE key_id=?", Date.now() - 3600000, reservation.key_id);
    await revokePending(env());
    expect((await first("SELECT status FROM reviewer_keys WHERE key_id=?", reservation.key_id)).status).toBe("provisioning");
    adminFails = false; await revokePending(env());
    expect((await first("SELECT status FROM reviewer_keys WHERE key_id=?", reservation.key_id)).status).toBe("revoked");
  });
  it("polls burn, suspends stale keys, confirms revocation, flags accounts and retries notifications", async () => {
    const result = await req("/reviewer-keys/vend", { method: "POST", auth: key, body: { provider: "openai" } });
    const value = await result.json();
    await sql("UPDATE reviewer_keys SET polled_at=? WHERE key_id=?", Date.now() - 3 * 3600000, value.key_id);
    adminFails = true; await pollKeys(env());
    expect((await first("SELECT status FROM reviewer_keys WHERE key_id=?", value.key_id)).status).toBe("suspended");
    adminFails = false; usage = { usage_cents: 499, daily_cents: 100, trailing_daily_cents: 10 };
    await pollKeys(env());
    expect((await first("SELECT status FROM reviewer_keys WHERE key_id=?", value.key_id)).status).toBe("revoked");
    expect((await first("SELECT flagged FROM accounts WHERE id=?", a)).flagged).toBe(1);
    const sent = vi.fn(async () => new globalThis.Response(null, { status: 204 }));
    await deliverNotifications({ DB: db, NOTIFICATIONS: { fetch: sent } });
    await deliverNotifications({ DB: db, NOTIFICATIONS: { fetch: sent } });
    expect(sent.mock.calls.filter(([, options]) => JSON.parse(options.body).account_id === a)).toHaveLength(1);
    expect((await req("/reviewer-keys/confirm-account", { method: "POST" })).status).toBe(204);
    expect((await first("SELECT flagged FROM accounts WHERE id=?", a)).flagged).toBe(0);
  });
  it("continues financial revocation when telemetry delivery is unavailable", async () => {
    const pending = randomUUID(), outbox = randomUUID(), now = Date.now();
    await sql("INSERT INTO reviewer_keys(key_id,account_id,device_id,provider,project_id,status,cap_cents,polled_at,created_at,expires_at) VALUES(?,?,?,'openai',?,'revoking',500,?,?,?)", pending, a, deviceId, a, now, now, now + 86400000);
    await sql("INSERT INTO telemetry_outbox VALUES(?,?,?,?,?)", outbox, a, deviceId, "[]", now);
    await expect(scheduled({ ...env(), TELEMETRY: { send: async () => { throw new Error("queue unavailable"); } } })).rejects.toThrow("scheduled_task_failed");
    expect((await first("SELECT status FROM reviewer_keys WHERE key_id=?", pending)).status).toBe("revoked");
    await sql("DELETE FROM telemetry_outbox WHERE id=?", outbox);
  });
  it("retains historical aggregates while removing old raw events and samples", async () => {
    await putProfile();
    const now = Date.now();
    await sql("INSERT INTO telemetry_events VALUES(?,?,?,?,?)", randomUUID(), a, deviceId, now - 181 * 86400000, "{}");
    await sql("INSERT INTO telemetry_daily VALUES(?,?,?,?,?)", a, "2020-01-01", "local", "filler", 4);
    await sql("INSERT INTO samples VALUES(?,?,?,?,?,?,?,?)", randomUUID(), a, deviceId, `${a}/docs`, 1, "example", "{}", now - 91 * 86400000);
    await aggregateAndRetain({ DB: db }, now);
    expect((await first("SELECT COUNT(*) AS n FROM telemetry_events WHERE account_id=?", a)).n).toBe(0);
    expect((await first("SELECT COUNT(*) AS n FROM samples WHERE account_id=?", a)).n).toBe(0);
    expect((await first("SELECT count FROM telemetry_daily WHERE account_id=?", a)).count).toBe(4);
  });
  it("runs the exported Queue consumer in workerd and aggregates delayed delivery exactly once", async () => {
    const runtime = new Miniflare({
      modules: true, scriptPath: `${root}/dist/worker.js`, compatibilityDate: "2026-07-30",
      d1Databases: { DB: "queue-runtime-test" }, queueProducers: { TELEMETRY: "runtime-events" },
      queueConsumers: { "runtime-events": { maxBatchTimeout: 0 } },
    });
    try {
      const queueDb = await runtime.getD1Database("DB");
      for (const statement of (await readFile(`${root}/migrations/0001_config.sql`, "utf8")).split(";").filter((s) => s.trim())) await queueDb.prepare(statement).run();
      const outboxId = randomUUID(), ts = Math.floor((Date.now() - 5 * 86400000) / 60000) * 60000;
      const event = { ts, t: "review", profile_id: "local", pass: 1, verdict: "pass", prose_words_bucket: 100, by_category: { filler: 3 }, rule_ids: [], cleared: 0, cleared_categories: [], account_id: a, device_id: deviceId };
      await queueDb.prepare("INSERT INTO telemetry_outbox VALUES(?,?,?,?,?)").bind(outboxId, a, deviceId, JSON.stringify([event]), Date.now() - 5 * 86400000).run();
      const queue = await runtime.getQueueProducer("TELEMETRY");
      await queue.send({ id: outboxId }); await queue.send({ id: outboxId });
      await vi.waitFor(async () => expect((await queueDb.prepare("SELECT COUNT(*) AS n FROM telemetry_events").first()).n).toBe(1), { timeout: 10000 });
      await aggregateAndRetain({ DB: queueDb }); await aggregateAndRetain({ DB: queueDb });
      expect((await queueDb.prepare("SELECT count FROM telemetry_daily WHERE account_id=?").bind(a).first()).count).toBe(3);
      expect((await queueDb.prepare("SELECT COUNT(*) AS n FROM telemetry_outbox").first()).n).toBe(0);
    } finally { await runtime.dispose(); }
  });
});
