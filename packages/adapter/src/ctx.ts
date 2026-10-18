import { homedir } from "node:os";
import { join } from "node:path";
import type { OrgPolicyInput, ResolutionSources } from "@prosegate/profiles";

/**
 * Everything the adapter reads from the process: environment, clock, working directory, the home
 * directory. Handlers take a Ctx instead of touching `process` so unit tests can drive them.
 */
export interface Ctx {
  env: Readonly<Record<string, string | undefined>>;
  /** `~/.prosegate`, or PROSEGATE_HOME. */
  home: string;
  /** Epoch milliseconds. */
  now: () => number;
  /** Milliseconds since this process started (performance.now()); every deadline counts from here (ADR-31). */
  elapsedMs: () => number;
  cwd: string;
  platform: NodeJS.Platform;
  /** True when stdin is a terminal; the agent-context check (ADR-27) needs it. */
  stdinIsTTY: boolean;
  /** The verified org policy of the account. None exists in the free tier (Phase 7 supplies it). */
  policy: OrgPolicyInput | null;
  /** Verified synced profiles and packs from the config client (Phase 7). Null in the free tier. */
  synced: ResolutionSources | null;
  /** Fault injection. Always empty in a release bundle (ADR-29). */
  testHooks: TestHooks;
  /** --debug or PROSEGATE_DEBUG=1 (07: writes the turn text to the session's debug directory). */
  debug: boolean;
}

/**
 * Test-only levers. They exist only in a test build (`__PROSEGATE_TEST__` true, ADR-29): a release
 * bundle never reads PROSEGATE_TEST_HOOKS, because a project `.claude/settings.json` `env` block can set
 * any variable for hook processes and an environment lever would be an enforcement bypass.
 */
export interface TestHooks {
  /** Throw inside this stage ("session-start" | "turn-start" | "turn-end"). */
  crash?: string;
  /** Sleep this long before the review (milliseconds). */
  delayMs?: number;
  /** Override of the 6 s turn-end review cap. */
  budgetMs?: number;
  /** Override of the engine budget. */
  engineBudgetMs?: number;
  /** Override of the 8 s hard deadline. */
  hardDeadlineMs?: number;
  /** A fake reviewer stage that reports these spans as unsupported claims (09 mock 2; the real reviewer is Phase 4). */
  fakeUnsupportedClaims?: string[];
}

/**
 * Replaced by tsup (`define`). In the release bundle it is `false`; in a test build it is the NAME of the
 * environment variable that carries the levers. Because the name only exists in the test build, a release
 * bundle does not contain it at all, and run from source (unit tests) it is undefined, so nothing is read.
 */
declare const __PROSEGATE_TEST__: boolean | string | undefined;

export function parseTestHooks(raw: string | undefined): TestHooks {
  if (raw === undefined || raw === "") return {};
  try {
    const v: unknown = JSON.parse(raw);
    if (typeof v !== "object" || v === null) return {};
    const o = v as Record<string, unknown>;
    const out: TestHooks = {};
    if (typeof o["crash"] === "string") out.crash = o["crash"];
    const claims = o["fakeUnsupportedClaims"];
    if (Array.isArray(claims) && claims.every((c) => typeof c === "string")) out.fakeUnsupportedClaims = claims as string[];
    for (const k of ["delayMs", "budgetMs", "engineBudgetMs", "hardDeadlineMs"] as const) {
      if (typeof o[k] === "number") out[k] = o[k];
    }
    return out;
  } catch {
    return {};
  }
}

/** The one place the environment lever is read. A release bundle never reads it. */
export function testHooksFromEnv(env: Readonly<Record<string, string | undefined>>): TestHooks {
  const name = typeof __PROSEGATE_TEST__ === "string" ? __PROSEGATE_TEST__ : undefined;
  return name === undefined ? {} : parseTestHooks(env[name]);
}

export function homeDir(env: Readonly<Record<string, string | undefined>>): string {
  const override = env["PROSEGATE_HOME"];
  return override !== undefined && override !== "" ? override : join(homedir(), ".prosegate");
}

export function createCtx(over: Partial<Ctx> = {}): Ctx {
  const env = over.env ?? process.env;
  return {
    env,
    home: over.home ?? homeDir(env),
    now: over.now ?? Date.now,
    elapsedMs: over.elapsedMs ?? (() => performance.now()),
    cwd: over.cwd ?? process.cwd(),
    platform: over.platform ?? process.platform,
    stdinIsTTY: over.stdinIsTTY ?? process.stdin.isTTY === true,
    policy: over.policy ?? null,
    synced: over.synced ?? null,
    testHooks: over.testHooks ?? testHooksFromEnv(env),
    debug: over.debug ?? env["PROSEGATE_DEBUG"] === "1",
  };
}

export const SESSIONS_DIR = "sessions";
export const SESSION_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

/** A turn-end past this many milliseconds from process start is not reviewed: the hook cap (05). */
export const REVIEW_CAP_MS = 6000;
/** The hook gives its decision by here, under Claude Code's 10 s Stop timeout (ADR-31). */
export const HARD_DEADLINE_MS = 8000;
/** The engine's production budget (ADR-29): the time left under the review cap, at most this. */
export const ENGINE_BUDGET_MAX_MS = 2000;
/** Local files are read and validated only until here; the rest are skipped and reported. */
export const LOAD_DEADLINE_MS = 3500;

export function hardDeadline(ctx: Ctx): number {
  return ctx.testHooks.hardDeadlineMs ?? HARD_DEADLINE_MS;
}
export function reviewCap(ctx: Ctx): number {
  return ctx.testHooks.budgetMs ?? REVIEW_CAP_MS;
}
/** Milliseconds left before the hard deadline. */
export function msLeft(ctx: Ctx): number {
  return hardDeadline(ctx) - ctx.elapsedMs();
}
/** How long one lock wait may last: what is left under the hard deadline less a 600 ms reserve for the decision, never more than 3 s, never less than 50 ms. */
export function lockWaitMs(ctx: Ctx): number {
  return Math.max(50, Math.min(3000, Math.floor(msLeft(ctx) - 600)));
}
