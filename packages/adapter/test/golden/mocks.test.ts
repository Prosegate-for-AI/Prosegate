import { beforeAll, describe, expect, it } from "vitest";
import { renderNotice, type ReviewResult } from "@prosegate/schema";
import { ADAPTER_DIR, json, pg, tmpDir, testHooks } from "../helpers.js";
import { FakeClaudeCode, PROMPT_ID, SESSION, releasePkg, testPkg, type Pkg } from "./driver.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Golden tests for the Claude Code shim (plan section 10): the three 09 mock transcripts replayed through a fake
// Claude Code, one fresh shim process per hook call. Every expected string is written out by hand from 09, 03,
// ADR-16 and ADR-28, not produced by the code under test.

const DASH = "\u2014";
const ARROW = "\u2192";
const DOT = "\u00b7";

const LAST_LINES = [
  "Reply with the revised response only. Do not run prosegate commands.",
  "(For the user: run prosegate advisory in a terminal to pause these revisions for this session.)",
];
const UNSUPPORTED_FORK = "Cite a source you actually have, restate this as expectation or opinion, or remove it. Do not invent a citation.";

/** What Claude Code reads on a continuation: this object and nothing else (ADR-11, ADR-13). */
function continuation(feedback: string): string {
  return `${JSON.stringify({ hookSpecificOutput: { hookEventName: "Stop", additionalContext: feedback } })}\n`;
}

// ---- 09 mock 1 ---------------------------------------------------------------------------------

// 09's first paragraph, padded with plain sentences to clear the 60-word floor.
const MOCK1_TEXT =
  "This PR introduces a robust caching layer that significantly improves performance. It's worth noting that the cache is per tenant, which makes the system fast, simple, and reliable. " +
  "The cache sits in front of the catalog reads and keeps one entry per tenant. A read checks the entry first and falls back to the database on a miss. " +
  "The entry expires after sixty seconds, so a price change reaches every tenant within a minute. Writes bypass the cache and delete the tenant's entry.";
// 09's revised paragraph.
const MOCK1_REVISED =
  "Add a per-tenant cache in front of the catalog reads. p95 latency on /catalog drops from 410 ms to 95 ms on the staging dataset. " +
  "A read checks the entry first and falls back to the database on a miss. The entry expires after sixty seconds, so a price change reaches every tenant within a minute. " +
  "Writes bypass the cache and delete the tenant's entry.";

const MOCK1_FEEDBACK = [
  '[Prosegate] 3 findings against profile "local/pr-description" (pass 1 of 2). Revise your last response.',
  `1. vocab (core.vocab.003) ${DASH} "robust" ${ARROW} Replace with the property that makes it so, or remove.`,
  `2. hedge (core.hedge.001) ${DASH} "It's worth noting that" ${ARROW} Remove the preamble; keep the clause after it.`,
  `3. triad (core.triad.001) ${DASH} "fast, simple, and reliable" ${ARROW} Keep the one that matters, or give evidence for each.`,
  ...LAST_LINES,
].join("\n");

// 09's first four lines, byte for byte (ADR-12 order: hedge, vocab, triad); the override line follows on the first notice.
const MOCK1_NOTICE = [
  `Prosegate ${DOT} profile pr-description ${DOT} 3 findings (hedge 1, vocab 1, triad 1) ${DOT} revising, pass 1 of 2`,
  '  hedge   core.hedge.001  "It\'s worth noting that"',
  '  vocab   core.vocab.003  "robust"',
  '  triad   core.triad.001  "fast, simple, and reliable"',
].join("\n");

let release: Pkg;
let test: Pkg;
beforeAll(async () => {
  release = await releasePkg();
  test = await testPkg();
}, 120_000);

describe("09 mock 1: pass-1 revise, pr-description, interactive", () => {
  it("replays the transcript hook by hook", () => {
    const cc = new FakeClaudeCode(release);

    const start = cc.sessionStart();
    expect(start.code).toBe(0);
    expect(start.stderr).toBe("");
    const startOut = start.json as { hookSpecificOutput: { hookEventName: string; additionalContext: string }; systemMessage?: string };
    expect(startOut.hookSpecificOutput.hookEventName).toBe("SessionStart");
    expect(startOut.hookSpecificOutput.additionalContext).toMatch(/^If a later message starts with \[Prosegate\], revise your last response as it asks\. Do not run prosegate commands\./);
    expect(startOut.systemMessage).toBeUndefined();

    expect(cc.cli(["profile", "pr-description"]).stdout).toBe("Prosegate: profile set to local/pr-description; it applies from the next turn.\n");

    const prompt = cc.prompt("write the PR description for this branch");
    expect(prompt).toMatchObject({ code: 0, stdout: "", stderr: "" });

    // Pass 1: the model's reply has a hedge, a vocab word and a triad.
    const pass1 = cc.stop(MOCK1_TEXT);
    expect(pass1.code).toBe(0);
    expect(pass1.stderr).toBe("");
    // The additionalContext is the canonical feedback_text, byte for byte, in an object with no other key.
    expect(pass1.stdout).toBe(continuation(MOCK1_FEEDBACK));
    expect(Object.keys(pass1.json ?? {})).toEqual(["hookSpecificOutput"]);
    expect(pass1.stdout).not.toContain("systemMessage");
    expect(pass1.stdout).not.toContain('"decision"');

    // The revised reply is clean: allow, and silence.
    const pass2 = cc.stop(MOCK1_REVISED, { stop_hook_active: true });
    expect(pass2).toMatchObject({ code: 0, stdout: "", stderr: "" });
  });

  it("the 09 notice for that result is 09's four lines byte for byte (in Claude Code the feedback block stands in for it)", () => {
    // The same turn through the adapter directly, to get the ReviewResult and the adapter's own notice.
    const home = join(tmpDir(), ".prosegate");
    const env = { PROSEGATE_SESSION: SESSION };
    pg(release.bundle, ["session-start"], { home, input: { harness: "claude-code", session_id: SESSION, cwd: "/work/project", mode: "interactive" } });
    pg(release.bundle, ["profile", "pr-description"], { home, env, cwd: home });
    const r = pg(release.bundle, ["turn-end"], {
      home,
      input: { session_id: SESSION, turn_id: PROMPT_ID, assistant_text: MOCK1_TEXT, tool_calls: [], continuation: false },
    });
    expect(r.code).toBe(0);
    const out = json<{ decision: string; result: ReviewResult; notice: string; feedback_text: string }>(r);
    expect(out.decision).toBe("continue");
    expect(out.feedback_text).toBe(MOCK1_FEEDBACK);
    // 09's mock 1 as it stands after ADR-34: the first notice of a session ends with the override line. This is the adapter's
    // notice, harness-neutral; in Claude Code a continuing turn shows the feedback block instead (ADR-13), asserted above.
    const first = `${MOCK1_NOTICE}\n  To pause for this session, run: prosegate advisory`;
    expect(renderNotice(out.result, { mode: "enforce", render: "diff", firstNoticeOfSession: true, phase: "pass1" })).toBe(first);
    expect(out.notice).toBe(first);
    // Later notices in the session do not repeat it.
    expect(renderNotice(out.result, { mode: "enforce", render: "diff", firstNoticeOfSession: false, phase: "pass1" })).toBe(MOCK1_NOTICE);
  });
});

// ---- 09 mock 2 ---------------------------------------------------------------------------------

const CLAIM_A = "reduces cost by 40%";
const CLAIM_B = "the industry standard approach";
const MOCK2_TEXT =
  `The design moves session lookups from the primary database to a per-region cache. The design ${CLAIM_A}. ` +
  "Each region keeps its own copy, and a write invalidates the entry in every region within a second. " +
  `Reads that miss the cache fall back to the primary and refill the entry. It is ${CLAIM_B} for this problem. ` +
  "The rollout starts with one region, and the fallback path stays in place until the hit rate holds above ninety percent for a week.";
// "one claim cited, one left in"
const MOCK2_REVISED =
  `The design moves session lookups from the primary database to a per-region cache. The staging run cut cost by 40% (run 12 October, tracked in the cost sheet). ` +
  "Each region keeps its own copy, and a write invalidates the entry in every region within a second. " +
  `Reads that miss the cache fall back to the primary and refill the entry. It is ${CLAIM_B} for this problem. ` +
  "The rollout starts with one region, and the fallback path stays in place until the hit rate holds above ninety percent for a week.";

describe("09 mock 2: pass cap reached, design-doc, two unsupported claims (fake reviewer stage)", () => {
  it("pass 1 continues, pass 2 continues with one finding left, pass 3 ships as is", () => {
    // The reviewer is Phase 4: the test build's fake stage reports the two spans (ADR-29).
    const cc = new FakeClaudeCode(test, { env: testHooks({ fakeUnsupportedClaims: [CLAIM_A, CLAIM_B] }) });
    cc.sessionStart();
    expect(cc.cli(["profile", "design-doc"]).code).toBe(0);
    cc.prompt("write the design doc for the session cache");

    const pass1 = cc.stop(MOCK2_TEXT);
    expect(pass1.stdout).toBe(
      continuation(
        [
          '[Prosegate] 2 findings against profile "local/design-doc" (pass 1 of 2). Revise your last response.',
          `1. unsupported claim ${DASH} "${CLAIM_A}" ${ARROW} ${UNSUPPORTED_FORK}`,
          `2. unsupported claim ${DASH} "${CLAIM_B}" ${ARROW} same as 1.`,
          ...LAST_LINES,
        ].join("\n"),
      ),
    );

    // Pass 2: one claim was cited, one left in. "1 of 2 findings remain" (09 pass cap).
    const pass2 = cc.stop(MOCK2_REVISED, { stop_hook_active: true });
    expect(pass2.stdout).toBe(
      continuation(
        [
          '[Prosegate] 1 finding remains after your revision, against profile "local/design-doc" (pass 2 of 2). Revise your last response.',
          `1. unsupported claim ${DASH} "${CLAIM_B}" ${ARROW} ${UNSUPPORTED_FORK}`,
          ...LAST_LINES,
        ].join("\n"),
      ),
    );
    expect(Object.keys(pass2.json ?? {})).toEqual(["hookSpecificOutput"]);

    // Pass 3 (the Stop after the second revision): the claim is still there. Allow, with the "shipped as is" notice.
    const pass3 = cc.stop(MOCK2_REVISED, { stop_hook_active: true });
    expect(pass3.code).toBe(0);
    expect(pass3.json).toEqual({
      systemMessage: [`Prosegate ${DOT} 1 finding remains after 2 passes ${DOT} shipped as is`, `  unsupported claim  "${CLAIM_B}"`].join("\n"),
    });
    expect(pass3.stdout).not.toContain("additionalContext");

    // A further Stop in the same turn (another hook continued the model) does not repeat the notice (ADR-31).
    expect(cc.stop(MOCK2_REVISED, { stop_hook_active: true })).toMatchObject({ code: 0, stdout: "" });
  });

  it("the pass-2 and pass-1 notices are 09's lines (the user sees feedback_text in Claude Code, these are for other channels)", () => {
    const home = join(tmpDir(), ".prosegate");
    const env = { PROSEGATE_SESSION: SESSION };
    const hooks = testHooks({ fakeUnsupportedClaims: [CLAIM_A, CLAIM_B] });
    pg(test.bundle, ["session-start"], { home, input: { harness: "claude-code", session_id: SESSION, cwd: "/work/project", mode: "interactive" }, env: hooks });
    pg(test.bundle, ["profile", "design-doc"], { home, env: { ...env, ...hooks }, cwd: home });
    const turn = (text: string, continuation: boolean) =>
      json<{ notice: string | null }>(
        pg(test.bundle, ["turn-end"], { home, env: hooks, input: { session_id: SESSION, turn_id: PROMPT_ID, assistant_text: text, tool_calls: [], continuation } }),
      );
    expect(turn(MOCK2_TEXT, false).notice).toBe(
      [
        `Prosegate ${DOT} profile design-doc ${DOT} 2 findings (unsupported claim 2) ${DOT} revising, pass 1 of 2`,
        `  unsupported claim  "${CLAIM_A}"`,
        `  unsupported claim  "${CLAIM_B}"`,
        "  To pause for this session, run: prosegate advisory",
      ].join("\n"),
    );
    expect(turn(MOCK2_REVISED, true).notice).toBe(`Prosegate ${DOT} 1 of 2 findings remain ${DOT} revising, pass 2 of 2`);
  });
});

describe("the fake reviewer is a test-build seam only (ADR-29)", () => {
  it("the release bundle neither contains it nor honours it, even with the lever set in the environment", () => {
    // The seam's code is compiled out of the release bundle (its evidence text is the tell), and is in the test build.
    expect(readFileSync(release.bundle, "utf8")).not.toContain("The turn gives no basis for this claim.");
    expect(readFileSync(test.bundle, "utf8")).toContain("The turn gives no basis for this claim.");
    const cc = new FakeClaudeCode(release, { env: testHooks({ fakeUnsupportedClaims: [CLAIM_A, CLAIM_B] }) });
    cc.sessionStart();
    cc.cli(["profile", "design-doc"]);
    expect(cc.stop(MOCK2_TEXT)).toMatchObject({ code: 0, stdout: "", stderr: "" });
  });
});

// ---- advisory ----------------------------------------------------------------------------------

describe("09 advisory mode", () => {
  it("prosegate advisory prints 09's line; the next Stop allows with the advisory notice as systemMessage", () => {
    const cc = new FakeClaudeCode(release);
    cc.sessionStart();
    cc.cli(["profile", "pr-description"]);
    cc.prompt("summarise the incident");

    const adv = cc.cli(["advisory"]);
    expect(adv.code).toBe(0);
    expect(adv.stdout).toBe("Prosegate: advisory for this session. Findings will be shown, not enforced. Run prosegate enforce to restore.\n");

    const stop = cc.stop(MOCK1_TEXT);
    expect(stop.code).toBe(0);
    expect(Object.keys(stop.json ?? {})).toEqual(["systemMessage"]);
    expect(stop.stdout).not.toContain("additionalContext");
    // ADR-30, ADR-33: the first turn of a lowered session says so inside the one notice's header; exactly three finding lines fit.
    expect((stop.json as { systemMessage: string }).systemMessage).toBe(
      [
        `Prosegate ${DOT} profile pr-description ${DOT} 3 findings (hedge 1, vocab 1, triad 1) ${DOT} advisory, not enforced ${DOT} enforcement is lowered in this session (advisory)`,
        '  hedge   core.hedge.001  "It\'s worth noting that"',
        '  vocab   core.vocab.003  "robust"',
        '  triad   core.triad.001  "fast, simple, and reliable"',
      ].join("\n"),
    );

    // The lowered text is shown once; the advisory notice is shown on every turn that has findings.
    const again = cc.stop(MOCK1_TEXT, { prompt_id: "second-prompt" });
    expect((again.json as { systemMessage: string }).systemMessage.split("\n")[0]).toBe(
      `Prosegate ${DOT} profile pr-description ${DOT} 3 findings (hedge 1, vocab 1, triad 1) ${DOT} advisory, not enforced`,
    );

    // enforce restores the revision.
    expect(cc.cli(["enforce"]).stdout).toBe("Prosegate: enforcement restored for this session.\n");
    const back = cc.stop(MOCK1_TEXT, { prompt_id: "third-prompt" });
    expect(back.stdout).toBe(continuation(MOCK1_FEEDBACK));
  });
});

// 09's advisory mock: profile chat-reply, filler.001 and filler.004, padded with plain sentences to clear the 60-word floor.
const CHAT_TEXT =
  "Great question! The cache sits in front of the catalog reads and keeps one entry per tenant. A read checks the entry first and falls back to the database on a miss. " +
  "The entry expires after sixty seconds, so a price change reaches every tenant within a minute. In summary, writes bypass the cache and delete the tenant's entry, which keeps the two copies from drifting apart.";

describe("09 advisory mock (chat-reply), byte for byte", () => {
  it("the first advisory turn: the lowered text is in the header, two finding lines follow", () => {
    const cc = new FakeClaudeCode(release);
    cc.sessionStart();
    expect(cc.cli(["profile", "chat-reply"]).code).toBe(0);
    expect(cc.cli(["advisory"]).code).toBe(0);
    const stop = cc.stop(CHAT_TEXT);
    expect(stop.json).toEqual({
      systemMessage: [
        `Prosegate ${DOT} profile chat-reply ${DOT} 2 findings (filler 2) ${DOT} advisory, not enforced ${DOT} enforcement is lowered in this session (advisory)`,
        // 09's advisory mock (after ADR-34): the label padded to max(8, longest + 2), the rule phrases without punctuation.
        '  filler  core.filler.001  "Great question"',
        '  filler  core.filler.004  "In summary"',
      ].join("\n"),
    });
    // Later advisory turns: the header without the lowered text.
    const next = cc.stop(CHAT_TEXT, { prompt_id: "second-prompt" });
    expect(next.json).toEqual({ systemMessage: [`Prosegate ${DOT} profile chat-reply ${DOT} 2 findings (filler 2) ${DOT} advisory, not enforced`, '  filler  core.filler.001  "Great question"', '  filler  core.filler.004  "In summary"'].join("\n") });
  });

  it("a lowering that starts while a revision is asked for is not spent on the continuation: the allow that follows carries it (b8d17b5)", () => {
    const cc = new FakeClaudeCode(release);
    cc.sessionStart();
    expect(cc.cli(["profile", "pr-description"]).code).toBe(0);
    expect(cc.cli(["rule", "off", "core.vocab.003"]).code).toBe(0);
    const pass1 = cc.stop(MOCK1_TEXT);
    expect(Object.keys(pass1.json ?? {})).toEqual(["hookSpecificOutput"]); // the notice is never displayed on a continuation
    const allow = cc.stop(MOCK1_REVISED, { stop_hook_active: true });
    const lines = (allow.json as { systemMessage: string }).systemMessage.split("\n");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^Prosegate · enforcement is lowered in this session \(.+\) · prosegate status$/);
    expect(cc.stop(MOCK1_REVISED, { prompt_id: "next-turn" })).toMatchObject({ code: 0, stdout: "" });
  });

  it("an advisory turn with no findings keeps the lowered line on its own, once", () => {
    const cc = new FakeClaudeCode(release);
    cc.sessionStart();
    cc.cli(["advisory"]);
    expect(cc.stop(MOCK1_REVISED).json).toEqual({ systemMessage: `Prosegate ${DOT} enforcement is lowered in this session (advisory) ${DOT} prosegate status` });
    expect(cc.stop(MOCK1_REVISED, { prompt_id: "second-prompt" })).toMatchObject({ code: 0, stdout: "" });
  });

  it("more than three findings: three lines, then '  …and N more'", () => {
    const cc = new FakeClaudeCode(release);
    cc.sessionStart();
    cc.cli(["profile", "pr-description"]);
    cc.cli(["advisory"]);
    const many =
      "Great question! It's worth noting that this PR introduces a robust and seamless caching layer. In summary, the cache is per tenant, which makes the system fast, simple, and reliable. " +
      "The cache sits in front of the catalog reads and keeps one entry per tenant. A read checks the entry first and falls back to the database on a miss. Writes bypass the cache and delete the tenant's entry.";
    const lines = (cc.stop(many).json as { systemMessage: string }).systemMessage.split("\n");
    expect(lines).toHaveLength(5);
    expect(lines[0]).toMatch(/^Prosegate · profile pr-description · \d+ findings \(.+\) · advisory, not enforced · enforcement is lowered in this session \(advisory\)$/);
    expect(lines.slice(1, 4).every((l) => l.startsWith("  ") && !l.includes("more"))).toBe(true);
    expect(lines[4]).toMatch(/^ {2}…and \d+ more$/);
  });
});

// ---- more shim behaviour through the real adapter ---------------------------------------------

describe("the shim and the real adapter", () => {
  it("a Stop with stop_hook_active true and no adapter state is pass 1: the adapter's count is the truth (05)", () => {
    const cc = new FakeClaudeCode(release);
    const first = cc.stop(MOCK1_TEXT, { stop_hook_active: true });
    expect(first.stdout.startsWith('{"hookSpecificOutput":{"hookEventName":"Stop","additionalContext":"[Prosegate] 3 findings against profile \\"local/base\\" (pass 1 of 2).')).toBe(true);
  });

  it("the agent-context refusal (ADR-27): with the agent markers in the hook environment, a lowering command is refused and enforcement carries on", () => {
    const marked = { CLAUDECODE: "1", CLAUDE_CODE_ENTRYPOINT: "cli" };
    const cc = new FakeClaudeCode(release, { env: marked });
    expect(cc.sessionStart().code).toBe(0);
    cc.cli(["profile", "pr-description"], { CLAUDECODE: undefined, CLAUDE_CODE_ENTRYPOINT: undefined }); // choosing a profile is refused to the agent too (W3.1 cycle 2), so the user does it
    const refused = cc.cli(["advisory"], marked);
    expect(refused.code).toBe(1);
    expect(refused.stderr).toBe(
      "Prosegate: advisory was refused because it looks like the agent ran it. In Claude Code, a command typed after ! counts as the agent; run it in a separate terminal.\n",
    );
    expect(refused.stdout).toBe("");
    // Still enforcing: the next Stop continues the model.
    expect(cc.stop(MOCK1_TEXT).stdout).toBe(continuation(MOCK1_FEEDBACK));
    // A command that raises enforcement is always allowed.
    expect(cc.cli(["enforce"], marked).code).toBe(0);
  });

  it("headless (CI): findings still continue the model; the end of the turn writes one summary line to stderr, no systemMessage", () => {
    const cc = new FakeClaudeCode(release, { env: { CI: "1" } });
    cc.sessionStart();
    cc.cli(["profile", "pr-description"]);
    cc.prompt("write the PR description");
    const pass1 = cc.stop(MOCK1_TEXT);
    expect(pass1.stdout).toBe(continuation(MOCK1_FEEDBACK));
    expect(pass1.stderr).toBe("");
    const pass2 = cc.stop(MOCK1_REVISED, { stop_hook_active: true });
    expect(pass2.stdout).toBe("");
    expect(pass2.stderr).toBe("Prosegate | turn 1 | profile pr-description | clean after 1 revision\n");
  });

  it("a Stop with a clean reply prints nothing at all", () => {
    const cc = new FakeClaudeCode(release);
    cc.sessionStart();
    expect(cc.stop(MOCK1_REVISED)).toMatchObject({ code: 0, stdout: "", stderr: "" });
  });
});

// ---- the goldens are 09's mocks, read from the document ---------------------------------------

describe("the notices the goldens assert are the ones docs/09 Enforcement UX.md draws (ADR-34)", () => {
  const OVERRIDE = "  To pause for this session, run: prosegate advisory";
  const expected = [
    `${MOCK1_NOTICE}\n${OVERRIDE}`,
    [`Prosegate ${DOT} profile design-doc ${DOT} 2 findings (unsupported claim 2) ${DOT} revising, pass 1 of 2`, `  unsupported claim  "${CLAIM_A}"`, `  unsupported claim  "${CLAIM_B}"`, OVERRIDE].join("\n"),
    `Prosegate ${DOT} 1 of 2 findings remain ${DOT} revising, pass 2 of 2`,
    `Prosegate ${DOT} 1 finding remains after 2 passes ${DOT} shipped as is\n  unsupported claim  "${CLAIM_B}"`,
    [
      `Prosegate ${DOT} profile chat-reply ${DOT} 2 findings (filler 2) ${DOT} advisory, not enforced ${DOT} enforcement is lowered in this session (advisory)`,
      '  filler  core.filler.001  "Great question"',
      '  filler  core.filler.004  "In summary"',
    ].join("\n"),
  ];

  it("every Prosegate notice block in the mock transcripts of 09 is asserted by a golden, byte for byte, and no golden notice is missing from 09", () => {
    const doc = readFileSync(join(ADAPTER_DIR, "..", "..", "docs", "09 Enforcement UX.md"), "utf8");
    const mocks = doc.slice(doc.indexOf("## Mock transcripts"), doc.indexOf("## Noise budget"));
    const blocks = [...mocks.matchAll(/^(Prosegate · .*(?:\n {2}.*)*)$/gm)].map((m) => m[1] as string);
    expect(blocks).toEqual(expected);
  });
});


