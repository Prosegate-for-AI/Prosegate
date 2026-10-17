import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { disallowedSpecifiers } from "./check-bundle.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, "check-bundle.mjs");
const ADAPTER = join(HERE, "..", "packages", "adapter");

const dirs = [];
const tmp = (prefix) => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function check(file, ...extra) {
  const r = spawnSync(process.execPath, [SCRIPT, file, ...extra], { encoding: "utf8" });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

function bundle(content, name = "prosegate.mjs") {
  const dir = tmp("pg-bundle-");
  const file = join(dir, name);
  writeFileSync(file, content);
  return file;
}

describe("disallowedSpecifiers", () => {
  it("allows node builtins (prefixed or bare) and the native keychain module", () => {
    const text = [
      'import fs from "node:fs";',
      'import { join } from "path";',
      'import { Entry } from "@napi-rs/keyring";',
      'const k = await import("@napi-rs/keyring");',
      'const z = __require("zlib");',
    ].join("\n");
    expect(disallowedSpecifiers(text)).toEqual([]);
  });

  it("finds every other form of import or require", () => {
    const text = [
      'import a from "left-pad";',
      'import "side-effect";',
      'export * from "@prosegate/schema";',
      'const b = require("lodash");',
      'const c = await import("chalk");',
      'const d = __require("kleur");',
    ].join("\n");
    expect(disallowedSpecifiers(text)).toEqual(["@prosegate/schema", "chalk", "kleur", "left-pad", "lodash", "side-effect"]);
  });
});

describe("check-bundle (subprocess)", () => {
  it("passes a self-contained bundle and prints its size", () => {
    const res = check(bundle('#!/usr/bin/env node\nimport fs from "node:fs";\nconsole.log(fs.sep);\n'));
    expect(res.code).toBe(0);
    expect(res.out).toMatch(/check:bundle: ok \(prosegate\.mjs \d+ bytes, budget 2097152\)/);
  });

  it("fails and names the module when a workspace package was not inlined", () => {
    const res = check(bundle('import { x } from "@prosegate/schema";\nconsole.log(x);\n'));
    expect(res.code).toBe(1);
    expect(res.err).toContain("@prosegate/schema");
  });

  it("fails on an un-inlined external dependency", () => {
    const res = check(bundle('const z = require("zod");\n'));
    expect(res.code).toBe(1);
    expect(res.err).toContain("zod");
  });

  it("fails over the size budget and prints the size", () => {
    const file = bundle("x".repeat(2000));
    expect(check(file, "--max-bytes", "2000").code).toBe(0);
    const res = check(file, "--max-bytes", "1999");
    expect(res.code).toBe(1);
    expect(res.err).toContain("2000 bytes, over the budget of 1999");
  });

  it("uses a 2 MB default budget", () => {
    expect(check(bundle("x".repeat(2 * 1024 * 1024 + 1))).code).toBe(1);
    expect(check(bundle("x".repeat(2 * 1024 * 1024))).code).toBe(0);
  });

  it("fails when other JS files sit next to the bundle (code splitting)", () => {
    const file = bundle("console.log(1);\n");
    writeFileSync(join(dirname(file), "chunk-ABC.mjs"), "export {};\n");
    const res = check(file);
    expect(res.code).toBe(1);
    expect(res.err).toContain("chunk-ABC.mjs");
  });

  it("exits 2 when the bundle does not exist", () => {
    expect(check(join(tmp("pg-none-"), "prosegate.mjs")).code).toBe(2);
  });
});

// ---- the real adapter build ---------------------------------------------------------------

function build(entryArgs, outDir) {
  const r = spawnSync("pnpm", ["exec", "tsup", ...entryArgs, "--out-dir", outDir], {
    cwd: ADAPTER,
    encoding: "utf8",
    shell: process.platform === "win32", // pnpm is a .cmd shim on Windows
  });
  if (r.status !== 0) throw new Error(`tsup failed:\n${r.stdout}\n${r.stderr}`);
}

describe("adapter bundle (built with the real tsup config)", () => {
  it("inlines every workspace package: no @prosegate/ import remains and check-bundle passes", () => {
    const out = tmp("pg-probe-");
    build(["test-fixtures/inline-probe.ts"], out);
    const file = join(out, "inline-probe.mjs");
    const text = readFileSync(file, "utf8");
    for (const name of ["schema", "segmenter", "profiles", "engine", "reviewer"]) {
      expect(text, name).toContain(`prosegate:${name}:placeholder`);
    }
    expect(text).not.toMatch(/["']@prosegate\//);
    expect(disallowedSpecifiers(text)).toEqual([]);
    expect(check(file).code).toBe(0);
    expect(readdirSync(out)).toEqual(["inline-probe.mjs"]);
  });

  it("the real CLI bundle runs alone in an empty directory (no node_modules anywhere above it)", () => {
    const out = tmp("pg-cli-");
    build([], out);
    expect(readdirSync(out)).toEqual(["prosegate.mjs"]);
    expect(check(join(out, "prosegate.mjs")).code).toBe(0);

    const lonely = tmp("pg-lonely-");
    copyFileSync(join(out, "prosegate.mjs"), join(lonely, "prosegate.mjs"));
    const run = (...args) => {
      const r = spawnSync(process.execPath, [join(lonely, "prosegate.mjs"), ...args], { cwd: lonely, encoding: "utf8" });
      return { code: r.status, out: r.stdout, err: r.stderr };
    };
    const pkg = JSON.parse(readFileSync(join(ADAPTER, "package.json"), "utf8"));
    expect(run("--version")).toEqual({ code: 0, out: `${pkg.version}\n`, err: "" });
    expect(run("--help").code).toBe(0);
    expect(run().out).toContain("usage: prosegate");
    expect(run("init")).toMatchObject({ code: 1, out: "", err: "prosegate init is not available in this build yet.\n" });
    expect(run("nope")).toMatchObject({ code: 1, err: 'prosegate: unknown command "nope". Run prosegate --help.\n' });
  });
});
