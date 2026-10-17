#!/usr/bin/env node
// S3 spike CLI. Dummy values only. Service name is fixed to `prosegate-spike`.
// Usage: prosegate-spike <set|get|delete|probe|roundtrip> [--async] [--store secret-service|keyutils] [--timeout ms]
// Prints one JSON line to stdout with timings. Never prints the secret value
// (get prints only length + whether it equals the dummy).

const T0 = performance.now();
const SERVICE = process.env.SPIKE_SERVICE ?? 'prosegate-spike';
const ACCOUNT = process.env.SPIKE_ACCOUNT ?? 'device-key';
const DUMMY = 'prosegate-spike-dummy-not-a-secret';

const args = process.argv.slice(2);
const cmd = args[0] ?? 'roundtrip';
const useAsync = args.includes('--async');
const storeIdx = args.indexOf('--store');
const store = storeIdx >= 0 ? args[storeIdx + 1] : process.env.SPIKE_STORE || undefined;
const toIdx = args.indexOf('--timeout');
const timeoutMs = toIdx >= 0 ? Number(args[toIdx + 1]) : 0;

function out(o: Record<string, unknown>) {
  process.stdout.write(JSON.stringify({ cmd, platform: process.platform, arch: process.arch, ...o }) + '\n');
}

function describeErr(e: unknown) {
  const err = e as { name?: string; message?: string; code?: unknown; cause?: unknown };
  return {
    name: err?.name,
    code: err?.code,
    message: err?.message,
    messageContainsDummy: String(err?.message ?? '').includes(DUMMY),
  };
}

async function main() {
  const tLoad0 = performance.now();
  let mod: typeof import('@napi-rs/keyring');
  try {
    // Dynamic import so a missing optional dependency is catchable (file fallback path).
    mod = await import('@napi-rs/keyring');
  } catch (e) {
    out({ ok: false, stage: 'load', loadMs: +(performance.now() - tLoad0).toFixed(2), err: describeErr(e) });
    process.exitCode = 3;
    return;
  }
  const loadMs = +(performance.now() - tLoad0).toFixed(2);
  const opts = store ? { linux: { store: store as 'secret-service' | 'keyutils' } } : undefined;

  const timings: Record<string, number> = {};
  const time = async <T>(label: string, fn: () => T | Promise<T>): Promise<T> => {
    const t = performance.now();
    try {
      return await fn();
    } finally {
      timings[label] = +(performance.now() - t).toFixed(2);
    }
  };

  let guard: NodeJS.Timeout | undefined;
  if (timeoutMs > 0) {
    // Timeout guard: only effective with --async (a sync native call blocks the event loop).
    guard = setTimeout(() => {
      out({ ok: false, stage: 'timeout', timeoutMs, loadMs, timings, totalMs: +(performance.now() - T0).toFixed(2) });
      process.exit(4);
    }, timeoutMs);
  }

  try {
    const entry = await time('construct', () =>
      useAsync ? new mod.AsyncEntry(SERVICE, ACCOUNT, opts) : new mod.Entry(SERVICE, ACCOUNT, opts),
    );
    const e = entry as any;
    let result: Record<string, unknown> = {};
    if (cmd === 'set' || cmd === 'roundtrip') {
      await time('set', () => e.setPassword(DUMMY));
    }
    if (cmd === 'get' || cmd === 'roundtrip' || cmd === 'probe') {
      const v = await time('get', () => e.getPassword());
      result.got = v === null ? null : { length: (v as string).length, equalsDummy: v === DUMMY };
    }
    if (cmd === 'warm') {
      // N gets in one process after module load: warm latency.
      const n = Number(args[1] ?? 20);
      const samples: number[] = [];
      for (let i = 0; i < n; i++) {
        const t = performance.now();
        await e.getPassword();
        samples.push(+(performance.now() - t).toFixed(3));
      }
      result.samples = samples;
    }
    if (cmd === 'delete' || cmd === 'roundtrip') {
      result.deleted = await time('delete', () => e.deletePassword());
    }
    if (cmd === 'seterr') {
      // Force an error on setPassword with a value that contains the dummy marker, to see whether the error echoes it.
      const big = (DUMMY + '-').repeat(Number(args[1] ?? 200));
      await time('set', () => e.setPassword(big));
      result.setBigLength = big.length;
      result.deleted = await e.deletePassword();
    }
    if (cmd === 'getafterdelete') {
      const v = await time('get', () => e.getPassword());
      result.got = v;
    }
    if (guard) clearTimeout(guard);
    out({ ok: true, service: SERVICE, account: ACCOUNT, store: store ?? 'default', async: useAsync, loadMs, timings, ...result, totalMs: +(performance.now() - T0).toFixed(2) });
  } catch (err) {
    if (guard) clearTimeout(guard);
    out({ ok: false, stage: 'call', store: store ?? 'default', async: useAsync, loadMs, timings, err: describeErr(err), totalMs: +(performance.now() - T0).toFixed(2) });
    process.exitCode = 2;
  }
}

main();
