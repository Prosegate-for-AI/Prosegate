// Owner-only files, atomic writes and a lock file for the session store (07 data flows; ADR-14 / S3).
//
// POSIX: directories 0700, files 0600. Windows: fs.chmod is a no-op there (S3), so the Prosegate home
// root gets an owner-and-SYSTEM-only ACL through icacls (SID read from whoami.exe), with inheritance
// flags so every file and directory created inside inherits it. The ACL is applied to the root
// explicitly and idempotently, a pre-existing root included, and a marker file records that it
// succeeded, so a failed icacls is retried on the next hook (ADR-29).
//
// Hooks are separate processes: a write is "temp file, then rename", and a read-modify-write holds a
// lock file for a few milliseconds. A lock names its owner (pid and a token); a lock whose owner is
// dead, whose mtime is in the future, or that is older than 5 s is broken at once (ADR-30, ADR-31).

import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";

export const FILE_MODE = 0o600;
export const DIR_MODE = 0o700;
/** A lock file with no owner on record is stale after this long. */
export const OWNERLESS_STALE_MS = 1000;
/** Present in the home root once its owner-only ACL was applied successfully (Windows). */
export const ACL_MARKER = ".owner-only-acl";

const WINDOWS_SYSTEM_SID = "S-1-5-18";
let cachedSid: string | undefined;

function systemExe(name: string): string {
  const root = process.env["SystemRoot"] ?? "C:\\Windows";
  return join(root, "System32", name);
}

/** The current user's SID, from whoami.exe (S3 spike). Cached for the process. */
export function currentUserSid(): string {
  if (cachedSid !== undefined) return cachedSid;
  const out = execFileSync(systemExe("whoami.exe"), ["/user", "/fo", "csv", "/nh"], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 5000,
  });
  const sid = out.trim().split(",").pop()?.replace(/"/g, "").trim() ?? "";
  if (!/^S-1-\d+(?:-\d+)+$/.test(sid)) throw new Error("whoami returned no SID");
  cachedSid = sid;
  return sid;
}

/**
 * Windows: removes inherited ACEs from `path` and grants only the current user and SYSTEM full
 * control, inherited by children when `path` is a directory. No-op elsewhere.
 */
export function restrictToOwner(path: string, isDir: boolean, platform: NodeJS.Platform = process.platform): void {
  if (platform !== "win32") return;
  const sid = currentUserSid();
  const flags = isDir ? "(OI)(CI)" : "";
  execFileSync(
    systemExe("icacls.exe"),
    [path, "/inheritance:r", "/grant:r", `*${sid}:${flags}F`, `*${WINDOWS_SYSTEM_SID}:${flags}F`],
    { encoding: "utf8", windowsHide: true, timeout: 10_000, stdio: ["ignore", "pipe", "pipe"] },
  );
}

const restrictedThisProcess = new Set<string>();

/**
 * Makes the Prosegate home root owner-only on Windows, once: creates it if needed, applies the ACL
 * (also to a root that already existed with inherited permissions), then writes the marker. If icacls
 * fails the marker is not written and the error propagates, so the next hook tries again. `restrict`
 * is a seam for tests. A no-op off Windows.
 */
export function ensureHomeRestricted(
  home: string,
  platform: NodeJS.Platform = process.platform,
  restrict: (path: string, isDir: boolean, platform: NodeJS.Platform) => void = restrictToOwner,
): void {
  mkdirSync(home, { recursive: true, mode: DIR_MODE });
  if (platform !== "win32") return;
  const key = `${platform}:${home}`;
  if (restrictedThisProcess.has(key)) return;
  const marker = join(home, ACL_MARKER);
  if (!existsSync(marker)) {
    restrict(home, true, platform);
    writeFileSync(marker, "owner-only ACL applied\n");
  }
  restrictedThisProcess.add(key);
}

export function resetRestrictedCache(): void {
  restrictedThisProcess.clear();
}

/**
 * Creates `path` (and parents) as an owner-only directory under `home`. On Windows the home root is
 * restricted first, and a directory created inside inherits that ACL, so no icacls spawn happens
 * per directory.
 */
export function ensureDirIn(home: string, path: string, platform: NodeJS.Platform = process.platform): void {
  ensureHomeRestricted(home, platform);
  mkdirSync(path, { recursive: true, mode: DIR_MODE });
}

const TRANSIENT = new Set(["EPERM", "EBUSY", "EACCES"]);

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error ? String((error as { code: unknown }).code) : undefined;
}

let sleepCell: Int32Array | undefined;
/** Blocks this thread for `ms` (hooks are short-lived and synchronous). */
export function sleepSync(ms: number): void {
  sleepCell ??= new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(sleepCell, 0, 0, Math.max(1, Math.floor(ms)));
}

/** Writes `data` to a temp file in the same directory, then renames it over `path`. */
export function writeFileAtomic(path: string, data: string): void {
  const tmp = `${path}.${process.pid}.${Math.random().toString(16).slice(2, 10)}.tmp`;
  writeFileSync(tmp, data, { mode: FILE_MODE });
  let lastError: unknown;
  for (let attempt = 0; attempt < 12; attempt++) {
    try {
      renameSync(tmp, path);
      return;
    } catch (error) {
      lastError = error;
      // Windows reports EPERM/EBUSY while another process has the target open at that instant.
      if (!TRANSIENT.has(errorCode(error) ?? "")) break;
      sleepSync(5 + attempt * 5);
    }
  }
  try {
    unlinkSync(tmp);
  } catch {
    // The temp file may already be gone.
  }
  throw lastError;
}

/** Removes `*.tmp` files older than `minAgeMs` in `dir` (a kill between the write and the rename leaves one behind). */
export function sweepTempFiles(dir: string, nowMs: number, minAgeMs = 10_000): number {
  let removed = 0;
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return 0;
  }
  for (const name of names) {
    if (!name.endsWith(".tmp")) continue;
    const path = join(dir, name);
    try {
      if (nowMs - statSync(path).mtimeMs >= minAgeMs) {
        unlinkSync(path);
        removed++;
      }
    } catch {
      // gone already, or in use
    }
  }
  return removed;
}

export function readFileOrNull(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    if (errorCode(error) === "ENOENT") return null;
    throw error;
  }
}

export class LockTimeoutError extends Error {
  override readonly name = "LockTimeoutError";
}

export interface LockOptions {
  /** Give up after this long (default 3 s). */
  timeoutMs?: number;
  /** A lock file older than this belongs to a crashed process (default 5 s). */
  staleMs?: number;
}

interface LockOwner {
  pid: number;
  token: string;
  /** Epoch ms the owner started waiting-free: when it took the lock. */
  at: number;
}

function parseOwner(text: string | null): LockOwner | null {
  if (text === null) return null;
  try {
    const v = JSON.parse(text) as Partial<LockOwner>;
    if (typeof v.pid === "number" && typeof v.token === "string") return { pid: v.pid, token: v.token, at: typeof v.at === "number" ? v.at : 0 };
  } catch {
    // an empty or foreign file: judged by its age alone
  }
  return null;
}

/** Whether a process with this pid exists. EPERM means it exists but is not ours. */
export function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) === "EPERM";
  }
}

function tryRead(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/**
 * Why `lockPath` is stale, or null if its holder may still be working: the owner is dead, the mtime
 * is in the future (a planted lock), or the file is older than `staleMs`.
 */
function staleReason(lockPath: string, staleMs: number): { reason: string; text: string | null } | null {
  let mtime: number;
  try {
    mtime = statSync(lockPath).mtimeMs;
  } catch {
    return null; // released between our open and our stat
  }
  const text = tryRead(lockPath);
  const owner = parseOwner(text);
  const now = Date.now();
  if (mtime - now > 1000) return { reason: "future", text };
  if (owner !== null && owner.pid !== process.pid && !processAlive(owner.pid)) return { reason: "owner-dead", text };
  // A lock with no readable owner is either being created right now (the window between open and write is
  // microseconds) or was left by a process killed inside that window: waiting 5 s for it helps nobody.
  const limit = owner === null ? Math.min(staleMs, OWNERLESS_STALE_MS) : staleMs;
  if (now - mtime > limit) return { reason: "old", text };
  return null;
}

/**
 * Removes a stale lock without two contenders both believing they removed it: the file is renamed
 * to a name only this process uses (rename is atomic, so one contender wins), then deleted. If the
 * renamed file turns out to be a different, live lock than the one judged stale, it is put back.
 */
function breakLock(lockPath: string, judged: string | null): void {
  const mine = `${lockPath}.stale.${process.pid}.${Math.random().toString(16).slice(2, 8)}`;
  try {
    renameSync(lockPath, mine);
  } catch {
    return; // someone else broke it, or it was released
  }
  const taken = tryRead(mine);
  if (judged !== null && taken !== null && taken !== judged && parseOwner(taken) !== null) {
    // We took a fresh lock someone created after our judgement: give it back if the name is free.
    try {
      if (!existsSync(lockPath)) renameSync(mine, lockPath);
      else unlinkSync(mine);
    } catch {
      // nothing more to do
    }
    return;
  }
  try {
    unlinkSync(mine);
  } catch {
    // already gone
  }
}

/**
 * Runs `fn` holding an exclusive lock file. The lock is created with O_EXCL and records its owner;
 * contenders retry with a short jittered sleep and break a stale lock (see staleReason). A holder
 * deletes the lock only if it still owns it.
 */
export function withLock<T>(lockPath: string, fn: () => T, opts: LockOptions = {}): T {
  const timeoutMs = opts.timeoutMs ?? 3000;
  const staleMs = opts.staleMs ?? 5000;
  const deadline = Date.now() + timeoutMs;
  const token = `${process.pid}-${Math.random().toString(16).slice(2, 12)}`;
  for (;;) {
    try {
      const fd = openSync(lockPath, "wx", FILE_MODE);
      try {
        writeSync(fd, JSON.stringify({ pid: process.pid, token, at: Date.now() } satisfies LockOwner));
      } finally {
        closeSync(fd);
      }
      break;
    } catch (error) {
      const code = errorCode(error);
      if (code !== "EEXIST" && !TRANSIENT.has(code ?? "")) throw error;
      const stale = staleReason(lockPath, staleMs);
      if (stale !== null) {
        breakLock(lockPath, stale.text);
        continue;
      }
      if (Date.now() > deadline) throw new LockTimeoutError(`lock ${lockPath} not acquired within ${timeoutMs} ms`);
      sleepSync(3 + Math.random() * 12);
    }
  }
  try {
    return fn();
  } finally {
    const owner = parseOwner(tryRead(lockPath));
    // Delete only a lock we still own: after a long stall a contender may have broken ours and taken its own.
    if (owner === null || owner.token === token) {
      try {
        unlinkSync(lockPath);
      } catch {
        // already removed
      }
    }
  }
}

/** Appends to a file created owner-only (a new file gets mode 0600; Windows files inherit the root ACL). */
export function appendLine(path: string, line: string): void {
  appendFileSync(path, line, { mode: FILE_MODE });
}

export function removeTree(path: string): void {
  rmSync(path, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
}
