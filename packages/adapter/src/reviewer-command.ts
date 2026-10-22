import { resolveOverlaps, reviewRulesDetailed, type DetailedReview } from "@prosegate/engine";
import { reviewDraft, reviewerEligibility, type ReviewerOutcome } from "@prosegate/reviewer";
import { ReviewRequestSchema, renderFeedbackText, type Category, type ReviewRequest, type ReviewResult, type ReviewerProvider } from "@prosegate/schema";
import { isAgentContext } from "./agent-context.js";
import type { Ctx } from "./ctx.js";
import { KeyStore, KeyStoreError } from "./key-store.js";
import { resolveAndLoad } from "./profiles.js";
import { automaticReviewerStatus, setAutomaticReviewer } from "./reviewer-settings.js";
import type { RunIO } from "./run.js";

export function mergeReviewer(base: DetailedReview, outcome: ReviewerOutcome, request: ReviewRequest, enforce: boolean): ReviewResult {
  if (outcome.stats === null) {
    // Without the reviewer, a rules-only pass cannot prove that a previous reviewer finding cleared.
    return request.pass === 2 ? { ...base.result, cleared: [] } : base.result;
  }
  const all = resolveOverlaps([...base.diagnostics.all_findings, ...outcome.findings]);
  const counts: Partial<Record<Category, number>> = {};
  for (const f of all) counts[f.category] = (counts[f.category] ?? 0) + 1;
  const present = new Set(all.map((f) => f.id));
  const findings = all.filter((f) => f.severity !== "info");
  const result: ReviewResult = {
    ...base.result, verdict: enforce && findings.some((f) => f.severity === "block") ? "revise" : "pass", findings,
    cleared: request.pass === 2 ? [...new Set(request.prior_findings)].filter((id) => !present.has(id)) : [],
    stats: { ...base.result.stats, reviewer: outcome.stats, findings_by_category: counts }, feedback_text: "",
  };
  result.feedback_text = renderFeedbackText(result);
  return result;
}

export function providerArg(value: string | undefined): ReviewerProvider | null { return value === "openai" || value === "anthropic" ? value : null; }

export async function runReviewerCommand(args: string[], io: RunIO, ctx: Ctx, store: Pick<KeyStore, "prepare" | "get"> = new KeyStore(ctx)): Promise<number> {
  if (args.length === 1 && args[0] === "status") { io.stdout.write(`${automaticReviewerStatus(ctx)}\n`); return 0; }
  const provider = args[0] === "on" && args[1] === "--provider" && args.length === 3 ? providerArg(args[2]) : null;
  const off = args.length === 1 && args[0] === "off";
  if (provider === null && !off) { io.stderr.write("Usage: prosegate reviewer on --provider openai|anthropic | off | status\n"); return 1; }
  if (isAgentContext(ctx)) { io.stderr.write("Prosegate: change automatic reviewer settings from your own terminal.\n"); return 1; }
  try {
    if (provider !== null) {
      const prepared = await store.prepare();
      if (prepared.notice) io.stderr.write(`${prepared.notice}\n`);
      if (await store.get(provider) === null) { io.stderr.write(`Prosegate: set a saved key first with prosegate key set ${provider}.\n`); return 1; }
    }
    setAutomaticReviewer(ctx, provider);
    io.stdout.write(`${automaticReviewerStatus(ctx)}\n`);
    if (provider !== null) io.stdout.write("Draft prose and the current user message will go to this provider. Profile floors and provider policy still apply. MCP stays local-only.\n");
    return 0;
  } catch { io.stderr.write("Prosegate: could not change automatic review settings; check the saved key and local files.\n"); return 1; }
}

/** Explicit one-shot review; automatic hooks share the transport and result merger. */
export async function runReviewCommand(args: string[], raw: string, io: RunIO, ctx: Ctx, deps: { store?: KeyStore; fetch?: typeof fetch } = {}): Promise<number> {
  const provider = args[0] === "--provider" && args.length === 2 ? providerArg(args[1]) : null;
  if (!provider) { io.stderr.write("Usage: prosegate review --provider openai|anthropic < request.json\n"); return 1; }
  try {
    const request = ReviewRequestSchema.parse(JSON.parse(raw.replace(/^\uFEFF/, "")));
    const started = performance.now();
    const loaded = resolveAndLoad(ctx, request.profile_id);
    if (loaded.fellBack || loaded.issues.length) { io.stderr.write("Prosegate: the requested profile or rule packs could not be loaded; fix them before reviewing.\n"); return 1; }
    const enforce = loaded.resolved.enforcement.mode === "enforce";
    const base = reviewRulesDetailed({ request, resolved: loaded.resolved, packs: loaded.packs, enforce, budgetMs: 2000, maxProseChars: 100 * 1024 });
    if (base.diagnostics.budget_exceeded || base.diagnostics.truncated) { io.stderr.write("Prosegate: the draft could not be reviewed completely; shorten it and retry.\n"); return 1; }
    if (base.result.verdict === "skipped" || reviewerEligibility(request, loaded.resolved, provider)) {
      const result = request.pass === 2 ? { ...base.result, cleared: [] } : base.result;
      io.stdout.write(`${JSON.stringify(result)}\n`);
      io.stderr.write("Prosegate: local rules only; the reviewer is disabled, below its word floor, or not allowed by this profile.\n");
      return 0;
    }
    const store = deps.store ?? new KeyStore(ctx);
    let key: string | null = null;
    let keyError: string | null = null;
    try {
      const prepared = await store.prepare();
      if (prepared.notice) io.stderr.write(`${prepared.notice}\n`);
      key = await store.get(provider);
    }
    catch (e) { keyError = e instanceof KeyStoreError ? e.code : "keychain_unavailable"; }
    const outcome = await reviewDraft({ request, resolved: loaded.resolved, provider, key, localFindings: base.result.findings, timeoutMs: Math.max(0, 6000 - (performance.now() - started)), ...(deps.fetch ? { fetch: deps.fetch } : {}) });
    const result = mergeReviewer(base, outcome, request, enforce);
    io.stdout.write(`${JSON.stringify(result)}\n`);
    if (keyError) io.stderr.write(`Prosegate: local rules only; the reviewer key could not be read (${keyError}). Run prosegate key status ${provider} in your terminal.\n`);
    else if (outcome.error === "reviewer_key_missing") io.stderr.write(`Prosegate: local rules only; set your reviewer key with prosegate key set ${provider}.\n`);
    else if (outcome.error) io.stderr.write(`Prosegate: local rules only; ${outcome.error}.\n`);
    return 0;
  } catch {
    // Neither parsing exceptions nor provider/key-store messages may echo the draft or a secret.
    io.stderr.write("Prosegate: review could not finish. Check the review request and local profile; no text or keys were logged.\n");
    return 1;
  }
}

export async function runKeyCommand(args: string[], io: RunIO, ctx: Ctx, store = new KeyStore(ctx)): Promise<number> {
  const [action, name, flag] = args;
  const provider = providerArg(name);
  if (!provider || !["set", "remove", "status"].includes(action ?? "") || args.length > 3 || (flag !== undefined && (flag !== "--stdin" || action !== "set"))) {
    io.stderr.write("Usage: prosegate key set|remove|status openai|anthropic [--stdin for set]\n"); return 1;
  }
  if (action !== "status" && isAgentContext(ctx)) { io.stderr.write("Prosegate: change reviewer keys from your own terminal. Do not paste a key into an agent conversation.\n"); return 1; }
  try {
    let value: string | null = null;
    if (action === "set") {
      if (flag === "--stdin") value = (await io.stdin()).replace(/\r?\n$/, "");
      else if (ctx.stdinIsTTY && io.secret) value = await io.secret();
      else { io.stderr.write("Prosegate: run key set in a terminal for hidden input, or pipe the key using --stdin. Never put a key on the command line.\n"); return 1; }
      if (!value || value.length > 1000 || !/^[\x21-\x7e]+$/.test(value)) throw new KeyStoreError("key_invalid");
    }
    const prepared = await store.prepare();
    if (prepared.notice) io.stderr.write(`${prepared.notice}\n`);
    if (action === "set" && value !== null) { await store.set(provider, value); io.stdout.write(`Prosegate: ${provider} reviewer key saved in ${prepared.backend}.\n`); }
    else if (action === "remove") { await store.remove(provider); io.stdout.write(`Prosegate: ${provider} reviewer key removed from ${prepared.backend}.\n`); }
    else io.stdout.write(`Prosegate: ${provider} reviewer key ${(await store.get(provider)) === null ? "not set" : "set"} (${prepared.backend}).\n`);
    return 0;
  } catch (e) {
    const code = e instanceof KeyStoreError ? e.code : "keychain_unavailable";
    io.stderr.write(`Prosegate: could not ${action} the reviewer key (${code}).${code === "key_store_busy" ? " Close other Prosegate key commands; if none are running, remove key-store.lock from the Prosegate home and retry." : ""}\n`);
    return 1;
  }
}
