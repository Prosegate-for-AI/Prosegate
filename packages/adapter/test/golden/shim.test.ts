import { spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { buildBundle, testHooks, tmpDir } from "../helpers.js";
import { FakeClaudeCode, LAUNCHER_SOURCE, PROMPT_ID, SESSION, SHIM_SOURCE, cleanEnv } from "./driver.js";
import { deleteVersion, installApp, stubPkg, testPkg, type Pkg } from "./driver.js";

// The launcher and the shim (ADR-33, ADR-34): the process around the Claude Code mapping. The mapping itself is tested in
// claude-code.test.ts; here a stand-in bundle answers with what a test tells it to, plus the failure modes (05: fail open).

const STUB = `
import { appendFileSync } from "node:fs";
export async function claudeCodeHook({ event, raw }) {
  appendFileSync(process.env.STUB_OUT + "/calls.in", JSON.stringify({ event, raw }) + "\\n");
  let sid = null;
  try { sid = JSON.parse(raw).session_id; } catch {}
  const how = process.env.STUB_MODE || "answer";
  if (how === "junk") process.stdout.write("Debugger attached.\\n");
  if (how === "throw") throw new Error("boom");
  if (how === "hang") await new Promise(() => {});
  if (how === "late") setTimeout(() => { throw new Error("late failure"); }, 20);
  if (how === "problem") {
    const why = process.env.STUB_WHY || "internal error";
    return { sid, problem: { why, where: process.env.STUB_WHERE || null, detail: "stub problem" } };
  }
  if (how === "home") return { sid, json: { home: process.env.PROSEGATE_HOME } };
  return { sid, ...JSON.parse(process.env.STUB_ANSWER || "{}") };
}
`;

interface Stubbed {
  cc: FakeClaudeCode;
  calls: () => Array<{ event: string; raw: string }>;
  logText: () => string;
}
function stubbed(answer: unknown, env: Record<string, string> = {}, body = STUB): Stubbed {
  const out = tmpDir("pg-stub-");
  const env2 = { STUB_OUT: out, STUB_ANSWER: JSON.stringify(answer), ...env };
  const cc = new FakeClaudeCode(stubPkg(body), { env: env2 });
  const calls = (): Array<{ event: string; raw: string }> => {
    const f = join(out, "calls.in");
    return existsSync(f) ? readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { event: string; raw: string }) : [];
  };
  const logText = (): string => {
    const dir = join(cc.home, "logs");
    return existsSync(dir) ? readdirSync(dir).map((f) => readFileSync(join(dir, f), "utf8")).join("") : "";
  };
  return { cc, calls, logText };
}

const logFile = (cc: FakeClaudeCode): string => join(cc.home, "logs", `${new Date().toISOString().slice(0, 10)}.log`);
const TURN = "this turn was not reviewed";
const SESSION_WHAT = "this session may not be reviewed";
/** The one line a fail-open shows the user (N14, ADR-33). */
const line = (cc: FakeClaudeCode, why: string, what = TURN): object => ({ systemMessage: `Prosegate · ${what} (${why}) · details: ${logFile(cc)}` });
const MISSING = 'its files are missing; run "npx prosegate init" again';
const lines = (file: string): string[] => readFileSync(file, "utf8").trimEnd().split("\n");

describe("the shim files (ADR-34: honestly formatted)", () => {
  it("the shim and the launcher together are at most 150 lines, and no line is over 100 columns", () => {
    expect(lines(SHIM_SOURCE).length + lines(LAUNCHER_SOURCE).length).toBeLessThanOrEqual(150);
    for (const file of [SHIM_SOURCE, LAUNCHER_SOURCE]) {
      const long = lines(file).filter((l) => l.length > 100);
      expect(long, file).toEqual([]);
    }
  });

  it("the shim has no dead --headless handling (mode comes from CI and PROSEGATE_MODE in the mapping)", () => {
    expect(readFileSync(SHIM_SOURCE, "utf8")).not.toContain("headless");
    expect(readFileSync(LAUNCHER_SOURCE, "utf8")).not.toContain("headless");
  });
});

describe("what the launcher writes", () => {
  it("hands the hook input to the mapping and writes its JSON as the one object on stdout", () => {
    const { cc, calls } = stubbed({ json: { systemMessage: "N" } });
    const r = cc.stop("the reply");
    expect(r).toMatchObject({ code: 0, stderr: "" });
    expect(r.stdout).toBe('{"systemMessage":"N"}\n');
    expect(calls().map((c) => c.event)).toEqual(["Stop"]);
    expect(JSON.parse(calls()[0]?.raw ?? "{}")).toMatchObject({ session_id: SESSION, prompt_id: PROMPT_ID, last_assistant_message: "the reply" });
  });

  it("writes plain text for a UserPromptSubmit inject, passes the adapter's stderr through, and prints nothing for an empty answer", () => {
    expect(stubbed({ text: "Use the pr-description profile.\n" }).cc.prompt("hi").stdout).toBe("Use the pr-description profile.\n");
    const err = stubbed({ stderr: "Prosegate | turn 1 | profile base | clean\n" }).cc.stop("x");
    expect(err).toMatchObject({ code: 0, stdout: "", stderr: "Prosegate | turn 1 | profile base | clean\n" });
    expect(stubbed({}).cc.stop("x")).toMatchObject({ code: 0, stdout: "", stderr: "" });
  });

  it("an unknown event does nothing", () => {
    const { cc } = stubbed({});
    const r = spawnSync(process.execPath, [cc.launcher, "PostToolUse"], { input: JSON.stringify({ session_id: SESSION }), encoding: "utf8", env: cleanEnv(cc.home, cc.env) });
    expect({ code: r.status, stdout: r.stdout }).toEqual({ code: 0, stdout: "" });
  });

  it("a byte order mark on the input reaches the mapping untouched (the mapping strips it; claude-code.test.ts)", () => {
    const { cc, calls } = stubbed({});
    const input = String.fromCharCode(0xfeff) + JSON.stringify({ session_id: SESSION, prompt_id: PROMPT_ID });
    spawnSync(process.execPath, [cc.launcher, "Stop"], { input, encoding: "utf8", env: cleanEnv(cc.home, cc.env) });
    expect(calls()[0]?.raw.charCodeAt(0)).toBe(0xfeff);
  });
});

describe("what reaches stdout", () => {
  async function wrapped(importTime: string): Promise<FakeClaudeCode> {
    const real = await buildBundle("release");
    const pkg = stubPkg("");
    const realCopy = join(pkg.dir, "dist", "real.mjs");
    writeFileSync(realCopy, readFileSync(real));
    const nl = String.fromCharCode(10);
    const body = [
      `import { writeSync } from "node:fs";`,
      importTime,
      `const m = await import(${JSON.stringify(pathToFileURL(realCopy).href)});`,
      "export const claudeCodeHook = m.claudeCodeHook;",
    ].join(nl);
    writeFileSync(pkg.bundle, body);
    return new FakeClaudeCode(pkg);
  }

  it("console.log from a dependency, at import or later, is muted: stdout is exactly one JSON object", async () => {
    const cc = await wrapped(`console.log("Loading profile..."); process.stdout.write("more junk" + String.fromCharCode(10));`);
    const r = cc.sessionStart();
    expect(r.code).toBe(0);
    expect(r.stdout.split("\n").filter(Boolean)).toHaveLength(1);
    expect(r.stdout.startsWith('{"hookSpecificOutput":{"hookEventName":"SessionStart"')).toBe(true);
  });

  it("RESIDUAL (D-29): a dependency that writes to fd 1 itself while it is imported puts text before the JSON; the JSON still comes last and the exit code is 0", async () => {
    const cc = await wrapped(`writeSync(1, "fd one junk" + String.fromCharCode(10));`);
    const r = cc.sessionStart();
    expect(r.code).toBe(0);
    const out = r.stdout.split("\n").filter(Boolean);
    expect(out[0]).toBe("fd one junk");
    expect(out.at(-1)?.startsWith('{"hookSpecificOutput"')).toBe(true);
  });

  it("junk the adapter prints to stdout while it runs never reaches Claude Code", () => {
    const { cc } = stubbed({ json: { systemMessage: "N" } }, { STUB_MODE: "junk", STUB_ANSWER: '{"json":{"systemMessage":"N"}}' });
    expect(cc.stop("x").stdout).toBe('{"systemMessage":"N"}\n');
  });

  it("a failure after the answer was written (an exception a moment later) cannot add a second object", () => {
    const { cc } = stubbed({ json: { systemMessage: "once" } }, { STUB_MODE: "late" });
    const r = cc.stop("x");
    expect(r.code).toBe(0);
    expect(r.stdout.split("\n").filter(Boolean)).toHaveLength(1);
    expect(JSON.parse(r.stdout)).toEqual({ systemMessage: "once" });
  });
});

describe("fail open (05)", () => {
  it("a problem from the mapping: exit 0, the line for the user, the detail in the log", () => {
    const { cc, logText } = stubbed({}, { STUB_MODE: "problem" });
    expect(cc.stop("x")).toMatchObject({ code: 0, stderr: "", json: line(cc, "internal error") });
    expect(logText()).toMatch(/ error shim_failed stub problem$/m);
  });

  it("the reason and the log path come from the mapping's problem", () => {
    const { cc } = stubbed({}, { STUB_MODE: "problem", STUB_WHY: "input too large", STUB_WHERE: "/logs/x.log" });
    expect(cc.stop("x").json).toEqual({ systemMessage: "Prosegate · this turn was not reviewed (input too large) · details: /logs/x.log" });
  });

  it("a mapping that throws, or a bundle without one, fails open and is logged", () => {
    const thrown = stubbed({}, { STUB_MODE: "throw" });
    expect(thrown.cc.stop("x")).toMatchObject({ code: 0, stderr: "", json: line(thrown.cc, "internal error") });
    expect(thrown.logText()).toContain("shim_error boom");
    const bare = new FakeClaudeCode(stubPkg("export const nothing = 1;"));
    expect(bare.stop("x")).toMatchObject({ code: 0, stderr: "", json: line(bare, "internal error") });
  });

  it("a dependency missing INSIDE the bundle is an internal error, not 'its files are missing'", () => {
    const { cc, logText } = stubbed({}, {}, `import "prosegate-no-such-dependency";\nexport async function claudeCodeHook() { return {}; }\n`);
    expect(cc.stop("x").json).toEqual(line(cc, "internal error"));
    expect(logText()).toContain("ERR_MODULE_NOT_FOUND");
  });

  it("a hung mapping is given up on at 7.5 s from the process start: the answer comes in [7000, 8500] ms from spawn", () => {
    const { cc, logText } = stubbed({}, { STUB_MODE: "hang" });
    const t0 = performance.now();
    const r = cc.stop("x");
    const took = performance.now() - t0;
    expect(took).toBeGreaterThanOrEqual(7000);
    expect(took).toBeLessThanOrEqual(8500);
    expect(r).toMatchObject({ code: 0, json: line(cc, "it took too long") });
    expect(logText()).toContain("shim_timeout Stop over 7.5 s");
  }, 20_000);

  it("the 7.5 s counts from the process start, not from when the launcher began to run (L7): a slow Node start does not push the answer past 8.5 s", () => {
    const slow = join(tmpDir("pg-slow-"), "slow-start.cjs");
    // Runs before any user code: a 1.2 s busy wait, as a slow disk or a virus scanner makes of a cold Node start.
    writeFileSync(slow, "Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1200);\n");
    const { cc } = stubbed({}, { STUB_MODE: "hang", NODE_OPTIONS: `--require "${slow.replace(/\\/g, "/")}"` });
    const t0 = performance.now();
    const r = cc.stop("x");
    const took = performance.now() - t0;
    expect(r).toMatchObject({ code: 0, json: line(cc, "it took too long") });
    expect(took).toBeGreaterThanOrEqual(7000);
    expect(took).toBeLessThanOrEqual(8500);
  }, 20_000);

  it("a stdin that never closes does not hold the hook: the watchdog is live while the input is read, same window", async () => {
    const { cc } = stubbed({});
    const t0 = performance.now();
    const child = spawn(process.execPath, [cc.launcher, "Stop"], { env: cleanEnv(cc.home, cc.env), stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    const code = await new Promise<number | null>((resolve) => child.on("close", resolve));
    const took = performance.now() - t0;
    expect(code).toBe(0);
    expect(took).toBeGreaterThanOrEqual(7000);
    expect(took).toBeLessThanOrEqual(8500);
    expect(JSON.parse(stdout)).toEqual(line(cc, "it took too long"));
  }, 20_000);

  it("the Prosegate home the launcher was installed under wins over PROSEGATE_HOME in the hook's environment", () => {
    const elsewhere = join(tmpDir("pg-elsewhere-"), ".prosegate");
    const { cc } = stubbed({}, { STUB_MODE: "home" });
    cc.env = { ...cc.env, PROSEGATE_HOME: elsewhere };
    const r = spawnSync(process.execPath, [cc.launcher, "Stop"], {
      input: JSON.stringify({ session_id: SESSION }),
      encoding: "utf8",
      env: { ...cleanEnv(cc.home, cc.env), PROSEGATE_HOME: elsewhere },
    });
    expect(JSON.parse(r.stdout)).toEqual({ home: cc.home });
  });
});

describe("the launcher and a missing version (ADR-33)", () => {
  it("current names a deleted version: the user sees the files-are-missing line, and the exit code is 0", () => {
    const { cc } = stubbed({});
    deleteVersion(cc.home);
    const first = cc.stop("x");
    expect(first).toMatchObject({ code: 0, stderr: "" });
    expect(first.stdout).toBe(`${JSON.stringify(line(cc, MISSING))}\n`);
    // ADR-33's line, character for character.
    expect((first.json as { systemMessage: string }).systemMessage).toBe(`Prosegate · this turn was not reviewed (its files are missing; run "npx prosegate init" again) · details: ${logFile(cc)}`);
  });

  it("no current file, an unsafe current ('.', '..', a path), or a version without its bundle are all the same line", () => {
    const none = stubbed({});
    rmSync(join(none.cc.home, "app", "current"));
    expect(none.cc.stop("x").json).toEqual(line(none.cc, MISSING));
    for (const bad of ["../../elsewhere", "..", ".", "a/b", ".hidden"]) {
      const unsafe = stubbed({});
      writeFileSync(join(unsafe.cc.home, "app", "current"), `${bad}\n`);
      expect(unsafe.cc.stop("x").json, bad).toEqual(line(unsafe.cc, MISSING));
    }
    const nobundle = stubbed({});
    rmSync(join(nobundle.cc.home, "app", "1.0.0", "dist"), { recursive: true });
    expect(nobundle.cc.stop("x").json).toEqual(line(nobundle.cc, MISSING));
  });

  it("--use rejects '.', '..' and anything with a separator (L5): the same line, and nothing is read outside app/", () => {
    const { cc } = stubbed({}, { STUB_MODE: "home" });
    // Decoys: a complete version laid out where "." (the app directory) and ".." (the Prosegate home) would point, so a
    // launcher that accepted those names would run it instead of reporting the version missing.
    for (const dir of [join(cc.home, "app"), cc.home]) {
      cpSync(join(cc.home, "app", "1.0.0", "dist"), join(dir, "dist"), { recursive: true });
      cpSync(join(cc.home, "app", "1.0.0", "shims"), join(dir, "shims"), { recursive: true });
    }
    for (const bad of ["..", ".", "a/b", "a\\b", "../app", ".hidden"]) {
      expect(cc.sessionStart("startup", [`--use=${bad}`]).json, bad).toEqual(line(cc, MISSING, SESSION_WHAT));
    }
    expect(cc.sessionStart("startup", ["--use=1.0.0"]).json).toEqual({ home: cc.home });
  });

  it("an upgrade swaps the version the launcher runs without the registration changing", () => {
    const first = stubbed({ json: { systemMessage: "from the first version" } });
    expect(first.cc.stop("x").json).toEqual({ systemMessage: "from the first version" });
    const second: Pkg = stubPkg(`export async function claudeCodeHook() { return { json: { systemMessage: "from the second version" } }; }\n`);
    expect(installApp(second, first.cc.home, "2.0.0")).toBe(first.cc.launcher);
    expect(first.cc.stop("again", { prompt_id: "p2" }).json).toEqual({ systemMessage: "from the second version" });
  });
});

describe("at most one Prosegate line per turn (ADR-33, V F-C)", () => {
  it("the deleted-version case end to end: SessionStart may show it, UserPromptSubmit never, Stop once per session", () => {
    const { cc, logText } = stubbed({});
    deleteVersion(cc.home);
    expect(cc.sessionStart().json).toEqual(line(cc, MISSING, SESSION_WHAT));
    expect(cc.prompt("write something")).toMatchObject({ code: 0, stdout: "", stderr: "" });
    expect(cc.stop("a reply").json).toEqual(line(cc, MISSING)); // SessionStart's line does not count as shown
    expect(cc.prompt("again")).toMatchObject({ stdout: "" });
    expect(cc.stop("another reply", { prompt_id: "p2" })).toMatchObject({ code: 0, stdout: "" });
    expect(logText()).toContain("shim_missing");
  });

  it("SessionStart shows its line every time (once per session start) and never records it", () => {
    const { cc } = stubbed({}, { STUB_MODE: "problem" });
    expect(cc.sessionStart().json).toEqual(line(cc, "internal error", SESSION_WHAT));
    expect(cc.sessionStart("resume").json).toEqual(line(cc, "internal error", SESSION_WHAT));
    expect(cc.stop("x").json).toEqual(line(cc, "internal error"));
  });

  it("UserPromptSubmit only logs", () => {
    const { cc, logText } = stubbed({}, { STUB_MODE: "problem" });
    expect(cc.prompt("hi")).toMatchObject({ code: 0, stdout: "", stderr: "" });
    expect(logText()).toContain("shim_failed stub problem");
  });

  it("Stop: one line, then silence; a new session or a new reason shows it again", () => {
    const { cc } = stubbed({}, { STUB_MODE: "problem" });
    expect(cc.stop("x").json).toEqual(line(cc, "internal error"));
    expect(cc.stop("y", { prompt_id: "next" })).toMatchObject({ code: 0, stdout: "", stderr: "" });
    cc.sessionId = "a-second-session";
    expect(cc.stop("z").json).toEqual(line(cc, "internal error"));
    cc.env = { ...cc.env, STUB_WHY: "input too large", STUB_WHERE: "/logs/x.log" };
    cc.sessionId = SESSION;
    expect(cc.stop("w").json).toEqual({ systemMessage: "Prosegate · this turn was not reviewed (input too large) · details: /logs/x.log" });
  });

  it("a failure before the mapping answers is still deduped per session, never machine-wide (the id comes from the input)", () => {
    const { cc } = stubbed({}, { STUB_MODE: "throw" });
    expect(cc.stop("x").json).toEqual(line(cc, "internal error"));
    expect(cc.stop("y", { prompt_id: "next" })).toMatchObject({ code: 0, stdout: "" });
    cc.sessionId = "a-second-session";
    expect(cc.stop("z").json).toEqual(line(cc, "internal error"));
    cc.sessionId = "a-third-session";
    expect(cc.stop("w").json).toEqual(line(cc, "internal error"));
  });

  it("remembers more than one session (S11): the first is still silent after others have had their line", () => {
    const { cc } = stubbed({}, { STUB_MODE: "problem" });
    for (const id of ["session-a", "session-b", "session-c"]) {
      cc.sessionId = id;
      expect(cc.stop("x").json, id).toEqual(line(cc, "internal error"));
    }
    cc.sessionId = "session-a";
    expect(cc.stop("again", { prompt_id: "p2" })).toMatchObject({ code: 0, stdout: "" });
  });

  it("session ids like __proto__ or constructor are ordinary keys; a record that is junk or unwritable still shows the line and exits 0", () => {
    for (const id of ["__proto__", "constructor", "hasOwnProperty", "toString", "a/b\\c:d"]) {
      const { cc } = stubbed({}, { STUB_MODE: "problem" });
      cc.sessionId = id;
      expect(cc.stop("x").json, id).toEqual(line(cc, "internal error"));
      expect(cc.stop("y", { prompt_id: "p2" }), id).toMatchObject({ code: 0, stdout: "" });
    }
    const { cc } = stubbed({}, { STUB_MODE: "problem" });
    writeFileSync(join(cc.home, "notices"), "this is a file where a directory should be");
    expect(cc.stop("x")).toMatchObject({ code: 0, json: line(cc, "internal error") });
  });

  it("a Stop failure through the real adapter (test build crash fixture) takes the reason and the log path from the adapter's stderr line", async () => {
    const cc = new FakeClaudeCode(await testPkg(), { env: testHooks({ crash: "turn-end" }) });
    cc.sessionStart();
    const r = cc.stop("The cache is per tenant.");
    expect(r.code).toBe(0);
    expect(r.stderr).toBe("");
    expect(r.stdout).toBe(`${JSON.stringify(line(cc, "internal error"))}\n`);
    expect(cc.stop("Again.", { prompt_id: "p2" })).toMatchObject({ code: 0, stdout: "" });
  });
});

