// The program files `init` installs under ~/.prosegate (ADR-32, ADR-33):
//   app/hook.mjs           the launcher every registration names; it never moves or changes between versions
//   app/<version>/         a copy of the package: dist/prosegate.mjs, shims/, package.json and the installed optional keyring dependency
//   app/current            the version the launcher runs (replaced atomically after the self-check passes)
//   app/previous           the version before it; the current and the previous are kept, the rest are pruned
//   bin/prosegate(.cmd)    the command, on a path the user controls; it follows app/current
// Hooks therefore never point into an npx cache or at a version that a later init prunes.

import { createHash, randomBytes } from "node:crypto";
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Ctx } from "./ctx.js";
import { ensureDirIn, writeFileAtomic } from "./fs-secure.js";
import { quoteProblem } from "./hook-shell.js";

export const VERSION_RE = /^[A-Za-z0-9._+-]+$/;

export const appDir = (ctx: Ctx): string => join(ctx.home, "app");
export const binDir = (ctx: Ctx): string => join(ctx.home, "bin");
export const launcherPath = (ctx: Ctx): string => join(appDir(ctx), "hook.mjs");

/** The installed package: dist/ and shims/ sit beside src/ when run from source and beside dist/ when bundled. */
export function packageRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..");
}

function readText(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

export function currentVersion(ctx: Ctx): string | null {
  const v = readText(join(appDir(ctx), "current"))?.trim();
  return v !== undefined && VERSION_RE.test(v) ? v : null;
}

const sha = (...parts: Array<Buffer | string>): string => {
  const h = createHash("sha256");
  for (const p of parts) h.update(p);
  return h.digest("hex");
};

/** The package files that make up one installed version, or the first one that is missing. */
function sources(root: string): { files: Array<[string, string]>; missing: string | null } {
  const files: Array<[string, string]> = [
    [join(root, "dist", "prosegate.mjs"), join("dist", "prosegate.mjs")],
    [join(root, "shims", "claude-code", "hook.mjs"), join("shims", "claude-code", "hook.mjs")],
    [join(root, "shims", "claude-code", "launcher.mjs"), join("shims", "claude-code", "launcher.mjs")],
  ];
  return { files, missing: files.find(([from]) => !existsSync(from))?.[0] ?? null };
}

/** Optional native dependencies installed beside the package (npm hoists them next to it): copied so they stay resolvable. */
function optionalDependencies(root: string): Array<[string, string]> {
  const found: Array<[string, string]> = [];
  for (let dir = root, prev = ""; dir !== prev; prev = dir, dir = dirname(dir)) {
    const scope = join(dir, "node_modules", "@napi-rs");
    if (!existsSync(scope)) continue;
    for (const name of readdirSync(scope)) if (name.startsWith("keyring")) found.push([join(scope, name), join("node_modules", "@napi-rs", name)]);
    if (found.length > 0) break;
  }
  return found;
}

export interface Installed {
  version: string;
  dir: string;
  /** True when this call created the version directory (a failed self-check removes only what it created). */
  created: boolean;
}

/** Copies the package into app/<version>/ (reusing an identical copy), and the launcher into app/hook.mjs. */
export function installVersion(ctx: Ctx, root = packageRoot()): Installed | string {
  const src = sources(root);
  if (src.missing !== null) return `Prosegate: the package is incomplete (${src.missing} is missing). Reinstall it, then run this again.`;
  const pkg = JSON.parse(readText(join(root, "package.json")) ?? "{}") as { version?: unknown };
  const base = typeof pkg.version === "string" && VERSION_RE.test(pkg.version) ? pkg.version : "0.0.0";
  const hash = sha(...src.files.map(([from]) => readFileSync(from))).slice(0, 12);
  const apps = appDir(ctx);
  ensureDirIn(ctx.home, apps, ctx.platform);
  // The same version with other content (a development build) gets its own directory, so a running hook never loses its files.
  let version = base;
  while (existsSync(join(apps, version)) && readText(join(apps, version, ".content"))?.trim() !== hash) version = version === base ? `${base}-${hash.slice(0, 8)}` : `${version}-x`;
  const dir = join(apps, version);
  const created = !existsSync(dir);
  if (created) {
    const tmp = join(apps, `.tmp-${randomBytes(4).toString("hex")}`);
    try {
      for (const [from, rel] of src.files) {
        mkdirSync(dirname(join(tmp, rel)), { recursive: true });
        copyFileSync(from, join(tmp, rel));
      }
      for (const [from, rel] of optionalDependencies(root)) cpSync(from, join(tmp, rel), { recursive: true });
      writeFileSync(join(tmp, "package.json"), `${JSON.stringify({ name: "prosegate", version: base })}\n`);
      writeFileSync(join(tmp, ".content"), `${hash}\n`);
      renameSync(tmp, dir);
    } catch (error) {
      rmSync(tmp, { recursive: true, force: true });
      return `Prosegate: could not copy the program files to ${dir} (${(error as NodeJS.ErrnoException).code ?? "error"}). Nothing was changed.`;
    }
  }
  // The launcher is the one file registrations name. It is replaced only when it differs, and atomically.
  const launcher = readFileSync(join(root, "shims", "claude-code", "launcher.mjs"), "utf8");
  if (readText(launcherPath(ctx)) !== launcher) writeFileAtomic(launcherPath(ctx), launcher);
  return { version, dir, created };
}

/** Replaces app/current atomically, remembering the one before it. */
export function setCurrent(ctx: Ctx, version: string): void {
  const before = currentVersion(ctx);
  if (before === version) return;
  if (before !== null) writeFileAtomic(join(appDir(ctx), "previous"), `${before}\n`);
  writeFileAtomic(join(appDir(ctx), "current"), `${version}\n`);
}

/** Puts app/current back as it was (a failed self-check), removing a pointer that did not exist. */
export function restoreCurrent(ctx: Ctx, before: string | null, previousBefore: string | null): void {
  const set = (name: string, v: string | null): void => {
    if (v === null) rmSync(join(appDir(ctx), name), { force: true });
    else writeFileAtomic(join(appDir(ctx), name), `${v}\n`);
  };
  set("current", before);
  set("previous", previousBefore);
}

export function previousVersion(ctx: Ctx): string | null {
  const v = readText(join(appDir(ctx), "previous"))?.trim();
  return v !== undefined && VERSION_RE.test(v) ? v : null;
}

/** Removes every version directory except the current and the previous. A directory a running hook holds open stays for the next time. */
export function pruneVersions(ctx: Ctx): string[] {
  const keep = new Set([currentVersion(ctx), previousVersion(ctx)]);
  const removed: string[] = [];
  for (const name of readdirSync(appDir(ctx))) {
    if (name.startsWith(".tmp-") || !existsSync(join(appDir(ctx), name, ".content")) || keep.has(name)) continue;
    try {
      rmSync(join(appDir(ctx), name), { recursive: true, force: true });
      removed.push(name);
    } catch {
      // still in use (Windows): pruned by a later init
    }
  }
  return removed;
}

const fwd = (p: string): string => p.replace(/\\/g, "/");

/** The `prosegate` command: scripts that read app/current, so an upgrade needs no rewrite. Returns the files written. */
export function writeBin(ctx: Ctx, nodePath: string): string[] | string {
  const problem = quoteProblem(nodePath, ctx.home);
  if (problem !== null) return problem;
  const dir = binDir(ctx);
  ensureDirIn(ctx.home, dir, ctx.platform);
  const sh = ["#!/bin/sh", `app='${fwd(appDir(ctx))}'`, 'exec \'' + fwd(nodePath) + '\' "$app/$(cat "$app/current")/dist/prosegate.mjs" "$@"', ""].join("\n");
  const written: string[] = [];
  const put = (name: string, text: string): void => {
    const file = join(dir, name);
    if (readText(file) !== text) writeFileAtomic(file, text);
    written.push(file);
  };
  put("prosegate", sh);
  if (ctx.platform === "win32") {
    const cmd = ["@echo off", "setlocal", `set /p V=<"${appDir(ctx)}\\current"`, `"${nodePath}" "${appDir(ctx)}\\%V%\\dist\\prosegate.mjs" %*`, ""].join("\r\n");
    put("prosegate.cmd", cmd);
  }
  return written;
}

/**
 * True when typing `prosegate` in a new terminal would find a program (ours, or one the user installed some other way). The
 * directories `npx` and `pnpm exec` add to PATH for their own child (`.../_npx/...`, `.../node_modules/.bin`) do not outlive the
 * command, so a `prosegate` found only there does not count.
 */
export function onPath(ctx: Ctx): boolean {
  const names = ctx.platform === "win32" ? ["prosegate.cmd", "prosegate.exe", "prosegate.bat", "prosegate"] : ["prosegate"];
  const path = ctx.env["PATH"] ?? ctx.env["Path"] ?? process.env["PATH"] ?? "";
  const temporary = (dir: string): boolean => /[\\/]_npx[\\/]/.test(dir) || /[\\/]node_modules[\\/]\.bin[\\/]?$/.test(dir);
  return path.split(delimiter).some((dir) => dir !== "" && !temporary(dir) && names.some((name) => existsSync(join(dir, name))));
}

/** Removes the program files and the command (`uninit --purge`). */
export function purge(ctx: Ctx): void {
  rmSync(appDir(ctx), { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  rmSync(binDir(ctx), { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
}
