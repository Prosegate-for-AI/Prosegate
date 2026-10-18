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
  /** Milliseconds since this process started (performance.now()); the 6 s turn-end budget counts from here. */
  elapsedMs: () => number;
  cwd: string;
  platform: NodeJS.Platform;
  /** True when stdin is a terminal; the agent-context check (ADR-27) needs it. */
  stdinIsTTY: boolean;
  /** The verified org policy of the account. None exists in the free tier (Phase 7 supplies it). */
  policy: OrgPolicyInput | null;
  /** Verified synced profiles and packs from the config client (Phase 7). Null in the free tier. */
  synced: ResolutionSources | null;
  /** Test-only fault injection (PROSEGATE_TEST_HOOKS). */
  testHooks: TestHooks;
  /** --debug or PROSEGATE_DEBUG=1 (07: writes the turn text to the session's debug directory). */
  debug: boolean;
}

export interface TestHooks {
  /** Throw inside this stage ("session-start" | "turn-start" | "turn-end"). */
  crash?: string;
  /** Busy-wait this long before the review (milliseconds). */
  delayMs?: number;
  /** Override of the 6 s turn-end wall budget. */
  budgetMs?: number;
  /** Override of the engine's own 200 ms review budget. */
  engineBudgetMs?: number;
}

export function parseTestHooks(raw: string | undefined): TestHooks {
  if (raw === undefined || raw === "") return {};
  try {
    const v: unknown = JSON.parse(raw);
    if (typeof v !== "object" || v === null) return {};
    const o = v as Record<string, unknown>;
    const out: TestHooks = {};
    if (typeof o["crash"] === "string") out.crash = o["crash"];
    if (typeof o["delayMs"] === "number") out.delayMs = o["delayMs"];
    if (typeof o["budgetMs"] === "number") out.budgetMs = o["budgetMs"];
    if (typeof o["engineBudgetMs"] === "number") out.engineBudgetMs = o["engineBudgetMs"];
    return out;
  } catch {
    return {};
  }
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
    testHooks: over.testHooks ?? parseTestHooks(env["PROSEGATE_TEST_HOOKS"]),
    debug: over.debug ?? env["PROSEGATE_DEBUG"] === "1",
  };
}

export const SESSIONS_DIR = "sessions";
export const SESSION_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
