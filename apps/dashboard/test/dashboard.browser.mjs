import { beforeAll, afterAll, beforeEach, afterEach, describe, it, expect } from "vitest";
import { chromium } from "playwright";
import { Miniflare } from "miniflare";
import { generateKeyPair, exportJWK, SignJWT } from "jose";
import { createServer } from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { readFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

// Real built browser app -> real workerd/D1, with an isolated, ephemeral OIDC issuer.
// No fixture auth code is bundled into the application.
const appRoot = fileURLToPath(new URL("..", import.meta.url));
const repo = fileURLToPath(new URL("../../..", import.meta.url));
const serviceRoot = `${repo}/services/config`;
const shots = `${repo}/.scratch/dashboard`;
const codes = new Map();
let server, origin, apiOrigin, mf, db, browser, context, page, signing, oidc;
let account, org, device, subject, mfa, badNonce, authRequests, tokenRequests, pageErrors, staticHeaders, responses;
const hash = (s) => createHash("sha256").update(s).digest("hex");
const sql = (query, ...args) => db.prepare(query).bind(...args).run();
const first = (query, ...args) => db.prepare(query).bind(...args).first();
const yaml = (id, name = "Team writing") => `schema: prosegate.profile/1\nid: ${id}\nversion: 1\nname: ${name}\nextends: local/pr-description\n`;
const sendJson = (res, value, status = 200) => res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" }).end(JSON.stringify(value));
async function jwt(nonce) {
  return new SignJWT({ amr: mfa ? ["pwd", "mfa"] : ["pwd"], ...(nonce ? { nonce } : {}) })
    .setProtectedHeader({ alg: "ES256", kid: "browser-test" }).setIssuer(`${origin}/oidc`).setAudience("dashboard-test")
    .setSubject(subject).setIssuedAt().setExpirationTime("10m").sign(oidc.privateKey);
}
async function request(path, method = "GET", body, headers = {}) {
  return mf.dispatchFetch(`${apiOrigin}/v1${path}`, { method,
    headers: { Authorization: `Bearer ${await jwt()}`, "Content-Type": "application/json", "Idempotency-Key": randomUUID(), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
async function serve(req, res) {
  const url = new URL(req.url, origin), path = url.pathname;
  if (path === "/oidc/.well-known/openid-configuration") {
    sendJson(res, { issuer: `${origin}/oidc`, authorization_endpoint: `${origin}/oidc/authorize`, token_endpoint: `${origin}/oidc/token`,
      jwks_uri: `${origin}/oidc/jwks`, response_types_supported: ["code"], subject_types_supported: ["public"],
      id_token_signing_alg_values_supported: ["ES256"], code_challenge_methods_supported: ["S256"], token_endpoint_auth_methods_supported: ["none"] }); return;
  }
  if (path === "/oidc/authorize") {
    authRequests++;
    if (url.searchParams.get("redirect_uri") !== `${origin}/auth/callback` || url.searchParams.get("client_id") !== "dashboard-test" ||
        url.searchParams.get("response_type") !== "code" || url.searchParams.get("code_challenge_method") !== "S256" ||
        !url.searchParams.get("nonce") || !url.searchParams.get("state")) { sendJson(res, {}, 400); return; }
    const code = randomUUID(); codes.set(code, Object.fromEntries(url.searchParams));
    res.writeHead(302, { Location: `${origin}/auth/callback?code=${code}&state=${encodeURIComponent(url.searchParams.get("state"))}` }).end(); return;
  }
  if (path === "/oidc/token") {
    tokenRequests++;
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = new globalThis.URLSearchParams(Buffer.concat(chunks).toString()), state = codes.get(body.get("code"));
    codes.delete(body.get("code"));
    if (!state || createHash("sha256").update(body.get("code_verifier") ?? "").digest("base64url") !== state.code_challenge ||
        body.get("client_id") !== "dashboard-test" || body.get("redirect_uri") !== `${origin}/auth/callback`) { sendJson(res, {}, 400); return; }
    sendJson(res, { id_token: await jwt(badNonce ? "wrong-nonce" : state.nonce), access_token: randomUUID(), token_type: "Bearer", expires_in: 600, scope: "openid profile" }); return;
  }
  if (path === "/oidc/jwks") { sendJson(res, { keys: [{ ...await exportJWK(oidc.publicKey), kid: "browser-test" }] }); return; }
  const files = { "/assets/app.js": "text/javascript", "/assets/app.css": "text/css", "/config.json": "application/json" };
  const known = Object.hasOwn(files, path);
  const bytes = await readFile(`${appRoot}/dist${known ? path : ["/privacy", "/privacy/", "/privacy.html"].includes(path) ? "/privacy.html" : "/index.html"}`);
  res.writeHead(200, { ...staticHeaders, "Content-Type": known ? files[path] : "text/html" }).end(bytes);
}
beforeAll(async () => {
  oidc = await generateKeyPair("ES256", { extractable: true });
  signing = await generateKeyPair("EdDSA", { extractable: true });
  server = createServer((req, res) => { void serve(req, res).catch(() => { if (!res.headersSent) sendJson(res, {}, 500); else res.end(); }); });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  execFileSync(process.execPath, ["build.mjs"], { cwd: serviceRoot });
  mf = new Miniflare({
    modules: true, scriptPath: `${serviceRoot}/dist/worker.js`, compatibilityDate: "2026-07-30",
    host: "127.0.0.1", port: 0, d1Databases: { DB: "dashboard-test" }, queueProducers: { TELEMETRY: "telemetry" },
    bindings: { DASHBOARD_ORIGIN: origin, OIDC_ISSUER: `${origin}/oidc`, OIDC_AUDIENCE: "dashboard-test",
      OIDC_JWKS: JSON.stringify({ keys: [{ ...await exportJWK(oidc.publicKey), kid: "browser-test" }] }),
      SIGNING_KEY: JSON.stringify(await exportJWK(signing.privateKey)) },
  });
  apiOrigin = (await mf.ready).origin;
  db = await mf.getD1Database("DB");
  for (const statement of (await readFile(`${serviceRoot}/migrations/0001_config.sql`, "utf8")).split(";").filter((s) => s.trim())) await db.prepare(statement).run();
  execFileSync(process.execPath, ["build.mjs"], { cwd: appRoot, env: { ...process.env,
    PROSEGATE_API_ORIGIN: apiOrigin, PROSEGATE_OIDC_AUTHORITY: `${origin}/oidc`, PROSEGATE_OIDC_CLIENT_ID: "dashboard-test",
    PROSEGATE_DASHBOARD_DEPLOY: "0" } });
  staticHeaders = Object.fromEntries((await readFile(`${appRoot}/dist/_headers`, "utf8")).split("\n").filter((line) => line.startsWith("  ")).map((line) => {
    const at = line.indexOf(":"); return [line.slice(0, at).trim(), line.slice(at + 1).trim()];
  }));
  browser = await chromium.launch({ headless: true });
  await mkdir(shots, { recursive: true });
}, 60000);
afterAll(async () => {
  await browser?.close(); await mf?.dispose();
  if (server) await new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
});
beforeEach(async () => {
  account = `a${randomUUID().slice(0, 8)}`; org = `o${randomUUID().slice(0, 8)}`; device = randomUUID();
  subject = account; mfa = true; badNonce = false; authRequests = 0; tokenRequests = 0; pageErrors = []; responses = [];
  for (const name of [account, org]) await sql("INSERT INTO namespaces VALUES(?,?)", name, name);
  await sql("INSERT INTO orgs(id,namespace,name) VALUES(?,?,?)", org, org, "Editorial team");
  await sql("INSERT INTO accounts(id,auth_subject,namespace,plan,org_id) VALUES(?,?,?,'paid',?)", account, account, account, org);
  await sql("INSERT INTO org_members VALUES(?,?,'admin')", org, account);
  await sql("INSERT INTO devices VALUES(?,?,?,?,?,?,NULL)", device, account, "Test laptop", hash(randomUUID()), Date.now(), Date.now());
  context = await browser.newContext({ viewport: { width: 1280, height: 920 } });
  await context.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== origin && url.origin !== apiOrigin) { await route.abort(); return; }
    await route.continue();
  });
  page = await context.newPage(); page.setDefaultTimeout(10000);
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("response", (response) => responses.push([new URL(response.url()).pathname, response.status()]));
  page.on("requestfailed", (request) => responses.push([new URL(request.url()).pathname, request.failure()?.errorText]));
  page.on("dialog", (dialog) => dialog.accept());
});
afterEach(async () => { await context?.close(); expect(pageErrors).toEqual([]); });
async function visible(value) { await page.getByText(value, { exact: false }).first().waitFor({ state: "visible" }); }
async function login(path = "/profiles") {
  await page.goto(`${origin}${path}`); await page.getByRole("button", { name: "Sign in", exact: true }).click();
  try { await page.getByRole("navigation").waitFor(); }
  catch { throw new Error(JSON.stringify({ screen: await page.locator("body").innerText(), authRequests, tokenRequests, responses })); }
}
async function nav(label) { await page.getByRole("link", { name: label, exact: true }).click(); await page.getByRole("heading", { name: label, exact: true, level: 1 }).waitFor(); }
async function createProfile(slug = "docs") {
  await page.getByLabel("New profile ID").fill(`${account}/${slug}`);
  await page.getByRole("button", { name: "Create profile", exact: true }).click();
  await page.getByLabel("Profile YAML").waitFor();
}

describe("dashboard browser workflows", () => {
  it("serves the public privacy page without JavaScript, login or API requests", async () => {
    const privacyContext = await browser.newContext({ javaScriptEnabled: false });
    try {
      const privacy = await privacyContext.newPage();
      const requests = [];
      privacy.on("request", (request) => requests.push(request.url()));
      const response = await privacy.goto(`${origin}/privacy`);
      expect(response.status()).toBe(200);
      expect(await privacy.getByRole("heading", { name: "Prosegate privacy", exact: true }).count()).toBe(1);
      expect(await privacy.getByText("FSL-1.1-ALv2", { exact: false }).count()).toBeGreaterThan(0);
      expect(requests.every((url) => url === `${origin}/privacy` || url === `${origin}/assets/app.css`)).toBe(true);
      await privacy.screenshot({ path: `${shots}/privacy.png`, fullPage: true });
    } finally { await privacyContext.close(); }
  });

  it("uses PKCE/MFA and approves, claims and revokes a device without storing tokens", async () => {
    const createdResponse = await mf.dispatchFetch(`${apiOrigin}/v1/device-codes`, { method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": randomUUID() },
      body: JSON.stringify({ name: "Browser approval device", platform: "win32", adapter_version: "0.1.0" }) });
    expect(createdResponse.status).toBe(201);
    const created = await createdResponse.json();
    await login("/devices/approve");
    expect(authRequests).toBe(1); expect(tokenRequests).toBe(1); expect(page.url()).toBe(`${origin}/devices/approve`);
    const storage = await page.evaluate(() => ({ local: { ...globalThis.localStorage }, session: { ...globalThis.sessionStorage } }));
    expect(storage).toEqual({ local: {}, session: {} });
    await page.getByLabel("Device code").fill(created.user_code);
    await page.getByLabel("I started this request on my own device.").check();
    await page.getByRole("button", { name: "Approve device", exact: true }).click(); await visible("Device approved.");
    const claim = await mf.dispatchFetch(`${apiOrigin}/v1/devices/claim`, { method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": randomUUID() }, body: JSON.stringify({ device_code: created.device_code }) });
    expect(claim.status).toBe(200);
    const credential = await claim.json();
    await page.getByRole("button", { name: "Refresh devices" }).click(); await visible("Browser approval device");
    await page.getByRole("row").filter({ hasText: "Browser approval device" }).getByRole("button", { name: "Revoke device" }).click();
    await expect.poll(async () => (await first("SELECT revoked_at FROM devices WHERE id=?", credential.device_id)).revoked_at).not.toBeNull();
    expect((await mf.dispatchFetch(`${apiOrigin}/v1/me`, { headers: { Authorization: `Bearer ${credential.device_key}` } })).status).toBe(401);
    await page.getByRole("button", { name: "Sign out", exact: true }).click(); await visible("Signed out of this dashboard");
    expect(await page.getByRole("navigation").count()).toBe(0);
  });
  it("validates and previews unsaved YAML, saves and preserves drafts on concurrent edits", async () => {
    await login(); await createProfile();
    const area = page.getByLabel("Profile YAML"), original = await area.inputValue();
    await area.fill(original.replace("version: 1", "version: 0"));
    await page.getByRole("button", { name: "Preview draft" }).click(); await visible("The profile is invalid");
    expect(await first("SELECT id FROM profiles WHERE id=?", `${account}/docs`)).toBeNull();
    await area.fill(original);
    const revision = await first("SELECT revision FROM state_revision");
    await page.getByRole("button", { name: "Preview draft" }).click(); await visible("Resolved draft · not saved");
    expect(await first("SELECT revision FROM state_revision")).toEqual(revision);
    await page.getByRole("button", { name: "Save profile", exact: true }).click(); await visible("Profile saved.");
    expect((await first("SELECT version FROM profiles WHERE id=?", `${account}/docs`)).version).toBe(1);
    await page.getByLabel("Allow this profile to share blocking excerpts").check();
    await page.getByRole("button", { name: "Update sharing" }).click(); await visible("Sample sharing enabled.");
    expect((await first("SELECT sharing_enabled FROM profiles WHERE id=?", `${account}/docs`)).sharing_enabled).toBe(1);
    expect((await request(`/profiles/${account}/docs`, "PUT", { yaml: yaml(`${account}/docs`, "Concurrent change") })).status).toBe(200);
    await area.fill(original.replace("My writing profile", "My unsaved draft"));
    await page.getByRole("button", { name: "Save profile", exact: true }).click(); await visible("This item changed since you opened it.");
    expect(await area.inputValue()).toContain("My unsaved draft");
    await page.screenshot({ path: `${shots}/profile-conflict.png`, fullPage: true });
    await page.getByRole("button", { name: "Close editor" }).click(); await visible("Concurrent change");
    await page.getByRole("button", { name: "Edit", exact: true }).click();
    await page.getByRole("button", { name: "Delete profile", exact: true }).click(); await visible("Start with your first profile");
  });
  it("shows published packs, key usage, safely rendered samples and aggregate charts on desktop and mobile", async () => {
    await request(`/profiles/${account}/docs`, "PUT", { yaml: yaml(`${account}/docs`) });
    await sql("INSERT INTO publishers VALUES(?,?)", account, account);
    await sql("INSERT INTO rule_packs VALUES(?, '1.0.0', ?, ?, 'signed-test-fixture', '{}')", account, account, "schema: prosegate.rule-pack/1\nname: Test pack\n");
    const keyId = randomUUID();
    await sql("INSERT INTO reviewer_keys VALUES(?,?,?,'openai','project-test','active',500,100,0,0,?,?,?)", keyId, account, device, Date.now(), Date.now(), Date.now() + 86400000);
    const sampleId = randomUUID(), excerpt = '<img src=x onerror="globalThis.hacked=true"> private example';
    await sql("INSERT INTO samples VALUES(?,?,?,?,?,?,?,?)", sampleId, account, device, `${account}/docs`, 1, excerpt, '{"category":"filler"}', Date.now());
    await sql("INSERT INTO telemetry_daily VALUES(?,?,?,?,?)", account, new Date().toISOString().slice(0, 10), `${account}/docs`, "filler", 12);
    await login(); await nav("Rule packs");
    await page.getByRole("row").filter({ hasText: account }).getByRole("button", { name: "1.0.0" }).click(); await visible("name: Test pack");
    await nav("Reviewer keys"); await visible("20.0%");
    await page.getByRole("button", { name: "Revoke key", exact: true }).click(); await visible("revoking");
    expect((await first("SELECT status FROM reviewer_keys WHERE key_id=?", keyId)).status).toBe("revoking");
    await nav("Shared samples"); await visible(excerpt);
    expect(await page.locator("blockquote img").count()).toBe(0);
    expect(await page.evaluate(() => globalThis.hacked)).toBeUndefined();
    await page.getByRole("button", { name: "Delete sample", exact: true }).click(); await visible("You have no shared samples");
    expect(await first("SELECT id FROM samples WHERE id=?", sampleId)).toBeNull();
    await nav("Usage"); await visible("Findings by day");
    expect(await page.locator("meter").getAttribute("value")).toBe("12");
    await page.screenshot({ path: `${shots}/usage-desktop.png`, fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => globalThis.document.documentElement.scrollWidth <= globalThis.innerWidth)).toBe(true);
    await page.screenshot({ path: `${shots}/usage-mobile.png`, fullPage: true });
    await page.getByLabel("From", { exact: true }).fill("2020-01-01");
    await page.getByRole("button", { name: "Apply dates" }).click(); await visible("Choose a valid range");
  });
  it("manages org policy and members, refuses stale policy and protects the last administrator", async () => {
    const member = `b${randomUUID().slice(0, 8)}`;
    await sql("INSERT INTO namespaces VALUES(?,?)", member, member);
    await sql("INSERT INTO accounts(id,auth_subject,namespace) VALUES(?,?,?)", member, member, member);
    await login("/organization");
    await page.getByLabel("Account ID", { exact: true }).fill(account);
    await page.getByRole("button", { name: "Add or update member" }).click(); await visible("must keep at least one administrator");
    await page.getByLabel("Account ID", { exact: true }).fill(member);
    await page.getByRole("button", { name: "Add or update member" }).click(); await visible(member);
    expect((await first("SELECT org_id FROM accounts WHERE id=?", member)).org_id).toBe(org);
    await page.getByLabel("Default enforcement").selectOption("advisory");
    await page.getByLabel("Allow all supported providers").uncheck();
    await page.getByLabel("Allowed providers", { exact: true }).fill("openai");
    await page.getByRole("button", { name: "Save policy", exact: true }).click(); await visible("Organization policy saved.");
    expect(JSON.parse((await first("SELECT policy_json FROM orgs WHERE id=?", org)).policy_json).allowed_providers).toEqual(["openai"]);
    await request(`/orgs/${org}/policy`, "PUT", { sharing_allowed: false });
    await page.getByRole("button", { name: "Save policy", exact: true }).click(); await visible("This item changed since you opened it");
    await page.screenshot({ path: `${shots}/organization.png`, fullPage: true });
    await page.getByRole("button", { name: "Sign out", exact: true }).click();
    subject = member;
    await page.getByRole("button", { name: "Sign in", exact: true }).click(); await visible("Only administrators can change policy");
    expect(await page.getByRole("button", { name: "Save policy", exact: true }).count()).toBe(0);
    expect(await page.getByLabel("Default enforcement").isDisabled()).toBe(true);
  });
  it("rejects forged callbacks, wrong nonce, missing MFA and unprovisioned identities", async () => {
    await page.goto(`${origin}/auth/callback?code=forged&state=unknown`);
    await visible("Sign-in could not be completed");
    expect(tokenRequests).toBe(0); expect(page.url()).toBe(`${origin}/auth/callback`);
    badNonce = true;
    await page.getByRole("button", { name: "Sign in", exact: true }).click(); await visible("Sign-in could not be completed");
    badNonce = false; mfa = false;
    await page.getByRole("button", { name: "Sign in", exact: true }).click(); await visible("Sign in using multi-factor authentication");
    mfa = true; subject = "unregistered";
    await page.getByRole("button", { name: "Sign in", exact: true }).click(); await visible("Your account has not been provisioned");
    expect(await page.getByRole("navigation").count()).toBe(0);
  });
  it("keeps a draft visible when its session becomes invalid", async () => {
    await login(); await createProfile();
    await page.getByLabel("Profile YAML").fill(yaml(`${account}/docs`, "Unsaved work"));
    await context.route(`${apiOrigin}/v1/profiles/**/preview`, (route) => route.fulfill({ status: 401,
      headers: { "Access-Control-Allow-Origin": origin, "Content-Type": "application/json" }, body: JSON.stringify({ code: "unauthorized" }) }));
    await page.getByRole("button", { name: "Preview draft" }).click(); await visible("Your session has expired.");
    expect(await page.getByLabel("Profile YAML").inputValue()).toContain("Unsaved work");
    expect(await page.getByRole("button", { name: "Sign in again" }).count()).toBe(1);
  });
});
