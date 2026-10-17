// Scratch experiments: where does re2js time go, and what makes it fast?
import { RE2JS, RE2Set } from 're2js';
import { RULES } from './rules.mjs';
import { makeDoc } from './corpus.mjs';
import { prepare, phrasePattern } from './engine.mjs';

const now = () => performance.now();
const pct = (arr, p) => { const a = [...arr].sort((x, y) => x - y); return a[Math.min(a.length - 1, Math.ceil((p / 100) * a.length) - 1)]; };
const raw = makeDoc({ words: 2000, hitRate: 0.05, seed: 1 });
const ctx = prepare(raw);
const text = ctx.text;
const lower = text.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32)); // ASCII-only, 1:1
if (lower.length !== text.length) throw new Error('len');
const rxs = [];
for (const r of RULES) for (const p of r.parts) {
  if (p.k === 'phrase') rxs.push([r.id, phrasePattern(p.phrases)]);
  else if (p.k === 'regex') rxs.push([r.id + 'r', p.pattern]);
}
const noB = (s) => s.replace(/\\b/g, '');
function time(label, fn, iters = 60, warm = 20) {
  for (let i = 0; i < warm; i++) fn();
  const xs = [];
  for (let i = 0; i < iters; i++) { const t0 = now(); fn(); xs.push(now() - t0); }
  console.log(`${label.padEnd(78)} p50 ${pct(xs, 50).toFixed(2).padStart(7)}  p95 ${pct(xs, 95).toFixed(2).padStart(7)}`);
  return xs;
}
const CI = RE2JS.CASE_INSENSITIVE;
const mk = (s, f = 0) => RE2JS.compile(s, f);

const A = rxs.map(([, s]) => mk(s, CI));
time('1. matcher.find() loop over whole text, (?i), with \\b  [current]', () => { for (const re of A) { const m = re.matcher(text); while (m.find()) m.start(0); } });
const A2 = rxs.map(([, s]) => mk(s, CI));
time('2. re.test(text) only, (?i), with \\b', () => { for (const re of A2) re.test(text); });
const B = rxs.map(([, s]) => mk(noB(s), CI));
time('3. re.test(text) only, (?i), NO \\b', () => { for (const re of B) re.test(text); });
const C = rxs.map(([, s]) => mk(noB(s), 0));
time('4. re.test(lowercased text) only, case-sensitive, NO \\b', () => { for (const re of C) re.test(lower); });
time('5. matcher.find() loop, (?i), NO \\b, whole text', () => { for (const re of B) { const m = re.matcher(text); while (m.find()) m.start(0); } });
time('6. matcher.find() loop, case-sensitive on lowercased text, NO \\b', () => { for (const re of C) { const m = re.matcher(lower); while (m.find()) m.start(0); } });
time('7. test() gate on lowercased/no-\\b, then find() only if gate hits', () => { for (let i = 0; i < C.length; i++) { if (C[i].test(lower)) { const m = C[i].matcher(lower); while (m.find()) m.start(0); } } });
// chunked: run on paragraphs (BitState fast path for short inputs)
const paras = []; { let p = 0; for (const m of text.matchAll(/\n\n/g)) { paras.push([p, m.index]); p = m.index + 2; } paras.push([p, text.length]); }
time(`8. matcher.find() on ${paras.length} paragraph substrings, (?i), with \\b (offset += para start)`, () => { for (const re of A) for (const [s, e] of paras) { const m = re.matcher(text.slice(s, e)); while (m.find()) m.start(0) + s; } });
time(`9. same, NO \\b, lowercased paragraphs, case-sensitive`, () => { for (const re of C) for (const [s, e] of paras) { const m = re.matcher(lower.slice(s, e)); while (m.find()) m.start(0) + s; } });
// RE2Set
{
  const set = new RE2Set(RE2Set.UNANCHORED, 0);
  rxs.forEach(([, s]) => set.add(noB(s)));
  set.compile();
  const r = set.match(lower);
  console.log('   RE2Set (case-sensitive, lowercased, no \\b) matched pattern idx:', JSON.stringify(r));
  time('10. RE2Set.match(lowercased) one pass for all 17 patterns', () => set.match(lower));
  const setB = new RE2Set(RE2Set.UNANCHORED, CI);
  rxs.forEach(([, s]) => setB.add(noB(s)));
  setB.compile();
  time('11. RE2Set (?i) on original text, no \\b', () => setB.match(text));
  const setC = new RE2Set(RE2Set.UNANCHORED, CI);
  rxs.forEach(([, s]) => setC.add(s));
  try { setC.compile(); time('12. RE2Set (?i) WITH \\b', () => setC.match(text)); } catch (e) { console.log('12. RE2Set with \\b failed:', e.message); }
}
// JS indexOf prefilter for the literal-only phrase rules
{
  const phraseLists = []; for (const r of RULES) for (const p of r.parts) if (p.k === 'phrase') phraseLists.push(p.phrases.map((x) => x.toLowerCase()));
  time('13. plain JS indexOf over all ' + phraseLists.flat().length + ' phrases on lowercased text', () => { for (const l of phraseLists) for (const ph of l) { let i = 0; while ((i = lower.indexOf(ph, i)) !== -1) i += ph.length; } });
}
// Program size / which engine per pattern
console.log('\nper-pattern test() cost, (?i)+\\b vs no-\\b+lowercase (p50 ms over 60 runs):');
rxs.forEach(([id, s], i) => {
  const t = (fn) => { for (let k = 0; k < 10; k++) fn(); const xs = []; for (let k = 0; k < 40; k++) { const t0 = now(); fn(); xs.push(now() - t0); } return pct(xs, 50); };
  const a = t(() => A2[i].test(text)), b = t(() => C[i].test(lower)), c = t(() => { const m = A[i].matcher(text); while (m.find()); });
  console.log(`  ${id.padEnd(18)} test(?i)\\b ${a.toFixed(3).padStart(7)} | test lower,noB ${b.toFixed(3).padStart(7)} | find-loop(?i)\\b ${c.toFixed(3).padStart(7)}`);
});
