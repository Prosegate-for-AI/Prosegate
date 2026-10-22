import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ReviewResultSchema } from "@prosegate/schema";
import { sessionStart, turnEndWithReviewer, turnStart } from "../src/hooks.js";
import { automaticReviewer, setAutomaticReviewer } from "../src/reviewer-settings.js";
import { runReviewerCommand } from "../src/reviewer-command.js";
import { SessionStore } from "../src/store.js";
import { TurnEndInputSchema } from "../src/schemas.js";
import { INIT_CHECK_SESSION } from "../src/init-check.js";
import { CLEAN_TEXT, testCtx, tmpDir, turnEndInput } from "./helpers.js";
import { run } from "../src/run.js";

const text = "They told them to change it before that happened.";
const finding = { span_text: text, category: "register", check_id: "missing-actor", exception_applies: false,
  severity: "warn", confidence: 0.9, action: "rephrase", instruction: "Identify who told whom to change what and before which event.", evidence: "The pronouns have no identifiable referents." };
function setup(profile = "local/writing-review", sid = "auto-test") {
  const ctx = testCtx(tmpDir(), { platform: "linux" });
  sessionStart({ harness: "claude-code", session_id: sid, cwd: ctx.cwd, mode: "interactive" }, ctx);
  const store = new SessionStore(ctx, sid);
  store.updateState(() => { throw new Error("missing session"); }, (s) => ({ ...s, active_profile: profile }));
  turnStart({ session_id: sid, turn_id: "turn-1", user_message: "Explain who changed what.", tool_calls_so_far: [] }, ctx);
  const input = TurnEndInputSchema.parse(turnEndInput(text, { session_id: sid }));
  const getKey = vi.fn(async () => "dummy-private-key");
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response(JSON.stringify({ status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify({ findings: [finding] }) }] }], usage: { input_tokens: 100, output_tokens: 30 } })));
  return { ctx, store, input, getKey, fetcher, deps: { getKey, fetch: fetcher } };
}

describe("automatic reviewer opt-in and Stop lifecycle", () => {
  it("never reads a key or calls the provider without a valid opt-in", async () => {
    const s = setup();
    for (const config of [null, "invalid", '{"v":1,"provider":"openai","endpoint":"https://invalid"}', '{"v":1,"provider":"other"}']) {
      if (config !== null) writeFileSync(join(s.ctx.home, "automatic-reviewer.json"), config);
      const r = await turnEndWithReviewer(s.input, s.ctx, s.deps);
      expect(r.output.result.stats.reviewer).toBeNull();
    }
    expect(s.getKey).not.toHaveBeenCalled(); expect(s.fetcher).not.toHaveBeenCalled();
  });
  it("uses the saved key, shares validation, retains warning severity and deletes the stored prompt", async () => {
    const s = setup(); setAutomaticReviewer(s.ctx, "openai");
    const r = await turnEndWithReviewer(s.input, s.ctx, s.deps);
    expect(r.output.decision).toBe("allow");
    expect(ReviewResultSchema.parse(r.output.result).findings).toMatchObject([{ source: "reviewer", severity: "warn" }]);
    expect(r.output.notice).toContain("AI review completed");
    expect(s.store.readTurn()).toBeNull();
    const body = JSON.parse(String(s.fetcher.mock.calls[0]?.[1]?.body));
    expect(s.fetcher.mock.calls[0]?.[0]).toBe("https://api.openai.com/v1/responses");
    expect(body.store).toBe(false);
    expect(JSON.parse(body.input[0].content)).toMatchObject({ draft: text, user_message: "Explain who changed what." });
    const receipt = readFileSync(join(s.store.dir, "reviewer-attempts.json"), "utf8");
    expect(receipt).not.toContain(text); expect(receipt).not.toContain("dummy-private-key");
  });
  it("claims a pass before awaiting and does not repeat it on concurrent or duplicate Stop events", async () => {
    const s = setup(); setAutomaticReviewer(s.ctx, "openai");
    await Promise.all([turnEndWithReviewer(s.input, s.ctx, s.deps), turnEndWithReviewer(s.input, s.ctx, s.deps)]);
    await turnEndWithReviewer(s.input, s.ctx, s.deps);
    expect(s.fetcher).toHaveBeenCalledTimes(1);
  });
  it("reviews a genuinely new repeated prompt while deduplicating prompt-hook redelivery", async () => {
    const s = setup(); setAutomaticReviewer(s.ctx, "openai");
    await turnEndWithReviewer(s.input, s.ctx, s.deps);
    const start = { session_id: s.input.session_id, turn_id: "turn-1", user_message: "Explain who changed what.", tool_calls_so_far: [] };
    turnStart(start, s.ctx); turnStart(start, s.ctx);
    await turnEndWithReviewer(s.input, s.ctx, s.deps);
    await turnEndWithReviewer(s.input, s.ctx, s.deps);
    expect(s.fetcher).toHaveBeenCalledTimes(2);
  });
  it.each(["off", "floor", "policy", "oversized", "init", "disabled"])("does not pay for %s reviews", async (why) => {
    const s = setup(why === "floor" ? "local/base" : "local/writing-review", why === "init" ? INIT_CHECK_SESSION : "auto-test");
    setAutomaticReviewer(s.ctx, "openai");
    if (why === "off") s.store.updateState(() => { throw new Error("missing"); }, (v) => ({ ...v, mode: "off" }));
    if (why === "policy") s.ctx.policy = { org_id: "test", org_name: "Test org", namespace: "test", allowed_providers: ["anthropic"] };
    if (why === "oversized") s.input.assistant_text = "A clear sentence. ".repeat(7000);
    if (why === "disabled") setAutomaticReviewer(s.ctx, null);
    await turnEndWithReviewer(s.input, s.ctx, s.deps);
    expect(s.getKey).not.toHaveBeenCalled(); expect(s.fetcher).not.toHaveBeenCalled();
  });
  it("retains local findings and does not echo key/provider failures", async () => {
    const s = setup(); setAutomaticReviewer(s.ctx, "openai");
    s.input.assistant_text = "At this point in time, the patch might possibly help.";
    s.getKey.mockRejectedValue(new Error("dummy-private-key"));
    const r = await turnEndWithReviewer(s.input, s.ctx, s.deps);
    expect(r.output.result.findings.some((f) => f.source === "rule")).toBe(true);
    expect(r.output.result.stats.reviewer).toBeNull(); expect(JSON.stringify(r)).not.toContain("dummy-private-key");
    expect(s.fetcher).not.toHaveBeenCalled();
  });
  it("does not start a provider call when disabled while the keychain is opening", async () => {
    const s = setup(); setAutomaticReviewer(s.ctx, "openai");
    s.getKey.mockImplementation(async () => { setAutomaticReviewer(s.ctx, null); return "dummy-private-key"; });
    await turnEndWithReviewer(s.input, s.ctx, s.deps);
    expect(s.fetcher).not.toHaveBeenCalled();
  });
  it("aborts within the remaining hook budget and preserves local output", async () => {
    const s = setup(); setAutomaticReviewer(s.ctx, "openai");
    s.ctx.elapsedMs = () => 5800;
    s.fetcher.mockImplementation(async (_url, options) => new Promise((_resolve, reject) => {
      options?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    }));
    const r = await turnEndWithReviewer(s.input, s.ctx, s.deps);
    expect(r.output.decision).toBe("allow"); expect(r.stderr.join(" ")).toContain("reviewer_timeout");
    expect(r.output.result.stats.reviewer).toBeNull();
  });
  it("preserves pass-two clearance on failure and never calls the provider after the revision cap", async () => {
    const s = setup("local/base"); setAutomaticReviewer(s.ctx, "openai");
    s.input.assistant_text = "It always works. " + CLEAN_TEXT.repeat(2);
    const block = { ...finding, span_text: "It always works.", check_id: null, category: "unsupported_claim", severity: "block", action: "cite_or_soften_or_remove" };
    s.fetcher.mockImplementation(async () => new Response(JSON.stringify({ status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify({ findings: [block] }) }] }] })));
    const first = await turnEndWithReviewer(s.input, s.ctx, s.deps);
    expect(first.output.decision).toBe("continue");
    s.input.continuation = true;
    const second = await turnEndWithReviewer(s.input, s.ctx, s.deps);
    expect(second.output.decision).toBe("continue");
    const capped = await turnEndWithReviewer(s.input, s.ctx, s.deps);
    expect(capped.output.decision).toBe("allow"); expect(capped.output.result.cleared).toEqual([]);
    expect(s.fetcher).toHaveBeenCalledTimes(2);
    const other = setup("local/base"); setAutomaticReviewer(other.ctx, "openai");
    other.input.assistant_text = s.input.assistant_text;
    await turnEndWithReviewer(other.input, other.ctx, s.deps);
    other.input.continuation = true; other.getKey.mockRejectedValue(new Error("locked"));
    const failed = await turnEndWithReviewer(other.input, other.ctx, other.deps);
    expect(failed.output.result.cleared).toEqual([]);
  });
  it("awaits the automatic stage in the CLI hook dispatch", async () => {
    const s = setup(); setAutomaticReviewer(s.ctx, "openai");
    // Missing stored key exercises the real async dispatch with no network or test key injection.
    let out = "";
    expect(await run(["turn-end"], { ctx: s.ctx, stdin: async () => JSON.stringify(s.input), stdout: { write: (v) => { out += v; } }, stderr: { write: () => {} } })).toBe(0);
    expect(JSON.parse(out).decision).toBe("allow");
  });
});

describe("automatic reviewer commands", () => {
  it("requires a saved key, refuses agent mutations, exposes status and disables without deleting keys", async () => {
    const s = setup(); let out = "";
    const io = { stdin: async () => "", stdout: { write: (v: string) => { out += v; } }, stderr: { write: () => {} } };
    const store = { prepare: vi.fn(async () => ({ backend: "file" as const, notice: null })), get: vi.fn(async (): Promise<string | null> => null) };
    // Commands accept only the two operations they need, without requiring a real credential in tests.
    expect(await runReviewerCommand(["on", "--provider", "openai"], io, s.ctx, store)).toBe(1);
    expect(automaticReviewer(s.ctx)).toBeNull(); store.get.mockResolvedValue("dummy-private-key");
    expect(await runReviewerCommand(["on", "--provider", "openai"], io, s.ctx, store)).toBe(0);
    expect(automaticReviewer(s.ctx)).toBe("openai");
    expect(await runReviewerCommand(["off"], io, { ...s.ctx, stdinIsTTY: false, env: { CLAUDECODE: "1" } }, store)).toBe(1);
    expect(await runReviewerCommand(["status"], io, s.ctx, store)).toBe(0); expect(out).toContain("openai");
    expect(out).not.toContain("dummy-private-key");
    expect(await runReviewerCommand(["off"], io, s.ctx, store)).toBe(0); expect(automaticReviewer(s.ctx)).toBeNull();
  });
});
