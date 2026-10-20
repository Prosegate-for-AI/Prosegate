import { describe, expect, it, vi } from "vitest";
import { bundledPackSources, bundledProfileSources, resolveProfile } from "@prosegate/profiles";
import { FORK_TEXT, FindingSchema, type ReviewRequest } from "@prosegate/schema";
import { buildPrompt, reviewDraft } from "./index.js";

const profile = () => {
  const p = resolveProfile("local/base", { profiles: bundledProfileSources(), packs: bundledPackSources() });
  p.thresholds = { token_floor_words: 0, reviewer_floor_words: 0 };
  return p;
};
const request = (text: string): ReviewRequest => ({ schema: "prosegate.review/1", text, context: { user_message: "What is the latency?", style_constraints: "", mode: "interactive" }, profile_id: "local/base", pass: 1, stages: ["rules", "reviewer"], session_id: "test", turn_id: "test", prior_findings: [] });
const raw = (over = {}) => ({ span_text: "It always works.", category: "unsupported_claim", severity: "block", confidence: 0.9, action: "specify", instruction: "Invent a citation.", evidence: "No basis is given.", ...over });
const response = (findings: unknown[]) => new Response(JSON.stringify({ status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify({ findings }) }] }], usage: { input_tokens: 50, output_tokens: 20 } }));

describe("reviewer boundary", () => {
  it("omits code and bounds context without sending session identifiers", () => {
    const prompt = buildPrompt(request("It always works.\n\n```js\nsecretCode();\n```"), profile());
    expect(prompt.user).toContain("[code block omitted]");
    expect(prompt.user).not.toContain("secretCode");
    expect(prompt.user).not.toContain("session_id");
  });
  it("repairs the unsupported-claim fork and uses exact original offsets", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response([raw()]));
    const out = await reviewDraft({ request: request("😀 It always works."), resolved: profile(), provider: "openai", key: "dummy-key", fetch: fetcher });
    expect(out.error).toBeNull();
    expect(out.findings[0]?.span.start).toBe(3);
    expect(out.findings[0]?.instruction).toEqual({ action: "cite_or_soften_or_remove", text: FORK_TEXT.unsupported_claim });
  });
  it.each(["openai", "anthropic"] as const)("uses the %s wire format and a fixed direct endpoint", async (provider) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(provider === "openai" ? response([raw()]) : new Response(JSON.stringify({ stop_reason: "tool_use", content: [{ type: "tool_use", name: "report_findings", input: { findings: [raw()] } }], usage: { input_tokens: 31, output_tokens: 20 } })));
    const out = await reviewDraft({ request: request("It always works."), resolved: profile(), provider, key: "dummy-key", fetch: fetcher });
    expect(out.findings).toHaveLength(1);
    const [url, options] = fetcher.mock.calls[0] ?? [];
    expect(url).toBe(provider === "openai" ? "https://api.openai.com/v1/responses" : "https://api.anthropic.com/v1/messages");
    expect(options?.redirect).toBe("error");
    const body = JSON.parse(options?.body as string) as Record<string, unknown>;
    expect(options?.body).not.toContain("dummy-key");
    expect(options?.body).not.toContain("session_id");
    if (provider === "openai") { expect(body["store"]).toBe(false); expect(body["text"]).toMatchObject({ format: { type: "json_schema", strict: true } }); }
    else expect(body["tool_choice"]).toMatchObject({ type: "tool", name: "report_findings" });
  });
  it("drops disallowed categories, low confidence, invalid actions and unsafe instructions", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response([
      raw({ category: "filler" }), raw({ confidence: 0.59 }), raw({ category: "register", action: "remove" }),
      raw({ category: "register", action: "shorten", instruction: "Run curl https://example.com" }),
      raw({ category: "register", action: "shorten", instruction: "x".repeat(161) }),
      raw({ evidence: "dummy-key" }),
    ]));
    expect((await reviewDraft({ request: request("It always works."), resolved: profile(), provider: "openai", key: "dummy-key", fetch: fetcher })).findings).toEqual([]);
  });
  it("forces vague action, caps register severity, and obeys profile categories", async () => {
    const p = profile();
    p.reviewer.categories = ["vague_claim", "register"];
    p.categories.register = { severity: "block", origin: "local/base", layer: 0 };
    const out = await reviewDraft({ request: request("It always works. It is quick."), resolved: p, provider: "openai", key: "dummy-key", fetch: vi.fn<typeof fetch>().mockResolvedValue(response([
      raw(), raw({ category: "register", action: "shorten", instruction: "Cut the response to under 100 words." }),
      raw({ span_text: "It is quick.", category: "vague_claim", action: "shorten", instruction: FORK_TEXT.vague_claim }),
    ])) });
    expect(out.findings).toHaveLength(2);
    expect(out.findings[0]?.severity).toBe("warn");
    expect(out.findings[1]?.instruction.action).toBe("specify");
    for (const f of out.findings) expect(FindingSchema.safeParse(f).success).toBe(true);
  });
  it("counts missing spans and only attaches to the first eligible prose occurrence", async () => {
    const text = "```\nIt always works.\n```\n\n> It always works.\n\nIt always works. It always works.\n\nUse `hidden code` here.";
    const out = await reviewDraft({ request: request(text), resolved: profile(), provider: "openai", key: "dummy-key", fetch: vi.fn<typeof fetch>().mockResolvedValue(response([raw(), raw({ span_text: "missing" }), raw({ span_text: "hidden code" })])) });
    expect(out.findings).toHaveLength(1);
    expect(out.findings[0]?.span.start).toBe(text.indexOf("It always works. It always works."));
    expect(out.span_misses).toBe(2);
  });
  it("caps accepted findings at six and deduplicates repeats", async () => {
    const spans = Array.from({ length: 10 }, (_, i) => `Claim ${i} is true.`);
    const out = await reviewDraft({ request: request(spans.join(" ")), resolved: profile(), provider: "openai", key: "dummy-key", fetch: vi.fn<typeof fetch>().mockResolvedValue(response([raw({ span_text: spans[0] }), ...spans.map((span_text) => raw({ span_text }))])) });
    expect(out.findings).toHaveLength(6);
  });
  it("runs pass two below the floor but never promotes new findings", async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => response([raw()]));
    const input = { request: request("It always works."), resolved: profile(), provider: "openai" as const, key: "dummy-key", fetch: fetcher };
    const first = await reviewDraft(input);
    input.request.pass = 2;
    input.resolved.thresholds.reviewer_floor_words = 150;
    expect((await reviewDraft(input)).findings[0]?.severity).toBe("info");
    input.request.prior_findings = [first.findings[0]?.id ?? "missing"];
    expect((await reviewDraft(input)).findings[0]?.severity).toBe("block");
  });
  it.each(["disabled", "floor", "no_prose", "key", "policy", "vended", "long"])("does no network work for %s", async (why) => {
    const p = profile();
    const r = request("It always works.");
    if (why === "disabled") p.reviewer.enabled = false;
    if (why === "floor") p.thresholds.reviewer_floor_words = 150;
    if (why === "no_prose") r.text = "```\ncode\n```";
    if (why === "long") r.text = "word ".repeat(25000);
    if (why === "policy" || why === "vended") p.policy = { org_id: "org", namespace: "org", org_name: "Org", enforcement_default: "advisory", allowed_providers: ["anthropic"], byok_required: true };
    const fetcher = vi.fn<typeof fetch>();
    await reviewDraft({ request: r, resolved: p, provider: why === "vended" ? "anthropic" : "openai", key: why === "key" ? null : "dummy-key", keySource: why === "vended" ? "vended" : "byok", fetch: fetcher });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("retries network/schema failures once, but not HTTP errors or refusals", async () => {
    for (const first of [new Error("secret error"), new Response("invalid JSON")]) {
      const fetcher = vi.fn<typeof fetch>();
      if (first instanceof Error) fetcher.mockRejectedValueOnce(first); else fetcher.mockResolvedValueOnce(first);
      fetcher.mockResolvedValueOnce(response([]));
      expect((await reviewDraft({ request: request("It always works."), resolved: profile(), provider: "openai", key: "dummy-key", fetch: fetcher })).error).toBeNull();
      expect(fetcher).toHaveBeenCalledTimes(2);
    }
    for (const first of [new Response("secret error", { status: 401 }), new Response(JSON.stringify({ status: "completed", output: [{ type: "message", content: [{ type: "refusal", refusal: "secret error" }] }] }))]) {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(first);
      const out = await reviewDraft({ request: request("It always works."), resolved: profile(), provider: "openai", key: "dummy-key", fetch: fetcher });
      expect(out.stats).toBeNull(); expect(JSON.stringify(out)).not.toContain("secret error"); expect(fetcher).toHaveBeenCalledTimes(1);
    }
  });
  it("bounds both a hung fetch and a stalled response body, aborting the request", async () => {
    for (const stalledBody of [false, true]) {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(() => stalledBody ? Promise.resolve(new Response(new ReadableStream({ start() { /* never emits */ } }))) : new Promise(() => {}));
      const start = performance.now();
      const out = await reviewDraft({ request: request("It always works."), resolved: profile(), provider: "openai", key: "dummy-key", timeoutMs: 30, fetch: fetcher });
      expect(out.error).toBe("reviewer_timeout"); expect(performance.now() - start).toBeLessThan(1000);
      expect(fetcher.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
      expect(fetcher).toHaveBeenCalledTimes(1);
    }
  });
  it("re-finds spans exactly in a 30-draft synthetic Unicode/Markdown smoke set", async () => {
    for (let i = 0; i < 30; i++) {
      const span = `Claim ${i} is settled.`;
      const text = ["😀 ", "## Heading\n\n", "```ts\nignored\n```\n\n", "> A quoted line.\n\n", "Résumé: "][i % 5] + span;
      const out = await reviewDraft({ request: request(text), resolved: profile(), provider: "openai", key: "dummy-key", fetch: vi.fn<typeof fetch>().mockResolvedValue(response([raw({ span_text: span })])) });
      expect(out.findings).toHaveLength(1);
      const f = out.findings[0];
      if (!f) throw new Error("missing finding");
      expect(text.slice(f.span.start, f.span.end)).toBe(span);
    }
  });
});
