import type { MiddlewareHandler } from "hono";
import type { App } from "./types.js";
import { authenticate } from "./auth.js";
import { commit, digest, fail, one, problem, response, revision, stage } from "./util.js";

/** Stream bound applies even when Content-Length is absent or lies. No request body is logged. */
async function readBody(req: Request): Promise<string> {
  const reader = req.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.length;
      if (bytes > 350 * 1024) { await reader.cancel(); return fail(413, "body_too_large"); }
      chunks.push(part.value);
    }
  } finally { reader.releaseLock(); }
  const merged = new Uint8Array(bytes);
  let at = 0;
  for (const part of chunks) { merged.set(part, at); at += part.length; }
  try { return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(merged); }
  catch { return fail(422, "invalid_encoding"); }
}
/** Apply headers after raw Response objects and error responses have been installed by Hono. */
export const securityHeaders: MiddlewareHandler<App> = async (c, next) => {
  await next();
  c.header("X-Content-Type-Options", "nosniff");
  c.header("Cache-Control", "no-store");
  const origin = c.req.header("Origin");
  if (origin && origin === c.env.DASHBOARD_ORIGIN) {
    c.header("Access-Control-Allow-Origin", origin);
    c.header("Vary", "Origin");
    c.header("Access-Control-Allow-Headers", "Authorization,Content-Type,Idempotency-Key,If-None-Match,If-Match");
    c.header("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS");
    c.header("Access-Control-Expose-Headers", "ETag,Retry-After");
  }
};
export const boundary: MiddlewareHandler<App> = async (c, next) => {
  const origin = c.req.header("Origin");
  if (origin && origin !== c.env.DASHBOARD_ORIGIN) return problem(403, "origin_not_allowed");
  if (c.req.method === "OPTIONS") return c.body(null, 204);
  const mutating = !["GET", "HEAD"].includes(c.req.method);
  c.set("tx", { revision: await revision(c.env), statements: [], sensitive: false });
  const path = new URL(c.req.url).pathname;
  // Unsaved YAML previews are read-only: never persist their body or resolution in idempotency storage.
  const preview = c.req.method === "POST" && /^\/v1\/profiles\/[^/]+\/[^/]+\/preview$/.test(path);
  const anonymous = path === "/v1/device-codes" || path === "/v1/devices/claim";
  const internal = path.startsWith("/v1/internal/");
  if (internal) {
    const bearer = c.req.header("Authorization") ?? "";
    if (!c.env.PUBLISH_TOKEN || await digest(bearer) !== await digest(`Bearer ${c.env.PUBLISH_TOKEN}`)) return problem(401, "unauthorized");
  } else if (!anonymous) c.set("principal", await authenticate(c));
  let text = "";
  if (mutating) {
    text = await readBody(c.req.raw);
    if (text && !/^application\/json(?:;|$)/i.test(c.req.header("Content-Type") ?? "")) return problem(415, "json_required");
    try { c.set("raw", text ? JSON.parse(text) as unknown : {}); }
    catch { return problem(422, "invalid_body"); }
  } else c.set("raw", {});
  c.set("rawText", text);
  const idem = c.req.header("Idempotency-Key");
  if (mutating && (!idem || !/^[A-Za-z0-9_-]{8,128}$/.test(idem))) return problem(422, "idempotency_key_required");
  const scope = internal ? "publisher-ci" : anonymous ? path : `${c.get("principal").account.id}:${c.get("principal").device_id ?? "dashboard"}`;
  const keyHash = await digest(idem ?? "");
  const requestHash = await digest(`${c.req.method}\n${new URL(c.req.url).pathname}${new URL(c.req.url).search}\n${c.req.header("If-Match") ?? ""}\n${c.req.header("If-None-Match") ?? ""}\n${text}`);
  if (mutating && !preview) {
    const prior = await one<{ request_hash: string; response_status: number; response_body: string | null; response_headers: string }>(c.env, "SELECT * FROM idempotency WHERE scope=? AND key_hash=? AND expires_at>?", scope, keyHash, Date.now());
    if (prior) {
      if (prior.request_hash !== requestHash) return problem(409, "idempotency_conflict");
      if (prior.response_body === null) return problem(409, "secret_already_delivered");
      return new Response(prior.response_status === 204 ? null : prior.response_body, { status: prior.response_status, headers: JSON.parse(prior.response_headers) as HeadersInit });
    }
  }
  await next();
  if (c.error) return;
  if (!mutating || preview) return;
  if (c.res.status >= 200 && c.res.status < 300) {
    // One-time device/provider secrets are NEVER written to the idempotency table.
    const body = c.get("tx").sensitive ? null : await c.res.clone().text();
    stage(c, "INSERT OR REPLACE INTO idempotency VALUES(?,?,?,?,?,?,?)", scope, keyHash, requestHash, c.res.status, body,
      JSON.stringify({ "Content-Type": c.res.headers.get("Content-Type") ?? "application/json", "Cache-Control": "no-store", ...(c.res.headers.has("ETag") ? { ETag: c.res.headers.get("ETag") } : {}) }), Date.now() + 86400000);
  }
  await commit(c.env, c.get("tx"));
  return;
};
export const health = () => response({ service: "prosegate-config", status: "ok" });
