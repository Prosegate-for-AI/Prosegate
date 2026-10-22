import { describe, expect, it, vi } from "vitest";
import { ReviewResultSchema, type ReviewRequest } from "@prosegate/schema";
import { KeyStore } from "../src/key-store.js";
import { runKeyCommand, runReviewCommand } from "../src/reviewer-command.js";
import { createCtx } from "../src/ctx.js";
import type { RunIO } from "../src/run.js";
import { buildBundle, pg, tmpDir } from "./helpers.js";

const text = "Great question! It always works. " + "The cache stores an entry per tenant and reads the database on a miss. ".repeat(15);
const request = (): ReviewRequest => ({ schema: "prosegate.review/1", text, context: { user_message: "Explain the cache", style_constraints: "", mode: "interactive" }, pass: 1, stages: ["rules", "reviewer"], profile_id: "local/base", session_id: "manual", turn_id: "manual", prior_findings: [] });
const setup = () => {
  const ctx = createCtx({ home: tmpDir(), env: { PROSEGATE_KEY_STORE: "file" }, elapsedMs: () => 0, stdinIsTTY: true });
  const stdout = vi.fn<(text: string) => void>(); const stderr = vi.fn<(text: string) => void>();
  const io: RunIO = { ctx, stdout: { write: stdout }, stderr: { write: stderr }, stdin: async () => "dummy-key\n", secret: async () => "dummy-key" };
  const store = new KeyStore(ctx);
  return { ctx, stdout, stderr, io, store };
};
describe("explicit reviewer preview", () => {
  it("carries optional writing context to the provider and merges warnings without duplicates", async () => {
    const { ctx, io, store, stdout } = setup(); await store.prepare(); await store.set("openai", "dummy-key");
    const r = request();
    r.profile_id = "local/writing-review";
    r.text = "The patch might possibly reduce latency. The vendor may terminate the agreement.";
    r.context.audience = "Contract reviewers";
    r.context.original_text = "The vendor may terminate only after giving 30 days' written notice.";
    r.context.source_material = "The patch has not yet been benchmarked.";
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify({ findings: [
      { check_id: "stacked-uncertainty", exception_applies: false, span_text: "The patch might possibly reduce latency.", category: "register", severity: "block", confidence: 0.9, action: "rephrase", instruction: "Retain one hedge and the uncertainty.", evidence: "The hedges repeat the same uncertainty." },
      { check_id: "meaning-lost", exception_applies: false, span_text: "The vendor may terminate the agreement.", category: "register", severity: "block", confidence: 0.9, action: "rephrase", instruction: "Restore the notice period from the original.", evidence: "The original requires thirty days of notice." },
    ] }) }] }] })));
    expect(await runReviewCommand(["--provider", "openai"], JSON.stringify(r), io, ctx, { store, fetch: fetcher })).toBe(0);
    const result = ReviewResultSchema.parse(JSON.parse(stdout.mock.calls[0]?.[0] ?? ""));
    expect(result.verdict).toBe("pass");
    expect(result.findings.map((f) => [f.source, f.severity])).toEqual([["rule", "warn"], ["reviewer", "warn"]]);
    const body = JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body));
    expect(JSON.parse(body.input[0].content)).toMatchObject({ audience: r.context.audience, original_text: r.context.original_text, source_material: r.context.source_material, local_findings: [{ rule_id: "writing.hedge.001", span_text: "might possibly" }] });
  });
  it("runs key commands from the release bundle without installing hooks", async () => {
    const bundle = await buildBundle();
    const home = tmpDir();
    const env = { PROSEGATE_KEY_STORE: "file" };
    const set = pg(bundle, ["key", "set", "openai", "--stdin"], { home, env, raw: "dummy-private-value\n" });
    expect(set.code).toBe(0);
    expect(set.stdout + set.stderr).not.toContain("dummy-private-value");
    expect(pg(bundle, ["key", "status", "openai"], { home, env }).stdout).toContain("key set");
    expect(pg(bundle, ["key", "remove", "openai"], { home, env }).code).toBe(0);
    expect(pg(bundle, ["key", "status", "openai"], { home, env }).stdout).toContain("not set");
  });
  it("manages keys without printing them and refuses secret arguments", async () => {
    const { ctx, io, stdout, stderr, store } = setup();
    for (const action of ["set", "status", "remove", "status"]) expect(await runKeyCommand([action, "openai"], io, ctx, store)).toBe(0);
    expect(stdout.mock.calls.at(-1)?.[0]).toContain("not set");
    expect(await runKeyCommand(["set", "openai", "dummy-key"], io, ctx, store)).toBe(1);
    expect(JSON.stringify([stdout.mock.calls, stderr.mock.calls])).not.toContain("dummy-key");
  });
  it("refuses agent key mutations before reading input", async () => {
    const { ctx, io, store } = setup(); const read = vi.fn(async () => "dummy-key"); io.stdin = read;
    expect(await runKeyCommand(["set", "openai", "--stdin"], io, { ...ctx, stdinIsTTY: false, env: { CLAUDECODE: "1" } }, store)).toBe(1);
    expect(read).not.toHaveBeenCalled();
  });
  it("merges reviewer and rule findings into a valid result", async () => {
    const { ctx, io, store, stdout } = setup(); await store.prepare(); await store.set("openai", "dummy-key");
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify({ findings: [{ span_text: "It always works.", category: "unsupported_claim", confidence: 0.9, severity: "block", action: "specify", instruction: "Cite it.", evidence: "No basis is given." }] }) }] }], usage: { input_tokens: 30, output_tokens: 20 } })));
    expect(await runReviewCommand(["--provider", "openai"], JSON.stringify(request()), io, ctx, { store, fetch: fetcher })).toBe(0);
    const result = ReviewResultSchema.parse(JSON.parse(stdout.mock.calls[0]?.[0] ?? ""));
    expect(result.findings.some((f) => f.source === "reviewer")).toBe(true);
    expect(result.findings.some((f) => f.source === "rule")).toBe(true);
    expect(result.verdict).toBe("revise");
    expect(result.stats.reviewer?.input_tokens).toBe(30);
  });
  it("preserves rules on missing keys and does not make a network request", async () => {
    const { ctx, io, store, stdout, stderr } = setup(); const fetcher = vi.fn<typeof fetch>();
    expect(await runReviewCommand(["--provider", "openai"], JSON.stringify(request()), io, ctx, { store, fetch: fetcher })).toBe(0);
    const result = ReviewResultSchema.parse(JSON.parse(stdout.mock.calls[0]?.[0] ?? ""));
    expect(result.verdict).toBe("revise"); expect(result.stats.reviewer).toBeNull(); expect(fetcher).not.toHaveBeenCalled();
    expect(stderr.mock.calls.flat().join("")).toContain("key set openai");
  });
  it("does not echo malformed input", async () => {
    const { ctx, io, stdout, stderr } = setup();
    expect(await runReviewCommand(["--provider", "openai"], "private draft broken json", io, ctx)).toBe(1);
    expect(stdout).not.toHaveBeenCalled(); expect(JSON.stringify(stderr.mock.calls)).not.toContain("private draft");
  });
  it("does not claim reviewer findings cleared when pass two skips remote review", async () => {
    const { ctx, io, store, stdout } = setup();
    const r = request(); r.pass = 2; r.prior_findings = ["1234567890"]; r.stages = ["rules"];
    expect(await runReviewCommand(["--provider", "openai"], JSON.stringify(r), io, ctx, { store })).toBe(0);
    expect(ReviewResultSchema.parse(JSON.parse(stdout.mock.calls[0]?.[0] ?? "")).cleared).toEqual([]);
  });
});
