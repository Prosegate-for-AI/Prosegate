// The session store: ~/.prosegate/sessions/<session_id>/ (05, 07, ADR-19).
//
//   state.json    mode, profile selection, pass counts by turn, once-per-session notice flags
//   profile.json  the resolved snapshot as a CACHE; nothing reads policy or `required` from it
//   turn.json     the current user message and turn id
//   report.json   headless only
//   debug/        --debug only
//
// Every write is atomic (temp + rename). A read-modify-write of state.json holds state.lock for a few
// milliseconds, so a turn-end and a mode command racing in two processes cannot lose each other's
// field: each applies its own change to the freshest copy.

import { createHash } from "node:crypto";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { serializeSnapshot, type ResolvedProfile } from "@prosegate/profiles";
import { SESSIONS_DIR, SESSION_ID_RE, type Ctx } from "./ctx.js";
import { ensureDir, readFileOrNull, removeTree, withLock, writeFileAtomic } from "./fs-secure.js";
import { log } from "./log.js";
import {
  CwdProfilesSchema,
  ProfileVersionsSchema,
  ReportFileSchema,
  StateSchema,
  TurnFileSchema,
  type CwdProfiles,
  type ProfileVersions,
  type ReportFile,
  type SessionState,
  type TurnFile,
  type TurnReport,
} from "./schemas.js";

/** Sessions idle for longer than this are deleted at the next session-start (07 retention; see decision note in the report). */
export const SESSION_RETENTION_MS = 24 * 60 * 60 * 1000;
const MAX_TURNS_KEPT = 20;
const MAX_REPORT_TURNS = 100;
const MAX_CWD_ENTRIES = 200;
const MAX_VERSION_ENTRIES = 50;

/** The key a turn id is stored under: 16 hex of its sha256, so a hostile id cannot become a path or a prototype key. */
export function turnKey(turnId: string): string {
  return createHash("sha256").update(turnId).digest("hex").slice(0, 16);
}

/** 05: the shim's id, else sha256(session_id + user message). */
export function deriveTurnId(sessionId: string, userMessage: string): string {
  return createHash("sha256").update(sessionId).update(userMessage).digest("hex");
}

export function sessionDir(ctx: Ctx, sessionId: string): string {
  if (!SESSION_ID_RE.test(sessionId)) throw new Error("invalid session id");
  return join(ctx.home, SESSIONS_DIR, sessionId);
}

export function defaultState(ctx: Ctx, init: { session_id: string; harness: string; cwd: string; context_mode: "interactive" | "headless"; active_profile: string }): SessionState {
  const now = ctx.now();
  return {
    v: 1,
    session_id: init.session_id,
    harness: init.harness,
    cwd: init.cwd,
    context_mode: init.context_mode,
    mode: null,
    active_profile: init.active_profile,
    previous_profile: null,
    candidate: null,
    candidate_streak: 0,
    turns: {},
    first_notice_shown: false,
    overlays_notice_shown: false,
    resolution_notice_shown: false,
    last_seen_profile_version: null,
    created_at: now,
    updated_at: now,
  };
}

export class SessionStore {
  readonly dir: string;
  constructor(
    private readonly ctx: Ctx,
    readonly sessionId: string,
  ) {
    this.dir = sessionDir(ctx, sessionId);
  }

  private path(name: string): string {
    return join(this.dir, name);
  }

  ensure(): void {
    ensureDir(this.dir, this.ctx.platform);
  }

  exists(): boolean {
    return readFileOrNull(this.path("state.json")) !== null;
  }

  /** The stored state, or null when missing or unreadable (a corrupt file is logged and treated as absent). */
  readState(): SessionState | null {
    const text = readFileOrNull(this.path("state.json"));
    if (text === null) return null;
    try {
      const parsed = StateSchema.safeParse(JSON.parse(text));
      if (parsed.success && parsed.data.session_id === this.sessionId) return parsed.data;
    } catch {
      // fall through to the corrupt-file path
    }
    log(this.ctx, "warn", "state_corrupt", "state.json did not parse; starting from defaults");
    return null;
  }

  /**
   * Applies `change` to the freshest state under the lock and writes the result. `fallback` builds the
   * state when none exists (first call, or a corrupt file).
   */
  updateState(fallback: () => SessionState, change: (state: SessionState) => SessionState): SessionState {
    this.ensure();
    return withLock(this.path("state.lock"), () => {
      const current = this.readState() ?? fallback();
      const next = change(current);
      const stamped = { ...next, updated_at: this.ctx.now() };
      // Keep the turns map bounded: the newest MAX_TURNS_KEPT by update time.
      const entries = Object.entries(stamped.turns);
      if (entries.length > MAX_TURNS_KEPT) {
        entries.sort((a, b) => b[1].updated_at - a[1].updated_at);
        stamped.turns = Object.fromEntries(entries.slice(0, MAX_TURNS_KEPT));
      }
      writeFileAtomic(this.path("state.json"), `${JSON.stringify(stamped, null, 2)}\n`);
      return stamped;
    });
  }

  readTurn(): TurnFile | null {
    const text = readFileOrNull(this.path("turn.json"));
    if (text === null) return null;
    try {
      const parsed = TurnFileSchema.safeParse(JSON.parse(text));
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }

  writeTurn(turn: TurnFile): void {
    this.ensure();
    writeFileAtomic(this.path("turn.json"), `${JSON.stringify(turn)}\n`);
  }

  /** A cache of the snapshot the session resolved (04). Never read back as policy (ADR-19). */
  writeProfileCache(snapshot: ResolvedProfile): void {
    this.ensure();
    writeFileAtomic(this.path("profile.json"), serializeSnapshot(snapshot));
  }

  readReport(): ReportFile {
    const text = readFileOrNull(this.path("report.json"));
    if (text !== null) {
      try {
        const parsed = ReportFileSchema.safeParse(JSON.parse(text));
        if (parsed.success) return parsed.data;
      } catch {
        // start a fresh report
      }
    }
    return { schema: "prosegate.report/1", session_id: this.sessionId, turns: [] };
  }

  /** Headless: records or replaces the entry for this turn. */
  upsertReport(entry: TurnReport): ReportFile {
    this.ensure();
    return withLock(this.path("report.lock"), () => {
      const report = this.readReport();
      const turns = report.turns.filter((t) => t.turn !== entry.turn);
      turns.push(entry);
      const next: ReportFile = { ...report, turns: turns.slice(-MAX_REPORT_TURNS) };
      writeFileAtomic(this.path("report.json"), `${JSON.stringify(next, null, 2)}\n`);
      return next;
    });
  }

  /** --debug (07): the turn text, written locally, with a warning printed by the caller. */
  writeDebug(name: string, data: unknown): string {
    const dir = this.path("debug");
    ensureDir(dir, this.ctx.platform);
    const file = join(dir, `${name}.json`);
    writeFileAtomic(file, `${JSON.stringify(data, null, 2)}\n`);
    return dir;
  }
}

// ---- session discovery and retention ------------------------------------------------------------

function newestMtime(dir: string): number {
  let newest = statSync(dir).mtimeMs;
  for (const name of readdirSync(dir)) {
    try {
      newest = Math.max(newest, statSync(join(dir, name)).mtimeMs);
    } catch {
      // a file vanished mid-scan
    }
  }
  return newest;
}

/** Session ids on disk, with their last-activity time. */
export function listSessions(ctx: Ctx): Array<{ id: string; dir: string; lastActive: number }> {
  const root = join(ctx.home, SESSIONS_DIR);
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return [];
  }
  const out: Array<{ id: string; dir: string; lastActive: number }> = [];
  for (const id of names) {
    if (!SESSION_ID_RE.test(id)) continue;
    const dir = join(root, id);
    try {
      out.push({ id, dir, lastActive: newestMtime(dir) });
    } catch {
      // not a directory, or gone
    }
  }
  return out;
}

/**
 * 07 retention. Deletes every session directory other than `keepId` that has been idle for longer
 * than the retention window. Returns the deleted ids. Never throws.
 */
export function sweepSessions(ctx: Ctx, keepId: string, retentionMs: number = SESSION_RETENTION_MS): string[] {
  const deleted: string[] = [];
  try {
    const cutoff = ctx.now() - retentionMs;
    for (const s of listSessions(ctx)) {
      if (s.id === keepId || s.lastActive >= cutoff) continue;
      try {
        removeTree(s.dir);
        deleted.push(s.id);
      } catch {
        log(ctx, "warn", "retention_failed", "could not delete an old session directory");
      }
    }
  } catch {
    log(ctx, "warn", "retention_failed", "session sweep failed");
  }
  return deleted;
}

export function normaliseCwd(ctx: Ctx, cwd: string): string {
  const cleaned = cwd.replace(/[\\/]+$/, "");
  return ctx.platform === "win32" ? cleaned.toLowerCase().replace(/\//g, "\\") : cleaned;
}

/**
 * The session a command acts on: PROSEGATE_SESSION, else the most recently active session whose cwd
 * matches the command's working directory.
 */
export function findSession(ctx: Ctx): SessionStore | null {
  const named = ctx.env["PROSEGATE_SESSION"];
  if (named !== undefined && named !== "") {
    if (!SESSION_ID_RE.test(named)) return null;
    const store = new SessionStore(ctx, named);
    return store.exists() ? store : null;
  }
  const want = normaliseCwd(ctx, ctx.cwd);
  let best: { store: SessionStore; at: number } | null = null;
  for (const s of listSessions(ctx)) {
    const store = new SessionStore(ctx, s.id);
    const state = store.readState();
    if (state === null || normaliseCwd(ctx, state.cwd) !== want) continue;
    if (best === null || state.updated_at > best.at) best = { store, at: state.updated_at };
  }
  return best?.store ?? null;
}

// ---- small cross-session files ------------------------------------------------------------------

function readJson<T>(path: string, schema: { safeParse(v: unknown): { success: true; data: T } | { success: false } }, empty: T): T {
  const text = readFileOrNull(path);
  if (text === null) return empty;
  try {
    const parsed = schema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : empty;
  } catch {
    return empty;
  }
}

export function readCwdProfiles(ctx: Ctx): CwdProfiles {
  return readJson(join(ctx.home, "cwd-profiles.json"), CwdProfilesSchema, {});
}

export function rememberCwdProfile(ctx: Ctx, cwd: string, profile: string): void {
  ensureDir(ctx.home, ctx.platform);
  const file = join(ctx.home, "cwd-profiles.json");
  withLock(`${file}.lock`, () => {
    const map = readCwdProfiles(ctx);
    map[normaliseCwd(ctx, cwd)] = { profile, ts: ctx.now() };
    const entries = Object.entries(map).sort((a, b) => b[1].ts - a[1].ts).slice(0, MAX_CWD_ENTRIES);
    writeFileAtomic(file, `${JSON.stringify(Object.fromEntries(entries), null, 2)}\n`);
  });
}

export function readProfileVersions(ctx: Ctx): ProfileVersions {
  return readJson(join(ctx.home, "profile-versions.json"), ProfileVersionsSchema, {});
}

export function rememberProfileVersion(ctx: Ctx, profile: string, version: string, summary: Record<string, string>): void {
  ensureDir(ctx.home, ctx.platform);
  const file = join(ctx.home, "profile-versions.json");
  withLock(`${file}.lock`, () => {
    // Most recently seen last; the oldest entries fall off the front.
    const kept = Object.entries(readProfileVersions(ctx)).filter(([id]) => id !== profile);
    kept.push([profile, { version, summary }]);
    writeFileAtomic(file, `${JSON.stringify(Object.fromEntries(kept.slice(-MAX_VERSION_ENTRIES)), null, 2)}\n`);
  });
}
