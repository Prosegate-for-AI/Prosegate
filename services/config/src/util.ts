import { z } from "zod";
import type { Ctx, Env, Tx } from "./types.js";

export class Problem extends Error {
  constructor(readonly status: number, readonly code: string) { super(code); }
}
export const fail = (status: number, code: string): never => { throw new Problem(status, code); };
export function response(body: unknown, status = 200, headers: HeadersInit = {}): Response {
  return new Response(status === 204 || status === 304 ? null : JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers } });
}
export const problem = (status: number, code: string): Response => response({ type: `urn:prosegate:problem:${code}`, title: code.replaceAll("_", " "), status, code }, status, { "Content-Type": "application/problem+json" });
export function parse<T>(c: Ctx, schema: z.ZodType<T>): T {
  const p = schema.safeParse(c.get("raw"));
  return p.success ? p.data : fail(422, "invalid_body");
}
export function random(bytes = 32): string {
  return btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(bytes)))).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}
export const id = (): string => crypto.randomUUID();
export async function digest(text: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
export async function sign(env: Env, bytes: string): Promise<string> {
  if (!env.SIGNING_KEY) return fail(503, "signing_unavailable");
  // Node's newer JWK exporter writes alg=Ed25519; workerd expects the JOSE alg EdDSA.
  const jwk = JSON.parse(env.SIGNING_KEY) as JsonWebKey;
  const key = await crypto.subtle.importKey("jwk", { ...jwk, alg: "EdDSA" }, { name: "Ed25519" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("Ed25519", key, new TextEncoder().encode(bytes));
  return btoa(String.fromCharCode(...new Uint8Array(signature)));
}
export const stmt = (env: Env, sql: string, ...values: (string | number | null)[]): D1PreparedStatement => env.DB.prepare(sql).bind(...values);
export async function one<T>(env: Env, sql: string, ...values: (string | number | null)[]): Promise<T | null> { return stmt(env, sql, ...values).first<T>(); }
export async function all<T>(env: Env, sql: string, ...values: (string | number | null)[]): Promise<T[]> { return (await stmt(env, sql, ...values).all<T>()).results; }
export const stage = (c: Ctx, sql: string, ...values: (string | number | null)[]): void => { c.get("tx").statements.push(stmt(c.env, sql, ...values)); };
export async function revision(env: Env): Promise<number> { return (await one<{ revision: number }>(env, "SELECT revision FROM state_revision WHERE id=1"))?.revision ?? fail(503, "database_uninitialized"); }
export async function commit(env: Env, tx: Tx): Promise<void> {
  if (!tx.statements.length) return;
  const guard = id();
  try {
    // D1 batch is a transaction. A failed revision CHECK rolls back every mutation, including
    // audit/idempotency writes. This also serializes read/validate/write profile graph changes.
    await env.DB.batch([
      stmt(env, "INSERT INTO transaction_guard(id,valid) VALUES(?,(SELECT revision=? FROM state_revision WHERE id=1))", guard, tx.revision),
      ...tx.statements,
      stmt(env, "UPDATE state_revision SET revision=revision+1 WHERE id=1"),
      stmt(env, "DELETE FROM transaction_guard WHERE id=?", guard),
    ]);
  } catch {
    if (await revision(env) !== tx.revision) fail(409, "state_changed_retry");
    fail(409, "write_conflict");
  }
}
export function audit(c: Ctx, action: string, target: string): void {
  const p = c.get("principal");
  stage(c, "INSERT INTO audit_log VALUES(?,?,?,?,?,?)", id(), p.account.id, p.device_id ?? p.account.id, action, target, Date.now());
}
export const Empty = z.strictObject({});
export const Token = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
export const Namespace = z.string().regex(/^[a-z0-9-]{1,31}$/).refine((v) => !["local", "prosegate", "core"].includes(v));
export function dashboard(c: Ctx): void { if (c.get("principal").kind !== "dashboard") fail(403, "dashboard_required"); }
export function device(c: Ctx): string { const p = c.get("principal"); return p.kind === "device" && p.device_id ? p.device_id : fail(403, "device_required"); }
export function orgAdmin(c: Ctx, org: string): void {
  dashboard(c);
  const p = c.get("principal");
  if (p.account.org_id !== org || p.role !== "admin") fail(403, "org_admin_required");
}
export function namespaceAccess(c: Ctx, namespace: string, write = false): boolean {
  const p = c.get("principal");
  return namespace === p.account.namespace || (namespace === p.policy?.namespace && (!write || p.role === "admin"));
}
