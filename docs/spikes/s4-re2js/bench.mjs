// Spike S4 benchmark + correctness harness.  Run: node bench.mjs
import { RE2JS } from "re2js";
import { readFileSync } from 'node:fs';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  re2jsEngine, nativeEngine, prepare, buildPack, normalise, splitSentences, countWords, phrasePattern,
  bow, cosine, STOP_BASE, STOP_EXT, similarityToPrior, unicodeBoundaryOk, buildPackOpt, PACK_VARIANTS,
} from './engine.mjs';
import { RULES, EXTRAS } from './rules.mjs';
import { makeDoc, pathological } from './corpus.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const now = () => performance.now();
const pct = (arr, p) => { const a = [...arr].sort((x, y) => x - y); return a[Math.min(a.length - 1, Math.ceil((p / 100) * a.length) - 1)]; };
const f = (x, d = 2) => x.toFixed(d);
const H = (t) => console.log('\n=== ' + t + ' ===');
const ONLY = process.argv.slice(2);
const want = (s) => ONLY.length === 0 || ONLY.includes(s);

console.log(`node ${process.version} | re2js ${JSON.parse(readFileSync(path.join(here, 'node_modules/re2js/package.json'), 'utf8')).version} | ${os.cpus()[0].model.trim()} | ${os.platform()} ${os.arch()}`);

// ============================================================ A. API facts
if (want('api')) {
  H('A. re2js API facts');
  const P = (s, fl = 0) => RE2JS.compile(s, fl);
  // A1 offsets
  const emoji = '\u{1F600} ok \u{1F600}\u{1F600} delve here';
  const m = P('\\bdelve\\b').matcher(emoji);
  m.find();
  console.log(`A1 UTF-16 offsets: JS indexOf=${emoji.indexOf('delve')} re2js start=${m.start()} end=${m.end()} (3 astral chars precede the match; a code-point index would be ${[...emoji].indexOf("d")}) slice===match: ${emoji.slice(m.start(), m.end()) === 'delve'}`);
  const m2 = P("(\\w+) (\\w+)").matcher('\u{1F600}\u{1F600} abc def'); m2.find();
  console.log(`A1b group offsets with astral prefix: start(1)=${m2.start(1)} end(1)=${m2.end(1)} start(2)=${m2.start(2)} text='${'\u{1F600}\u{1F600} abc def'.slice(m2.start(2), m2.end(2))}'`);
  // A2 '.' and astral
  console.log(`A2 '.' consumes a whole astral code point: ${P('^.$').matches('\u{1F600}')} ; lone surrogate: ${P('^.$').matches('\uD83D')}`);
  // A3 global iteration
  const text = 'delve delve; delve';
  const ms = P('\\bdelve\\b').matcher(text); const pos = []; while (ms.find()) pos.push([ms.start(), ms.end()]);
  console.log(`A3 Matcher.find() loop: ${JSON.stringify(pos)}`);
  const ma = [...P('\\b(del)ve\\b').matchAll(text)];
  console.log(`A3b matchAll(): ${ma.length} matches; fields: ${Object.keys(ma[0]).join(',')} ; index=${ma.map((x) => x.index)}; has group offsets (indices)? ${'indices' in ma[0]}`);
  const ex = P('\\b(del)ve\\b').exec('x delve');
  console.log(`A3c exec(): index=${ex.index} [0]=${ex[0]} [1]=${ex[1]} indices? ${'indices' in ex}`);
  // A4 unmatched / absent group 1
  const mg = P('\\bfrom \\w+ to \\w+, (and )?\\w+').matcher('from a to b, c'); mg.find();
  console.log(`A4 optional group 1 unmatched: start(1)=${mg.start(1)} end(1)=${mg.end(1)} group(1)=${mg.group(1)} groupCount=${mg.groupCount()}`);
  const mn = P('\\bit depends[.!]').matcher('It depends.'); console.log(`A4b no group 1: groupCount=${mn.groupCount()}`);
  // A5 case-insensitive
  console.log(`A5 flag CASE_INSENSITIVE: ${P('\\bit depends[.!]', RE2JS.CASE_INSENSITIVE).test('It depends.')} ; inline (?i): ${P('(?i)\\bit depends[.!]').test('It depends.')} ; none: ${P('\\bit depends[.!]').test('It depends.')}`);
  console.log(`A5b flags are not wired to a '(?i)' prefix by the phrase compiler; both forms accepted. Unicode fold: (?i)k matches U+212A KELVIN: ${P('(?i)k').test('\u212A')} ; (?i)s matches U+017F LONG S: ${P('(?i)s').test('\u017F')}`);
  // A6 rejected syntax
  for (const [label, s, fl] of [['backreference (a)\\1', '(a)\\1', 0], ['lookahead (?=a)', 'a(?=b)', 0], ['negative lookahead (?!a)', 'a(?!b)', 0], ['lookbehind (?<=a)', '(?<=a)b', 0], ['lookbehind WITH RE2JS.LOOKBEHINDS flag', '(?<=a)b', RE2JS.LOOKBEHINDS], ['atomic group (?>a)', '(?>a)', 0], ['possessive a++', 'a++', 0], ['\\d{1001}', 'a{1001}', 0], ['named group (?P<n>a)', '(?P<n>a)', 0], ['named group (?<n>a)', '(?<n>a)', 0]]) {
    let r; try { P(s, fl); r = 'accepted'; } catch (e) { r = 'REJECTED: ' + e.message.split('\n')[0].slice(0, 70); }
    console.log(`A6 ${label.padEnd(40)} ${r}`);
  }
  console.log('A6b NOTE: re2js 2.8.x ships an opt-in RE2JS.LOOKBEHINDS flag (non-standard). The pack loader must never pass it, or rules stop being portable to native re2.');
  // A7 \b, \w, \s are ASCII only
  console.log(`A7 ASCII-only classes: \\w matches 'é': ${P('\\w').test('é')} ; \\b between 'é' and 'x' (i.e. \\bx\\b in 'éx'): ${P('\\bx\\b').test('éx')} ; \\s matches NBSP: ${P('\\s').test('\u00A0')} ; \\s matches U+2028: ${P('\\s').test('\u2028')} ; \\pL matches 'é': ${P('\\pL').test('é')}`);
  // A8 literal markdown escapes
  for (const [label, s, sample] of [
    ['hedge.002 as printed in 08 (\\| escapes)', '\\b(somewhat\\|fairly\\|relatively\\|rather)\\s+(\\w+)', 'The query is relatively slow.'],
    ['vocab.002 as printed (\\\\b, \\|)', '\\\\b(the\\|this\\|today\'s) (current \\|modern \\|evolving \\|changing )?landscape\\\\b', 'The current landscape of auth.'],
    ['hedge.004 as printed (\\| escapes)', '\\b(may or may not\\|could potentially\\|might possibly\\|can possibly)\\b', 'This could potentially break the build.'],
  ]) {
    let r; try { r = P(s, RE2JS.CASE_INSENSITIVE).test(sample) ? 'compiles, MATCHES' : 'compiles, SILENTLY NEVER MATCHES'; } catch (e) { r = 'rejected'; }
    console.log(`A8 ${label.padEnd(44)} ${r}`);
  }
  // A9: uniform word-boundary wrapping of a phrase list (what 11 section 6.3 literally says) vs per-edge
  const uniform = (ps) => '\\b(?:' + ps.join('|') + ')\\b';
  const perEdge = phrasePattern;
  for (const [label, ps, sample] of [
    ['filler.001 "certainly!" in "Certainly! Here is the fix."', ["certainly!", "absolutely!"], 'Certainly! Here is the fix.'],
    ['filler.004 "overall," in "Overall, the fix is safe."', ['overall,', 'in summary'], 'Overall, the fix is safe.'],
  ]) {
    console.log(`A9 uniform \\b(?:...)\\b: ${P(uniform(ps), RE2JS.CASE_INSENSITIVE).test(sample)} | per-edge boundaries (boundary only where the phrase edge is a word char): ${P(perEdge(ps), RE2JS.CASE_INSENSITIVE).test(sample)}   <- ${label}`);
  }
}

// ============================================================ B. correctness
const packA = () => buildPack(re2jsEngine, RULES, { ci: false, span: 'group1' });  // regexes exactly as written (no flags)
const packB = () => buildPack(re2jsEngine, RULES, { ci: true, span: 'group1' });   // + case-insensitive, 04 span semantics
const packC = () => buildPack(re2jsEngine, RULES, { ci: true, span: 'whole' });    // + whole-match span
const show = (t, fs) => fs.length ? fs.slice(0, 2).map((x) => JSON.stringify(t.slice(x.s, x.e))).join('|') + (fs.length > 2 ? '+' : '') : '-';
if (want('correct')) {
  H('B. Correctness: 08 hit/miss examples through compiled patterns');
  const pa = packA(), pb = packB(), pc = packC();
  const rows = [];
  RULES.forEach((rule, i) => {
    const hit = rule.hit[0], miss = rule.miss[0];
    const run = (p, t) => p[i].run(prepare(t));
    const hA = run(pa, hit), hB = run(pb, hit), hC = run(pc, hit);
    const mA = run(pa, miss), mB = run(pb, miss);
    const isRegex = rule.parts.some((p) => p.k === 'regex');
    const hitText = prepare(hit).text;
    const ok = hB.length > 0 && mB.length === 0;
    rows.push({ id: rule.id, hitA: hA.length > 0, hitB: hB.length > 0, missB: mB.length > 0, ok, spanB: show(hitText, hB), spanC: show(hitText, hC), isRegex });
  });
  console.log('rule                   | hit fires: no-flags / (?i) | miss fires (?i) | verdict | span if group1 (04 semantics)   | span if whole match');
  for (const r of rows) {
    const verdict = r.ok ? 'PASS' : (r.hitB && r.missB ? 'FAIL(miss fires)' : 'FAIL(hit silent)');
    console.log(`${r.id.padEnd(22)} | ${String(r.hitA).padEnd(5)} / ${String(r.hitB).padEnd(5)}            | ${String(r.missB).padEnd(15)} | ${verdict.padEnd(7)} | ${r.spanB.slice(0, 34).padEnd(34)} | ${r.spanC.slice(0, 40)}`);
  }
  console.log('\nExtras (not in 08; expected true/false, null = informational):');
  const pb2 = packB(); const pa2 = packA(); const byId = Object.fromEntries(RULES.map((r, i) => [r.id, i]));
  for (const [id, label, text, expect] of EXTRAS) {
    const fs = pb2[byId[id]].run(prepare(text));
    const fsA = pa2[byId[id]].run(prepare(text));
    const got = fs.length > 0;
    const t = prepare(text).text;
    console.log(`  ${id.padEnd(17)} ${label.padEnd(66)} fires=${String(got).padEnd(5)} (no-flags: ${String(fsA.length > 0).padEnd(5)}) ${expect === null ? '(info)' : got === expect ? 'ok' : 'UNEXPECTED'} ${show(t, fs)}`);
  }

  console.log('\nStructure/repetition metric values for the 08 examples (hit / miss):');
  const bold = re2jsEngine.compile('\\*\\*[^*\\n]+\\*\\*');
  const { docMetrics } = await import('./engine.mjs');
  for (const rule of RULES.filter((r) => r.parts[0].k === 'metric' && r.parts[0].metric !== 'similarity_to_prior')) {
    const p = rule.parts[0]; const mh = docMetrics(prepare(rule.hit[0]), bold); const mm = docMetrics(prepare(rule.miss[0]), bold);
    console.log(`  ${rule.id} ${p.metric.padEnd(22)} threshold ${p.above !== undefined ? '>' + p.above : '<' + p.below}, min_sentences ${p.minSentences}: hit=${f(mh[p.metric])} (sentences=${mh.sentences}, words=${prepare(rule.hit[0]).words})  miss=${f(mm[p.metric])} (sentences=${mm.sentences}, words=${prepare(rule.miss[0]).words})`);
  }
  console.log('\nrepetition.001 cosine of the 08 hit example under different stop-word assumptions:');
  const hitT = 'The cache is per tenant. Each tenant has its own cache.';
  const sents = splitSentences(hitT).map((s) => hitT.slice(s.start, s.end));
  for (const [name, stop] of [['no stop words', new Set()], ['common list (has each/own, not per)', STOP_BASE], ['extended list (+per)', STOP_EXT]]) {
    const c = cosine(bow(sents[0], stop), bow(sents[1], stop));
    const fire = similarityToPrior(hitT, splitSentences(hitT), { stop }).length > 0;
    const fireBoth = similarityToPrior(hitT, splitSentences(hitT), { stop, bothMin: true }).length > 0;
    console.log(`  ${name.padEnd(40)} cosine=${f(c, 3)}  fires(min 6 words on later sentence only)=${fire}  fires(min 6 on both)=${fireBoth}`);
  }
}

// ============================================================ C. unicode
if (want('unicode')) {
  H('C. Unicode / typography hazards');
  const pk = buildPack(re2jsEngine, RULES, { ci: true, span: 'whole', unicodeBoundary: false });
  const byId = Object.fromEntries(RULES.map((r, i) => [r.id, i]));
  const t = (id, text, { norm = false } = {}) => {
    const raw = text; const ctx = prepare(raw); if (!norm) ctx.text = raw; // norm=false: skip normalisation
    return pk[byId[id]].run(ctx).length;
  };
  const row = (label, a, b) => console.log(`  ${label.padEnd(74)} raw: ${String(a).padEnd(5)} normalised: ${b}`);
  row("phrase hedge.001  \"It\u2019s worth noting that\" (U+2019) vs pattern with '", t('core.hedge.001', 'It\u2019s worth noting that x.'), t('core.hedge.001', 'It\u2019s worth noting that x.', { norm: true }));
  row("phrase filler.001 \"Let\u2019s dive into\" (U+2019)", t('core.filler.001', 'Let\u2019s dive into the cache.'), t('core.filler.001', 'Let\u2019s dive into the cache.', { norm: true }));
  row("regex  triad.002  \"It\u2019s not just about speed, it\u2019s about trust.\"", t('core.triad.002', 'It\u2019s not just about speed, it\u2019s about trust.'), t('core.triad.002', 'It\u2019s not just about speed, it\u2019s about trust.', { norm: true }));
  row("regex  vocab.002  \"today\u2019s landscape\"", t('core.vocab.002', 'Consider today\u2019s landscape of tools.'), t('core.vocab.002', 'Consider today\u2019s landscape of tools.', { norm: true }));
  row('phrase filler.002 "Let me know if you have any questions" with NBSP (U+00A0) as spaces', t('core.filler.002', 'Let\u00A0me\u00A0know\u00A0if you have any questions!'), t('core.filler.002', 'Let\u00A0me\u00A0know\u00A0if you have any questions!', { norm: true }));
  row('phrase vocab.002  "game\u2011changer" (U+2011 non-breaking hyphen)', t('core.vocab.002', 'A game\u2011changer for us.'), t('core.vocab.002', 'A game\u2011changer for us.', { norm: true }));
  row('phrase vocab.003  "cutting\u2010edge" (U+2010 hyphen)', t('core.vocab.003', 'A cutting\u2010edge tool.'), t('core.vocab.003', 'A cutting\u2010edge tool.', { norm: true }));
  console.log('  -> after normalisation all of the above fire; before, every curly-apostrophe / NBSP / U+2010-1 variant is a silent false negative.');

  console.log('\n  \\b next to non-ASCII letters (re2js \\b and \\w are ASCII-only, same as native JS):');
  const bp = (src, text) => RE2JS.compile(src, RE2JS.CASE_INSENSITIVE).test(text);
  console.log(`    \\bve\\b      in "naïve"        -> ${bp('\\bve\\b', 'naïve')}   (true = "ï" is a non-word char to RE2, so "ve" looks like a whole word)`);
  console.log(`    \\bcaf\\b     in "café"         -> ${bp('\\bcaf\\b', 'café')}`);
  console.log(`    \\brobust\\b  in "robustés"      -> ${bp('\\brobust\\b', 'robustés')}   (listed word glued to an accented suffix)`);
  console.log(`    \\brobust\\b  in "érobust"       -> ${bp('\\brobust\\b', 'érobust')}`);
  const tri = 'The naïve, simple, and robust option.';
  const ms = RE2JS.compile('\\b([a-z]{1,12}), ([a-z]{1,12}),? and ([a-z]{1,12})\\b', RE2JS.CASE_INSENSITIVE).matcher(tri); ms.find();
  console.log(`    triad.001 on "${tri}" matched ${JSON.stringify(tri.slice(ms.start(), ms.end()))} (match starts mid-word, after the "ï")`);
  const um = RE2JS.compile('\\brobust\\b', RE2JS.CASE_INSENSITIVE).matcher('robustés'); um.find();
  console.log(`    JS post-filter unicodeBoundaryOk() on the ASCII-\\b match of "robust" in "robustés" (${um.start()}-${um.end()}) -> ${unicodeBoundaryOk('robustés', um.start(), um.end())} (false = rejected)`);

  console.log('\n  Em/en dash adjacency (— U+2014, – U+2013):');
  for (const s of ['robust\u2014and', '\u2014robust', 'we delve\u2014briefly', 'seamless\u2013robust', 'a leverage\u2014 ']) {
    console.log(`    ${JSON.stringify(s).padEnd(26)} vocab.003/001 matches: ${t('core.vocab.003', s) + t('core.vocab.001', s)}`);
  }
  const sd = splitSentences('It works\u2014however it is slow. Next one.');
  console.log(`    sentence splitter on "It works—however it is slow. Next one." -> ${sd.length} sentences (em dash is not a boundary)`);
  console.log(`    \\s+ between words does NOT match em dash: ${RE2JS.compile('a\\s+b').test('a\u2014b')} ; "it\u2014depends." hedge.005 -> ${t('core.hedge.005', 'Well\u2014it depends.')} (fires)`);
  console.log(`    ellipsis "It depends\u2026" (U+2026) hedge.005 -> ${t('core.hedge.005', 'It depends\u2026')} ; closing quote 'It depends."' -> ${t('core.hedge.005', 'He said "it depends."')} ; "It depends!!" -> ${t('core.hedge.005', 'It depends!!')}`);
  const raw = 'a\u2019b\u00A0c\u2010d\u201Ce\u201D \u{1F600} f'; const nn = normalise(raw);
  console.log(`  normalise(): length preserved ${raw.length === nn.length}; astral char untouched: ${nn.includes('\u{1F600}')}`);
  const NORM_RE = /[\u2018\u2019\u201A\u201B\u02BC\u2032\u201C-\u201F\u00A0\u202F\u2009\u2007\u2002\u2003\u2010\u2011]/g;
  const big = makeDoc({ words: 2000, curly: 0.9 });
  let t0 = now(); for (let i = 0; i < 1000; i++) big.replace(NORM_RE, (c) => c); const dt = (now() - t0) / 1000;
  console.log(`  normalise cost on 2,000 words (${big.length} chars): ${f(dt * 1000, 1)} us (replace w/ callback, avg of 1000)`);
}


// ============================================================ D. benchmark
const ENGINES = Object.entries(PACK_VARIANTS).map(([key, v]) => ({ key, name: v.name, make: () => v.make(RULES) }));
export function makeCtx(pack, raw) {
  const text = normalise(raw); const sentences = splitSentences(text);
  const ctx = { raw, text, sentences, words: countWords(text) };
  if (pack.prepare) pack.prepare(ctx);
  return ctx;
}
function runPack(pack, raw, rec) {
  const t0 = now();
  const text = normalise(raw); const t1 = now();
  const sentences = splitSentences(text); const t2 = now();
  const words = countWords(text); const ctx = { raw, text, sentences, words }; const t3 = now();
  if (pack.prepare) pack.prepare(ctx);
  const t4 = now();
  let found = 0; let tr = 0;
  const per = rec ? rec.per : null;
  for (let i = 0; i < pack.length; i++) {
    const a = now();
    const out = pack[i].run(ctx);
    const b = now();
    found += out.length;
    if (per) per[i].push(b - a);
    tr += b - a;
  }
  if (rec) { rec.norm.push(t1 - t0); rec.split.push(t2 - t1); rec.words.push(t3 - t2); rec.prep.push(t4 - t3); rec.rules.push(tr); rec.total.push(now() - t0); }
  return found;
}
const newRec = (n) => ({ norm: [], split: [], words: [], prep: [], rules: [], total: [], per: Array.from({ length: n }, () => []) });
function benchOne(make, raw, iters = 100, warm = 30) {
  const pack = make();
  let found = 0;
  for (let i = 0; i < warm; i++) found = runPack(pack, raw, null);
  const rec = newRec(pack.length);
  for (let i = 0; i < iters; i++) runPack(pack, raw, rec);
  return { pack, rec, found };
}
const FAMILIES = {
  'phrase+regex (17 rules)': (id) => /filler|hedge|vocab|triad/.test(id),
  'structure (5 metrics)': (id) => /structure/.test(id),
  'repetition.001 (similarity)': (id) => /repetition/.test(id),
};
const IDX17 = RULES.map((x, i) => (FAMILIES['phrase+regex (17 rules)'](x.id) ? i : -1)).filter((i) => i >= 0);
const spansOf = (pack, raw) => { const ctx = makeCtx(pack, raw); return pack.map((r) => r.run(ctx).map((x) => x.s + ':' + x.e).join(',')); };

if (want('bench')) {
  H('D0. Parity: optimised pipeline vs naive pipeline (exact spans), on 08 examples, extras and the bench docs');
  const naive = ENGINES.find((e) => e.key === "naive").make(), opt = ENGINES.find((e) => e.key === "opt").make();
  const byId = Object.fromEntries(RULES.map((r, i) => [r.id, i]));
  let checked = 0; const bad = [];
  const cmp = (label, text) => { const a = spansOf(naive, text), b = spansOf(opt, text); a.forEach((x, i) => { checked++; if (x !== b[i]) bad.push(`${label} ${RULES[i].id} naive=[${x}] opt=[${b[i]}]`); }); };
  for (const r of RULES) { cmp('hit ' + r.id, r.hit[0]); cmp('miss ' + r.id, r.miss[0]); }
  for (const [id, label, text] of EXTRAS) cmp('extra ' + id + ' ' + label, text);
  for (const seed of [1, 2, 3, 4, 5]) cmp('doc seed ' + seed, makeDoc({ words: 2000, hitRate: seed === 1 ? 0.05 : 0.5, seed }));
  console.log(`${checked} (text x rule) comparisons, ${bad.length} mismatches${bad.length ? ':\n  ' + bad.join('\n  ') : ''}`);

  H('D. Benchmark: 2,000-word prose, 100 iterations after 30 warm-up (warm JIT, warm DFA caches)');
  const docs = {
    'realistic (~5% hit sentences)': makeDoc({ words: 2000, hitRate: 0.05, seed: 1 }),
    'dense (50% hit sentences)': makeDoc({ words: 2000, hitRate: 0.5, seed: 2 }),
  };
  for (const [k, d] of Object.entries(docs)) console.log(`doc "${k}": ${countWords(d)} words, ${d.length} chars, ${splitSentences(d).length} sentences`);
  const results = {};
  for (const [dn, raw] of Object.entries(docs)) for (const e of ENGINES) results[dn + '|' + e.key] = benchOne(e.make, raw);
  console.log('\nFull pack (normalise + split + word count + gate + all 23 rules in 08), ms per run:');
  console.log('doc                              | variant  | p50     p95     max    | findings');
  for (const [k, r] of Object.entries(results)) {
    const [dn, en] = k.split('|');
    console.log(`${dn.padEnd(32)} | ${en.padEnd(8)} | ${f(pct(r.rec.total, 50)).padStart(6)} ${f(pct(r.rec.total, 95)).padStart(7)} ${f(Math.max(...r.rec.total)).padStart(7)} | ${r.found}`);
  }
  console.log('\nBreakdown p50 / p95 ms by stage:');
  for (const dn of Object.keys(docs)) for (const key of ['naive', 'opt']) {
    const r = results[dn + '|' + key];
    console.log(`  [${dn}] [${key}]`);
    console.log(`    normalise ${f(pct(r.rec.norm, 50), 3)}/${f(pct(r.rec.norm, 95), 3)} | sentence split ${f(pct(r.rec.split, 50), 3)}/${f(pct(r.rec.split, 95), 3)} | word count ${f(pct(r.rec.words, 50), 3)}/${f(pct(r.rec.words, 95), 3)} | lowercase+RE2Set gate+chunking ${f(pct(r.rec.prep, 50), 3)}/${f(pct(r.rec.prep, 95), 3)}`);
    const parts = [];
    for (const [fn, pred] of Object.entries(FAMILIES)) {
      const idx = RULES.map((x, i) => (pred(x.id) ? i : -1)).filter((i) => i >= 0);
      const sums = r.rec.total.map((_, it) => idx.reduce((a, i) => a + r.rec.per[i][it], 0));
      parts.push(`${fn} ${f(pct(sums, 50), 3)}/${f(pct(sums, 95), 3)}`);
    }
    console.log('    ' + parts.join(' | '));
  }
  console.log('\nPer-rule p95 ms, realistic doc:  naive | optimised | native      (dense doc: naive | optimised)');
  const R = (k, dn = 'realistic (~5% hit sentences)') => results[dn + '|' + k];
  RULES.forEach((rule, i) => {
    console.log(`  ${rule.id.padEnd(22)} ${f(pct(R('naive').rec.per[i], 95), 3).padStart(7)} | ${f(pct(R('opt').rec.per[i], 95), 3).padStart(7)} | ${f(pct(R('native').rec.per[i], 95), 3).padStart(7)}      (${f(pct(R('naive', 'dense (50% hit sentences)').rec.per[i], 95), 3)} | ${f(pct(R('opt', 'dense (50% hit sentences)').rec.per[i], 95), 3)})`);
  });
  const cnt = (k, dn) => R(k, dn).found;
  console.log(`\nfinding counts (naive / opt / native) realistic: ${cnt('naive')} / ${cnt('opt')} / ${cnt('native')} ; dense: ${cnt('naive', 'dense (50% hit sentences)')} / ${cnt('opt', 'dense (50% hit sentences)')} / ${cnt('native', 'dense (50% hit sentences)')}`);

  H('D2. Pack compile time, in-process (17 phrase/regex rules + bold pattern; opt also builds the RE2Set)');
  for (const e of ENGINES) {
    const xs = []; for (let i = 0; i < 100; i++) { const t0 = now(); e.make(); xs.push(now() - t0); }
    console.log(`${e.name.padEnd(16)} first call ${f(xs[0], 2)} ms | all 100: p50 ${f(pct(xs, 50), 3)}  p95 ${f(pct(xs, 95), 3)}  max ${f(Math.max(...xs), 3)} ms`);
  }
}

if (want('scale')) {
  H('E1. Scaling: dense docs, 17 phrase/regex rules (+prep), p50 ms; x = ratio vs previous size (2.0 = linear)');
  for (const e of ENGINES) {
    const pk = e.make();
    let prev = 0; const line = [];
    for (const w of [1000, 2000, 4000, 8000, 16000, 32000]) {
      const raw = makeDoc({ words: w, hitRate: 0.5, seed: 3 });
      const run = () => { const ctx = makeCtx(pk, raw); IDX17.forEach((k) => pk[k].run(ctx)); };
      for (let i = 0; i < 5; i++) run();
      const xs = []; for (let i = 0; i < 10; i++) { const t0 = now(); run(); xs.push(now() - t0); }
      const p50 = pct(xs, 50); line.push(`${w}w ${f(p50)}${prev ? ` (x${f(p50 / prev, 1)})` : ''}`); prev = p50;
    }
    console.log(`${e.name.padEnd(16)} ${line.join(' | ')}`);
  }

  H('E2. similarity_to_prior O(n^2) scaling (naive bag-of-words cosine vs every earlier sentence)');
  for (const w of [500, 1000, 2000, 4000, 8000, 16000, 32000]) {
    const raw = makeDoc({ words: w, hitRate: 0.0, seed: 4, closing: false });
    const text = normalise(raw); const ss = splitSentences(text);
    for (let i = 0; i < 3; i++) similarityToPrior(text, ss);
    const xs = []; const reps = w <= 4000 ? 20 : 5;
    for (let i = 0; i < reps; i++) { const t0 = now(); similarityToPrior(text, ss); xs.push(now() - t0); }
    console.log(`  ${String(w).padStart(6)} words, ${String(ss.length).padStart(5)} sentences: p50 ${f(pct(xs, 50), 2).padStart(8)} ms  max ${f(Math.max(...xs), 2).padStart(8)} ms`);
  }

  H('E3. Pathological inputs: 17 phrase/regex rules incl. normalise+split+prep, p50 / max of 10 runs (ms)');
  const P = pathological();
  const packs = ENGINES.map((e) => ({ e, pk: e.make() }));
  for (const [name, raw] of Object.entries(P)) {
    const cells = [];
    for (const { e, pk } of packs) {
      const once = (r) => { const ctx = makeCtx(pk, r); return IDX17.reduce((a, k) => a + pk[k].run(ctx).length, 0); };
      const xs = []; let n = 0; for (let i = 0; i < 12; i++) { const t0 = now(); n = once(raw); xs.push(now() - t0); } xs.shift(); xs.shift();
      const big = (raw + ' ').repeat(4); const tb = now(); once(big); once(big); const t4 = (now() - tb) / 2;
      cells.push(`${e.key} ${f(pct(xs, 50)).padStart(7)}/${f(Math.max(...xs)).padStart(7)} 4x:x${f(t4 / pct(xs, 50), 1)} n=${n}`);
    }
    console.log(`  ${name.padEnd(48)} ${String(raw.length).padStart(5)}ch | ${cells.join(' | ')}`);
  }
  const evil = 'a'.repeat(26) + '!';
  let t0 = now(); RE2JS.compile('^(a+)+$').test(evil); const tr = now() - t0;
  t0 = now(); /^(a+)+$/.test(evil); const tn = now() - t0;
  console.log(`  classic ReDoS ^(a+)+$ on "a"x26+"!": re2js ${f(tr, 3)} ms vs native ${f(tn, 1)} ms (native is exponential; none of the 08 patterns is vulnerable, this only demonstrates RE2 semantics)`);
}

// ============================================================ F. cold start
if (want('cold')) {
  H('F. Cold start: fresh `node` process per run (what a command-hook CLI actually pays), 15 runs');
  const runs = 15;
  const base = []; const res = { naive: [], optwhole: [], opt: [], optgate: [], 'opt+compilecache': [], native: [] };
  const ccDir = path.join(os.tmpdir(), 's4-cc-' + process.pid);
  spawnSync(process.execPath, [path.join(here, 'cold.mjs'), 'opt'], { env: { ...process.env, NODE_COMPILE_CACHE: ccDir } }); // prime
  for (let i = 0; i < runs; i++) {
    let t0 = now(); spawnSync(process.execPath, ['-e', '0']); base.push(now() - t0);
    for (const which of Object.keys(res)) {
      t0 = now();
      const r = spawnSync(process.execPath, [path.join(here, 'cold.mjs'), which.split('+')[0]], { encoding: 'utf8', env: which.includes('compilecache') ? { ...process.env, NODE_COMPILE_CACHE: ccDir } : process.env });
      const wall = now() - t0;
      const j = JSON.parse(r.stdout.trim().split('\n').pop());
      res[which].push({ wall, ...j });
    }
  }
  const col = (arr, k) => arr.map((x) => x[k]);
  console.log(`bare \`node -e 0\` wall: p50 ${f(pct(base, 50), 1)}  p95 ${f(pct(base, 95), 1)} ms`);
  for (const which of Object.keys(res)) {
    const a = res[which];
    const both = a.map((x) => x.compileMs + x.run1Ms);
    console.log(`${which.padEnd(16)} process wall p50 ${f(pct(col(a, 'wall'), 50), 0)} p95 ${f(pct(col(a, 'wall'), 95), 0)} | module load ${f(pct(col(a, 'importMs'), 50), 1)} | compile pack ${f(pct(col(a, 'compileMs'), 50), 1)} | 1st run ${f(pct(col(a, 'run1Ms'), 50), 1)} (p95 ${f(pct(col(a, 'run1Ms'), 95), 1)}, max ${f(Math.max(...col(a, 'run1Ms')), 1)}) | 2nd run ${f(pct(col(a, 'run2Ms'), 50), 1)} | 10th run ${f(pct(col(a, 'run10Ms'), 50), 1)}`);
    console.log(`        compile + 1st run (one hook invocation of engine work): p50 ${f(pct(both, 50), 1)}  p95 ${f(pct(both, 95), 1)}  max ${f(Math.max(...both), 1)} ms`);
  }
}
