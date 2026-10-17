// Deterministic synthetic prose generator for the S4 benchmark.
import { countWords } from './engine.mjs';

export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SUBJ = ['The cache layer', 'The retry loop', 'Each worker', 'The scheduler', 'A failed request', 'The migration', 'The config loader', 'Our parser', 'The build step', 'The primary index', 'The queue consumer', 'A stale entry', 'The deploy script', 'The audit log', 'The rate limiter', 'The gateway', 'Every replica', 'The compiler', 'A slow query', 'The health check', 'The importer', 'The session store', 'The metrics agent', 'Our test suite', 'The release job'];
const VERB = ['writes {o} to disk', 'reads {o} before the first request', 'skips {o} when the flag is set', 'rejects {o} larger than the limit', 'logs {o} at debug level', 'retries {o} three times', 'caches {o} for ten minutes', 'drops {o} after a timeout', 'copies {o} into the staging bucket', 'validates {o} against the schema', 'compresses {o} before upload', 'hashes {o} with a fixed salt', 'renames {o} once the lock is free', 'counts {o} per partition', 'sorts {o} by creation time'];
const OBJ = ['the session token', 'each batch', 'the lockfile', 'a partial write', 'the schema version', 'the user record', 'every header', 'the checksum', 'old snapshots', 'the pending jobs', 'the temporary files', 'a duplicate key', 'the response body', 'the request id', 'unused columns'];
const TAIL = ['', '', ' during startup', ' on the primary node', ' without blocking the caller', ' unless the key is missing', ' because the upstream is slow', ', which keeps memory flat', ' in under a second', ' for every tenant', ' after the nightly rollup', ' when the disk is full', ', then moves on'];
const SHORT = ['That fixes it.', 'Nothing else changes.', 'The test passes.', 'It runs on Linux.', 'We checked twice.', 'Latency drops by 30 ms.', 'Rollback takes a minute.', 'The default is four.', 'Memory stays under 200 MB.'];
const LISTY = ['Install git, node, and pnpm before you start the build.', 'The result is fast, stable, and cheap to run in production.', 'Ana, Ben, and Chloe reviewed the change on Tuesday afternoon.', 'We tried caching, batching, and sharding, but only batching helped.', 'The plan covers Monday, Tuesday, and Friday of next week.'];
const HITS = [
  "Great question! Let's dive into the cache layer.",
  'This document outlines the migration plan for the primary region.',
  "It's worth noting that the index is unique across all tenants.",
  'The query is relatively slow when the table has no partitions.',
  'Arguably, the retry is unnecessary for idempotent writes here.',
  'This could potentially break the build on older runners today.',
  'It depends.',
  'We can leverage the existing cache to speed up the lookup path.',
  'The current landscape of auth libraries is crowded and uneven.',
  'A robust and seamless integration is hard to get right in practice.',
  'This is incredibly useful for anyone who runs the nightly job.',
  'There are a number of options for storing the session token safely.',
  'It is fast, simple, and reliable under normal production load.',
  "It's not just about speed, it's about trust in the output we ship.",
  "Whether it's a startup or an enterprise, the same pattern holds up well.",
  'We moved from Berlin to Paris, and everything changed for the team.',
  'Overall, the fix is a testament to careful review by the whole team.',
  'In many cases the timeout is the real culprit behind the slow requests.',
  'This is a highly effective way to keep the queue short at peak times.',
  "Let's explore how the scheduler assigns work to each of the workers.",
];

function pick(r, a) { return a[Math.floor(r() * a.length)]; }
function sentence(r) {
  const k = r();
  if (k < 0.1) return pick(r, SHORT);
  if (k < 0.16) return pick(r, LISTY);
  return pick(r, SUBJ) + ' ' + pick(r, VERB).replace('{o}', pick(r, OBJ)) + pick(r, TAIL) + '.';
}

// Prose with no markdown. hitRate = probability that a sentence is drawn from the hit pool.
export function makeDoc({ words = 2000, hitRate = 0.05, seed = 1, curly = 0.5, closing = true } = {}) {
  const r = rng(seed);
  const paras = [];
  let cur = [];
  let total = 0;
  const flush = () => { if (cur.length) { paras.push(cur.join(' ')); cur = []; } };
  let target = 3 + Math.floor(r() * 4);
  while (total < words) {
    let s = r() < hitRate ? pick(r, HITS) : sentence(r);
    if (curly && r() < curly) s = s.replace(/'/g, '’');
    cur.push(s);
    total += countWords(s);
    if (cur.length >= target) { flush(); target = 3 + Math.floor(r() * 4); }
  }
  flush();
  if (closing) paras.push('Let me know if you have any questions!');
  return paras.join('\n\n');
}

// neutral filler prose of >= n words (no rule hits)
export function neutral(n, seed = 7) {
  const r = rng(seed);
  const out = [];
  let t = 0;
  while (t < n) {
    const s = pick(r, SUBJ) + ' ' + pick(r, VERB).replace('{o}', pick(r, OBJ)) + '.';
    out.push(s); t += countWords(s);
  }
  return out.join(' ');
}

export function pathological() {
  const rr = rng(99);
  const alpha = 'abcdefghijklmnopqrstuvwxyz';
  const w = () => { let n = 2 + Math.floor(rr() * 7), s = ''; while (n--) s += alpha[Math.floor(rr() * 26)]; return s; };
  let noPunct = '';
  while (noPunct.length < 10000) noPunct += w() + ' ';
  return {
    'a, a, a, and a x400 (2,000 words, no sentence end)': 'a, a, a, and a '.repeat(400),
    'Aa, aa, aa, and aa. x400 (400 sentences, triad.001 hits each)': 'Aa, aa, aa, and aa. '.repeat(400),
    'a, a, a, a, a, ... (no "and", 4,000 items)': 'a, '.repeat(4000),
    '10,000-char single sentence, no punctuation': noPunct.slice(0, 10000),
    '"not just " x1100 (triad.002 lazy window)': 'not just '.repeat(1100),
    '"it depends" / "somewhat " x1100': 'somewhat '.repeat(1100),
    '"from a to b, " x800 (triad.003)': 'from a to b, '.repeat(800),
    '"the current " x800 (vocab.002 near-miss)': 'the current '.repeat(800),
    '10,000 x "a" (one 10k-char word)': 'a'.repeat(10000),
    '10,000-char run of commas and spaces': ', '.repeat(5000),
  };
}
