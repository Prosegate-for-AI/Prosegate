import { describe, it, expect, vi } from "vitest";
import { z } from "zod";
import { Api, ApiError, errorText } from "./api.js";
import { ConfigSchema, returnPath } from "./config.js";
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
describe("dashboard trust boundaries", () => {
  it("only accepts operator-configured HTTPS endpoints or loopback development", () => {
    const valid = { apiOrigin: "https://config.example.test", authority: "https://auth.example.test/tenant", clientId: "public-client" };
    expect(ConfigSchema.safeParse(valid).success).toBe(true);
    for (const apiOrigin of ["http://example.test", "https://user:password@example.test", "javascript:alert(1)", "https://example.test/path", "https://example.test?token=x", "https://example.test\n"]) {
      expect(ConfigSchema.safeParse({ ...valid, apiOrigin }).success).toBe(false);
    }
    expect(ConfigSchema.safeParse({ ...valid, apiOrigin: "http://127.0.0.1:4173" }).success).toBe(true);
    expect(ConfigSchema.safeParse({ ...valid, secret: "never" }).success).toBe(false);
  });
  it("does not turn an auth return path into an open redirect", () => {
    for (const p of ["//evil.test", "https://evil.test", "/profiles?token=secret", "/\\evil.test", { path: "/usage" }]) expect(returnPath(p)).toBe("/profiles");
    expect(returnPath("/devices/approve")).toBe("/devices/approve");
  });
  it("retries only rolled-back state conflicts, preserving idempotency and preconditions", async () => {
    const transport = vi.fn<typeof fetch>().mockResolvedValueOnce(json({ code: "state_changed_retry" }, 409)).mockResolvedValueOnce(json({ ok: true }));
    const api = new Api("https://config.test", () => "test-session", vi.fn(), transport);
    await expect(api.mutate("/v1/profiles/alice/docs", "PUT", { yaml: "draft" }, z.object({ ok: z.boolean() }), { "If-Match": '"v1"' })).resolves.toEqual({ ok: true });
    const first = transport.mock.calls[0]?.[1], second = transport.mock.calls[1]?.[1];
    expect(first?.headers).toEqual(second?.headers);
    expect(first).toMatchObject({ credentials: "omit", redirect: "error", cache: "no-store", headers: { "If-Match": '"v1"', Authorization: "Bearer test-session" } });
  });
  it("never repeats ambiguous writes, conflicts or expired sessions", async () => {
    for (const result of [new ApiError(0, "failure"), json({ code: "etag_mismatch" }, 412), json({ code: "unauthorized" }, 401)]) {
      const transport = vi.fn<typeof fetch>();
      if (result instanceof Error) transport.mockRejectedValue(result); else transport.mockResolvedValue(result);
      const expired = vi.fn(), api = new Api("https://config.test", () => "test", expired, transport);
      await expect(api.mutate("/v1/profiles/alice/docs", "PUT", {}, z.unknown())).rejects.toBeInstanceOf(ApiError);
      expect(transport).toHaveBeenCalledTimes(1);
      expect(expired).toHaveBeenCalledTimes(result instanceof Response && result.status === 401 ? 1 : 0);
    }
  });
  it("rejects missing credentials before network and renders useful field errors", async () => {
    const transport = vi.fn<typeof fetch>(), expired = vi.fn();
    await expect(new Api("https://config.test", () => null, expired, transport).get("/v1/me", z.unknown())).rejects.toMatchObject({ code: "session_expired" });
    expect(expired).toHaveBeenCalledOnce(); expect(transport).not.toHaveBeenCalled();
    expect(errorText(new ApiError(422, "profile_invalid", ["id: must match"]))).toContain("id: must match");
  });
});
