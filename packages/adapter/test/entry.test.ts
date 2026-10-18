import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { CLEAN_TEXT, SESSION, TIC_TEXT, WARN_TEXT, buildBundle, cleanEnv, json, pg, sessionStartInput, testHooks, tmpDir, turnEndInput } from "./helpers.js";

// Subprocess tests over the built bundle: every exit-code path, with fresh processes (05). The release
// bundle is used unless a test needs fault injection, which only a test build has (ADR-29).

// Each test spawns real processes; the root run executes dozens of test files in parallel.
vi.setConfig({ testTimeout: 120_000 });

let bundle = "";
let testBundle = "";
beforeAll(async () => {
  bundle = await buildBundle("release");
  testBundle = await buildBundle("test");
}, 240_000);

interface TurnEndOut {
  decision: "allow" | "continue";
  feedback_text: string;
  render: string;
  notice: string | null;
  result: { verdict: string; skipped_reason?: string; findings: unknown[]; pass: number; profile: { id: string } };
}

function start(home: string, over: Record<string, unknown> = {}, env: Record<string, string> = {}) {
  return pg(bundle, ["session-start"], { home, input: sessionStartInput(over), env });
}

function logText(home: string): string {
  const dir = join(home, "logs");
  if (!existsSync(dir)) return "";
  return readdirSync(dir)
    .map((f) => readFileSync(join(dir, f), "utf8"))
    .join("\n");
}

const FAIL_LINE = (what: string, hook: string, why: string, effect: string) =>
  new RegExp(`^prosegate: could not ${what} \\(${hook} failed: ${why}\\); ${effect}\\. Details: .+\\.log\\n$`);

describe("session-start", () => {
  it("returns the inject block, a null notice, the active profile and offline, and creates the session store", () => {
    const home = tmpDir();
    const r = start(home);
    expect(r.code).toBe(0);
    expect(r.stderr).toBe("");
    const out = json<{ inject: string; notice: string | null; active_profile: string; offline: boolean }>(r);
    expect(out.active_profile).toBe("local/base");
    expect(out.offline).toBe(true);
    expect(out.notice).toBeNull();
    expect(out.inject.split("\n")[0]).toBe("If a later message starts with [Prosegate], revise your last response as it asks. Do not run prosegate commands.");
    expect(out.inject).toContain("Active profile: Base.");
    expect(out.inject).toContain("Tone: Plain and direct");
    expect(out.inject).not.toMatch(/list_profiles|select_profile/);
    const dir = join(home, "sessions", SESSION);
    expect(readdirSync(dir).sort()).toEqual(["profile.json", "state.json"]);
    const state = JSON.parse(readFileSync(join(dir, "state.json"), "utf8")) as Record<string, unknown>;
    expect(state).toMatchObject({ v: 1, active_profile: "local/base", mode: null, first_notice_shown: false, overlays_notice_shown: false });
  });

  it("accepts and acts on `source` (ADR-31): modes reset on startup and clear, survive resume, compact and fork", () => {
    const home = tmpDir();
    start(home);
    const mode = (): string | null => (JSON.parse(readFileSync(join(home, "sessions", SESSION, "state.json"), "utf8")) as { mode: string | null }).mode;
    const set = (m: string) => pg(bundle, [m], { home, env: { PROSEGATE_SESSION: SESSION } });
    for (const [source, survives] of [["resume", true], ["compact", true], ["fork", true], ["clear", false], ["startup", false]] as const) {
      expect(set("advisory").code).toBe(0);
      const r = start(home, { source });
      expect(r.code, source).toBe(0);
      expect(mode(), source).toBe(survives ? "advisory" : null);
    }
  });

  it("spools a session_start event with the profile id masked", () => {
    const home = tmpDir();
    start(home);
    const spool = readFileSync(join(home, "telemetry", "spool.jsonl"), "utf8");
    expect(spool).toContain('"t":"session_start"');
    expect(spool).toContain('"offline":true');
    expect(spool).not.toContain("local/base");
  });
});

describe("turn-start", () => {
  it("returns nulls (selection is Phase 5) and stores the user message and a derived turn id", () => {
    const home = tmpDir();
    start(home);
    const r = pg(bundle, ["turn-start"], { home, input: { session_id: SESSION, user_message: "write the PR description", tool_calls_so_far: [] } });
    expect(r.code).toBe(0);
    expect(json(r)).toEqual({ inject: null, candidate: null });
    const turn = JSON.parse(readFileSync(join(home, "sessions", SESSION, "turn.json"), "utf8")) as { turn_id: string; user_message: string };
    expect(turn.user_message).toBe("write the PR description");
    expect(turn.turn_id).toMatch(/^[0-9a-f]{64}$/);
  });

  it("trims the stored user message to 2,000 characters", () => {
    const home = tmpDir();
    start(home);
    pg(bundle, ["turn-start"], { home, input: { session_id: SESSION, user_message: "x".repeat(5000), tool_calls_so_far: [] } });
    const turn = JSON.parse(readFileSync(join(home, "sessions", SESSION, "turn.json"), "utf8")) as { user_message: string };
    expect(turn.user_message).toHaveLength(2000);
  });
});

describe("turn-end", () => {
  it("allows a clean turn silently: no feedback, no notice, render none, nothing on stderr", () => {
    const home = tmpDir();
    start(home);
    const r = pg(bundle, ["turn-end"], { home, input: turnEndInput(CLEAN_TEXT) });
    expect(r.code).toBe(0);
    expect(r.stderr).toBe("");
    const out = json<TurnEndOut>(r);
    expect(out).toMatchObject({ decision: "allow", feedback_text: "", render: "none", notice: null });
    expect(out.result.verdict).toBe("pass");
    expect(out.result.findings).toEqual([]);
  });

  it("continues on a block finding with the canonical feedback_text and a pass-1 notice naming the override", () => {
    const home = tmpDir();
    start(home);
    const out = json<TurnEndOut>(pg(bundle, ["turn-end"], { home, input: turnEndInput(TIC_TEXT) }));
    expect(out.decision).toBe("continue");
    expect(out.feedback_text).toMatch(/^\[Prosegate\] \d+ findings? against profile "local\/base" \(pass 1 of 2\)\. Revise your last response\.\n/);
    expect(out.feedback_text).toContain("Do not run prosegate commands.");
    expect(out.feedback_text.split("\n").at(-1)).toBe("(For the user: run prosegate advisory in a terminal to pause these revisions for this session.)");
    expect(out.feedback_text).toBe((out.result as unknown as { feedback_text: string }).feedback_text);
    expect(out.render).toBe("diff");
    expect(out.notice).toMatch(/^Prosegate · profile base · \d+ findings \(.*\) · revising, pass 1 of 2\n/);
    expect(out.notice).toContain("To pause for this session, run: prosegate advisory");
  });

  it("skips a text below the token floor on pass 1", () => {
    const home = tmpDir();
    start(home);
    const out = json<TurnEndOut>(pg(bundle, ["turn-end"], { home, input: turnEndInput("It's worth noting that this is short.") }));
    expect(out.decision).toBe("allow");
    expect(out.result.verdict).toBe("skipped");
    expect(out.result.skipped_reason).toBe("below_floor");
    expect(out.notice).toBeNull();
  });

  it("allows a warn-only turn silently", () => {
    const home = tmpDir();
    start(home);
    const out = json<TurnEndOut>(pg(bundle, ["turn-end"], { home, input: turnEndInput(WARN_TEXT) }));
    expect(out).toMatchObject({ decision: "allow", feedback_text: "", notice: null, render: "none" });
    expect(out.result.findings.length).toBeGreaterThan(0);
    expect(out.result.verdict).toBe("pass");
  });

  it("works with no prior session-start (the store is created on demand)", () => {
    const home = tmpDir();
    const out = json<TurnEndOut>(pg(bundle, ["turn-end"], { home, input: turnEndInput(TIC_TEXT) }));
    expect(out.decision).toBe("continue");
  });

  it("accepts input that starts with a UTF-8 byte order mark (PowerShell pipes add one)", () => {
    const home = tmpDir();
    const r = pg(bundle, ["session-start"], { home, raw: `\uFEFF${JSON.stringify(sessionStartInput())}` });
    expect(r.code).toBe(0);
    const t = pg(bundle, ["turn-end"], { home, raw: `\uFEFF${JSON.stringify(turnEndInput(TIC_TEXT))}` });
    expect(json<TurnEndOut>(t).decision).toBe("continue");
  });

  it("derives a stable turn id from the session and user message when the shim sends none", () => {
    const home = tmpDir();
    start(home);
    const input = turnEndInput(TIC_TEXT, { turn_id: "", user_message: "describe the cache" });
    expect(json<TurnEndOut>(pg(bundle, ["turn-end"], { home, input })).result.pass).toBe(1);
    expect(json<TurnEndOut>(pg(bundle, ["turn-end"], { home, input: { ...input, continuation: true } })).result.pass).toBe(2);
  });

  it("reviews a reply far longer than 256 KB instead of skipping it (ADR-30): the first 100 KB of prose, with turn_truncated", () => {
    const home = tmpDir();
    start(home);
    // The tics are at the head; 300 KB of clean prose follows.
    const big = `${TIC_TEXT} ${`${CLEAN_TEXT} `.repeat(Math.ceil((300 * 1024) / CLEAN_TEXT.length))}`;
    const r = pg(bundle, ["turn-end"], { home, input: turnEndInput(big) });
    expect(r.code).toBe(0);
    const out = json<TurnEndOut>(r);
    expect(out.decision).toBe("continue");
    expect(out.result.verdict).toBe("revise");
    expect(readFileSync(join(home, "telemetry", "spool.jsonl"), "utf8")).toContain('"code":"turn_truncated"');
    expect(readFileSync(join(home, "telemetry", "spool.jsonl"), "utf8")).not.toContain("turn_budget_exceeded");
  });

  it("a tic past the first 100 KB of prose is not reviewed, and the user can see that in status", () => {
    const home = tmpDir();
    start(home);
    const big = `${CLEAN_TEXT} `.repeat(Math.ceil((120 * 1024) / CLEAN_TEXT.length)) + TIC_TEXT;
    const out = json<TurnEndOut>(pg(bundle, ["turn-end"], { home, input: turnEndInput(big) }));
    expect(out.result.findings.filter((f) => (f as { rule_id: string }).rule_id === "core.hedge.001")).toHaveLength(0);
    const status = pg(bundle, ["status"], { home, env: { PROSEGATE_SESSION: SESSION } });
    expect(status.stdout).toContain("Last turn: only the first 100 KB of prose was reviewed");
  });

  it("reads an 11 MB input (under the 12 MB cap), reviews it, and answers in time", () => {
    const home = tmpDir();
    start(home);
    const filler = `${CLEAN_TEXT} `.repeat(Math.ceil((11 * 1024 * 1024) / CLEAN_TEXT.length));
    const text = `${TIC_TEXT} ${filler}`.slice(0, 11 * 1024 * 1024);
    const t0 = performance.now();
    const r = pg(bundle, ["turn-end"], { home, input: turnEndInput(text) });
    expect(r.code).toBe(0);
    expect(performance.now() - t0).toBeLessThan(20_000);
    expect(json<TurnEndOut>(r).decision).toBe("continue");
  });

  it("refuses an input over the 12 MB stdin cap, as `input too large`, and records it", () => {
    const home = tmpDir();
    start(home);
    const raw = JSON.stringify(turnEndInput(`${CLEAN_TEXT} `.repeat(Math.ceil((13 * 1024 * 1024) / CLEAN_TEXT.length))));
    expect(raw.length).toBeGreaterThan(12 * 1024 * 1024);
    const r = pg(bundle, ["turn-end"], { home, raw });
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(FAIL_LINE("review this turn", "turn-end", "input too large", "your reply was not held"));
    expect(logText(home)).toContain("InputTooLargeError");
  });
});

describe("fail open (05)", () => {
  const BAD_INPUTS: Array<[string, string]> = [
    ["malformed JSON", "{not json"],
    ["an empty stdin", ""],
    ["a JSON array", "[]"],
    ["an unknown field", JSON.stringify({ ...turnEndInput(CLEAN_TEXT), extra: 1 })],
    ["a missing field", JSON.stringify({ session_id: SESSION })],
    ["a session id that is a path", JSON.stringify(turnEndInput(CLEAN_TEXT, { session_id: "../../etc" }))],
    ["a wrong type", JSON.stringify(turnEndInput(CLEAN_TEXT, { continuation: "yes" }))],
  ];
  it.each(BAD_INPUTS)("%s: exit 1, one plain stderr line with the log path, a log entry, an adapter_error event, nothing on stdout, never exit 2", (_name, raw) => {
    const home = tmpDir();
    const r = pg(bundle, ["turn-end"], { home, raw });
    expect(r.code).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr.trim().split("\n")).toHaveLength(1);
    expect(r.stderr).toMatch(FAIL_LINE("review this turn", "turn-end", "invalid hook input", "your reply was not held"));
    expect(r.stderr).not.toMatch(/ZodError|SyntaxError|failing open/);
    expect(logText(home)).toMatch(/ error adapter_error turn-end failed: /);
    expect(readFileSync(join(home, "telemetry", "spool.jsonl"), "utf8")).toContain('"code":"adapter_error"');
  });

  it.each([
    ["session-start", "start Prosegate for this session", "nothing was blocked"],
    ["turn-start", "prepare this turn", "nothing was blocked"],
    ["turn-end", "review this turn", "your reply was not held"],
  ])("an internal crash in %s (test build) exits 1 with one plain line, a log entry and no text in the log", (stage, what, effect) => {
    const home = tmpDir();
    const input = stage === "session-start" ? sessionStartInput() : stage === "turn-start" ? { session_id: SESSION, user_message: "SECRET-USER-WORDS", tool_calls_so_far: [] } : turnEndInput(TIC_TEXT);
    const r = pg(testBundle, [stage], { home, input, env: testHooks({ crash: stage }) });
    expect(r.code).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr.trim().split("\n")).toHaveLength(1);
    expect(r.stderr).toMatch(FAIL_LINE(what, stage, "internal error", effect));
    const log = logText(home);
    expect(log).toContain(`adapter_error ${stage} failed`);
    expect(log).not.toContain("SECRET-USER-WORDS");
    expect(log).not.toContain("catalog");
    expect(readFileSync(join(home, "telemetry", "spool.jsonl"), "utf8")).toContain('"code":"adapter_error"');
  });

  it("a stdin that never closes is abandoned after the wait, exit 1", async () => {
    const home = tmpDir();
    const child = spawn(process.execPath, [bundle, "turn-end"], { env: cleanEnv(home), stdio: ["pipe", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    const code = await new Promise<number | null>((resolve) => child.on("close", resolve));
    expect(code).toBe(1);
    expect(stderr).toMatch(FAIL_LINE("review this turn", "turn-end", "no input arrived", "your reply was not held"));
  }, 30_000);

  it("a corrupt state.json is replaced by defaults, not a failure", () => {
    const home = tmpDir();
    start(home);
    const state = join(home, "sessions", SESSION, "state.json");
    writeFileSync(state, "{ not json");
    const r = pg(bundle, ["turn-end"], { home, input: turnEndInput(TIC_TEXT) });
    expect(r.code).toBe(0);
    expect(json<TurnEndOut>(r).decision).toBe("continue");
    expect(() => JSON.parse(readFileSync(state, "utf8"))).not.toThrow();
  });

  it("a command that throws exits 1, never 2, with a plain line", () => {
    const home = tmpDir();
    start(home);
    // state.json replaced by a directory: reading it throws EISDIR inside the command.
    const state = join(home, "sessions", SESSION, "state.json");
    rmSync(state);
    mkdirSync(state);
    const r = pg(bundle, ["status"], { home, env: { PROSEGATE_SESSION: SESSION } });
    expect(r.code).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toMatch(/^prosegate: status failed \(internal error\)\. Details: .+\.log\n$/);
    expect(logText(home)).toMatch(/ error adapter_error status failed: /);
  });

  it("the same broken store makes a hook fail open (exit 1), never block", () => {
    const home = tmpDir();
    start(home);
    const state = join(home, "sessions", SESSION, "state.json");
    rmSync(state);
    mkdirSync(state);
    const r = pg(bundle, ["turn-end"], { home, input: turnEndInput(TIC_TEXT) });
    expect(r.code).toBe(1);
    expect(r.stdout).toBe("");
  });
});

describe("test levers are not in the release bundle (ADR-29)", () => {
  it("the release bundle ignores PROSEGATE_TEST_HOOKS: crash, budgetMs and engineBudgetMs have no effect", () => {
    const home = tmpDir();
    start(home);
    for (const hooks of [{ crash: "turn-end" }, { budgetMs: 0 }, { engineBudgetMs: 0 }, { delayMs: 8000, budgetMs: 100 }, { hardDeadlineMs: 0 }]) {
      const t0 = performance.now();
      const r = pg(bundle, ["turn-end"], { home, input: turnEndInput(TIC_TEXT, { turn_id: `t-${JSON.stringify(hooks)}` }), env: testHooks(hooks) });
      expect(r.code, JSON.stringify(hooks)).toBe(0);
      expect(r.stderr, JSON.stringify(hooks)).toBe("");
      expect(performance.now() - t0, JSON.stringify(hooks)).toBeLessThan(7500);
      const out = json<TurnEndOut>(r);
      expect(out.decision, JSON.stringify(hooks)).toBe("continue");
      expect(out.result.verdict, JSON.stringify(hooks)).toBe("revise");
    }
    expect(logText(home)).not.toContain("adapter_error");
  });

  it("the release bundle does not even contain the lever's name", () => {
    expect(readFileSync(bundle, "utf8")).not.toContain("PROSEGATE_TEST_HOOKS");
  });

  it("the test build does honour it (so the lever tests mean something)", () => {
    const home = tmpDir();
    const r = pg(testBundle, ["turn-end"], { home, input: turnEndInput(TIC_TEXT), env: testHooks({ crash: "turn-end" }) });
    expect(r.code).toBe(1);
  });
});

describe("budgets (ADR-29)", () => {
  it("allows past the review cap with skipped_reason reviewer_unavailable, a log line and turn_budget_exceeded", () => {
    const home = tmpDir();
    start(home);
    const r = pg(testBundle, ["turn-end"], { home, input: turnEndInput(TIC_TEXT), env: testHooks({ delayMs: 150, budgetMs: 100 }) });
    expect(r.code).toBe(0);
    const out = json<TurnEndOut>(r);
    expect(out.decision).toBe("allow");
    expect(out.result.skipped_reason).toBe("reviewer_unavailable");
    expect(out.notice).toBeNull();
    expect(logText(home)).toMatch(/ warn turn_budget_exceeded /);
    expect(readFileSync(join(home, "telemetry", "spool.jsonl"), "utf8")).toContain('"code":"turn_budget_exceeded"');
    const status = pg(bundle, ["status"], { home, env: { PROSEGATE_SESSION: SESSION } });
    expect(status.stdout).toContain("Last turn: not reviewed (the review ran out of time)");
  });

  it("an engine budget trip is allow, logged, sent to telemetry and shown by status, never silent", () => {
    const home = tmpDir();
    start(home);
    const r = pg(testBundle, ["turn-end"], { home, input: turnEndInput(TIC_TEXT), env: testHooks({ engineBudgetMs: 0 }) });
    const out = json<TurnEndOut>(r);
    expect(out.decision).toBe("allow");
    expect(out.result.skipped_reason).toBe("reviewer_unavailable");
    expect(logText(home)).toContain("the engine budget ran out during the review");
    expect(pg(bundle, ["status"], { home, env: { PROSEGATE_SESSION: SESSION } }).stdout).toContain("not reviewed (the review ran out of time)");
  });
});

describe("headless (09)", () => {
  it("CI=true: continues with feedback_text, shows no notice, renders summary and writes report.json", () => {
    const home = tmpDir();
    const env = { CI: "true" };
    start(home, {}, env);
    const out = json<TurnEndOut>(pg(bundle, ["turn-end"], { home, input: turnEndInput(TIC_TEXT), env }));
    expect(out.decision).toBe("continue");
    expect(out.feedback_text).toContain("[Prosegate]");
    expect(out.render).toBe("summary");
    expect(out.notice).toBeNull();
    const report = JSON.parse(readFileSync(join(home, "sessions", SESSION, "report.json"), "utf8")) as { turns: Array<{ passes: number; ordinal: number; findings: unknown[]; decision: string }> };
    expect(report.turns).toHaveLength(1);
    expect(report.turns[0]).toMatchObject({ passes: 1, ordinal: 1, decision: "continue" });
    expect(report.turns[0]?.findings.length).toBeGreaterThan(0);
  });

  it("PROSEGATE_MODE=headless behaves the same, and a headless turn that ships records what remained", () => {
    const home = tmpDir();
    const env = { PROSEGATE_MODE: "headless" };
    start(home, {}, env);
    for (const c of [false, true, true]) pg(bundle, ["turn-end"], { home, input: turnEndInput(TIC_TEXT, { continuation: c }), env });
    const report = JSON.parse(readFileSync(join(home, "sessions", SESSION, "report.json"), "utf8")) as { turns: Array<{ passes: number; shipped_remaining: number; decision: string }> };
    expect(report.turns).toHaveLength(1);
    expect(report.turns[0]).toMatchObject({ passes: 2, decision: "allow" });
    expect(report.turns[0]?.shipped_remaining).toBeGreaterThan(0);
  });
});

describe("--debug (07, ADR-30)", () => {
  it("writes the turn text under sessions/<id>/debug/, warns once on stderr, and tells the user through notice", () => {
    const home = tmpDir();
    start(home);
    const r = pg(bundle, ["turn-end", "--debug"], { home, input: turnEndInput(CLEAN_TEXT) });
    expect(r.code).toBe(0);
    expect(r.stderr.trim().split("\n")).toHaveLength(1);
    expect(r.stderr).toContain("--debug wrote this turn's text");
    const out = json<TurnEndOut>(r);
    expect(out.notice).toBe(`Prosegate · debug is on: each turn's text is written to ${join(home, "sessions", SESSION, "debug")}`);
    // Debug is still on and the turn ended with allow: the files stay.
    const dir = join(home, "sessions", SESSION, "debug");
    const files = readdirSync(dir);
    expect(files).toHaveLength(1);
    expect(readFileSync(join(dir, files[0] as string), "utf8")).toContain("catalog reads");
    // The notice is once per session.
    const again = json<TurnEndOut>(pg(bundle, ["turn-end", "--debug"], { home, input: turnEndInput(CLEAN_TEXT, { turn_id: "turn-2" }) }));
    expect(again.notice).toBeNull();
  });

  it("writes nothing without the flag", () => {
    const home = tmpDir();
    start(home);
    pg(bundle, ["turn-end"], { home, input: turnEndInput(TIC_TEXT) });
    expect(existsSync(join(home, "sessions", SESSION, "debug"))).toBe(false);
  });

  it("PROSEGATE_DEBUG=1 turns it on (and stays a release feature)", () => {
    const home = tmpDir();
    start(home);
    const out = json<TurnEndOut>(pg(bundle, ["turn-end"], { home, input: turnEndInput(TIC_TEXT), env: { PROSEGATE_DEBUG: "1" } }));
    expect(existsSync(join(home, "sessions", SESSION, "debug"))).toBe(true);
    expect(out.notice).toContain("Prosegate · debug is on");
  });

  it("the debug files go when the turn ends with allow and debug is no longer on", () => {
    const home = tmpDir();
    start(home);
    pg(bundle, ["turn-end"], { home, input: turnEndInput(TIC_TEXT), env: { PROSEGATE_DEBUG: "1" } }); // continue: files stay
    expect(existsSync(join(home, "sessions", SESSION, "debug"))).toBe(true);
    pg(bundle, ["turn-end"], { home, input: turnEndInput(CLEAN_TEXT, { turn_id: "turn-2" }) }); // allow, debug off
    expect(existsSync(join(home, "sessions", SESSION, "debug"))).toBe(false);
  });
});

describe("the CLI surface", () => {
  it("prints the version and the help (80 columns) without touching the store", () => {
    const home = tmpDir();
    expect(pg(bundle, ["--version"], { home }).stdout).toMatch(/^\S+\n$/);
    const help = pg(bundle, ["--help"], { home });
    expect(help.code).toBe(0);
    expect(help.stdout).toContain("rule off <id>    switch one rule off in every session");
    expect(help.stdout).toContain("a command typed after ! counts as the agent");
    expect(help.stdout).toContain("init --harness claude-code");
    for (const line of help.stdout.split("\n")) expect(line.length, line).toBeLessThanOrEqual(80);
    expect(existsSync(join(home, "sessions"))).toBe(false);
  });

  it("--session <id> picks the session, before or after the command", () => {
    const home = tmpDir();
    for (const id of ["sess-a", "sess-b"]) pg(bundle, ["session-start"], { home, input: sessionStartInput({ session_id: id }) });
    const mode = (id: string): string | null => (JSON.parse(readFileSync(join(home, "sessions", id, "state.json"), "utf8")) as { mode: string | null }).mode;
    expect(pg(bundle, ["quiet", "--session", "sess-b"], { home }).code).toBe(0);
    expect(pg(bundle, ["--session", "sess-a", "advisory"], { home }).code).toBe(0);
    expect([mode("sess-a"), mode("sess-b")]).toEqual(["advisory", "quiet"]);
    // Confirmations name the session when there is more than one for the directory.
    const r = pg(bundle, ["status", "--session", "sess-b"], { home });
    expect(r.code).toBe(0);
  });

  it("`prosegate constructor` is an unknown command, not a hook", () => {
    const home = tmpDir();
    const r = pg(bundle, ["constructor"], { home });
    expect(r.code).toBe(1);
    expect(r.stderr).toBe('prosegate: unknown command "constructor". Run prosegate --help.\n');
    for (const name of ["toString", "__proto__", "hasOwnProperty"]) expect(pg(bundle, [name], { home }).stderr).toContain("unknown command");
  });

  it("init without --harness prints the usage and exits 1, and installs nothing", () => {
    const r = pg(bundle, ["init"], { home: tmpDir(), env: { PROSEGATE_CLAUDE_HOME: tmpDir() } });
    expect(r).toMatchObject({ code: 1, stdout: "", stderr: "Prosegate: say which tool to set up, for example: prosegate init --harness claude-code\n" });
  });
});
