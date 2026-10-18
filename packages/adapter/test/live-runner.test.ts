import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ADAPTER_DIR } from "./helpers.js";

// The live runner (test/live/run-live.mjs) is never run by the test suite, so these checks read it as text: the rules that
// came out of the incident of 2026-10-18 must not be edited away by accident.

const source = readFileSync(join(ADAPTER_DIR, "test", "live", "run-live.mjs"), "utf8");
const code = source.split("\n").filter((l) => !l.trimStart().startsWith("//")).join("\n");

describe("run-live.mjs", () => {
  it("copies no credential file and never reads the real settings", () => {
    expect(code).not.toMatch(/credentials/i);
    expect(code).not.toContain("copyFileSync");
    expect(code).not.toMatch(/\.claude\.json/);
    // The only settings file it reads is the scratch project's own.
    const reads = [...code.matchAll(/readFileSync\(([^)]*)\)/g)].map((m) => m[1] ?? "");
    expect(reads.filter((r) => /settings/.test(r) && !/join\(project/.test(r))).toEqual([]);
  });

  it("runs claude without user-level settings, and says so at the top of the file", () => {
    expect(code).toContain('"--setting-sources", "project,local"');
    expect(source.split("\n").slice(0, 20).join("\n")).toMatch(/copies no credential file/);
  });

  it("collects only the projects/ directories its own run created, then deletes them", () => {
    expect(code).toContain("projectsBefore.has(name)");
    expect(code).toMatch(/cpSync\(join\(claudeProjects, name\)[\s\S]*rmSync\(join\(claudeProjects, name\)/);
  });

  it("runs init with every home variable in the scratch tree", () => {
    for (const v of ["HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "XDG_CONFIG_HOME", "CLAUDE_CONFIG_DIR", "PROSEGATE_CLAUDE_HOME"]) {
      expect(code).toMatch(new RegExp(`${v}: `));
    }
    expect(code).toContain('"--scope", "project"');
    expect(code).not.toContain('"--scope", "user"');
  });
});
