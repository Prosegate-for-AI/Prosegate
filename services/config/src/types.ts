import type { Context } from "hono";
import type { OrgPolicyInput } from "@prosegate/profiles";

export interface Env {
  DB: D1Database;
  TELEMETRY: Queue;
  SIGNING_KEY: string;
  DASHBOARD_ORIGIN: string;
  OIDC_ISSUER?: string;
  OIDC_AUDIENCE?: string;
  OIDC_JWKS_URL?: string;
  /** Optional pinned public JWKS for isolated installations/tests; never accepts client keys. */
  OIDC_JWKS?: string;
  PUBLISH_TOKEN?: string;
  /** Administrative provider bridge. No inference endpoint or draft crosses this binding. */
  REVIEWER_ADMIN?: Fetcher;
  NOTIFICATIONS?: Fetcher;
  VENDING_EXPOSURE_ACCEPTED?: string;
}
export interface Account { id: string; auth_subject: string; namespace: string; plan: "free" | "paid"; org_id: string | null; default_profile: string | null; publisher: number; flagged: number }
export interface Principal { account: Account; kind: "dashboard" | "device"; device_id: string | null; policy: OrgPolicyInput | null; role: "admin" | "member" | null }
export interface ProfileRow { id: string; namespace: string; version: number; name: string; yaml: string; signature: string; etag: string; parent_id: string | null; sharing_enabled: number; updated_at: number }
export interface Tx { revision: number; statements: D1PreparedStatement[]; sensitive: boolean }
export type App = { Bindings: Env; Variables: { principal: Principal; tx: Tx; raw: unknown; rawText: string } };
export type Ctx = Context<App>;
