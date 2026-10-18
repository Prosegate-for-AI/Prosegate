import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { sessionStart, turnEnd, turnStart } from "../src/hooks.js";
import { SESSION_RETENTION_MS, SessionStore, listSessions, rememberCwdProfile, readCwdProfiles, sweepSessions, turnKey } from "../src/store.js";
import { SPOOL_MAX_EVENTS, encodeBatch, readSpool, recordEvents, enforcementEvent } from "../src/telemetry.js";
import { CLEAN_TEXT, SESSION, TIC_TEXT, buildBundle, pg, sessionStartInput, testCtx, tmpDir, turnEndInput } from "./helpers.js";

// Each test spawns real processes; the root run executes dozens of test files in parallel.
vi.setConfig({ testTimeout: 120_000 });

let bundle = "";
beforeAll(async () => {
  bundle = await buildBundle();
}, 120_000);

const IS_WIN = process.platform === "win32";

/** A home the adapter creates itself, so on Windows the topmost new directory gets the ACL. */
function freshHome(): string {
  return join(tmpDir(), ".prosegate");
}

function populate(home: string): void {
  pg(bundle, ["session-start"], { home, input: sessionStartInput() });
  pg(bundle, ["turn-start"], { home, input: { session_id: SESSION, user_message: "hello", tool_calls_so_far: [] } });
  pg(bundle, ["turn-end"], { home, input: turnEndInput(TIC_TEXT), env: { CI: "true" } });
  pg(bundle, ["turn-end"], { home, raw: "{bad" }); // writes a log line
  pg(bundle, ["profile", "local/email"], { home, env: { PROSEGATE_SESSION: SESSION } });
}

function allPaths(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      out.push(p);
      if (statSync(p).isDirectory()) walk(p);
    }
  };
  walk(root);
  return out;
}

describe("store files are owner-only", () => {
  it("lists the files a session writes", () => {
    const home = freshHome();
    populate(home);
    const names = allPaths(home).map((p) => p.slice(home.length + 1).replace(/\\/g, "/"));
    for (const expected of [
      `sessions/${SESSION}/state.json`,
      `sessions/${SESSION}/profile.json`,
      `sessions/${SESSION}/turn.json`,
      `sessions/${SESSION}/report.json`,
      "telemetry/spool.jsonl",
      "cwd-profiles.json",
      "profile-versions.json",
    ]) {
      expect(names, expected).toContain(expected);
    }
    expect(names.some((n) => n.startsWith("logs/") && n.endsWith(".log"))).toBe(true);
    expect(names.filter((n) => n.endsWith(".tmp") || n.endsWith(".lock"))).toEqual([]);
  });

  it.skipIf(IS_WIN)("POSIX: files are 0600 and directories 0700", () => {
    const home = freshHome();
    populate(home);
    for (const p of allPaths(home)) {
      const mode = statSync(p).mode & 0o777;
      expect(mode.toString(8), p).toBe(statSync(p).isDirectory() ? "700" : "600");
    }
  });

  it.skipIf(!IS_WIN)("Windows: every file and directory grants only the current user and SYSTEM", () => {
    const home = freshHome();
    populate(home);
    const whoami = execFileSync(join(process.env["SystemRoot"] ?? "C:\\Windows", "System32", "whoami.exe"), ["/user", "/fo", "csv", "/nh"], { encoding: "utf8" })
      .trim()
      .split(",")
      .map((s) => s.replace(/"/g, "").trim());
    const me = (whoami[0] ?? "").toLowerCase();
    const sid = (whoami[1] ?? "").toLowerCase();
    const allowed = new Set([me, sid, "nt authority\\system", "s-1-5-18"]);
    const paths = [home, ...allPaths(home)];
    expect(paths.length).toBeGreaterThan(8);
    for (const p of paths) {
      const out = execFileSync(join(process.env["SystemRoot"] ?? "C:\\Windows", "System32", "icacls.exe"), [p], { encoding: "utf8" });
      const principals = out
        .split(/\r?\n/)
        .map((l) => l.replace(p, "").trim())
        .filter((l) => /:\(/.test(l))
        .map((l) => l.slice(0, l.indexOf(":(")).replace(/^\*/, "").trim().toLowerCase());
      expect(principals.length, p).toBeGreaterThan(0);
      for (const who of principals) expect(allowed.has(who), `${p} grants ${who}`).toBe(true);
    }
  });
});

describe("retention (07)", () => {
  function ageSession(home: string, id: string, ageMs: number): void {
    const dir = join(home, "sessions", id);
    const when = new Date(Date.now() - ageMs);
    for (const name of readdirSync(dir)) utimesSync(join(dir, name), when, when);
    utimesSync(dir, when, when);
  }

  it("session-start deletes session directories that have been idle past the window and keeps the rest", () => {
    const home = tmpDir();
    const ctx = testCtx(home);
    for (const id of ["old-a", "old-b", "recent", "other"]) {
      sessionStart({ harness: "claude-code", session_id: id, cwd: "/work/project", mode: "interactive" }, ctx);
    }
    ageSession(home, "old-a", 3 * 24 * 3600_000);
    ageSession(home, "old-b", SESSION_RETENTION_MS + 60_000);
    ageSession(home, "recent", 60_000);
    sessionStart({ harness: "claude-code", session_id: "current", cwd: "/work/project", mode: "interactive" }, ctx);
    expect(listSessions(ctx).map((s) => s.id).sort()).toEqual(["current", "other", "recent"]);
    expect(existsSync(join(home, "sessions", "old-a"))).toBe(false);
  });

  it("never deletes the session that is starting, however old its directory looks", () => {
    const home = tmpDir();
    const ctx = testCtx(home);
    sessionStart({ harness: "claude-code", session_id: "me", cwd: "/work/project", mode: "interactive" }, ctx);
    ageSession(home, "me", 10 * 24 * 3600_000);
    expect(sweepSessions(ctx, "me")).toEqual([]);
    expect(existsSync(join(home, "sessions", "me"))).toBe(true);
  });

  it("the built bundle does it too, in a fresh process", () => {
    const home = tmpDir();
    pg(bundle, ["session-start"], { home, input: sessionStartInput({ session_id: "old-one" }) });
    ageSession(home, "old-one", 5 * 24 * 3600_000);
    pg(bundle, ["session-start"], { home, input: sessionStartInput({ session_id: "new-one" }) });
    expect(readdirSync(join(home, "sessions"))).toEqual(["new-one"]);
  });

  it("ignores entries that are not session ids and files in the sessions directory", () => {
    const home = tmpDir();
    mkdirSync(join(home, "sessions", "not a session!"), { recursive: true });
    writeFileSync(join(home, "sessions", "stray.txt"), "x");
    expect(listSessions(testCtx(home))).toEqual([]);
  });
});

describe("the session store", () => {
  it("turn ids become 16-hex keys, so a hostile id cannot be a path or a prototype key", () => {
    for (const id of ["__proto__", "../../x", "constructor", "a".repeat(300)]) expect(turnKey(id)).toMatch(/^[0-9a-f]{16}$/);
    expect(turnKey("a")).not.toBe(turnKey("b"));
  });

  it("refuses a session id that is not [A-Za-z0-9_-]{1,128}", () => {
    const ctx = testCtx(tmpDir());
    for (const id of ["../x", "a/b", "a\\b", "", ".", "..", "a".repeat(129), "x y"]) expect(() => new SessionStore(ctx, id)).toThrow();
    expect(() => new SessionStore(ctx, "a".repeat(128))).not.toThrow();
  });

  it("keeps the turns map bounded to the newest 20", () => {
    const home = tmpDir();
    const ctx = testCtx(home);
    sessionStart({ harness: "claude-code", session_id: SESSION, cwd: "/work/project", mode: "interactive" }, ctx);
    for (let i = 0; i < 30; i++) {
      turnEnd({ session_id: SESSION, turn_id: `t${i}`, assistant_text: TIC_TEXT, user_message: "", tool_calls: [], continuation: false }, { ...ctx, now: () => 1_700_000_000_000 + i });
    }
    const state = new SessionStore(ctx, SESSION).readState();
    expect(Object.keys(state?.turns ?? {})).toHaveLength(20);
    expect(state?.turns[turnKey("t29")]).toBeDefined();
    expect(state?.turns[turnKey("t0")]).toBeUndefined();
  });

  it("turn-start clears every earlier pass count", () => {
    const home = tmpDir();
    const ctx = testCtx(home);
    sessionStart({ harness: "claude-code", session_id: SESSION, cwd: "/work/project", mode: "interactive" }, ctx);
    turnEnd({ session_id: SESSION, turn_id: "t1", assistant_text: TIC_TEXT, user_message: "", tool_calls: [], continuation: false }, ctx);
    expect(Object.keys(new SessionStore(ctx, SESSION).readState()?.turns ?? {})).toHaveLength(1);
    turnStart({ session_id: SESSION, user_message: "next", tool_calls_so_far: [] }, ctx);
    expect(new SessionStore(ctx, SESSION).readState()?.turns).toEqual({});
  });

  it("the cwd -> profile map is bounded and keyed by a normalised path", () => {
    const home = tmpDir();
    const ctx = testCtx(home);
    for (let i = 0; i < 220; i++) rememberCwdProfile({ ...ctx, now: () => i + 1 }, `/work/p${i}/`, "local/email");
    const map = readCwdProfiles(ctx);
    expect(Object.keys(map)).toHaveLength(200);
    expect(Object.keys(map).some((k) => k.endsWith("/") || k.endsWith("\\"))).toBe(false);
  });
});

describe("profile.json is a cache (ADR-19)", () => {
  it("a tampered or corrupt profile.json changes nothing: turn-end re-resolves from bundled and local sources", () => {
    const home = tmpDir();
    const ctx = testCtx(home);
    sessionStart({ harness: "claude-code", session_id: SESSION, cwd: "/work/project", mode: "interactive" }, ctx);
    const file = join(home, "sessions", SESSION, "profile.json");
    const snapshot = JSON.parse(readFileSync(file, "utf8")) as { enforcement: Record<string, unknown>; rules: Record<string, unknown> };
    // The attacker's edits: enforcement off, every rule switched off, a policy that says nothing is required.
    snapshot.enforcement["mode"] = "advisory";
    snapshot.enforcement["render"] = "none";
    snapshot.rules["core.hedge.001"] = { enabled: { value: false, origin: "local/base", layer: 0 } };
    writeFileSync(file, JSON.stringify(snapshot));
    const a = turnEnd({ session_id: SESSION, turn_id: "t1", assistant_text: TIC_TEXT, user_message: "", tool_calls: [], continuation: false }, ctx).output;
    expect(a.decision).toBe("continue");
    expect(a.result.findings.some((f) => f.rule_id === "core.hedge.001")).toBe(true);
    writeFileSync(file, "garbage");
    const b = turnEnd({ session_id: SESSION, turn_id: "t2", assistant_text: TIC_TEXT, user_message: "", tool_calls: [], continuation: false }, ctx).output;
    expect(b.decision).toBe("continue");
    // And nothing in the hook sources reads the file back.
    const src = readdirSync(join(__dirname, "..", "src")).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));
    for (const f of src) expect(readFileSync(join(__dirname, "..", "src", f), "utf8"), f).not.toMatch(/readFileOrNull\([^)]*profile\.json|parseSnapshot/);
  });
});

describe("the telemetry spool", () => {
  it("is bounded at 1,000 events, dropping the oldest", () => {
    const home = tmpDir();
    let t = 1_700_000_000_000;
    const ctx = testCtx(home, { now: () => (t += 60_000) });
    // 990 events already spooled (the first is the only one with override_used true), then 40 more through the real path.
    mkdirSync(join(home, "telemetry"), { recursive: true });
    const seeded = Array.from({ length: SPOOL_MAX_EVENTS - 10 }, (_, i) => encodeBatch([enforcementEvent({ decision: "allow", overrideUsed: i === 0 })], t));
    writeFileSync(join(home, "telemetry", "spool.jsonl"), `${seeded.join("\n")}\n`);
    for (let i = 0; i < 40; i++) recordEvents(ctx, [enforcementEvent({ decision: "allow", overrideUsed: false })]);
    const lines = readSpool(ctx);
    expect(lines).toHaveLength(SPOOL_MAX_EVENTS);
    // The first event (the only one with override_used true) was dropped.
    expect(lines.join("\n")).not.toContain('"override_used":true');
    // A multi-event batch counts its events.
    recordEvents(ctx, [enforcementEvent({ decision: "allow", overrideUsed: false }), enforcementEvent({ decision: "continue", overrideUsed: false })]);
    const total = readSpool(ctx).reduce((n, l) => n + (JSON.parse(l) as { events: unknown[] }).events.length, 0);
    expect(total).toBeLessThanOrEqual(SPOOL_MAX_EVENTS);
    expect(total).toBeGreaterThan(SPOOL_MAX_EVENTS - 3);
  });
});

describe("a clean turn leaves little behind", () => {
  it("writes the state, the cache, the spool and nothing else", () => {
    const home = tmpDir();
    const ctx = testCtx(home);
    sessionStart({ harness: "claude-code", session_id: SESSION, cwd: "/work/project", mode: "interactive" }, ctx);
    turnEnd({ session_id: SESSION, turn_id: "t1", assistant_text: CLEAN_TEXT, user_message: "", tool_calls: [], continuation: false }, ctx);
    expect(readdirSync(join(home, "sessions", SESSION)).sort()).toEqual(["profile.json", "state.json"]);
  });
});
