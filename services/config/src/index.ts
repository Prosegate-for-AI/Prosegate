import { Hono } from "hono";
import { z } from "zod";
import type { App, Env } from "./types.js";
import { boundary, securityHeaders } from "./middleware.js";
import { deviceRoutes } from "./devices.js";
import { profileRoutes } from "./profiles.js";
import { packRoutes } from "./packs.js";
import { orgRoutes } from "./orgs.js";
import { keyRoutes, vendingEnabled, revokePending, pollKeys, deliverNotifications } from "./keys.js";
import { telemetryRoutes, flushTelemetry, ingestTelemetry, aggregateAndRetain } from "./telemetry.js";
import { Problem, problem, response } from "./util.js";

export const app = new Hono<App>();
app.onError((err) => err instanceof Problem ? problem(err.status, err.code) : err instanceof z.ZodError ? problem(422, "invalid_body") : problem(500, "internal_error"));
app.notFound(() => problem(404, "not_found"));
app.use("/v1/*", securityHeaders, boundary);
app.get("/v1/me", (c) => {
  const p = c.get("principal");
  return response({ account_id: p.account.id, namespace: p.account.namespace, plan: p.account.plan,
    org: p.policy ? { id: p.policy.org_id, name: p.policy.org_name, namespace: p.policy.namespace, role: p.role } : null,
    account_flagged: Boolean(p.account.flagged),
    default_profile: p.account.default_profile,
    vending_enabled: vendingEnabled(c.env) && p.account.plan === "paid" && !p.account.flagged && !p.policy?.byok_required &&
      (!p.policy?.allowed_providers || p.policy.allowed_providers.includes("openai")),
  });
});
deviceRoutes(app);
profileRoutes(app);
packRoutes(app);
orgRoutes(app);
keyRoutes(app);
telemetryRoutes(app);

export async function scheduled(env: Env): Promise<void> {
  // A telemetry/notification outage must never prevent financial controls from running.
  const results = await Promise.allSettled([flushTelemetry(env), pollKeys(env), deliverNotifications(env), aggregateAndRetain(env)]);
  if (results.some((r) => r.status === "rejected")) throw new Error("scheduled_task_failed");
}
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const result = await app.fetch(request, env, ctx);
    if (request.method !== "GET" && result.status < 400) {
      ctx.waitUntil(Promise.allSettled([flushTelemetry(env), revokePending(env)]));
    }
    return result;
  },
  queue: ingestTelemetry,
  scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): void { ctx.waitUntil(scheduled(env)); },
} satisfies ExportedHandler<Env, unknown>;
