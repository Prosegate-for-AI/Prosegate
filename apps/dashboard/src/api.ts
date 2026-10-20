import { z } from "zod";

export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, readonly issues: string[] = []) { super(code); }
}
const Problem = z.object({ code: z.string(), issues: z.array(z.object({ path: z.string(), message: z.string() })).optional() });
export class Api {
  constructor(private readonly origin: string, private readonly token: () => string | null, private readonly expired: () => void,
    private readonly transport: typeof fetch = fetch) {}
  async get<T>(path: string, schema: z.ZodType<T>): Promise<T> {
    return schema.parse(await this.request(path));
  }
  async mutate<T>(path: string, method: "POST" | "PUT" | "DELETE", body: unknown, schema: z.ZodType<T>, headers: Record<string, string> = {}): Promise<T> {
    return schema.parse(await this.request(path, method, body, headers));
  }
  private async request(path: string, method = "GET", body?: unknown, headers: Record<string, string> = {}): Promise<unknown> {
    if (!path.startsWith("/v1/") || path.includes("\\") || path.includes("#") || path.includes("..")) throw new Error("invalid_api_path");
    const idempotency = crypto.randomUUID();
    for (let attempt = 0; attempt < 3; attempt++) {
      const token = this.token();
      if (!token) { this.expired(); throw new ApiError(401, "session_expired"); }
      let result: Response;
      try {
        // Native browser fetch rejects an Api instance as its receiver.
        const transport = this.transport;
        result = await transport(`${this.origin.replace(/\/$/, "")}${path}`, {
          method, credentials: "omit", redirect: "error", cache: "no-store", signal: AbortSignal.timeout(20000),
          headers: { ...headers, Authorization: `Bearer ${token}`, ...(method === "GET" ? {} : { "Content-Type": "application/json", "Idempotency-Key": idempotency }) },
          ...(method === "GET" ? {} : { body: JSON.stringify(body) }),
        });
      } catch { throw new ApiError(0, method === "GET" || path.endsWith("/preview") ? "network_error" : "mutation_unknown"); }
      if (result.status === 204) return null;
      let payload: unknown;
      try { payload = await result.json(); } catch { throw new ApiError(result.status, "invalid_response"); }
      if (result.ok) return payload;
      const parsed = Problem.safeParse(payload), code = parsed.success ? parsed.data.code : "request_failed";
      if (result.status === 401) this.expired();
      if (result.status === 409 && code === "state_changed_retry" && attempt < 2) continue;
      throw new ApiError(result.status, code, parsed.success ? (parsed.data.issues ?? []).map((i) => `${i.path || "Profile"}: ${i.message}`) : []);
    }
    throw new ApiError(409, "state_changed_retry");
  }
}
export const MeSchema = z.object({
  account_id: z.string(), namespace: z.string(), plan: z.enum(["free", "paid"]), account_flagged: z.boolean(), vending_enabled: z.boolean(),
  org: z.object({ id: z.string(), name: z.string(), namespace: z.string(), role: z.enum(["admin", "member"]).nullable() }).nullable(),
});
export type Me = z.infer<typeof MeSchema>;
export const ProfilesSchema = z.object({ profiles: z.array(z.object({ id: z.string(), name: z.string(), version: z.number(), etag: z.string(), updated_at: z.number() })) });
export const ProfileSchema = z.object({ yaml: z.string(), version: z.number(), etag: z.string(), sharing_enabled: z.boolean() });
export const DevicesSchema = z.object({ devices: z.array(z.object({ id: z.string(), name: z.string(), created_at: z.number(), last_seen: z.number(), revoked_at: z.number().nullable() })) });
export const PacksSchema = z.object({ rule_packs: z.array(z.object({ id: z.string(), versions: z.array(z.string()), publisher: z.string() })) });
export const KeysSchema = z.object({ keys: z.array(z.object({ key_id: z.string(), provider: z.string(), status: z.string(), usage_pct: z.number(), expires_at: z.number() })) });
export const SamplesSchema = z.object({ samples: z.array(z.object({ id: z.string(), profile_id: z.string(), pass: z.number(), excerpt: z.string(), finding: z.unknown(), created_at: z.number() })) });
export const UsageSchema = z.object({ usage: z.array(z.object({ day: z.string(), profile_id: z.string(), category: z.string(), count: z.number().nonnegative() })) });
export const PolicySchema = z.object({ policy: z.object({
  enforcement_default: z.enum(["enforce", "advisory", "required"]).optional(), allowed_providers: z.array(z.string()).optional(),
  byok_required: z.boolean().optional(), sharing_allowed: z.boolean().optional(),
}), etag: z.string() });
export const MembersSchema = z.object({ members: z.array(z.object({ account_id: z.string(), role: z.enum(["admin", "member"]) })) });
export const profilePath = (id: string): string => `/v1/profiles/${id.split("/").map(encodeURIComponent).join("/")}`;
export const segment = encodeURIComponent;
export function errorText(error: unknown): string {
  if (!(error instanceof ApiError)) return "Something went wrong. Please refresh and try again.";
  const messages: Record<string, string> = {
    etag_mismatch: "This item changed since you opened it. Your draft is still here. Copy it before reloading the latest version.",
    profile_invalid: "The profile is invalid. Check the YAML and use Preview for field details.",
    profile_resolution_failed: "This profile cannot resolve. Check its parent, rule-pack versions, and organization policy.",
    org_parent_private: "An organization profile cannot inherit from a private profile.",
    profile_extended: "Another profile inherits from this one. Update that child before deleting.",
    mfa_required: "Sign in using multi-factor authentication. Your provider must include the mfa authentication claim.",
    account_not_registered: "Your account has not been provisioned. Ask your administrator to add your sign-in identity.",
    session_expired: "Your session expired. Copy any unsaved work, then sign in again.",
    unauthorized: "Your session is no longer valid. Copy any unsaved work, then sign in again.",
    network_error: "The service could not be reached. Check your connection and try again.",
    mutation_unknown: "The connection ended before confirmation. The change may have succeeded. Refresh and check before retrying.",
    last_admin: "The organization must keep at least one administrator.",
    different_org: "This account already belongs to another organization.",
    sharing_forbidden: "Your organization does not allow sample sharing.",
    not_found: "This item was not found or is not available to your account.",
    org_admin_required: "Only an organization administrator can make this change.",
    namespace_forbidden: "You do not have permission to edit this namespace.",
    state_changed_retry: "The service is busy with another change. Please try again.",
  };
  return [messages[error.code] ?? `Request failed: ${error.code.replaceAll("_", " ")}.`, ...error.issues].join("\n");
}
