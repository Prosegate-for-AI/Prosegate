import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "tsup";
import { afterAll } from "vitest";
import tsupConfig from "../tsup.config.js";
import { createCtx, type Ctx } from "../src/ctx.js";

export const ADAPTER_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");

const cleanups: string[] = [];
afterAll(() => {
  for (const d of cleanups.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

/** A fresh empty directory, removed when the test file ends. */
export function tmpDir(prefix = "pg-adapter-"): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(d);
  return d;
}

const builtBundles = new Map<string, Promise<string>>();

/**
 * Builds the real tsup bundle (same config as `pnpm build`) into a temp directory, once per test file.
 * `release` is the published bundle, with no test lever in it (ADR-29): subprocess tests use it unless
 * they need fault injection. `test` is the same build with `__PROSEGATE_TEST__` true, which honours PROSEGATE_TEST_HOOKS.
 */
export function buildBundle(kind: "release" | "test" = "release"): Promise<string> {
  let built = builtBundles.get(kind);
  if (built === undefined) {
    built = (async () => {
      const out = tmpDir(`pg-bundle-${kind}-`);
      const base = tsupConfig as unknown as { define?: Record<string, string> } & Record<string, unknown>;
      await build({
        ...base,
        define: { ...(base.define ?? {}), __PROSEGATE_TEST__: kind === "test" ? JSON.stringify("PROSEGATE_TEST_HOOKS") : "false" },
        entry: { prosegate: join(ADAPTER_DIR, "src", "cli.ts") },
        tsconfig: join(ADAPTER_DIR, "tsconfig.json"),
        outDir: out,
        clean: false,
        silent: true,
        config: false,
      });
      return join(out, "prosegate.mjs");
    })();
    builtBundles.set(kind, built);
  }
  return built;
}

/** The environment that drives a test build's fault injection (it does nothing in a release bundle). */
export function testHooks(hooks: Record<string, unknown>): Record<string, string> {
  return { PROSEGATE_TEST_HOOKS: JSON.stringify(hooks) };
}

export interface Proc {
  code: number | null;
  stdout: string;
  stderr: string;
}

export interface SpawnOpts {
  home: string;
  input?: unknown;
  /** Raw stdin text (overrides `input`). */
  raw?: string;
  env?: Record<string, string | undefined>;
  cwd?: string;
  args?: string[];
}

const SCRUBBED = ["CLAUDECODE", "CLAUDE_CODE_CHILD_SESSION", "CLAUDE_CODE_SESSION_ID", "CLAUDE_CODE_ENTRYPOINT", "CI", "PROSEGATE_MODE", "PROSEGATE_SESSION", "PROSEGATE_DEBUG", "PROSEGATE_TEST_HOOKS", "PROSEGATE_TIMINGS"];

/** The test process's environment without agent markers and Prosegate switches, plus what the test sets. */
function cleanEnv(o: SpawnOpts): NodeJS.ProcessEnv {
  const kept = Object.entries(process.env).filter(([k]) => !SCRUBBED.includes(k.toUpperCase()));
  const extra = Object.entries(o.env ?? {}).filter((e): e is [string, string] => e[1] !== undefined);
  return { ...Object.fromEntries(kept), PROSEGATE_HOME: o.home, ...Object.fromEntries(extra) };
}

/** Runs the built bundle in a fresh process with a temp HOME. The environment starts clean of agent markers. */
export function pg(bundle: string, argv: string[], o: SpawnOpts): Proc {
  const r = spawnSync(process.execPath, [bundle, ...argv], {
    input: o.raw ?? (o.input === undefined ? "" : JSON.stringify(o.input)),
    encoding: "utf8",
    env: cleanEnv(o),
    cwd: o.cwd,
    timeout: 60_000,
  });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

/** As pg, but asynchronous, so two processes can run at the same time. */
export function pgAsync(bundle: string, argv: string[], o: SpawnOpts): Promise<Proc> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [bundle, ...argv], { env: cleanEnv(o), cwd: o.cwd, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(o.raw ?? (o.input === undefined ? "" : JSON.stringify(o.input)));
  });
}

export function json<T = Record<string, unknown>>(p: Proc): T {
  return JSON.parse(p.stdout) as T;
}

export const SESSION = "sess-1";

export function sessionStartInput(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { harness: "claude-code", session_id: SESSION, cwd: "/work/project", mode: "interactive", ...over };
}

export function turnEndInput(text: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return { session_id: SESSION, turn_id: "turn-1", assistant_text: text, user_message: "", tool_calls: [], continuation: false, ...over };
}

/** About 90 words of plain technical prose with none of the core pack's tics. */
export const CLEAN_TEXT =
  "The cache sits in front of the catalog reads and keeps one entry per tenant. " +
  "A read checks the entry first and falls back to the database on a miss. " +
  "The entry expires after sixty seconds, so a price change reaches every tenant within a minute. " +
  "On the staging dataset the median read dropped from 410 ms to 95 ms. " +
  "Writes bypass the cache and delete the tenant's entry, which keeps the two copies from drifting apart. " +
  "The change touches the catalog service and its tests, and it adds one configuration key for the expiry time.";

/** Two block findings (hedge, filler) and some warns; well over the 60-word floor. */
export const TIC_TEXT =
  "It's worth noting that the cache sits in front of the catalog reads and keeps one entry per tenant. " +
  "Great question! A read checks the entry first and falls back to the database on a miss. " +
  "The entry expires after sixty seconds, so a price change reaches every tenant within a minute. " +
  "On the staging dataset the median read dropped from 410 ms to 95 ms, which is a robust result. " +
  "Writes bypass the cache and delete the tenant's entry, which keeps the two copies from drifting apart. " +
  "The change touches the catalog service and its tests, and it adds one configuration key for the expiry time.";

/** Only warn-level findings (vocab): a turn that is allowed silently in enforce mode. */
export const WARN_TEXT =
  "The cache sits in front of the catalog reads and keeps one entry per tenant. " +
  "A read checks the entry first and falls back to the database on a miss. " +
  "The entry expires after sixty seconds, so a price change reaches every tenant within a minute. " +
  "On the staging dataset the median read dropped from 410 ms to 95 ms, which is a robust and seamless result. " +
  "Writes bypass the cache and delete the tenant's entry, which keeps the two copies from drifting apart. " +
  "The change touches the catalog service and its tests, and it adds one configuration key for the expiry time.";

/** An in-process Ctx over a temp home. */
export function testCtx(home: string, over: Partial<Ctx> = {}): Ctx {
  return createCtx({
    env: {},
    home,
    cwd: "/work/project",
    platform: process.platform,
    stdinIsTTY: true,
    // In process the clock would be the test worker's age, not a hook process's.
    elapsedMs: () => 10,
    ...over,
  });
}
