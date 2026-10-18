import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import { join, resolve, sep } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createCtx } from "../../src/ctx.js";
import { roundTripEnv, runInit, settingsTarget } from "../../src/init.js";
import { HOME_VARS, SCRUBBED, cleanEnv, isolatedHomes, pg, tmpDir } from "../helpers.js";
import pointSetup, { ISO_ROOT_VAR, pointHomesAt } from "../global-setup.js";
import { FakeClaudeCode, releasePkg, testPkg, type Pkg } from "./driver.js";

// Incident 2026-10-18: a test wrote the real ~/.claude/settings.json. These tests prove each layer that keeps tests
// at home: the vitest setup, the child-process environment, the in-process contexts, the product guard (test builds
// only) and the init self-check's homes. The global setup also fails the whole run if the real settings' mtime moves.

const under = (path: string, dir: string): boolean => {
  const norm = (p: string): string => (process.platform === "win32" ? resolve(p).toLowerCase() : resolve(p));
  const base = norm(dir);
  return norm(path).startsWith(base.endsWith(sep) ? base : base + sep);
};

let release: Pkg;
let test: Pkg;
beforeAll(async () => {
  release = await releasePkg();
  test = await testPkg();
}, 120_000);

describe("this worker is isolated", () => {
  it("every home-like variable points under the OS temp directory, and so does os.homedir()", () => {
    for (const k of HOME_VARS) {
      const v = process.env[k];
      expect(v, k).toBeTruthy();
      expect(under(v as string, tmpdir()), `${k}=${String(v)}`).toBe(true);
    }
    expect(under(homedir(), tmpdir())).toBe(true);
    expect(process.env[ISO_ROOT_VAR]).toBeTruthy();
  });

  it("the account's real profile directory is a different place", () => {
    // Only the path is compared; nothing under it is read.
    const real = userInfo().homedir;
    expect(resolve(homedir()).toLowerCase()).not.toBe(resolve(real).toLowerCase());
  });
});

describe("children get temp homes, never the host's", () => {
  it("cleanEnv replaces every home variable, including ones the host or the call site set", () => {
    const saved = Object.fromEntries(HOME_VARS.map((k) => [k, process.env[k]]));
    try {
      for (const k of HOME_VARS) process.env[k] = k.includes("CLAUDE") ? "C:\\Users\\Someone\\.claude" : "C:\\Users\\Someone";
      const home = tmpDir();
      const env = cleanEnv(home);
      for (const k of HOME_VARS) expect(under(env[k] as string, tmpdir()), k).toBe(true);
      expect(env["PROSEGATE_HOME"]).toBe(home);
      // A call site may override one on purpose.
      expect(cleanEnv(home, { CLAUDE_CONFIG_DIR: "X" })["CLAUDE_CONFIG_DIR"]).toBe("X");
    } finally {
      for (const [k, v] of Object.entries(saved)) Reflect.set(process.env, k, v as string);
    }
  });

  it("the scrubbed list names every home variable and the two that broke the isolation before", () => {
    for (const k of [...HOME_VARS, "CLAUDE_CONFIG_DIR", "PROSEGATE_CLAUDE_HOME"]) expect(SCRUBBED).toContain(k);
  });

  it("isolatedHomes gives one stable tree per test file", () => {
    expect(isolatedHomes().HOME).toBe(isolatedHomes().USERPROFILE);
    expect(isolatedHomes().APPDATA).toBe(isolatedHomes().APPDATA);
  });

  it("a hook run through the fake Claude Code sees temp homes", () => {
    const cc = new FakeClaudeCode(release);
    expect(cc.sessionStart().code).toBe(0);
    expect(under(cc.home, tmpdir())).toBe(true);
  });
});

describe("the vitest global setup", () => {
  it("points the homes it is given at the tree it is given", () => {
    const root = tmpDir();
    const saved = { ...process.env };
    try {
      pointHomesAt(root);
      for (const k of HOME_VARS) expect(under(process.env[k] as string, root), k).toBe(true);
    } finally {
      for (const k of HOME_VARS) process.env[k] = saved[k];
    }
  });

  it("fails the run when a watched settings file changes, and not otherwise (the mtime assertion)", () => {
    const watched = tmpDir();
    const saved = { ...process.env };
    try {
      // The setup watches the settings under PROSEGATE_CLAUDE_HOME as well as the real profile's.
      process.env["PROSEGATE_CLAUDE_HOME"] = watched;
      const settings = join(watched, "settings.json");
      writeFileSync(settings, "{}");
      const teardown = pointSetup();
      expect(() => teardown()).not.toThrow();
      process.env["PROSEGATE_CLAUDE_HOME"] = watched; // the setup re-pointed it at its own tree
      const again = pointSetup();
      // Moving the mtime is what a write does.
      const later = new Date(statSync(settings).mtimeMs + 60_000);
      utimesSync(settings, later, later);
      expect(() => again()).toThrow(/changed a real Claude settings file/);
    } finally {
      for (const k of HOME_VARS) process.env[k] = saved[k];
      process.env[ISO_ROOT_VAR] = saved[ISO_ROOT_VAR];
    }
  });
});

describe("the product guard (test builds and source runs only)", () => {
  // A place that is not under the temp directory and that no real home uses; unique per run, and removed if a broken guard ever creates it.
  const probe = `${process.platform === "win32" ? "C:\\" : "/"}prosegate-guard-probe-${randomBytes(4).toString("hex")}`;
  afterAll(() => rmSync(probe, { recursive: true, force: true }));

  it("refuses a user-scope write outside the temp directory when no Claude home was given, from source", () => {
    const ctx = createCtx({ env: { HOME: probe, USERPROFILE: probe }, home: tmpDir(), cwd: tmpDir() });
    const target = settingsTarget(ctx, "user");
    expect(typeof target).toBe("string");
    expect(target).toMatch(/^Prosegate: refusing to write .+settings\.json from a test build: it is outside the temp directory and no test home was given \(set PROSEGATE_CLAUDE_HOME\)\. Nothing was changed\.$/);
    const r = runInit(["--harness", "claude-code", "--local"], ctx);
    expect(r.code).toBe(1);
    expect(r.err).toContain("refusing to write");
    expect(existsSync(probe)).toBe(false);
  });

  it("allows a given home, and a default home under the temp directory", () => {
    const given = createCtx({ env: { HOME: probe, USERPROFILE: probe, CLAUDE_CONFIG_DIR: join(tmpDir(), "cfg") }, home: tmpDir() });
    expect(typeof settingsTarget(given, "user")).toBe("object");
    const temp = tmpDir();
    const underTemp = createCtx({ env: { HOME: temp, USERPROFILE: temp }, home: tmpDir() });
    expect(settingsTarget(underTemp, "user")).toMatchObject({ path: join(temp, ".claude", "settings.json"), claudeDir: join(temp, ".claude") });
  });

  it("derives the default from the environment's home, never from os.homedir()", () => {
    const temp = tmpDir();
    const ctx = createCtx({ env: { HOME: temp, USERPROFILE: temp }, home: tmpDir() });
    expect(homedir()).not.toBe(temp);
    expect((settingsTarget(ctx, "user") as { path: string }).path.startsWith(temp)).toBe(true);
    // No home in the environment at all: refuse rather than fall back to the account's profile.
    const none = createCtx({ env: {}, home: tmpDir() });
    expect(settingsTarget(none, "user")).toMatch(/cannot tell where your Claude settings are/);
  });

  it("the test build refuses too, through the real command line", () => {
    const home = tmpDir();
    const r = pg(test.bundle, ["init", "--harness", "claude-code", "--local"], { home, cwd: tmpDir(), env: { HOME: probe, USERPROFILE: probe, PROSEGATE_CLAUDE_HOME: "", CLAUDE_CONFIG_DIR: "" } });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("refusing to write");
    expect(existsSync(probe)).toBe(false);
  });

  it("the release bundle does not contain the guard", () => {
    expect(readFileSync(release.bundle, "utf8")).not.toContain("from a test build");
    expect(readFileSync(test.bundle, "utf8")).toContain("from a test build");
  });
});

describe("init's self-check uses the homes it was given", () => {
  it("passes the given Prosegate home and Claude home to the hook, over whatever the process has", () => {
    const ctx = createCtx({ env: { PROSEGATE_CLAUDE_HOME: "ignored" }, home: join(tmpDir(), "given-prosegate-home") });
    const env = roundTripEnv(ctx, join(tmpDir(), "given-claude"), { PROSEGATE_HOME: "C:\\Users\\Someone\\.prosegate", PATH: "p" });
    expect(env["PROSEGATE_HOME"]).toBe(ctx.home);
    expect(env["PROSEGATE_CLAUDE_HOME"]).toMatch(/given-claude$/);
    expect(env["PATH"]).toBe("p");
  });

  it("through the command line the synthetic session is created and removed under the given Prosegate home only", () => {
    const home = join(tmpDir(), ".prosegate");
    const claude = join(tmpDir(), ".claude");
    const r = pg(release.bundle, ["init", "--harness", "claude-code", "--local"], { home, cwd: tmpDir(), env: { PROSEGATE_CLAUDE_HOME: claude } });
    expect(r.code).toBe(0);
    expect(existsSync(join(home, "sessions", "prosegate-init-check"))).toBe(false);
    expect(readdirSync(home).length).toBeGreaterThan(0);
  });
});
