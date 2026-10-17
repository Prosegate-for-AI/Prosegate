// Can a timeout guard rescue the process when the keyring call blocks (hung D-Bus)?
// mode=worker: construct + getPassword inside a worker thread; main thread arms a timer and exits.
// mode=child:  spawn a child node process that does the call; parent kills it on timeout.
const mode = process.argv[2] || 'worker';
const LIMIT = Number(process.argv[3] || 1500);
const t0 = performance.now();
const store = process.env.SPIKE_STORE || undefined;
const done = (o, code) => {
  require('node:fs').writeSync(1, JSON.stringify({ mode, ...o, ms: +(performance.now() - t0).toFixed(1) }) + '\n');
  // process.exit() waits for a worker blocked in native code; reallyExit skips env teardown.
  if (mode === 'worker-reallyexit') process.reallyExit(code);
  if (mode === 'worker-sigkill' && o.timeout) process.kill(process.pid, 'SIGKILL');
  process.exit(code);
};
if (mode.startsWith('worker')) {
  const { Worker } = require('node:worker_threads');
  const w = new Worker(`
    const { parentPort, workerData } = require('node:worker_threads');
    const { Entry } = require(workerData.mod);
    try { const e = new Entry('prosegate-spike', 'device-key', workerData.store ? { linux: { store: workerData.store } } : undefined);
          const v = e.getPassword(); parentPort.postMessage({ ok: true, got: v === null ? null : v.length }); }
    catch (err) { parentPort.postMessage({ ok: false, message: err.message }); }`,
    { eval: true, workerData: { mod: process.env.KEYRING_MOD, store } });
  const timer = setTimeout(() => done({ ok: false, timeout: LIMIT }, 4), LIMIT);
  w.on('message', (m) => { clearTimeout(timer); done(m, m.ok ? 0 : 2); });
} else {
  const { spawn } = require('node:child_process');
  const c = spawn(process.execPath, ['-e', `
    const { Entry } = require(${JSON.stringify(process.env.KEYRING_MOD)});
    try { const e = new Entry('prosegate-spike', 'device-key', ${JSON.stringify(store ? { linux: { store } } : null)} || undefined);
          const v = e.getPassword(); process.stdout.write(JSON.stringify({ ok: true, got: v === null ? null : v.length })); }
    catch (err) { process.stdout.write(JSON.stringify({ ok: false, message: err.message })); }`], { stdio: ['ignore', 'pipe', 'inherit'] });
  let out = '';
  c.stdout.on('data', (d) => (out += d));
  const timer = setTimeout(() => { c.kill('SIGKILL'); done({ ok: false, timeout: LIMIT }, 4); }, LIMIT);
  c.on('exit', () => { clearTimeout(timer); const m = JSON.parse(out || '{}'); done(m, m.ok ? 0 : 2); });
}
