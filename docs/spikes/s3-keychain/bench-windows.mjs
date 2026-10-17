// S3 spike: reproduce the Windows keychain latency measurement with one command.
//   npm install && npm run bench:win        (builds dist/cli.js with tsup, then runs this)
//   node bench-windows.mjs [runs] [cliPath]  (cliPath defaults to dist/cli.js)
// Uses only the dummy value under service `prosegate-spike`; deletes it at the end and verifies.
import { spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const RUNS = Number(process.argv[2] ?? 20);
const CLI = path.resolve(process.argv[3] ?? path.join(here, 'dist', 'cli.js'));

function run(args, { cli = true } = {}) {
  const t = performance.now();
  const r = spawnSync(process.execPath, cli ? [CLI, ...args] : args, { encoding: 'utf8' });
  const wall = performance.now() - t;
  let json = null;
  try { json = JSON.parse(r.stdout.trim().split('\n').pop()); } catch {}
  if (r.stderr && r.stderr.trim()) console.error('[stderr]', r.stderr.trim());
  return { wall, json, status: r.status };
}

function pct(xs, p) {
  const s = [...xs].sort((a, b) => a - b);
  const i = Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1));
  return s[i];
}
const fmt = (xs) => `p50=${pct(xs, 50).toFixed(1)}ms p95=${pct(xs, 95).toFixed(1)}ms max=${Math.max(...xs).toFixed(1)}ms (n=${xs.length})`;

console.log(`node ${process.version} ${process.platform}-${process.arch}; cli=${CLI}; runs=${RUNS}`);

const base = [];

const set = run(['set']);
if (!set.json?.ok) { console.error('set failed', set.json); process.exit(1); }

const cold = { wall: [], load: [], get: [], total: [] };
const coldAsync = { wall: [], get: [] };
// Interleave bare-node baseline, sync get and async get so disk-cache / AV warm-up hits all three equally.
run([path.join(here, 'empty.js')], { cli: false }); // discard first spawn
for (let i = 0; i < RUNS; i++) {
  base.push(run([path.join(here, 'empty.js')], { cli: false }).wall);
  const r = run(['get']);
  if (!r.json?.ok || !r.json.got?.equalsDummy) { console.error('get failed', r.json); process.exit(1); }
  cold.wall.push(r.wall); cold.load.push(r.json.loadMs); cold.get.push(r.json.timings.get); cold.total.push(r.json.totalMs);
  const a = run(['get', '--async']);
  if (!a.json?.ok || !a.json.got?.equalsDummy) { console.error('async get failed', a.json); process.exit(1); }
  coldAsync.wall.push(a.wall); coldAsync.get.push(a.json.timings.get);
}

const warm = run(['warm', String(RUNS)]);
const warmAsync = run(['warm', String(RUNS), '--async']);

const del = run(['delete']);
const after = run(['getafterdelete']);

console.log('\nbaseline node empty.js wall      ', fmt(base));
console.log('cold get (sync)  process wall     ', fmt(cold.wall));
console.log('cold get (sync)  module load      ', fmt(cold.load));
console.log('cold get (sync)  first getPassword', fmt(cold.get));
console.log('cold get (sync)  in-process total ', fmt(cold.total));
console.log('cold get (async) process wall     ', fmt(coldAsync.wall));
console.log('cold get (async) first getPassword', fmt(coldAsync.get));
console.log('warm get (sync)  getPassword      ', fmt(warm.json.samples.slice(1)));
console.log('warm get (async) getPassword      ', fmt(warmAsync.json.samples.slice(1)));
console.log('\ndelete ->', JSON.stringify({ ok: del.json?.ok, deleted: del.json?.deleted }));
console.log('get after delete ->', JSON.stringify({ ok: after.json?.ok, got: after.json?.got }));
if (after.json?.got !== null) { console.error('ENTRY STILL PRESENT'); process.exit(1); }
console.log('cleanup confirmed: prosegate-spike/device-key absent');
