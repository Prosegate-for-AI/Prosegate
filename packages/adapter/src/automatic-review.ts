import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { reviewDraft, reviewerEligibility } from "@prosegate/reviewer";
import type { ReviewResult, ReviewerProvider } from "@prosegate/schema";
import { reviewCap, type Ctx } from "./ctx.js";
import { readFileOrNull, withLock, writeFileAtomic } from "./fs-secure.js";
import type { HookReview } from "./hooks.js";
import { KeyStore, nativeKeyRunner } from "./key-store.js";
import { mergeReviewer } from "./reviewer-command.js";
import { automaticReviewer } from "./reviewer-settings.js";
import { SessionStore } from "./store.js";
import { INIT_CHECK_SESSION } from "./init-check.js";

export interface AutomaticReviewDeps {
  getKey?: (provider: ReviewerProvider) => Promise<string | null>;
  fetch?: typeof fetch;
}

/** Hashes and timestamps only. Claim before awaiting; duplicate/concurrent deliveries never bill twice. */
function claim(ctx: Ctx, review: HookReview): boolean {
  const store = new SessionStore(ctx, review.request.session_id);
  store.ensure();
  const path = join(store.dir, "reviewer-attempts.json");
  return withLock(join(store.dir, "reviewer-attempts.lock"), () => {
    const raw = readFileOrNull(path);
    let entries: Record<string, number> = {};
    if (raw !== null) {
      if (raw.length > 8192) return false;
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
      entries = parsed as Record<string, number>;
      if (Object.entries(entries).some(([k, v]) => !/^[0-9a-f]{16}-[12]$/.test(k) || !Number.isFinite(v))) return false;
    }
    const id = `${review.attemptId}-${review.request.pass}`;
    if (Object.hasOwn(entries, id)) return false;
    // Keep an hour of receipts; refuse rather than evict live claims and allow duplicate spend.
    entries = Object.fromEntries(Object.entries(entries).filter(([, t]) => t > ctx.now() - 3600000));
    if (Object.keys(entries).length >= 200) return false;
    entries[id] = ctx.now();
    writeFileAtomic(path, JSON.stringify(entries));
    return true;
  }, { timeoutMs: 100 });
}

export async function automaticReview(review: HookReview, ctx: Ctx, provider: ReviewerProvider, deps: AutomaticReviewDeps = {}): Promise<ReviewResult> {
  const { detailed, resolved, enforce, stderr } = review;
  const fallback = (): ReviewResult => review.request.pass === 2 ? { ...detailed.result, cleared: [] } : detailed.result;
  const request = { ...review.request, stages: ["rules", "reviewer"] as ("rules" | "reviewer")[] };
  if (review.capCheck || detailed.result.verdict === "skipped" || detailed.diagnostics.truncated ||
      request.session_id === INIT_CHECK_SESSION || reviewerEligibility(request, resolved, provider)) return fallback();
  try {
    if (automaticReviewer(ctx) !== provider || reviewCap(ctx) - ctx.elapsedMs() <= 100 || !claim(ctx, review)) return fallback();
    // A Stop hook runs through hook.mjs, so process.argv[1] is NOT the key-worker CLI.
    // In a bundled build import.meta.url names the CLI bundle even when embedded by the shim.
    const entry = fileURLToPath(import.meta.url.endsWith(".ts") ? new URL("./cli.ts", import.meta.url) : import.meta.url);
    const store = new KeyStore(ctx, (op, ms) => nativeKeyRunner(op, Math.max(1, Math.min(ms, reviewCap(ctx) - ctx.elapsedMs())), entry));
    let timer: ReturnType<typeof setTimeout> | undefined;
    let key: string | null;
    try {
      key = await Promise.race([
        deps.getKey ? deps.getKey(provider) : store.get(provider),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("key timeout")), Math.max(1, reviewCap(ctx) - ctx.elapsedMs() - 100)); }),
      ]);
    } finally { if (timer !== undefined) clearTimeout(timer); }
    // A user may disable/change the provider while the keychain is opening.
    if (automaticReviewer(ctx) !== provider || ctx.elapsedMs() >= reviewCap(ctx)) return fallback();
    const outcome = await reviewDraft({ request, resolved, provider, key,
      timeoutMs: Math.max(0, reviewCap(ctx) - ctx.elapsedMs() - 100), localFindings: detailed.result.findings,
      ...(deps.fetch ? { fetch: deps.fetch } : {}),
    });
    if (outcome.error) stderr.push(`Prosegate: automatic ${provider} review unavailable (${outcome.error}); local checks retained.`);
    return mergeReviewer(detailed, outcome, request, enforce);
  } catch {
    // Keychain/lock/provider exceptions can contain private data; never echo them.
    stderr.push(`Prosegate: automatic ${provider} review unavailable; local checks retained.`);
    return fallback();
  }
}
