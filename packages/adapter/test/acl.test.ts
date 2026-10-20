import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { ACL_MARKER, ensureDirIn, ensureHomeRestricted, resetRestrictedCache } from "../src/fs-secure.js";
import { SESSION, buildBundle, pg, sessionStartInput, tmpDir, turnEndInput, TIC_TEXT } from "./helpers.js";

// ADR-29: the owner-only ACL is applied to the Prosegate home root explicitly and idempotently,
// including a root that already existed, retried if icacls failed earlier, and not spawned again for
// every directory inside an already-restricted root (S3: fs.chmod is a no-op on Windows).

vi.setConfig({ testTimeout: 120_000 });

const IS_WIN = process.platform === "win32";

let bundle = "";
beforeAll(async () => {
  bundle = await buildBundle();
}, 120_000);

describe("ensureHomeRestricted (logic, any platform)", () => {
  it("restricts the root once, writes the marker, and does not spawn again for later directories", () => {
    resetRestrictedCache();
    const home = tmpDir();
    const calls: string[] = [];
    const restrict = (path: string): void => void calls.push(path);
    ensureHomeRestricted(home, "win32", restrict);
    expect(calls).toEqual([home]);
    expect(existsSync(join(home, ACL_MARKER))).toBe(true);
    // Later hook processes: the marker is there, so no spawn.
    resetRestrictedCache();
    ensureHomeRestricted(home, "win32", restrict);
    ensureHomeRestricted(home, "win32", restrict);
    expect(calls).toEqual([home]);
  });

  it("works on a root that already existed with other contents", () => {
    resetRestrictedCache();
    const home = tmpDir();
    const calls: string[] = [];
    ensureHomeRestricted(home, "win32", (p) => void calls.push(p));
    expect(calls).toEqual([home]);
  });

  it("a failed icacls leaves no marker and is retried by the next hook", () => {
    resetRestrictedCache();
    const home = tmpDir();
    expect(() =>
      ensureHomeRestricted(home, "win32", () => {
        throw new Error("icacls failed");
      }),
    ).toThrow("icacls failed");
    expect(existsSync(join(home, ACL_MARKER))).toBe(false);
    const calls: string[] = [];
    resetRestrictedCache();
    ensureHomeRestricted(home, "win32", (p) => void calls.push(p));
    expect(calls).toEqual([home]);
    expect(existsSync(join(home, ACL_MARKER))).toBe(true);
  });

  it("is a no-op off Windows (mode bits do the work)", () => {
    resetRestrictedCache();
    const home = join(tmpDir(), "new-home");
    const calls: string[] = [];
    ensureHomeRestricted(home, "linux", (p) => void calls.push(p));
    expect(calls).toEqual([]);
    expect(existsSync(home)).toBe(true);
    expect(existsSync(join(home, ACL_MARKER))).toBe(false);
  });

  it("ensureDirIn creates a nested directory inside the home without restricting it again", () => {
    resetRestrictedCache();
    const home = tmpDir();
    ensureDirIn(home, join(home, "a", "b", "c"), "linux");
    expect(statSync(join(home, "a", "b", "c")).isDirectory()).toBe(true);
  });
});

describe.skipIf(!IS_WIN)("Windows: a root that already existed with inherited permissions", () => {
  const sys32 = (name: string) => join(process.env["SystemRoot"] ?? "C:\\Windows", "System32", name);
  const aceNames = (path: string): string[] => {
    const out = execFileSync(sys32("icacls.exe"), [path], { encoding: "utf8" });
    return out
      .split(/\r?\n/)
      .map((l) => l.replace(path, "").trim())
      .filter((l) => /:\(/.test(l))
      .map((l) => l.slice(0, l.indexOf(":(")).replace(/^\*/, "").trim().toLowerCase());
  };

  it("session-start makes the pre-existing root, its subdirectories and its files owner-and-SYSTEM only", () => {
    const home = tmpDir(); // created by mkdtemp: a pre-existing root with the temp directory's inherited ACL
    // Restriction must remove explicit grants too, not just inherited entries.
    execFileSync(sys32("icacls.exe"), [home, "/grant", "*S-1-1-0:(OI)(CI)R"], { stdio: "ignore" });
    writeFileSync(join(home, ".owner-only-acl"), "legacy restriction marker\n");
    expect(aceNames(home).length).toBeGreaterThan(0);
    expect(pg(bundle, ["session-start"], { home, input: sessionStartInput() }).code).toBe(0);
    expect(pg(bundle, ["turn-end"], { home, input: turnEndInput(TIC_TEXT) }).code).toBe(0);
    expect(existsSync(join(home, ACL_MARKER))).toBe(true);
    const me = execFileSync(sys32("whoami.exe"), ["/user", "/fo", "csv", "/nh"], { encoding: "utf8" })
      .trim()
      .split(",")
      .map((s) => s.replace(/"/g, "").trim().toLowerCase());
    const allowed = new Set([...me, "nt authority\\system", "s-1-5-18"]);
    const walk = (dir: string, acc: string[] = []): string[] => {
      acc.push(dir);
      for (const n of readdirSync(dir)) {
        const p = join(dir, n);
        if (statSync(p).isDirectory()) walk(p, acc);
        else acc.push(p);
      }
      return acc;
    };
    const paths = walk(home);
    expect(paths.length).toBeGreaterThan(8);
    for (const p of paths) for (const who of aceNames(p)) expect(allowed.has(who), `${p} grants ${who}`).toBe(true);
    // The root files the adapter writes outside any session directory are covered too.
    expect(existsSync(join(home, "profile-versions.json"))).toBe(true);
  });

  it("the second hook does not spawn icacls again (the marker is the cheap check)", () => {
    const home = tmpDir();
    pg(bundle, ["session-start"], { home, input: sessionStartInput() });
    const t0 = performance.now();
    const r = pg(bundle, ["turn-end"], { home, input: turnEndInput(TIC_TEXT), env: { PROSEGATE_SESSION: SESSION } });
    expect(r.code).toBe(0);
    // A spawn of whoami plus icacls costs well over 100 ms by itself; this only guards against a regression to per-directory spawns.
    expect(performance.now() - t0).toBeLessThan(5000);
  });
});
