import { spawnSync } from 'node:child_process';
const exe = process.argv[2]; const n = 20; const w = [], g = [];
spawnSync(exe, ['get']);
for (let i = 0; i < n; i++) { const t = performance.now(); const r = spawnSync(exe, ['get'], { encoding: 'utf8' }); w.push(performance.now() - t); g.push(JSON.parse(r.stdout).totalMs); }
const p = (xs, q) => [...xs].sort((a, b) => a - b)[Math.ceil(q / 100 * xs.length) - 1].toFixed(1);
console.log(`SEA get: wall p50=${p(w,50)} p95=${p(w,95)}; in-process total p50=${p(g,50)} p95=${p(g,95)} (n=${n})`);
