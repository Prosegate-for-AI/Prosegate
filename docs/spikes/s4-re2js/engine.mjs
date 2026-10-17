// Spike S4 - minimal rule engine used only to measure re2js. Not production code.
import { RE2JS } from 're2js';

// ---------------------------------------------------------------- engines
class Re2Pat {
  constructor(src, flags = '') {
    let f = 0;
    if (flags.includes('i')) f |= RE2JS.CASE_INSENSITIVE;
    if (flags.includes('m')) f |= RE2JS.MULTILINE;
    this.src = src;
    this.re = RE2JS.compile(src, f);
    this.ng = this.re.matcher('').groupCount();
  }
  // cb(start0, end0, start1, end1); group offsets are -1 when no group 1 / unmatched
  findAll(text, cb) {
    const m = this.re.matcher(text);
    const ng = this.ng;
    while (m.find()) cb(m.start(0), m.end(0), ng ? m.start(1) : -1, ng ? m.end(1) : -1);
  }
  test(text) { return this.re.test(text); }
}
class NatPat {
  constructor(src, flags = '') {
    this.src = src;
    this.re = new RegExp(src, 'g' + flags);
  }
  findAll(text, cb) {
    const re = this.re; re.lastIndex = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
      cb(m.index, m.index + m[0].length, -1, -1);
      if (m[0].length === 0) re.lastIndex++;
    }
  }
  test(text) { this.re.lastIndex = 0; return this.re.test(text); }
}
export const re2jsEngine = { name: 're2js', compile: (s, f) => new Re2Pat(s, f) };
export const nativeEngine = { name: 'native RegExp', compile: (s, f) => new NatPat(s, f) };

// ---------------------------------------------------------------- normalisation
// Every mapping is 1 UTF-16 code unit -> 1 UTF-16 code unit, so offsets are unchanged.
const NORM = {
  '‘': "'", '’': "'", '‚': "'", '‛': "'", 'ʼ': "'", '′': "'",
  '“': '"', '”': '"', '„': '"', '‟': '"',
  ' ': ' ', ' ': ' ', ' ': ' ', ' ': ' ', ' ': ' ', ' ': ' ',
  '‐': '-', '‑': '-',
};
const NORM_RE = /[‘’‚‛ʼ′“-‟      ‐‑]/g;
export function normalise(raw) {
  const out = raw.replace(NORM_RE, (c) => NORM[c]);
  if (out.length !== raw.length) throw new Error('normalise changed length');
  return out;
}

// ---------------------------------------------------------------- phrase compiler
const META = /[\\^$.|?*+()[\]{}]/g;
const isWord = (c) => /[A-Za-z0-9_]/.test(c);
export function phrasePattern(phrases) {
  const alts = [...phrases]
    .sort((a, b) => b.length - a.length)
    .map((p) => {
      const body = p.split(/\s+/).map((w) => w.replace(META, '\\$&')).join('\\s+');
      return (isWord(p[0]) ? '\\b' : '') + body + (isWord(p[p.length - 1]) ? '\\b' : '');
    });
  return '(?:' + alts.join('|') + ')';
}

// ---------------------------------------------------------------- sentences
const ABBR = new Set(['mr', 'mrs', 'ms', 'dr', 'prof', 'sr', 'jr', 'vs', 'etc', 'e.g', 'i.e', 'eg', 'ie', 'fig', 'no', 'approx', 'inc', 'ltd', 'st', 'cf', 'al']);
const isWs = (c) => c === 32 || c === 10 || c === 13 || c === 9 || c === 12;
const isCloser = (c) => c === 34 || c === 39 || c === 41 || c === 93 || c === 42 || c === 95; // " ' ) ] * _
export function splitSentences(text) {
  const out = [];
  const n = text.length;
  let start = 0;
  const push = (s, e) => {
    while (s < e && isWs(text.charCodeAt(s))) s++;
    while (e > s && isWs(text.charCodeAt(e - 1))) e--;
    if (e > s) out.push({ start: s, end: e });
  };
  let i = 0;
  while (i < n) {
    const c = text.charCodeAt(i);
    if (c === 10) {
      // blank line, bullet line or heading line starts a new segment
      let j = i + 1;
      while (j < n && (text.charCodeAt(j) === 32 || text.charCodeAt(j) === 9 || text.charCodeAt(j) === 13)) j++;
      const d = text.charCodeAt(j);
      const bullet = (d === 45 || d === 42 || d === 43) && text.charCodeAt(j + 1) === 32;
      const numbered = d >= 48 && d <= 57 && (text.charCodeAt(j + 1) === 46 || text.charCodeAt(j + 1) === 41) && text.charCodeAt(j + 2) === 32;
      if (d === 10 || bullet || numbered || d === 35) { push(start, i); start = j; }
      i = j > i ? j : i + 1;
      continue;
    }
    if (c === 46 || c === 33 || c === 63) { // . ! ?
      let j = i + 1;
      while (j < n) { const d = text.charCodeAt(j); if (d === 46 || d === 33 || d === 63) j++; else break; }
      const term = c;
      let k = j;
      while (k < n && isCloser(text.charCodeAt(k))) k++;
      if (k < n && !isWs(text.charCodeAt(k))) { i = k; continue; } // "3.14", "a.b", "file.txt"
      if (term === 46 && j === i + 1) { // single period: abbreviation / initial / list number check
        let b = i; while (b > 0 && /[A-Za-z.]/.test(text[b - 1])) b--;
        const tok = text.slice(b, i).toLowerCase();
        if (ABBR.has(tok) || (tok.length === 1 && b < i)) { i = k; continue; }
        if (/^\d+$/.test(text.slice(Math.max(0, i - 3), i)) && (b === 0 || text.charCodeAt(b - 1) === 10)) { i = k; continue; }
      }
      let m = k; while (m < n && isWs(text.charCodeAt(m))) m++;
      const nx = text.charCodeAt(m);
      if (term === 46 && nx >= 97 && nx <= 122) { i = k; continue; } // ". and" -> not a boundary
      push(start, k); start = k; i = k; continue;
    }
    i++;
  }
  push(start, n);
  return out;
}
export function countWords(text) {
  let n = 0, inw = false;
  for (let i = 0; i < text.length; i++) {
    const w = !isWs(text.charCodeAt(i));
    if (w && !inw) n++;
    inw = w;
  }
  return n;
}
export function sentenceIndexAt(sentences, pos) {
  let lo = 0, hi = sentences.length - 1, ans = -1;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (sentences[mid].start <= pos) { ans = mid; lo = mid + 1; } else hi = mid - 1; }
  return ans;
}
export function sentenceKind(text, s) {
  const c = text.charCodeAt(s.start), d = text.charCodeAt(s.start + 1);
  if (c === 35) return 'heading';
  if ((c === 45 || c === 42 || c === 43) && d === 32) return 'list';
  if (c >= 48 && c <= 57) { let j = s.start; while (text.charCodeAt(j) >= 48 && text.charCodeAt(j) <= 57) j++; if ((text.charCodeAt(j) === 46 || text.charCodeAt(j) === 41) && text.charCodeAt(j + 1) === 32) return 'list'; }
  return 'prose';
}

// ---------------------------------------------------------------- bag of words / similarity
export const STOP_BASE = new Set(('a an the and or but if then else of to in on at by for with about as into like through after over between out against during without before under around among from up down off above below is are was were be been being am do does did doing have has had having i me my we our you your he him his she her it its they them their this that these those there here what which who whom whose when where why how not no nor only own same so than too very can will just should now each few more most other some such also would could may might must shall s t').split(/\s+/));
export const STOP_EXT = new Set([...STOP_BASE, 'per', 'each', 'own']);
let STOP = STOP_BASE;
export function setStop(s) { STOP = s; }
const TOK = /[a-z0-9']+/g;
export function bow(sentenceText, stop = STOP) {
  const m = new Map();
  const toks = sentenceText.toLowerCase().match(TOK);
  if (!toks) return { m, norm: 0 };
  for (const t of toks) if (!stop.has(t)) m.set(t, (m.get(t) || 0) + 1);
  let sq = 0; for (const v of m.values()) sq += v * v;
  return { m, norm: Math.sqrt(sq) };
}
export function cosine(a, b) {
  if (!a.norm || !b.norm) return 0;
  const [s, l] = a.m.size <= b.m.size ? [a.m, b.m] : [b.m, a.m];
  let dot = 0;
  for (const [k, v] of s) { const w = l.get(k); if (w) dot += v * w; }
  return dot / (a.norm * b.norm);
}
// naive O(n^2): every sentence with >= minWords words versus every earlier sentence
export function similarityToPrior(text, sentences, { above = 0.7, minWords = 6, stop = STOP, bothMin = false } = {}) {
  const vecs = new Array(sentences.length);
  const wc = new Array(sentences.length);
  const out = [];
  for (let i = 0; i < sentences.length; i++) {
    const s = sentences[i];
    const t = text.slice(s.start, s.end);
    wc[i] = countWords(t);
    vecs[i] = bow(t, stop);
  }
  for (let i = 1; i < sentences.length; i++) {
    if (wc[i] < minWords) continue;
    for (let j = 0; j < i; j++) {
      if (bothMin && wc[j] < minWords) continue;
      const c = cosine(vecs[i], vecs[j]);
      if (c > above) { out.push({ start: sentences[i].start, end: sentences[i].end, sim: c, prior: j }); break; }
    }
  }
  return out;
}

// ---------------------------------------------------------------- document metrics
export function paragraphs(text) { return text.split(/\n\s*\n/).filter((p) => p.trim()); }
export function docMetrics(ctx, boldPat) {
  const { text, sentences, words } = ctx;
  let heads = 0, lists = 0, counted = 0;
  const lens = [];
  for (const s of sentences) {
    const k = sentenceKind(text, s);
    if (k === 'heading') { heads++; continue; }
    counted++;
    if (k === 'list') lists++;
    lens.push(countWords(text.slice(s.start, s.end)));
  }
  let mean = 0; for (const l of lens) mean += l; mean = lens.length ? mean / lens.length : 0;
  let v = 0; for (const l of lens) v += (l - mean) ** 2; v = lens.length ? v / lens.length : 0;
  const cv = mean ? Math.sqrt(v) / mean : 0;
  let bold = 0; boldPat.findAll(text, () => bold++);
  const ps = paragraphs(text);
  const closing = ps.length >= 2 ? cosine(bow(ps[0]), bow(ps[ps.length - 1])) : 0;
  return {
    sentences: counted,
    headers_per_100_words: words ? (heads / words) * 100 : 0,
    bullet_ratio: counted ? lists / counted : 0,
    sentence_length_cv: cv,
    closing_similarity: closing,
    bold_per_100_words: words ? (bold / words) * 100 : 0,
  };
}

// ---------------------------------------------------------------- context
export function prepare(raw) {
  const text = normalise(raw);
  const sentences = splitSentences(text);
  const words = countWords(text);
  return { raw, text, sentences, words };
}

// ---------------------------------------------------------------- unicode boundary post-check
const LETTERNUM = /[\p{L}\p{N}_\p{M}]/u;
function prevCp(text, i) { // code point ending right before i
  const c = text.charCodeAt(i - 1);
  if (c >= 0xDC00 && c <= 0xDFFF && i >= 2) return text.slice(i - 2, i);
  return text[i - 1];
}
function nextCp(text, i) { return String.fromCodePoint(text.codePointAt(i)); }
export function unicodeBoundaryOk(text, s, e, firstIsWord = true, lastIsWord = true) {
  if (firstIsWord && s > 0 && LETTERNUM.test(prevCp(text, s))) return false;
  if (lastIsWord && e < text.length && LETTERNUM.test(nextCp(text, e))) return false;
  return true;
}

// ---------------------------------------------------------------- pack
// triad.001 sentence constraints (no digits, <= 25 words); memoised per sentence so many candidates stay linear
function triadSentenceOk(ctx, si) {
  const memo = ctx.triadMemo ?? (ctx.triadMemo = new Map());
  let v = memo.get(si);
  if (v === undefined) {
    const sent = ctx.sentences[si];
    const st = ctx.text.slice(sent.start, sent.end);
    v = !/\d/.test(st) && countWords(st) <= 25;
    memo.set(si, v);
  }
  return v;
}
const SENT_START_PREFIX =/^[\s"'(\[*_>#\-0-9.]*$/;

export function buildPack(engine, RULES, opts = {}) {
  const { ci = true, span = 'group1', unicodeBoundary = true, hoist = true } = opts;
  const bold = engine.compile('\\*\\*[^*\\n]+\\*\\*');
  return RULES.map((rule) => {
    const parts = rule.parts.map((p) => {
      if (p.k === 'phrase') return { p, pat: engine.compile(opts.phrasePatternFn ? opts.phrasePatternFn(p.phrases) : phrasePattern(p.phrases), 'i') };
      if (p.k === 'regex') return { p, pat: engine.compile(opts.regexOverride?.[rule.id] ?? p.pattern, ci ? 'i' : '') };
      return { p, pat: null };
    });
    return {
      id: rule.id,
      run(ctx) {
        const out = [];
        const { text, sentences } = ctx;
        for (const { p, pat } of parts) {
          if (p.k === 'metric') {
            if (p.metric === 'similarity_to_prior') {
              for (const f of similarityToPrior(text, sentences, { stop: opts.stop ?? STOP })) out.push({ s: f.start, e: f.end, v: f.sim });
            } else {
              const m = ctx.metrics ?? (ctx.metrics = docMetrics(ctx, bold));
              if (m.sentences < p.minSentences) continue;
              const val = m[p.metric];
              if ((p.above !== undefined && val > p.above) || (p.below !== undefined && val < p.below)) {
                const first = sentences[0];
                out.push({ s: first.start, e: first.end, v: val });
              }
            }
            continue;
          }
          if (p.maxDocWords && ctx.words >= p.maxDocWords) continue;
          const closeFrom = p.position === 'closing' ? sentences[Math.max(0, sentences.length - 2)].start : -1;
          pat.findAll(text, (s0, e0, s1, e1) => {
            let s = s0, e = e0;
            if (span === 'group1' && s1 >= 0) { s = s1; e = e1; }
            if (p.k === 'phrase' || p.boundaryCheck) {
              if (unicodeBoundary && !unicodeBoundaryOk(text, s0, e0, /\w/.test(text[s0]), /\w/.test(text[e0 - 1]))) return;
            }
            if (p.position === 'sentence_start') {
              const si = sentenceIndexAt(sentences, s0);
              if (si < 0 || s0 - sentences[si].start > 12 || !SENT_START_PREFIX.test(text.slice(sentences[si].start, s0))) return;
            } else if (p.position === 'closing') {
              if (s0 < closeFrom) return;
            }
            if (p.post === 'triad1' && !triadSentenceOk(ctx, sentenceIndexAt(sentences, s0))) return;
            out.push({ s, e });
          });
        }
        return out;
      },
    };
  });
}

// ====================================================================================
// Optimised pipeline (what S4 recommends):
//  1. text normalised 1:1, ASCII-lowercased copy `lower` (1:1) -> patterns are case-sensitive and lowercase
//  2. NO \b inside RE2 (re2js's DFA/prefilter cannot handle word boundaries and falls back to the NFA);
//     boundaries are verified in JS on each candidate match instead (Unicode-aware as a bonus)
//  3. one RE2Set (single DFA pass) over all phrase/regex parts gates which parts can match at all
//  4. surviving parts run Matcher.find() per prose chunk (<= ~1500 chars) so re2js can use BitState
//     instead of the Pike NFA, then offsets are shifted by the chunk start
// ====================================================================================
import { RE2Set } from 're2js';
export const asciiLower = (s) => s.replace(/[A-Z]+/g, (m) => m.toLowerCase());
export function paragraphRanges(text) {
  const out = []; let s = 0; const re = /\n[ \t\r]*\n/g; let m;
  while ((m = re.exec(text)) !== null) { if (m.index > s) out.push([s, m.index]); s = m.index + m[0].length; }
  if (s < text.length) out.push([s, text.length]);
  return out;
}
export function chunkRanges(text, sentences, maxLen = 1500) {
  const out = [];
  let si = 0;
  for (const [ps, pe] of paragraphRanges(text)) {
    if (pe - ps <= maxLen) { out.push([ps, pe]); continue; }
    while (si < sentences.length && sentences[si].end <= ps) si++;
    let cs = -1, ce = -1;
    for (let k = si; k < sentences.length && sentences[k].start < pe; k++) {
      const sn = sentences[k];
      if (cs >= 0 && sn.end - cs > maxLen) { out.push([cs, ce]); cs = -1; }
      if (cs < 0) cs = sn.start;
      ce = sn.end;
    }
    if (cs >= 0) out.push([cs, ce]);
  }
  return out;
}
const BS_B = '\\' + 'b'; // the two characters backslash-b
const stripB = (p) => { let lead = false, trail = false; if (p.startsWith(BS_B)) { p = p.slice(2); lead = true; } if (p.endsWith(BS_B) && !p.endsWith('\\' + BS_B)) { p = p.slice(0, -2); trail = true; } return [p, lead, trail]; };
const phrasePatternNoB = (phrases) => '(?:' + [...phrases].sort((a, b) => b.length - a.length).map((p) => p.split(/\s+/).map((w) => w.replace(META, '\\$&')).join('\\s+')).join('|') + ')';

export function buildPackOpt(RULES, opts = {}) {
  const { span = 'group1', gate = false, chunked = true, maxChunk = 1500 } = opts;
  const bold = re2jsEngine.compile('\\*\\*[^*\\n]+\\*\\*');
  const flat = []; // parts that need a regex
  const ruleParts = RULES.map((rule, ri) => rule.parts.map((p) => {
    if (p.k === 'metric') return { p };
    let src, lead, trail;
    if (p.k === 'phrase') { src = phrasePatternNoB(p.phrases); lead = true; trail = true; } else { [src, lead, trail] = stripB(p.pattern); }
    const pat = re2jsEngine.compile(src, '');
    const e = { p, pat, lead, trail, src, idx: flat.length };
    flat.push(e);
    return e;
  }));
  let set = null;
  if (gate) { set = new RE2Set(RE2Set.UNANCHORED, 0); for (const e of flat) set.add(e.src); set.compile(); }
  const prepare = (ctx) => {
    ctx.lower = asciiLower(ctx.text);
    ctx.cand = gate ? new Set(set.match(ctx.lower)) : null;
    ctx.chunks = chunked ? chunkRanges(ctx.text, ctx.sentences, maxChunk) : [[0, ctx.text.length]];
  };
  const pack = RULES.map((rule, ri) => ({
    id: rule.id,
    run(ctx) {
      const out = [];
      const { text, lower, sentences } = ctx;
      for (const e of ruleParts[ri]) {
        const p = e.p;
        if (p.k === 'metric') {
          if (p.metric === 'similarity_to_prior') { for (const f of similarityToPrior(text, sentences)) out.push({ s: f.start, e: f.end, v: f.sim }); }
          else {
            const m = ctx.metrics ?? (ctx.metrics = docMetrics(ctx, bold));
            if (m.sentences < p.minSentences) continue;
            const val = m[p.metric];
            if ((p.above !== undefined && val > p.above) || (p.below !== undefined && val < p.below)) out.push({ s: sentences[0].start, e: sentences[0].end, v: val });
          }
          continue;
        }
        if (p.maxDocWords && ctx.words >= p.maxDocWords) continue;
        if (gate && !ctx.cand.has(e.idx)) continue;
        const closeFrom = p.position === 'closing' ? sentences[Math.max(0, sentences.length - 2)].start : -1;
        for (const [cs, ce] of ctx.chunks) {
          const chunk = (cs === 0 && ce === lower.length) ? lower : lower.slice(cs, ce);
          const m = e.pat.re.matcher(chunk);
          const ng = e.pat.ng;
          let ok = m.find();
          while (ok) {
            const s0 = cs + m.start(0), e0 = cs + m.end(0);
            let reject = false;
            if (e.lead && /\w/.test(text[s0]) && !unicodeBoundaryOk(text, s0, s0 + 1, true, false)) reject = true;
            if (!reject && e.trail && /\w/.test(text[e0 - 1]) && !unicodeBoundaryOk(text, e0 - 1, e0, false, true)) reject = true;
            if (!reject && p.position === 'sentence_start') {
              const si = sentenceIndexAt(sentences, s0);
              if (si < 0 || s0 - sentences[si].start > 12 || !SENT_START_PREFIX.test(text.slice(sentences[si].start, s0))) reject = true;
            } else if (!reject && p.position === 'closing' && s0 < closeFrom) reject = true;
            if (!reject && p.post === 'triad1' && !triadSentenceOk(ctx, sentenceIndexAt(sentences, s0))) reject = true;
            if (!reject) {
              let s = s0, e1 = e0;
              if (span === 'group1' && ng && m.start(1) >= 0) { s = cs + m.start(1); e1 = cs + m.end(1); }
              out.push({ s, e: e1 });
              ok = m.find();
            } else ok = (m.end(0) - m.start(0) > 0 || true) && m.start(0) + 1 <= chunk.length ? m.find(m.start(0) + 1) : false;
          }
        }
      }
      return out;
    },
  }));
  pack.prepare = prepare;
  return pack;
}

export const PACK_VARIANTS = {
  naive: { name: 're2js naive (word-boundary + case flag, whole-doc Matcher)', make: (R) => buildPack(re2jsEngine, R, { ci: true, span: 'group1' }) },
  optwhole: { name: 're2js opt A: no word-boundary in RE2, lowercased text, whole-doc Matcher', make: (R) => buildPackOpt(R, { span: 'group1', chunked: false, gate: false }) },
  opt: { name: 're2js opt B: A + per-paragraph Matcher (RECOMMENDED)', make: (R) => buildPackOpt(R, { span: 'group1', chunked: true, gate: false }) },
  optgate: { name: 're2js opt C: B + RE2Set pre-gate', make: (R) => buildPackOpt(R, { span: 'group1', chunked: true, gate: true }) },
  native: { name: 'native RegExp (reference)', make: (R) => buildPack(nativeEngine, R, { ci: true, span: 'group1' }) },
};
