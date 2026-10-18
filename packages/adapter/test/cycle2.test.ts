import { existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { runCommand } from "../src/commands.js";
import type { Ctx } from "../src/ctx.js";
import { sessionStart, turnEnd, turnStart, type TurnEndOutput } from "../src/hooks.js";
import { SessionStore } from "../src/store.js";
import { CLEAN_TEXT, SESSION, TIC_TEXT, testCtx, tmpDir } from "./helpers.js";

// Review cycle 2: a revision that cannot be re-checked (N7), the life of turn.json (N8) and a reply that was only
// partly read (N9). The lowering comparison (N1, N2), the marker-only cache (N3), turn-start (N6) and the stale-lock
// break (N10) are in lowering, profiles, store and locks tests.

vi.setConfig({ testTimeout: 120_000 });

const CWD = "/work/project";

function started(over: Partial<Ctx> = {}): { home: string; ctx: Ctx } {
  const home = tmpDir();
  const ctx = testCtx(home, { cwd: CWD, ...over });
  sessionStart({ harness: "claude-code", session_id: SESSION, cwd: CWD, mode: "interactive" }, ctx);
  return { home, ctx };
}
function end(ctx: Ctx, text: string, over: Record<string, unknown> = {}): TurnEndOutput {
  return turnEnd({ session_id: SESSION, turn_id: "turn-1", assistant_text: text, user_message: "", tool_calls: [], continuation: false, ...over } as never, ctx).output;
}
function status(ctx: Ctx): string {
  return runCommand(["status"], { ...ctx, env: { ...ctx.env, PROSEGATE_SESSION: SESSION } }).out;
}

const BAD =
  "This change could potentially break the build on older runners. It is worth noting that the cache is keyed per tenant, " +
  "so two tenants never share an entry. The reads go through the catalog service, and the writes go straight to the store. " +
  "We measured the latency on the staging dataset and it dropped from 410 ms to 95 ms at p95.";
const FIXED =
  "This change breaks the build on runners older than 2.3. The cache is keyed per tenant, " +
  "so two tenants never share an entry. The reads go through the catalog service, and the writes go straight to the store. " +
  "We measured the latency on the staging dataset and it dropped from 410 ms to 95 ms at p95.";
const sentences = (text: string) => text.split(". ").map((s) => (s.endsWith(".") ? s : `${s}.`));
const QUOTED = sentences(BAD).map((s) => `> ${s}`).join("\n");
const INDENTED = sentences(BAD).map((s) => `    ${s}`).join("\n");
const UNCHECKED = "Prosegate · 2 findings could not be re-checked (the revision has no prose) · shipped as is";

describe("a revision with no prose clears nothing (N7)", () => {
  it.each([
    ["a blockquote", QUOTED],
    ["an indented block", INDENTED],
    ["a code fence", `\`\`\`\n${BAD}\n\`\`\``],
  ])("pass 2 that is %s: the turn ships, the findings are the remainder, nothing is cleared", (_name, revision) => {
    const { ctx } = started();
    expect(end(ctx, BAD).decision).toBe("continue");
    const second = end(ctx, revision, { continuation: true });
    expect(second.decision).toBe("allow");
    expect(second.notice).toBe(UNCHECKED);
    expect(second.result.cleared).toEqual([]);
    expect(second.feedback_text).toBe("");
    expect(status(ctx)).toContain("Last turn: 2 remain after 1 revision, shipped as is");
    // A repeated Stop does not repeat the line (once per turn).
    expect(end(ctx, revision, { continuation: true }).notice).toBeNull();
  });

  it("the cap check with a prose-less text says the same (pass_cap 1)", () => {
    const { home, ctx } = started();
    mkdirSync(join(home, "profiles"), { recursive: true });
    writeFileSync(join(home, "profiles", "one.yaml"), "schema: prosegate.profile/1\nid: local/one\nversion: 1\nname: One\nextends: local/base\nenforcement:\n  mode: enforce\n  pass_cap: 1\n  render: diff\n");
    expect(runCommand(["profile", "local/one"], { ...ctx, env: { PROSEGATE_SESSION: SESSION } }).code).toBe(0);
    expect(end(ctx, BAD).decision).toBe("continue");
    const second = end(ctx, QUOTED, { continuation: true });
    expect(second.decision).toBe("allow");
    expect(second.notice).toBe(UNCHECKED);
    expect(second.result.cleared).toEqual([]);
  });

  it("a real revision is unchanged: fixed findings are cleared and the turn is clean", () => {
    const { ctx } = started();
    end(ctx, BAD);
    const second = end(ctx, FIXED, { continuation: true });
    expect(second.decision).toBe("allow");
    expect(second.result.cleared).toHaveLength(2);
    expect(second.notice ?? "").not.toContain("re-checked");
    expect(status(ctx)).toContain("Last turn: clean after 1 revision");
  });

  it("headless records the findings as shipped_remaining and prints no notice; quiet hides the line", () => {
    const headless = started({ env: { CI: "true" } });
    end(headless.ctx, BAD);
    const out = end(headless.ctx, QUOTED, { continuation: true });
    expect(out.notice).toBeNull();
    const report = new SessionStore(headless.ctx, SESSION).readReport();
    expect(report.turns.at(-1)?.shipped_remaining).toBe(2);
    const quiet = started();
    runCommand(["quiet"], { ...quiet.ctx, env: { PROSEGATE_SESSION: SESSION } });
    end(quiet.ctx, BAD);
    expect(end(quiet.ctx, QUOTED, { continuation: true }).notice).toBeNull();
  });
});

describe("turn.json does not outlive its turn (N8)", () => {
  const turnFile = (home: string, id = SESSION) => join(home, "sessions", id, "turn.json");
  const hoursAgo = (path: string, h: number) => {
    const when = new Date(Date.now() - h * 3600_000);
    utimesSync(path, when, when);
  };

  it("session start deletes a turn.json older than an hour, in this session and in others, and keeps a younger one", () => {
    const { home, ctx } = started();
    turnStart({ session_id: SESSION, user_message: "SECRET-ONE", tool_calls_so_far: [] }, ctx);
    sessionStart({ harness: "claude-code", session_id: "other", cwd: CWD, mode: "interactive" }, ctx);
    turnStart({ session_id: "other", user_message: "SECRET-TWO", tool_calls_so_far: [] }, ctx);
    hoursAgo(turnFile(home), 3);
    // A third session starting: the old one goes, the fresh one stays.
    sessionStart({ harness: "claude-code", session_id: "third", cwd: CWD, mode: "interactive" }, ctx);
    expect(existsSync(turnFile(home))).toBe(false);
    expect(existsSync(turnFile(home, "other"))).toBe(true);
    // This session's own start, an hour later, takes its own old file too.
    hoursAgo(turnFile(home, "other"), 2);
    sessionStart({ harness: "claude-code", session_id: "other", cwd: CWD, mode: "interactive", source: "resume" }, ctx);
    expect(existsSync(turnFile(home, "other"))).toBe(false);
  });

  it("a turn-end that fails open deletes turn.json", () => {
    const { home, ctx } = started();
    turnStart({ session_id: SESSION, user_message: "SECRET-THREE", tool_calls_so_far: [] }, ctx);
    expect(existsSync(turnFile(home))).toBe(true);
    const crashing = { ...ctx, testHooks: { crash: "turn-end" } };
    expect(() => end(crashing, TIC_TEXT)).toThrow(/injected crash/);
    expect(existsSync(turnFile(home))).toBe(false);
  });

  it("an ordinary allow deletes it (unchanged) and a revision keeps it for the next Stop", () => {
    const { home, ctx } = started();
    turnStart({ session_id: SESSION, user_message: "SECRET-FOUR", tool_calls_so_far: [] }, ctx);
    expect(end(ctx, TIC_TEXT).decision).toBe("continue");
    expect(existsSync(turnFile(home))).toBe(true);
    expect(end(ctx, CLEAN_TEXT, { continuation: true }).decision).toBe("allow");
    expect(existsSync(turnFile(home))).toBe(false);
  });

  it("temp files that may hold the message are swept at turn-start (when old) and at session start", () => {
    const { home, ctx } = started();
    const dir = join(home, "sessions", SESSION);
    const old = join(dir, "turn.json.1234.abcd1234.tmp");
    const fresh = join(dir, "turn.json.1234.ffff0000.tmp");
    writeFileSync(old, '{"user_message":"SECRET-FIVE"}');
    writeFileSync(fresh, "{}");
    hoursAgo(old, 1);
    turnStart({ session_id: SESSION, user_message: "x", tool_calls_so_far: [] }, ctx);
    expect(existsSync(old)).toBe(false);
    expect(existsSync(fresh)).toBe(true); // a write may be in flight
    const other = join(home, "sessions", "gone-quiet");
    mkdirSync(other, { recursive: true });
    const leftover = join(other, "turn.json.9.deadbeef.tmp");
    writeFileSync(leftover, '{"user_message":"SECRET-SIX"}');
    hoursAgo(leftover, 1);
    sessionStart({ harness: "claude-code", session_id: "next", cwd: CWD, mode: "interactive" }, ctx);
    expect(existsSync(leftover)).toBe(false);
  });
});

describe("a reply that was only partly read says so (N9)", () => {
  const TRUNCATED = "Prosegate · only the first 100 KB of prose in this reply was reviewed";
  const TOO_LONG = "Prosegate · this reply is too long to review; its prose was not checked";
  const clean = (kb: number): string => `${CLEAN_TEXT} `.repeat(Math.ceil((kb * 1024) / CLEAN_TEXT.length));

  it("tics after the first 100 KB: the allow carries the line, and status says what was reviewed", () => {
    const { ctx } = started();
    const out = end(ctx, `${clean(110)}\n\n${TIC_TEXT}`);
    expect(out.decision).toBe("allow");
    expect(out.notice).toBe(TRUNCATED);
    expect(status(ctx)).toContain("Last turn: only the first 100 KB of prose was reviewed");
  });

  it("when the first pass asks for a revision the line waits for the next allow", () => {
    const { ctx } = started();
    const first = end(ctx, `${TIC_TEXT}\n\n${clean(300)}`);
    expect(first.decision).toBe("continue");
    expect(first.notice ?? "").not.toContain("100 KB");
    const second = end(ctx, CLEAN_TEXT, { continuation: true });
    expect(second.decision).toBe("allow");
    expect(second.notice ?? "").toContain(TRUNCATED);
    // Once: the next turn is a normal one.
    expect(end(ctx, CLEAN_TEXT, { turn_id: "turn-2" }).notice).toBeNull();
  });

  it("more than 1 MB of code before the prose: not 'no prose to check' but 'too long', in the notice and in status", () => {
    const { ctx } = started();
    const code = `\`\`\`\n${"x = 1\n".repeat(190_000)}\`\`\`\n\n`;
    const out = end(ctx, code + TIC_TEXT);
    expect(out.decision).toBe("allow");
    expect(out.notice).toBe(TOO_LONG);
    const text = status(ctx);
    expect(text).toContain("Last turn: not reviewed (the reply is too long to check)");
    expect(text).not.toContain("no prose to check");
  });

  it("shown in quiet too (it is about what was not checked), never in headless, whose report records it", () => {
    const quiet = started();
    runCommand(["quiet"], { ...quiet.ctx, env: { PROSEGATE_SESSION: SESSION } });
    expect(end(quiet.ctx, `${clean(110)}\n\n${TIC_TEXT}`).notice).toBe(TRUNCATED);
    const headless = started({ env: { CI: "true" } });
    expect(end(headless.ctx, `${clean(110)}\n\n${TIC_TEXT}`).notice).toBeNull();
    const code = `\`\`\`\n${"x = 1\n".repeat(190_000)}\`\`\`\n\n`;
    end(headless.ctx, code + TIC_TEXT, { turn_id: "turn-2" });
    expect(new SessionStore(headless.ctx, SESSION).readReport().turns.at(-1)?.skipped_reason).toBe("too_long");
  });

  it("a reply under the limit has no such line", () => {
    const { ctx } = started();
    expect(end(ctx, CLEAN_TEXT).notice).toBeNull();
    expect(readFileSync(join(ctx.home, "sessions", SESSION, "state.json"), "utf8")).not.toContain('"truncated_pending": true');
  });
});
