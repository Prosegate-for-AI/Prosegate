// Owner-only files, atomic writes and a lock file for the session store (07 data flows; ADR-14 / S3).
//
// POSIX: directories 0700, files 0600. Windows: fs.chmod is a no-op there (S3), so a directory the
// adapter creates gets an owner-and-SYSTEM-only ACL through icacls (SID read from whoami.exe, never
// from the environment), with inheritance flags so every file created inside it inherits the ACL.
// Hooks are separate processes: a write is "temp file, then rename", and a read-modify-write holds a
// lock file for a few milliseconds.

import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
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

/**
 * Creates `path` (and parents) as an owner-only directory. Windows: when this call created a
 * directory, its topmost new directory gets the owner-only ACL, which its children inherit.
 */
export function ensureDir(path: string, platform: NodeJS.Platform = process.platform): void {
  const created = mkdirSync(path, { recursive: true, mode: DIR_MODE });
  if (created !== undefined && platform === "win32") restrictToOwner(created, true, platform);
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

/**
 * Runs `fn` holding an exclusive lock file. The lock is created with O_EXCL; contenders retry with a
 * short jittered sleep. A lock file older than `staleMs` is removed (its holder crashed).
 */
export function withLock<T>(lockPath: string, fn: () => T, opts: LockOptions = {}): T {
  const timeoutMs = opts.timeoutMs ?? 3000;
  const staleMs = opts.staleMs ?? 5000;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const fd = openSync(lockPath, "wx", FILE_MODE);
      try {
        writeSync(fd, String(process.pid));
      } finally {
        closeSync(fd);
      }
      break;
    } catch (error) {
      const code = errorCode(error);
      if (code !== "EEXIST" && !TRANSIENT.has(code ?? "")) throw error;
      try {
        if (Date.now() - statSync(lockPath).mtimeMs > staleMs) {
          unlinkSync(lockPath);
          continue;
        }
      } catch {
        // The holder released it between our open and our stat: just retry.
      }
      if (Date.now() > deadline) throw new LockTimeoutError(`lock ${lockPath} not acquired within ${timeoutMs} ms`);
      sleepSync(3 + Math.random() * 12);
    }
  }
  try {
    return fn();
  } finally {
    try {
      unlinkSync(lockPath);
    } catch {
      // Already removed as stale by a contender; nothing to release.
    }
  }
}

/** Appends to a file created owner-only (a new file gets mode 0600; Windows files inherit the directory ACL). */
export function appendLine(path: string, line: string): void {
  appendFileSync(path, line, { mode: FILE_MODE });
}

export function removeTree(path: string): void {
  rmSync(path, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
}

