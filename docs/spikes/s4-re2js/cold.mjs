// Child process for bench.mjs section F: measures one cold hook-like invocation.
const t00 = performance.now();
const which = process.argv[2] || 'naive';
const eng = await import('./engine.mjs');
const { RULES } = await import('./rules.mjs');
const { makeDoc } = await import('./corpus.mjs');
const importMs = performance.now() - t00;
const raw = makeDoc({ words: 2000, hitRate: 0.05, seed: 1 });
let t0 = performance.now();
const pack = eng.PACK_VARIANTS[which].make(RULES);
const compileMs = performance.now() - t0;
const run = () => {
  const t = performance.now();
  const text = eng.normalise(raw); const sentences = eng.splitSentences(text);
  const ctx = { raw, text, sentences, words: eng.countWords(text) };
  if (pack.prepare) pack.prepare(ctx);
  let n = 0; for (const r of pack) n += r.run(ctx).length;
  return [performance.now() - t, n];
};
const [run1Ms] = run();
const [run2Ms] = run();
let run10Ms = 0; for (let i = 3; i <= 10; i++) run10Ms = run()[0];
console.log(JSON.stringify({ importMs, compileMs, run1Ms, run2Ms, run10Ms }));
