import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { LockTimeoutError, sleepSync, withLock, writeFileAtomic } from "../src/fs-secure.js";
import { sessionStart } from "../src/hooks.js";
import { StateSchema } from "../src/schemas.js";
import { ADAPTER_DIR, SESSION, TIC_TEXT, buildBundle, json, pg, pgAsync, sessionStartInput, testCtx, tmpDir, turnEndInput } from "./helpers.js";

// Hooks are separate processes. These tests pin the lock rules deterministically (ADR-30, ADR-31): who may
// break a lock, that a holder deletes only its own, that a planted lock cannot disable enforcement or
// telemetry, and that two processes cannot lose each other's update. The old race test ran a turn-end
// against a command and passed 4 of 4 with the lock removed; nothing below depends on luck.

vi.setConfig({ testTimeout: 180_000 });

let bundle = "";
beforeAll(async () => {
  bundle = await buildBundle();
}, 120_000);

function sleeper(): { child: ChildProcess; pid: number } {
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 120000)"], { stdio: "ignore" });
  return { child, pid: child.pid as number };
}

async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ["-e", "0"], { stdio: "ignore" });
  const pid = child.pid as number;
  await new Promise((resolve) => child.on("close", resolve));
  return pid;
}

function plant(path: string, content: string, mtimeMs: number): void {
  writeFileSync(path, content);
  const when = new Date(mtimeMs);
  utimesSync(path, when, when);
}
const owned = (pid: number, token = "planted") => JSON.stringify({ pid, token, at: Date.now() });

describe("withLock: who may break a lock", () => {
  it("a lock whose owner is dead is broken at once, however fresh it is", async () => {
    const dir = tmpDir();
    const lock = join(dir, "x.lock");
    plant(lock, owned(await deadPid()), Date.now());
    const t0 = performance.now();
    expect(withLock(lock, () => "ran", { timeoutMs: 3000 })).toBe("ran");
    expect(performance.now() - t0).toBeLessThan(1000);
  });

  it("a lock whose owner is alive is not broken while it is fresh, and is the moment the owner dies", async () => {
    const dir = tmpDir();
    const lock = join(dir, "x.lock");
    const { child, pid } = sleeper();
    plant(lock, owned(pid), Date.now());
    expect(() => withLock(lock, () => 1, { timeoutMs: 400 })).toThrow(LockTimeoutError);
    expect(existsSync(lock)).toBe(true);
    child.kill();
    await new Promise((resolve) => child.on("close", resolve));
    const t0 = performance.now();
    expect(withLock(lock, () => "ran", { timeoutMs: 3000 })).toBe("ran");
    expect(performance.now() - t0).toBeLessThan(1000);
  });

  it("a lock dated in the future is broken at once, even with a live owner (a planted lock)", () => {
    const dir = tmpDir();
    const lock = join(dir, "x.lock");
    const { child, pid } = sleeper();
    try {
      plant(lock, owned(pid), Date.now() + 365 * 24 * 3600_000);
      const t0 = performance.now();
      expect(withLock(lock, () => "ran", { timeoutMs: 3000 })).toBe("ran");
      expect(performance.now() - t0).toBeLessThan(1000);
    } finally {
      child.kill();
    }
  });

  it("a lock with a live owner is waited on for 5 s and broken after: 4 s old is waited on, 6 s old is broken (the default)", () => {
    const dir = tmpDir();
    const lock = join(dir, "x.lock");
    const { child, pid } = sleeper();
    try {
      plant(lock, owned(pid), Date.now() - 4000);
      expect(() => withLock(lock, () => 1, { timeoutMs: 300 })).toThrow(LockTimeoutError);
      plant(lock, owned(pid), Date.now() - 6000);
      expect(withLock(lock, () => "ran", { timeoutMs: 3000 })).toBe("ran");
    } finally {
      child.kill();
    }
  });

  it("a lock with no owner on record (a holder killed between open and write) is stale after 1 s", () => {
    const dir = tmpDir();
    const lock = join(dir, "x.lock");
    plant(lock, "", Date.now() - 500);
    expect(() => withLock(lock, () => 1, { timeoutMs: 300 })).toThrow(LockTimeoutError);
    plant(lock, "", Date.now() - 1500);
    const t0 = performance.now();
    expect(withLock(lock, () => "ran", { timeoutMs: 3000 })).toBe("ran");
    expect(performance.now() - t0).toBeLessThan(1000);
    plant(lock, "not json", Date.now() - 1500);
    expect(withLock(lock, () => "ran", { timeoutMs: 3000 })).toBe("ran");
  });

  it("a holder deletes only a lock it still owns", () => {
    const dir = tmpDir();
    const lock = join(dir, "x.lock");
    withLock(lock, () => {
      // Another process broke ours and took its own while we stalled.
      writeFileSync(lock, owned(process.pid + 100_000, "the-thief"));
    });
    expect(readFileSync(lock, "utf8")).toContain("the-thief");
    // And its own lock is removed as usual.
    const mine = join(dir, "y.lock");
    withLock(mine, () => undefined);
    expect(existsSync(mine)).toBe(false);
  });
});

describe("planted locks in real hooks (release bundle)", () => {
  it("a future-dated state.lock does not disable enforcement: the turn is reviewed and continued, promptly", () => {
    const home = tmpDir();
    pg(bundle, ["session-start"], { home, input: sessionStartInput() });
    const lock = join(home, "sessions", SESSION, "state.lock");
    plant(lock, "1", Date.now() + 365 * 24 * 3600_000);
    const t0 = performance.now();
    const r = pg(bundle, ["turn-end"], { home, input: turnEndInput(TIC_TEXT) });
    expect(r.code).toBe(0);
    expect(json<{ decision: string }>(r).decision).toBe("continue");
    expect(performance.now() - t0).toBeLessThan(4500);
    expect(existsSync(lock)).toBe(false);
  });

  it("a future-dated spool lock does not suppress telemetry (override_used reaches the spool)", () => {
    const home = tmpDir();
    pg(bundle, ["session-start"], { home, input: sessionStartInput() });
    const lock = join(home, "telemetry", "spool.jsonl.lock");
    plant(lock, "1", Date.now() + 365 * 24 * 3600_000);
    const before = readFileSync(join(home, "telemetry", "spool.jsonl"), "utf8").split("\n").filter(Boolean).length;
    expect(pg(bundle, ["advisory"], { home, env: { PROSEGATE_SESSION: SESSION } }).code).toBe(0);
    const lines = readFileSync(join(home, "telemetry", "spool.jsonl"), "utf8").split("\n").filter(Boolean);
    expect(lines.length).toBe(before + 1);
    expect(lines.at(-1)).toContain('"override_used":true');
  });

  it("a spool lock that stays held does not drop the event either: it is appended without the lock", () => {
    const home = tmpDir();
    pg(bundle, ["session-start"], { home, input: sessionStartInput() });
    // A live owner (this very test process) with a fresh mtime: not stale by any rule.
    const lock = join(home, "telemetry", "spool.jsonl.lock");
    plant(lock, owned(process.pid), Date.now());
    expect(pg(bundle, ["advisory"], { home, env: { PROSEGATE_SESSION: SESSION } }).code).toBe(0);
    const lines = readFileSync(join(home, "telemetry", "spool.jsonl"), "utf8").split("\n").filter(Boolean);
    expect(lines.at(-1)).toContain('"override_used":true');
    expect(readFileSync(join(home, "logs", `${new Date().toISOString().slice(0, 10)}.log`), "utf8")).toContain("telemetry_lock_skipped");
  });

  it("a killed holder's lock is broken at once, not after 5 s", async () => {
    const home = tmpDir();
    pg(bundle, ["session-start"], { home, input: sessionStartInput() });
    const lock = join(home, "sessions", SESSION, "state.lock");
    plant(lock, owned(await deadPid()), Date.now());
    const t0 = performance.now();
    const r = pg(bundle, ["quiet"], { home, env: { PROSEGATE_SESSION: SESSION } });
    expect(r.code).toBe(0);
    expect(performance.now() - t0).toBeLessThan(2500);
    expect((JSON.parse(readFileSync(join(home, "sessions", SESSION, "state.json"), "utf8")) as { mode: string }).mode).toBe("quiet");
  });

  it("the hook decides within 8 s even when every lock is held for as long as it waits (the 13.5 s scenario)", async () => {
    const home = tmpDir();
    pg(bundle, ["session-start"], { home, input: sessionStartInput() });
    const locks = {
      state: join(home, "sessions", SESSION, "state.lock"),
      report: join(home, "sessions", SESSION, "report.lock"),
      spool: join(home, "telemetry", "spool.jsonl.lock"),
    };
    // Each lock is kept alive (fresh mtime, a live owner) until its release time; the spool lock is never released.
    const releaseAt: Record<keyof typeof locks, number> = { state: 7500, report: 10000, spool: Infinity };
    const t0 = performance.now();
    const keep = (): void => {
      const elapsed = performance.now() - t0;
      for (const k of Object.keys(locks) as Array<keyof typeof locks>) {
        try {
          if (elapsed < releaseAt[k]) plant(locks[k], owned(process.pid, k), Date.now());
          else rmSync(locks[k], { force: true });
        } catch {
          // a hook broke it under us
        }
      }
    };
    keep();
    const tick = setInterval(keep, 100);
    // The original trouble: stdin arrived at 4.5 s (a slow shim), then three lock waits of 3 s each ran one after the other (13.5 s).
    const child = spawn(process.execPath, [bundle, "turn-end"], {
      env: { ...process.env, PROSEGATE_HOME: home, PROSEGATE_MODE: "headless" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (d: Buffer) => (out += d.toString()));
    const closed = new Promise<number | null>((resolve) => child.on("close", resolve));
    setTimeout(() => child.stdin.end(JSON.stringify(turnEndInput(TIC_TEXT))), 4500);
    const code = await closed;
    clearInterval(tick);
    const wall = performance.now() - t0;
    // One deadline from process start: the hook answers (continue, or a fail-open exit 1) before 8 s, whatever the locks do.
    expect(wall).toBeLessThan(8500);
    expect([0, 1]).toContain(code);
    if (code === 0) expect((JSON.parse(out) as { decision: string }).decision).toBe("continue");
    else expect(out).toBe("");
  });
});

describe("deterministic concurrency", () => {
  it("(a) a command waits for a lock the test holds, then applies on top of the change the holder made", async () => {
    const home = tmpDir();
    const ctx = testCtx(home, { elapsedMs: () => 0 });
    sessionStart({ harness: "claude-code", session_id: SESSION, cwd: "/work/project", mode: "interactive" }, ctx);
    const stateFile = join(home, "sessions", SESSION, "state.json");
    const lock = join(home, "sessions", SESSION, "state.lock");
    let appliedWhileHeld = false;
    let child: ReturnType<typeof pgAsync> | undefined;
    withLock(lock, () => {
      child = pgAsync(bundle, ["quiet"], { home, env: { PROSEGATE_SESSION: SESSION } });
      // Hold for 2 s; the command starts, tries the lock and waits. If it applied its change anyway, the lock is not a lock.
      const until = performance.now() + 2000;
      while (performance.now() < until) {
        sleepSync(100);
        if ((JSON.parse(readFileSync(stateFile, "utf8")) as { mode: string | null }).mode === "quiet") appliedWhileHeld = true;
      }
      // The holder's own change, made while the command waits.
      const state = JSON.parse(readFileSync(stateFile, "utf8")) as Record<string, unknown>;
      writeFileAtomic(stateFile, `${JSON.stringify({ ...state, first_notice_shown: true }, null, 2)}\n`);
    });
    const r = await (child as ReturnType<typeof pgAsync>);
    expect(r.code, r.stderr).toBe(0);
    expect(appliedWhileHeld).toBe(false);
    const final = StateSchema.parse(JSON.parse(readFileSync(stateFile, "utf8")));
    expect(final.mode).toBe("quiet"); // the command's change landed
    expect(final.first_notice_shown).toBe(true); // and the holder's was not overwritten
  });

  it("(b) two worker processes each do 200 read-modify-write increments: none is lost", async () => {
    const home = tmpDir();
    sessionStart({ harness: "claude-code", session_id: SESSION, cwd: "/work/project", mode: "interactive" }, testCtx(home, { elapsedMs: () => 0 }));
    const worker = join(ADAPTER_DIR, "test", "lock-worker.ts");
    const run = (): Promise<{ code: number | null; out: string; err: string }> =>
      new Promise((resolve) => {
        const c = spawn(process.execPath, ["--import", "tsx", worker, home, SESSION, "200"], { cwd: ADAPTER_DIR, stdio: ["ignore", "pipe", "pipe"] });
        let out = "";
        let err = "";
        c.stdout.on("data", (d: Buffer) => (out += d.toString()));
        c.stderr.on("data", (d: Buffer) => (err += d.toString()));
        c.on("close", (code) => resolve({ code, out, err }));
      });
    const [a, b] = await Promise.all([run(), run()]);
    expect([a.code, b.code], `${a.err}${b.err}`).toEqual([0, 0]);
    expect(a.out + b.out).toBe("done\ndone\n");
    const state = StateSchema.parse(JSON.parse(readFileSync(join(home, "sessions", SESSION, "state.json"), "utf8")));
    expect(state.candidate_streak).toBe(400);
  });

  it("a reader never sees a torn state.json while a writer rewrites a large one (the write is atomic)", async () => {
    const dir = tmpDir();
    const file = join(dir, "state.json");
    const big = (n: number): string => JSON.stringify({ n, pad: "x".repeat(400_000) });
    writeFileAtomic(file, big(0));
    const reader = [
      "const fs = require('fs'); const f = process.argv[1]; const end = Date.now() + Number(process.argv[2]);",
      "const cell = new Int32Array(new SharedArrayBuffer(4)); let reads = 0; let bad = 0;",
      "while (Date.now() < end) { let t; try { t = fs.readFileSync(f, 'utf8'); } catch (e) { continue; }",
      "  reads++; try { JSON.parse(t); } catch (e) { bad++; } Atomics.wait(cell, 0, 0, 1); }",
      "console.log(JSON.stringify({ reads, bad }));",
    ].join("\n");
    const child = spawn(process.execPath, ["-e", reader, file, "2500"], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d: Buffer) => (out += d.toString()));
    const closed = new Promise((resolve) => child.on("close", resolve));
    let writes = 0;
    const end = performance.now() + 2200;
    while (performance.now() < end) {
      try {
        writeFileAtomic(file, big(++writes));
      } catch {
        // Windows can refuse a rename while the reader holds the file; the retries inside normally absorb it.
      }
    }
    await closed;
    const result = JSON.parse(out) as { reads: number; bad: number };
    expect(writes).toBeGreaterThan(20);
    expect(result.reads).toBeGreaterThan(50);
    expect(result.bad).toBe(0);
  });
});


describe("breaking a stale lock keeps mutual exclusion (N10)", () => {
  /** Runs `workers` processes over `rounds` aged locks and returns, per round, the holders seen and any overlap. */
  async function race(workers: number, rounds: number, ownerless: boolean): Promise<{ overlapping: number[]; failures: number; entered: number[] }> {
    const dir = tmpDir();
    for (let r = 0; r < rounds; r++) {
      writeFileSync(join(dir, `l${r}.log`), "");
      plant(join(dir, `l${r}.lock`), ownerless ? "99999" : owned(2_147_483_000), Date.now() - 10_000);
    }
    const worker = join(ADAPTER_DIR, "test", "lockrace-worker.ts");
    const stepMs = 700;
    const startAt = Date.now() + 5000 + workers * 300;
    const runs = Array.from(
      { length: workers },
      () =>
        new Promise<void>((resolve) => {
          const c = spawn(process.execPath, ["--import", "tsx", worker, dir, String(rounds), "40", String(stepMs)], {
            cwd: ADAPTER_DIR,
            env: { ...process.env, START_AT: String(startAt) },
            stdio: "ignore",
          });
          c.on("close", () => resolve());
        }),
    );
    await Promise.all(runs);
    const overlapping: number[] = [];
    const entered: number[] = [];
    let failures = 0;
    for (let r = 0; r < rounds; r++) {
      const events = readFileSync(join(dir, `l${r}.log`), "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((l) => l.split(" "));
      failures += events.filter((e) => e[0] === "fail").length;
      const spans = new Map<string, [number, number]>();
      for (const [kind, pid, at] of events) {
        if (kind === "enter") spans.set(pid as string, [Number(at), Infinity]);
        if (kind === "exit") (spans.get(pid as string) as [number, number])[1] = Number(at);
      }
      const all = [...spans.values()];
      entered.push(all.length);
      let pairs = 0;
      for (let i = 0; i < all.length; i++) {
        for (let j = i + 1; j < all.length; j++) {
          const a = all[i] as [number, number];
          const b = all[j] as [number, number];
          if (a[0] < b[1] && b[0] < a[1]) pairs++;
        }
      }
      if (pairs > 0) overlapping.push(r);
    }
    return { overlapping, failures, entered };
  }

  it("eight contenders on an aged ownerless lock, 30 rounds: never two holders at once, and everyone gets a turn", async () => {
    const out = await race(8, 30, true);
    expect(out.overlapping).toEqual([]);
    expect(out.failures).toBe(0);
    expect(out.entered.every((n) => n === 8)).toBe(true);
  }, 240_000);

  it("the same on a lock whose owner is dead", async () => {
    const out = await race(8, 20, false);
    expect(out.overlapping).toEqual([]);
    expect(out.failures).toBe(0);
    expect(out.entered.every((n) => n === 8)).toBe(true);
  }, 240_000);

  it("a planted, future-dated breaker mutex cannot stop a stale lock being broken", () => {
    const dir = tmpDir();
    const lock = join(dir, "x.lock");
    plant(lock, "99999", Date.now() - 10_000);
    plant(`${lock}.brk`, "planted", Date.now() + 365 * 24 * 3600_000);
    const t0 = performance.now();
    expect(withLock(lock, () => "ran", { timeoutMs: 3000 })).toBe("ran");
    expect(performance.now() - t0).toBeLessThan(1500);
    expect(existsSync(`${lock}.brk`)).toBe(false);
  });

  it("a fresh breaker mutex held by another process is waited on, and an old one is cleared", () => {
    const dir = tmpDir();
    const lock = join(dir, "x.lock");
    plant(lock, "99999", Date.now() - 10_000);
    plant(`${lock}.brk`, "someone", Date.now());
    expect(() => withLock(lock, () => 1, { timeoutMs: 300 })).toThrow(LockTimeoutError);
    plant(`${lock}.brk`, "abandoned", Date.now() - 5000);
    expect(withLock(lock, () => "ran", { timeoutMs: 3000 })).toBe("ran");
  });

  it("a fresh lock with a live owner is never taken from under it, and no breaker mutex is left behind", () => {
    const dir = tmpDir();
    const lock = join(dir, "x.lock");
    const { child, pid } = sleeper();
    try {
      // The lock is fresh and its owner alive, so it is not stale and is never taken.
      plant(lock, owned(pid), Date.now());
      expect(() => withLock(lock, () => 1, { timeoutMs: 300 })).toThrow(LockTimeoutError);
      expect(readFileSync(lock, "utf8")).toContain("planted");
      expect(existsSync(`${lock}.brk`)).toBe(false);
    } finally {
      child.kill();
    }
  });
});
