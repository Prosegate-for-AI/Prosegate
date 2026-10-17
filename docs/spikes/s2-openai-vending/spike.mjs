#!/usr/bin/env node
// Prosegate spike S2 - OpenAI reviewer-key vending.
//
// Measures, against a SANDBOX OpenAI org with an admin key:
//   - which project rate-limit fields the Administration API accepts and enforces
//   - whether the per-project hard spend limit (POST .../spend_limit) exists and how
//     fast / how far past the cap it actually enforces
//   - whether a per-project model allowlist stops other models being called
//   - how long /v1/organization/costs and /usage/completions lag behind real spend
//   - how quickly deleting a service account kills its key
// and computes worst_case_exposure_per_key_usd.
//
// Node 20+, ESM, zero dependencies. Reads OPENAI_ADMIN_KEY from the environment only.
// Run `node spike.mjs --help` for flags, `--dry-run --yes` to see the plan offline.

import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const SCHEMA = 'prosegate.spike.s2/1';
const OPENAI_HOST = 'api.openai.com';
const PROJECT_PREFIX = 'prosegate-s2-spike-';

// ---------------------------------------------------------------------------
// Secret hygiene
// ---------------------------------------------------------------------------

const REDACTED = '[REDACTED]';
// Keys whose value is always redacted (any type). `value` is redacted only when it is a string,
// because the costs API uses a numeric `amount.value` that is not a secret and that we must keep.
const SECRET_KEYS_ALWAYS = new Set(['api_key', 'key', 'secret']);
const SECRET_KEYS_IF_STRING = new Set(['value']);
const SK_RE = /\bsk-[A-Za-z0-9_\-*.]{3,}/g;
const BEARER_RE = /Bearer\s+[A-Za-z0-9._~+/=*-]+/gi;
const knownSecrets = new Set();

/** Register a literal secret so that any string containing it is scrubbed everywhere. */
export function registerSecret(s) {
  if (typeof s === 'string' && s.length >= 8) knownSecrets.add(s);
}

/** Scrub secrets out of a free-form string (error messages, URLs, headers). */
export function scrubString(s) {
  let out = String(s);
  for (const k of knownSecrets) out = out.split(k).join(REDACTED);
  out = out.replace(BEARER_RE, `Bearer ${REDACTED}`);
  out = out.replace(SK_RE, REDACTED);
  return out;
}

/** Deep-redact a JSON-like value. Never mutates the input. */
export function redact(v) {
  if (v === null || v === undefined) return v;
  if (typeof v === 'string') return v.startsWith('sk-') ? REDACTED : scrubString(v);
  if (Array.isArray(v)) return v.map(redact);
  if (typeof v === 'object') {
    const out = {};
    for (const [k, val] of Object.entries(v)) {
      const lk = k.toLowerCase();
      if (SECRET_KEYS_ALWAYS.has(lk) || (SECRET_KEYS_IF_STRING.has(lk) && typeof val === 'string')) {
        out[k] = REDACTED;
      } else {
        out[k] = redact(val);
      }
    }
    return out;
  }
  return v;
}

// ---------------------------------------------------------------------------
// Pure helpers (exported for the self-test)
// ---------------------------------------------------------------------------

export function buildQuery(params, arrayStyle = 'brackets') {
  const parts = [];
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    if (Array.isArray(v)) {
      for (const item of v) {
        const name = arrayStyle === 'brackets' ? `${k}[]` : k;
        parts.push(`${encodeURIComponent(name)}=${encodeURIComponent(item)}`);
      }
    } else {
      parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(v)}`);
    }
  }
  return parts.join('&');
}

/**
 * worst_case_exposure_per_key_usd = max_tokens_per_minute x price_per_token x exposure_window_minutes
 * exposure_window_minutes = polling_interval + cost_reporting_lag + revoke_latency
 * price_per_token is the dearer of input/output (a rate limit counts tokens, not their mix).
 */
export function computeExposure({ tpm, inPer1m, outPer1m, pollMin, costLagS, revokeS, capUsd, enforcementLagS }) {
  const pricePerToken = Math.max(inPer1m, outPer1m) / 1e6;
  const missing = [];
  if (costLagS == null) missing.push('cost_reporting_lag_s');
  if (revokeS == null) missing.push('revoke_latency_s');
  const windowMin = pollMin + (costLagS ?? 0) / 60 + (revokeS ?? 0) / 60;
  const usd = tpm * pricePerToken * windowMin;
  const out = {
    formula:
      'worst_case_exposure_per_key_usd = max_tokens_per_minute * price_per_token_usd * (polling_interval_min + cost_reporting_lag_min + revoke_latency_min)',
    price_per_token_rule: 'max(input_price, output_price) / 1e6 - the rate limit counts tokens regardless of mix',
    inputs: {
      max_tokens_per_minute: tpm,
      input_price_per_1m_usd: inPer1m,
      output_price_per_1m_usd: outPer1m,
      price_per_token_usd: pricePerToken,
      polling_interval_min: pollMin,
      cost_reporting_lag_min: costLagS == null ? null : costLagS / 60,
      revoke_latency_min: revokeS == null ? null : revokeS / 60,
      exposure_window_min: windowMin,
    },
    substituted: `${tpm} * ${pricePerToken} * ${round(windowMin, 3)}`,
    worst_case_exposure_per_key_usd: round(usd, 4),
    complete: missing.length === 0,
    missing_inputs: missing,
    note: missing.length ? 'LOWER BOUND: the missing inputs were treated as zero' : undefined,
  };
  if (capUsd != null) {
    // With a monthly hard cap that really enforces, exposure is bounded by cap + what can leak
    // between the cap being crossed and enforcement landing.
    const lag = enforcementLagS;
    out.with_hard_cap = {
      formula: 'cap_usd + max_tokens_per_minute * price_per_token_usd * enforcement_lag_min',
      cap_usd: capUsd,
      enforcement_lag_min: lag == null ? null : lag / 60,
      worst_case_usd: lag == null ? null : round(capUsd + tpm * pricePerToken * (lag / 60), 4),
      note:
        lag == null
          ? 'enforcement lag was not measured; cannot be computed'
          : 'only valid if the hard cap enforced in the test; a single test is not a guarantee',
    };
  }
  return out;
}

export function round(n, d = 4) {
  if (n == null || Number.isNaN(n)) return null;
  const f = 10 ** d;
  return Math.round(n * f) / f;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const FLAGS = {
  help: { t: 'bool', d: false, h: 'show this help' },
  'dry-run': { t: 'bool', d: false, h: 'print the plan with redacted headers; make no network call' },
  yes: { t: 'bool', d: false, h: 'confirm the estimated spend and proceed' },
  'self-test': { t: 'bool', d: false, h: 'run the offline redactor/helper self-test and exit' },
  'cleanup-orphans': { t: 'bool', d: false, h: `archive leftover projects named ${PROJECT_PREFIX}* (and delete their service accounts)` },
  model: { t: 'str', d: 'gpt-4o-mini', h: 'model to rate-limit and call' },
  'other-model': { t: 'str', d: 'gpt-4.1-mini', h: 'a different model, used to test the project model allowlist' },
  'skip-model-allowlist': { t: 'bool', d: false, h: 'skip the model allowlist test' },
  calls: { t: 'int', d: 20, h: 'tiny completion calls in step 4' },
  'max-tokens': { t: 'int', d: 16, h: 'output token cap per call' },
  'token-param': { t: 'str', d: 'max_completion_tokens', h: 'max_completion_tokens | max_tokens' },
  'max-calls': { t: 'int', d: 40, h: 'HARD cap on total completion calls (all phases)' },
  rpm: { t: 'int', d: 30, h: 'max_requests_per_1_minute to set' },
  tpm: { t: 'int', d: 10000, h: 'max_tokens_per_1_minute to set (feeds the exposure formula)' },
  rpd: { t: 'int', d: 200, h: 'max_requests_per_1_day to set (if the API accepts it)' },
  'batch-input-tokens': { t: 'int', d: 50000, h: 'batch_1_day_max_input_tokens to set (if the API accepts it)' },
  'burst-rpm': { t: 'int', d: 5, h: 'requests/min limit set before the 429 burst' },
  'burst-max': { t: 'int', d: 7, h: 'max calls in the burst; stops at the second 429' },
  'burst-spacing-ms': { t: 'int', d: 1500, h: 'gap between burst calls' },
  'skip-enforcement-test': { t: 'bool', d: false, h: 'skip the hard-spend-limit enforcement test' },
  'test-cap-cents': { t: 'int', d: 1, h: 'project hard spend limit used for the enforcement test (API minimum is 1)' },
  'enforce-prompt-tokens': { t: 'int', d: 16000, h: 'approx input tokens per enforcement-test call' },
  'enforce-max-calls': { t: 'int', d: 8, h: 'enforcement-test calls before the polling phase takes over' },
  'enforce-rpm': { t: 'int', d: 60, h: 'rpm set for the enforcement phase' },
  'enforce-tpm': { t: 'int', d: 100000, h: 'tpm set for the enforcement phase' },
  'design-cap-usd': { t: 'num', d: 5, h: 'monthly cap the product would set (07 default); used only in the secondary exposure figure' },
  'design-poll-minutes': { t: 'num', d: 15, h: 'production polling interval used in the exposure formula' },
  'poll-minutes': { t: 'num', d: 90, h: 'max minutes to poll costs/usage' },
  'poll-interval-seconds': { t: 'int', d: 60, h: 'seconds between cost/usage polls' },
  'revoke-wait-seconds': { t: 'int', d: 300, h: 'max seconds to wait for the deleted key to stop working' },
  'key-ttl-seconds': { t: 'int', d: 0, h: 'if >0, create the service account with expires_in_seconds' },
  'input-price-per-1m': { t: 'num', d: 0.15, h: 'USD per 1M input tokens (default = published gpt-4o-mini price, unverified for your org)' },
  'output-price-per-1m': { t: 'num', d: 0.6, h: 'USD per 1M output tokens (same caveat)' },
  out: { t: 'str', d: './s2-report.json', h: 'report path' },
  'base-url': { t: 'str', d: `https://${OPENAI_HOST}`, h: 'testing only: https://api.openai.com or a localhost mock' },
  'time-scale': { t: 'num', d: 1, h: 'testing only (localhost mock): divide all waits by this' },
};

export function parseArgs(argv) {
  const flags = {};
  const errors = [];
  for (const [k, spec] of Object.entries(FLAGS)) flags[k] = spec.d;
  for (let i = 0; i < argv.length; i++) {
    let a = argv[i];
    if (!a.startsWith('--')) {
      errors.push(`unexpected argument: ${a}`);
      continue;
    }
    a = a.slice(2);
    let val;
    const eq = a.indexOf('=');
    if (eq >= 0) {
      val = a.slice(eq + 1);
      a = a.slice(0, eq);
    }
    const spec = FLAGS[a];
    if (!spec) {
      errors.push(`unknown flag: --${a}`);
      continue;
    }
    if (spec.t === 'bool') {
      flags[a] = val === undefined ? true : val !== 'false';
      continue;
    }
    if (val === undefined) val = argv[++i];
    if (val === undefined) {
      errors.push(`--${a} needs a value`);
      continue;
    }
    if (spec.t === 'str') flags[a] = val;
    else {
      const n = Number(val);
      if (!Number.isFinite(n) || (spec.t === 'int' && !Number.isInteger(n))) errors.push(`--${a} must be a ${spec.t === 'int' ? 'whole ' : ''}number`);
      else flags[a] = n;
    }
  }
  return { flags, errors };
}

function helpText() {
  const lines = ['Usage: node spike.mjs [flags]', '', 'Requires OPENAI_ADMIN_KEY in the environment (not needed with --dry-run or --self-test).', ''];
  for (const [k, s] of Object.entries(FLAGS)) lines.push(`  --${k}${s.t === 'bool' ? '' : ' <' + s.t + '>'}  ${s.h}${s.t === 'bool' ? '' : ` (default ${JSON.stringify(s.d)})`}`);
  return lines.join('\n');
}

export function makeConfig(f) {
  const c = {
    model: f.model,
    otherModel: f['other-model'],
    skipAllowlist: f['skip-model-allowlist'] || !f['other-model'],
    calls: f.calls,
    maxTokens: f['max-tokens'],
    tokenParam: f['token-param'],
    maxCalls: f['max-calls'],
    rpm: f.rpm,
    tpm: f.tpm,
    rpd: f.rpd,
    batchInputTokens: f['batch-input-tokens'],
    burstRpm: f['burst-rpm'],
    burstMax: f['burst-max'],
    burstSpacingMs: f['burst-spacing-ms'],
    skipEnforcement: f['skip-enforcement-test'],
    testCapCents: f['test-cap-cents'],
    enforcePromptTokens: f['enforce-prompt-tokens'],
    enforceMaxCalls: f['enforce-max-calls'],
    enforceRpm: f['enforce-rpm'],
    enforceTpm: f['enforce-tpm'],
    designCapUsd: f['design-cap-usd'],
    designPollMin: f['design-poll-minutes'],
    pollMinutes: f['poll-minutes'],
    pollIntervalS: f['poll-interval-seconds'],
    revokeWaitS: f['revoke-wait-seconds'],
    keyTtlS: f['key-ttl-seconds'],
    inPer1m: f['input-price-per-1m'],
    outPer1m: f['output-price-per-1m'],
    pricesAreDefaults: f['input-price-per-1m'] === FLAGS['input-price-per-1m'].d && f['output-price-per-1m'] === FLAGS['output-price-per-1m'].d,
    out: f.out,
    baseUrl: f['base-url'].replace(/\/+$/, ''),
    timeScale: f['time-scale'],
  };
  return c;
}

export function validateConfig(c) {
  const e = [];
  let u;
  try {
    u = new URL(c.baseUrl);
  } catch {
    e.push('--base-url is not a URL');
  }
  if (u) {
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
    if (u.hostname !== OPENAI_HOST && !local) e.push(`--base-url host must be ${OPENAI_HOST} or localhost (the admin key is sent there)`);
    if (u.hostname === OPENAI_HOST && u.protocol !== 'https:') e.push('--base-url must be https for api.openai.com');
    if (u.hostname === OPENAI_HOST && c.timeScale !== 1) e.push('--time-scale is for the localhost mock only; it would corrupt real measurements');
  }
  if (!['max_completion_tokens', 'max_tokens'].includes(c.tokenParam)) e.push('--token-param must be max_completion_tokens or max_tokens');
  if (c.maxCalls < 1 || c.maxCalls > 200) e.push('--max-calls must be 1..200');
  if (c.calls < 1) e.push('--calls must be >= 1');
  if (c.maxTokens < 1 || c.maxTokens > 256) e.push('--max-tokens must be 1..256');
  if (c.enforcePromptTokens < 100 || c.enforcePromptTokens > 100000) e.push('--enforce-prompt-tokens must be 100..100000');
  if (c.testCapCents < 1) e.push('--test-cap-cents must be >= 1');
  if (c.timeScale <= 0) e.push('--time-scale must be > 0');
  if (c.pollIntervalS < 1) e.push('--poll-interval-seconds must be >= 1');
  const need = requiredCalls(c);
  if (need.total > c.maxCalls) {
    e.push(`--max-calls ${c.maxCalls} is below the ${need.total} calls the plan needs (${need.text}); raise --max-calls or lower --calls/--burst-max/--enforce-max-calls`);
  }
  return e;
}

export function requiredCalls(c) {
  const parts = {
    tiny: c.calls,
    burst: c.burstMax,
    allowlist_probe: c.skipAllowlist ? 0 : 1,
    enforcement: c.skipEnforcement ? 0 : c.enforceMaxCalls,
    revoke_checks: 3,
  };
  const total = Object.values(parts).reduce((a, b) => a + b, 0);
  return { parts, total, text: Object.entries(parts).map(([k, v]) => `${k}=${v}`).join(', ') };
}

export function estimateSpend(c) {
  const tinyTokensIn = 60; // generous: the tiny prompt is ~10 tokens
  const tinyCost = (tinyTokensIn * c.inPer1m + c.maxTokens * c.outPer1m) / 1e6;
  const bigCost = (c.enforcePromptTokens * 1.15 * c.inPer1m + c.maxTokens * c.outPer1m) / 1e6;
  const need = requiredCalls(c);
  const planned =
    (need.parts.tiny + need.parts.burst + need.parts.allowlist_probe + need.parts.revoke_checks) * tinyCost +
    need.parts.enforcement * bigCost;
  // Every call counts against --max-calls, so the absolute ceiling is max-calls of the dearer kind.
  const ceiling = c.maxCalls * Math.max(tinyCost, c.skipEnforcement ? 0 : bigCost);
  return { planned_usd: planned, hard_ceiling_usd: ceiling, tiny_call_usd: tinyCost, enforcement_call_usd: bigCost };
}

// ---------------------------------------------------------------------------
// Plan (used by --dry-run)
// ---------------------------------------------------------------------------

function planRequests(c) {
  const P = '<project_id>';
  const lim = { max_requests_per_1_minute: c.rpm, max_tokens_per_1_minute: c.tpm, max_requests_per_1_day: c.rpd, batch_1_day_max_input_tokens: c.batchInputTokens };
  const chat = (content = '<tiny prompt>') => ({ step: '', method: 'POST', path: '/v1/chat/completions', auth: 'service-account key', body: { model: c.model, messages: [{ role: 'user', content }], [c.tokenParam]: c.maxTokens } });
  const rows = [
    { step: '1 create project', method: 'POST', path: '/v1/organization/projects', auth: 'admin', body: { name: `${PROJECT_PREFIX}<timestamp>` } },
    { step: '2 list rate limits', method: 'GET', path: `/v1/organization/projects/${P}/rate_limits?limit=100`, auth: 'admin' },
    { step: '2 set conservative limits (combined; falls back to one field per request if rejected)', method: 'POST', path: `/v1/organization/projects/${P}/rate_limits/<rate_limit_id for ${c.model}>`, auth: 'admin', body: lim },
    { step: '2 read limits back', method: 'GET', path: `/v1/organization/projects/${P}/rate_limits?limit=100`, auth: 'admin' },
    { step: '2 probe hard spend limit (expect none yet)', method: 'GET', path: `/v1/organization/projects/${P}/spend_limit`, auth: 'admin' },
  ];
  if (!c.skipAllowlist) rows.push({ step: '2 restrict project to one model', method: 'POST', path: `/v1/organization/projects/${P}/model_permissions`, auth: 'admin', body: { mode: 'allow_list', model_ids: [c.model] } });
  rows.push(
    { step: '3 create service account (key captured in memory only)', method: 'POST', path: `/v1/organization/projects/${P}/service_accounts`, auth: 'admin', body: { name: 's2-spike-sa', ...(c.keyTtlS > 0 ? { expires_in_seconds: c.keyTtlS } : {}) } },
    { step: '3 wait for key to activate (up to 10 tries, no spend)', method: 'GET', path: '/v1/models', auth: 'service-account key' },
    { ...chat(), step: `4a x${c.calls} tiny completion calls (usage tokens recorded)` },
  );
  if (!c.skipAllowlist) rows.push({ ...chat(), step: `4b x1 call to ${c.otherModel} (expect rejection by the allowlist)`, body: { model: c.otherModel, messages: [{ role: 'user', content: '<tiny prompt>' }], [c.tokenParam]: c.maxTokens } });
  rows.push(
    { step: `4c lower rpm to ${c.burstRpm}`, method: 'POST', path: `/v1/organization/projects/${P}/rate_limits/<rate_limit_id>`, auth: 'admin', body: { max_requests_per_1_minute: c.burstRpm } },
    { ...chat(), step: `4c burst of up to ${c.burstMax} calls every ${c.burstSpacingMs} ms; stop at the 2nd HTTP 429` },
  );
  if (!c.skipEnforcement) {
    rows.push(
      { step: '4d raise limits for the enforcement phase, wait 65 s', method: 'POST', path: `/v1/organization/projects/${P}/rate_limits/<rate_limit_id>`, auth: 'admin', body: { max_requests_per_1_minute: c.enforceRpm, max_tokens_per_1_minute: c.enforceTpm } },
      { step: `4d set project hard spend limit to ${c.testCapCents} cent(s)`, method: 'POST', path: `/v1/organization/projects/${P}/spend_limit`, auth: 'admin', body: { threshold_amount: c.testCapCents, currency: 'USD', interval: 'month' } },
      { step: '4d read it back', method: 'GET', path: `/v1/organization/projects/${P}/spend_limit`, auth: 'admin' },
      { ...chat('<nonce + ~' + c.enforcePromptTokens + ' tokens of filler text>'), step: `4d up to ${c.enforceMaxCalls} calls of ~${c.enforcePromptTokens} input tokens, paced under the tpm; stop at the first spend-limit 429` },
    );
  }
  const q = '?start_time=<utc day start>&bucket_width=1d&project_ids[]=<project_id>&group_by[]=project_id&limit=7';
  rows.push(
    { step: `5 every ${c.pollIntervalS}s for up to ${c.pollMinutes} min: costs`, method: 'GET', path: `/v1/organization/costs${q}`, auth: 'admin' },
    { step: `5 ... and completions usage`, method: 'GET', path: '/v1/organization/usage/completions?start_time=<run start>&bucket_width=1m&project_ids[]=<project_id>&group_by[]=project_id&limit=<n>', auth: 'admin' },
  );
  if (!c.skipEnforcement) rows.push({ ...chat('<nonce + filler text>'), step: '5 (only if enforcement not yet seen and --max-calls allows) one enforcement-size probe per poll' });
  rows.push(
    { step: '6 delete service account', method: 'DELETE', path: `/v1/organization/projects/${P}/service_accounts/<service_account_id>`, auth: 'admin' },
    { ...chat(), step: '6 same key again at +0 s, +10 s, +60 s (3 calls); free GET /v1/models polls in between; stops when 401 seen and the 60 s check is done' },
    { step: '7 archive project', method: 'POST', path: `/v1/organization/projects/${P}/archive`, auth: 'admin' },
    { step: '8 finally{} always: delete service account, archive project (also on error / Ctrl-C)', method: '(none)', path: '- same two requests as 6 and 7, only if not already done', auth: 'admin' },
  );
  return rows;
}

export function formatPlan(c) {
  const lines = [];
  const need = requiredCalls(c);
  const est = estimateSpend(c);
  lines.push('=== Prosegate S2 spike - plan ===');
  lines.push(`base url:            ${c.baseUrl}`);
  lines.push(`project name:        ${PROJECT_PREFIX}<timestamp>`);
  lines.push(`model:               ${c.model}   other model (allowlist test): ${c.skipAllowlist ? '(skipped)' : c.otherModel}`);
  lines.push(`completion calls:    ${need.text}  => planned ${need.total}, HARD CAP --max-calls ${c.maxCalls}`);
  lines.push(`prices used:         input $${c.inPer1m}/1M, output $${c.outPer1m}/1M${c.pricesAreDefaults ? '  (DEFAULTS - pass --input-price-per-1m/--output-price-per-1m for your model)' : ''}`);
  lines.push(`estimated spend:     ~$${est.planned_usd.toFixed(4)} planned, absolute ceiling $${est.hard_ceiling_usd.toFixed(4)} (every one of ${c.maxCalls} calls at the dearest size)`);
  lines.push(`polling:             every ${c.pollIntervalS}s for up to ${c.pollMinutes} min  (whole run can take about ${Math.round(c.pollMinutes + 10)} min)`);
  lines.push('');
  lines.push('Planned requests (Authorization is always redacted here and in the report):');
  for (const r of planRequests(c)) {
    lines.push('');
    lines.push(`# ${r.step}`);
    lines.push(r.method === '(none)' ? r.path : `${r.method} ${c.baseUrl}${r.path}`);
    if (r.method !== '(none)') {
      lines.push(`  Authorization: Bearer ${REDACTED}   (${r.auth})`);
      if (r.body) lines.push('  Content-Type: application/json');
      if (r.body) lines.push(`  body: ${JSON.stringify(redact(r.body))}`);
    }
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Runtime
// ---------------------------------------------------------------------------

class AbortedError extends Error {
  constructor() {
    super('aborted');
    this.name = 'AbortedError';
  }
}
class SpikeError extends Error {}
class BudgetError extends Error {}

// Links the run-wide abort signal with a per-request timeout; dispose() removes the listener
// so hundreds of requests do not pile listeners onto the run signal.
function linkSignals(parent, timeoutMs) {
  const c = new AbortController();
  const onAbort = () => c.abort();
  if (parent.aborted) c.abort();
  else parent.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => c.abort(), timeoutMs);
  return {
    signal: c.signal,
    dispose() {
      clearTimeout(timer);
      parent.removeEventListener('abort', onAbort);
    },
  };
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new AbortedError());
    const onAbort = () => {
      clearTimeout(t);
      reject(new AbortedError());
    };
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, Math.max(0, ms));
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

const iso = (ms) => new Date(ms).toISOString();
const secs = (ms) => (ms == null ? null : round(ms / 1000, 2));

function errInfo(json) {
  const e = json?.error;
  if (!e || typeof e !== 'object') return null;
  return {
    type: e.type ?? null,
    code: e.code ?? null,
    param: e.param ?? null,
    message: e.message ? scrubString(String(e.message)).slice(0, 300) : null,
  };
}

function preview(v, max = 3000) {
  if (v === undefined) return undefined;
  const s = JSON.stringify(v);
  return s.length <= max ? v : { truncated: s.slice(0, max) };
}

function makeCtx(cfg, adminKey) {
  return {
    cfg,
    adminKey,
    saKey: null,
    aborter: new AbortController(),
    steps: [],
    stepN: 0,
    calls: 0,
    completions: [],
    warnings: [],
    project: null,
    sa: null,
    saDeleted: false,
    archived: false,
    runStartMs: Date.now(),
    tFirstBillable: null,
    tLastBillable: null,
    arrayStyle: 'brackets',
    phases: {},
    cleanedUp: false,
    interrupted: false,
  };
}

async function request(ctx, o) {
  const {
    step,
    name,
    method = 'GET',
    path,
    query = '',
    body,
    auth = 'admin',
    timeoutMs = 30000,
    summarize,
    bodyView,
    quiet = false,
    signal = ctx.aborter.signal,
  } = o;
  const retries = o.retries ?? (auth === 'admin' ? 3 : 0);
  const key = auth === 'admin' ? ctx.adminKey : ctx.saKey;
  const url = ctx.cfg.baseUrl + path + (query ? `?${query}` : '');
  for (let attempt = 1; ; attempt++) {
    const startedAt = Date.now();
    const t0 = performance.now();
    let status = 0;
    let json = null;
    let netErr = null;
    const headers = {};
    const link = linkSignals(signal, timeoutMs);
    try {
      const res = await fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${key}`,
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          'User-Agent': 'prosegate-s2-spike/1',
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: link.signal,
      });
      status = res.status;
      const text = await res.text();
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }
      for (const [k, v] of res.headers) if (/^(x-ratelimit-|retry-after$|x-request-id$|openai-processing-ms$)/i.test(k)) headers[k.toLowerCase()] = v;
    } catch (e) {
      if (signal.aborted) throw new AbortedError();
      netErr = scrubString(`${e.name}: ${e.cause?.code ?? e.message}`);
    } finally {
      link.dispose();
    }
    const ms = Math.round(performance.now() - t0);
    const rec = {
      n: ++ctx.stepN,
      step,
      name: name ?? `${method} ${path}`,
      method,
      url: scrubString(url),
      auth_used: auth === 'admin' ? 'admin' : 'service-account',
      started_at: iso(startedAt),
      ms,
      http_status: status || null,
      ok: status >= 200 && status < 300,
      attempt,
      request_body: body === undefined ? undefined : redact(bodyView ?? body),
      response: json === null ? undefined : preview(redact(summarize ? summarize(json) : json)),
      response_headers: Object.keys(headers).length ? headers : undefined,
      network_error: netErr ?? undefined,
    };
    ctx.steps.push(rec);
    if (!quiet) {
      const line = { ...rec };
      const r = JSON.stringify(line.response ?? null);
      line.response = r.length > 300 ? `${r.slice(0, 300)}...(truncated in console)` : line.response;
      console.log(JSON.stringify(line));
    }
    const retryable = (status === 429 || status >= 500 || status === 0) && attempt <= retries && !signal.aborted;
    if (retryable) {
      const ra = Number(headers['retry-after']);
      const wait = Math.min(Number.isFinite(ra) && ra > 0 ? ra : 2 ** attempt, 20) * 1000;
      await sleep(wait / ctx.cfg.timeScale, signal);
      continue;
    }
    return { status, ok: rec.ok, json, headers, ms, at: startedAt + ms, startedAt, netErr, rec };
  }
}

const admin = (ctx, o) => request(ctx, { ...o, auth: 'admin' });

function fail(r, what) {
  const e = errInfo(r.json);
  throw new SpikeError(`${what} failed: HTTP ${r.status}${e ? ` ${e.code ?? e.type ?? ''} ${e.message ?? ''}` : ''}${r.netErr ? ` ${r.netErr}` : ''}`);
}

// Completion calls: the single choke point for the hard --max-calls cap.
async function completion(ctx, { step, kind, prompt, model = ctx.cfg.model, maxTokens = ctx.cfg.maxTokens }) {
  if (ctx.calls >= ctx.cfg.maxCalls) throw new BudgetError(`--max-calls cap (${ctx.cfg.maxCalls}) reached`);
  ctx.calls++;
  const body = { model, messages: [{ role: 'user', content: prompt }], [ctx.cfg.tokenParam]: maxTokens };
  const r = await request(ctx, {
    step,
    name: `completion:${kind}`,
    method: 'POST',
    path: '/v1/chat/completions',
    body,
    bodyView: { model, [ctx.cfg.tokenParam]: maxTokens, prompt_chars: prompt.length },
    auth: 'sa',
    retries: 0,
    summarize: (j) => (j?.error ? { error: errInfo(j) } : { id: j?.id, model: j?.model, usage: j?.usage }),
  });
  const c = {
    call_no: ctx.calls,
    kind,
    model,
    http_status: r.status || null,
    ms: r.ms,
    at_ms: r.at,
    at: iso(r.at),
    usage: r.json?.usage
      ? {
          prompt_tokens: r.json.usage.prompt_tokens ?? 0,
          completion_tokens: r.json.usage.completion_tokens ?? 0,
          total_tokens: r.json.usage.total_tokens ?? 0,
          cached_tokens: r.json.usage.prompt_tokens_details?.cached_tokens ?? 0,
        }
      : null,
    error: errInfo(r.json),
    ratelimit_headers: Object.fromEntries(Object.entries(r.headers).filter(([k]) => k.startsWith('x-ratelimit-') || k === 'retry-after')),
  };
  ctx.completions.push(c);
  if (r.status === 200 && c.usage) {
    ctx.tFirstBillable ??= r.at;
    ctx.tLastBillable = r.at;
  }
  return c;
}

const callCost = (cfg, u) => (u ? (u.prompt_tokens * cfg.inPer1m + u.completion_tokens * cfg.outPer1m) / 1e6 : 0);
const budgetLeft = (ctx) => ctx.cfg.maxCalls - ctx.calls;

function tinyPrompt(i) {
  return `Reply with the single word: ok (${i})`;
}

function bigPrompt(approxTokens) {
  const nonce = Math.random().toString(36).slice(2) + Date.now().toString(36);
  const sentence = 'The quick brown fox jumps over the lazy dog. ';
  const n = Math.ceil(approxTokens / 10);
  // The nonce comes first so prompt caching cannot discount the repeated body.
  return `ref ${nonce}\n${sentence.repeat(n)}\nIgnore the text above and reply with the single word: ok`;
}

// ---- project / rate limits -------------------------------------------------

async function fetchRateLimitEntry(ctx, label) {
  const pid = ctx.project.id;
  let after;
  const models = [];
  for (let page = 0; page < 20; page++) {
    const r = await admin(ctx, {
      step: `list_rate_limits:${label}`,
      path: `/v1/organization/projects/${pid}/rate_limits`,
      query: buildQuery({ limit: 100, after }),
      summarize: (j) => ({ count: j?.data?.length, has_more: j?.has_more, entry: (j?.data ?? []).find((e) => e.model === ctx.cfg.model) ?? null }),
    });
    if (!r.ok) fail(r, 'list rate limits');
    for (const e of r.json.data ?? []) {
      models.push(e.model);
      if (e.model === ctx.cfg.model) return { entry: e, status: r.status };
    }
    if (!r.json.has_more) break;
    after = r.json.last_id ?? r.json.data?.at(-1)?.id;
    if (!after) break;
  }
  throw new SpikeError(`model ${ctx.cfg.model} is not in the project's rate-limit listing. Models listed: ${models.slice(0, 40).join(', ')}${models.length > 40 ? ', ...' : ''}. Re-run with --model set to one of them.`);
}

async function setRateLimits(ctx, rlId, fields, label) {
  const pid = ctx.project.id;
  const path = `/v1/organization/projects/${pid}/rate_limits/${rlId}`;
  const res = { label, requested: fields, combined_ok: false, accepted: [], rejected: [] };
  const r = await admin(ctx, { step: `set_rate_limits:${label}`, name: 'set_rate_limits(combined)', method: 'POST', path, body: fields });
  res.at_ms = r.at;
  if (r.ok) {
    res.combined_ok = true;
    res.accepted = Object.keys(fields);
    return res;
  }
  res.combined_error = { http_status: r.status, ...(errInfo(r.json) ?? {}) };
  for (const [k, v] of Object.entries(fields)) {
    const one = await admin(ctx, { step: `set_rate_limits:${label}`, name: `set_rate_limit_field:${k}`, method: 'POST', path, body: { [k]: v } });
    if (one.ok) {
      res.accepted.push(k);
      res.at_ms = one.at;
    } else res.rejected.push({ field: k, http_status: one.status, ...(errInfo(one.json) ?? {}) });
  }
  return res;
}

// ---- phases ------------------------------------------------------------------

async function phaseCreateProject(ctx) {
  const stamp = new Date(ctx.runStartMs).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const name = `${PROJECT_PREFIX}${stamp}`;
  const r = await admin(ctx, { step: '1_create_project', method: 'POST', path: '/v1/organization/projects', body: { name } });
  if (!r.ok || !r.json?.id) fail(r, 'create project');
  ctx.project = { id: r.json.id, name, created_at_ms: r.at };
  note(`project created: ${ctx.project.id} (${name}). If this script dies, archive projects named ${PROJECT_PREFIX}* in the dashboard.`);
}

async function phaseRateLimits(ctx) {
  const { cfg } = ctx;
  const P = (ctx.phases.rate_limits = { model: cfg.model });
  const before = await fetchRateLimitEntry(ctx, 'initial');
  P.listed_entry_before = before.entry;
  P.fields_present_in_listing = Object.keys(before.entry);
  const fields = {
    max_requests_per_1_minute: cfg.rpm,
    max_tokens_per_1_minute: cfg.tpm,
    max_requests_per_1_day: cfg.rpd,
    batch_1_day_max_input_tokens: cfg.batchInputTokens,
  };
  ctx.rlId = before.entry.id;
  P.apply_conservative = await setRateLimits(ctx, ctx.rlId, fields, 'conservative');
  await sleep(3000 / cfg.timeScale, ctx.aborter.signal); // give the change a moment before reading it back
  const after = await fetchRateLimitEntry(ctx, 'read_back');
  P.listed_entry_after = after.entry;
  P.read_back_matches = Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, after.entry[k] === v]));
  P.fields_not_in_listing_but_attempted = Object.keys(fields).filter((k) => !(k in before.entry));
  // Whether the API accepted a field is not the same as it being applied; read_back_matches says which.
}

async function phaseSpendLimitProbe(ctx) {
  const r = await admin(ctx, { step: '2_spend_limit_probe', path: `/v1/organization/projects/${ctx.project.id}/spend_limit` });
  ctx.phases.spend_limit_initial = { http_status: r.status, body: preview(redact(r.json)), note: '404 "no hard spend limit" is the expected answer on a fresh project; 403, or 404 with an unknown-route message, would mean the endpoint is not available to this key/org' };
}

async function phaseModelAllowlist(ctx) {
  if (ctx.cfg.skipAllowlist) return;
  const r = await admin(ctx, {
    step: '2_model_allowlist',
    method: 'POST',
    path: `/v1/organization/projects/${ctx.project.id}/model_permissions`,
    body: { mode: 'allow_list', model_ids: [ctx.cfg.model] },
  });
  ctx.phases.model_allowlist = { set_http_status: r.status, set_ok: r.ok, error: errInfo(r.json) };
}

async function phaseServiceAccount(ctx) {
  const body = { name: 's2-spike-sa' };
  if (ctx.cfg.keyTtlS > 0) body.expires_in_seconds = ctx.cfg.keyTtlS;
  const r = await admin(ctx, { step: '3_create_service_account', method: 'POST', path: `/v1/organization/projects/${ctx.project.id}/service_accounts`, body });
  if (!r.ok || !r.json?.id) fail(r, 'create service account');
  ctx.sa = { id: r.json.id, created_ms: r.at };
  // Remember the id first so cleanup can find the account even if the key is missing.
  const k = r.json.api_key;
  if (!k || typeof k.value !== 'string') throw new SpikeError('service account was created but the response carried no api_key.value');
  ctx.saKey = k.value;
  registerSecret(k.value);
  ctx.sa.key_id = k.id ?? null;
  ctx.sa.key_expires_at = k.expires_at ?? null;
  ctx.sa.key_prefix_shape = `${k.value.slice(0, 3)}... (length ${k.value.length})`;
  ctx.phases.service_account = {
    service_account_id: ctx.sa.id,
    key_id: ctx.sa.key_id,
    key_expires_at: ctx.sa.key_expires_at,
    key_returned_inline_on_create: true,
    role: r.json.role ?? null,
    key_value_stored: false,
  };
  // Activation: free GET /v1/models polling, no completion spend.
  let activated = null;
  for (let i = 0; i < 10; i++) {
    const m = await request(ctx, { step: '3_key_activation', name: 'activation_probe', path: '/v1/models', auth: 'sa', retries: 0, summarize: (j) => (j?.error ? { error: errInfo(j) } : { object: j?.object, n: j?.data?.length }) });
    if (m.status === 200) {
      activated = m.at;
      break;
    }
    if (m.status === 403) break; // key is live but scoped away from /models; fall through to completions
    await sleep(2000 / ctx.cfg.timeScale, ctx.aborter.signal);
  }
  ctx.phases.service_account.key_activation_lag_s = activated ? secs(activated - ctx.sa.created_ms) : null;
  if (!activated) ctx.warnings.push('GET /v1/models never returned 200 with the new key; activation lag not measured');
}

async function phaseTiny(ctx) {
  const P = (ctx.phases.tiny_calls = { requested: ctx.cfg.calls, results: [] });
  let consecutiveFail = 0;
  for (let i = 1; i <= ctx.cfg.calls; i++) {
    const c = await completion(ctx, { step: '4a_tiny_calls', kind: 'tiny', prompt: tinyPrompt(i) });
    P.results.push(slim(c));
    consecutiveFail = c.http_status === 200 ? 0 : consecutiveFail + 1;
    if (consecutiveFail >= 3) {
      ctx.warnings.push('3 consecutive tiny calls failed; stopped the tiny phase early');
      break;
    }
  }
  const ok = ctx.completions.filter((c) => c.kind === 'tiny' && c.http_status === 200 && c.usage);
  P.ok_count = ok.length;
  P.status_histogram = histogram(ctx.completions.filter((c) => c.kind === 'tiny').map((c) => c.http_status));
  P.usage_totals = sumUsage(ok);
  P.avg_prompt_tokens = ok.length ? round(P.usage_totals.prompt_tokens / ok.length, 1) : null;
  P.avg_completion_tokens = ok.length ? round(P.usage_totals.completion_tokens / ok.length, 1) : null;
  P.latency_ms = latencyStats(ok.map((c) => c.ms));
  P.expected_cost_usd_from_usage = round(ok.reduce((a, c) => a + callCost(ctx.cfg, c.usage), 0), 8);
  if (!ok.length) throw new SpikeError(`no tiny call succeeded; statuses ${JSON.stringify(P.status_histogram)}`);
}

async function phaseAllowlistProbe(ctx) {
  if (ctx.cfg.skipAllowlist) return;
  const c = await completion(ctx, { step: '4b_allowlist_probe', kind: 'allowlist_probe', prompt: tinyPrompt('other'), model: ctx.cfg.otherModel });
  ctx.phases.model_allowlist = {
    ...(ctx.phases.model_allowlist ?? {}),
    other_model: ctx.cfg.otherModel,
    other_model_call: slim(c),
    allowlist_effective: c.http_status !== 200 ? true : false,
    note: c.http_status === 200 ? 'the other model was served: the allowlist did NOT restrict the key (or has not propagated)' : 'the other model was refused',
  };
}

async function phaseBurst(ctx) {
  const { cfg } = ctx;
  const P = (ctx.phases.burst = { rpm_set: cfg.burstRpm, burst_max: cfg.burstMax, calls: [] });
  const upd = await setRateLimits(ctx, ctx.rlId, { max_requests_per_1_minute: cfg.burstRpm }, 'burst');
  P.limit_update = upd;
  const tAck = upd.at_ms ?? Date.now();
  let n429 = 0;
  for (let i = 1; i <= cfg.burstMax; i++) {
    const c = await completion(ctx, { step: '4c_burst', kind: 'burst', prompt: tinyPrompt(`burst${i}`) });
    const rec = { ...slim(c), ms_since_limit_update_ack: c.at_ms - tAck };
    P.calls.push(rec);
    if (c.http_status === 429) {
      n429++;
      if (n429 === 1) {
        P.first_429 = { call_index: i, ms_since_limit_update_ack: c.at_ms - tAck, error: c.error, ratelimit_headers: c.ratelimit_headers };
        P.rate_limit_effective_lag_s = secs(c.at_ms - tAck);
      }
      if (n429 >= 2) break;
    }
    if (i < cfg.burstMax) await sleep(cfg.burstSpacingMs / cfg.timeScale, ctx.aborter.signal);
  }
  P.status_histogram = histogram(P.calls.map((c) => c.http_status));
  P.got_429 = n429 > 0;
  if (!P.got_429) ctx.warnings.push(`no 429 in ${P.calls.length} burst calls at ${cfg.burstRpm} rpm; rate-limit change may not have propagated within the burst window`);
}

// ---- hard spend limit enforcement -------------------------------------------------

function newEnf(ctx) {
  return {
    skipped: ctx.cfg.skipEnforcement,
    api_available: null,
    cap_cents: ctx.cfg.testCapCents,
    cap_usd: ctx.cfg.testCapCents / 100,
    limit_set_at_ms: null,
    limit_set_response: null,
    limit_readback: null,
    calls: [],
    cum_est_usd: 0,
    crossed_at_ms: null,
    blocked: false,
    blocked_at_ms: null,
    done: ctx.cfg.skipEnforcement,
    other_429s: 0,
    errors: 0,
  };
}

async function phaseEnforcementSetup(ctx) {
  const { cfg } = ctx;
  const E = (ctx.enf = newEnf(ctx));
  ctx.phases.enforcement = E;
  if (E.skipped) return;
  const lim = await setRateLimits(ctx, ctx.rlId, { max_requests_per_1_minute: cfg.enforceRpm, max_tokens_per_1_minute: cfg.enforceTpm }, 'enforcement_phase');
  E.rate_limits_for_phase = lim;
  if (lim.rejected.length && lim.accepted.length === 0) {
    E.done = true;
    E.inconclusive_reason = 'could not raise rate limits for the large enforcement-test prompts';
    ctx.warnings.push(E.inconclusive_reason);
    return;
  }
  // Let the burst's per-minute window drain and the new limits propagate.
  await sleep(65000 / cfg.timeScale, ctx.aborter.signal);
  const r = await admin(ctx, {
    step: '4d_set_spend_limit',
    method: 'POST',
    path: `/v1/organization/projects/${ctx.project.id}/spend_limit`,
    body: { threshold_amount: cfg.testCapCents, currency: 'USD', interval: 'month' },
  });
  E.limit_set_response = { http_status: r.status, body: preview(redact(r.json)) };
  E.api_available = r.ok;
  if (!r.ok) {
    E.done = true;
    E.inconclusive_reason = `POST spend_limit refused: HTTP ${r.status} ${errInfo(r.json)?.message ?? ''}`.trim();
    ctx.warnings.push(E.inconclusive_reason);
    return;
  }
  E.limit_set_at_ms = r.at;
  const g = await admin(ctx, { step: '4d_get_spend_limit', path: `/v1/organization/projects/${ctx.project.id}/spend_limit` });
  E.limit_readback = { http_status: g.status, body: preview(redact(g.json)) };
  for (let i = 0; i < cfg.enforceMaxCalls && !E.done; i++) {
    await enforcementCall(ctx);
    if (!E.done && i < cfg.enforceMaxCalls - 1) await sleep(enforcePacingMs(cfg) / cfg.timeScale, ctx.aborter.signal);
  }
}

function enforcePacingMs(cfg) {
  // stay under ~80% of the tpm we set for this phase
  return Math.max(2000, Math.ceil(((cfg.enforcePromptTokens * 1.15) / (cfg.enforceTpm * 0.8)) * 60 * 1000));
}

async function enforcementCall(ctx) {
  const E = ctx.enf;
  const c = await completion(ctx, { step: '4d_enforcement_calls', kind: 'enforce', prompt: bigPrompt(ctx.cfg.enforcePromptTokens) });
  E.calls.push({ ...slim(c), cum_est_usd_after: null });
  const last = E.calls.at(-1);
  if (c.http_status === 200 && c.usage) {
    E.cum_est_usd += callCost(ctx.cfg, c.usage);
    last.cum_est_usd_after = round(E.cum_est_usd, 6);
    if (E.crossed_at_ms == null && E.cum_est_usd >= E.cap_usd) E.crossed_at_ms = c.at_ms;
  } else if (c.http_status === 429) {
    const spend = c.error?.code === 'project_spend_limit_exceeded' || /spend limit/i.test(c.error?.message ?? '');
    if (spend) {
      E.blocked = true;
      E.blocked_at_ms = c.at_ms;
      E.done = true;
      E.first_block = { call_no: c.call_no, error: c.error, ratelimit_headers: c.ratelimit_headers, cum_est_usd_before_block: round(E.cum_est_usd, 6) };
    } else E.other_429s++;
  } else if (c.http_status === 401 || c.http_status === 403) {
    E.done = true;
    E.inconclusive_reason = `key rejected during enforcement test (HTTP ${c.http_status})`;
  } else {
    E.errors++;
  }
  if (E.blocked && budgetLeft(ctx) > 3 && !E.persisted_checked) {
    E.persisted_checked = true;
    await sleep(5000 / ctx.cfg.timeScale, ctx.aborter.signal);
    const again = await completion(ctx, { step: '4d_enforcement_persist', kind: 'enforce_persist', prompt: tinyPrompt('persist') });
    E.block_persisted = again.http_status === 429 && (again.error?.code === 'project_spend_limit_exceeded' || /spend limit/i.test(again.error?.message ?? ''));
    E.persist_check = slim(again);
  }
}

function finalizeEnforcement(ctx) {
  const E = ctx.enf;
  if (!E || E.skipped) return;
  E.est_spend_total_usd = round(E.cum_est_usd, 6);
  if (E.blocked) {
    E.calls_before_block = E.calls.filter((c) => c.http_status === 200).length;
    E.time_from_limit_set_to_block_s = secs(E.blocked_at_ms - E.limit_set_at_ms);
    E.overshoot_est_usd = round(Math.max(0, E.first_block.cum_est_usd_before_block - E.cap_usd), 6);
    E.enforcement_lag_s = E.crossed_at_ms ? secs(Math.max(0, E.blocked_at_ms - E.crossed_at_ms)) : 0;
    E.enforcement_lag_note = E.crossed_at_ms
      ? 'seconds between our own token-based estimate crossing the cap and the first blocked call'
      : 'blocked before our own estimate reached the cap (OpenAI counts more than our estimate, or rounds up); lag treated as 0';
  } else if (!E.inconclusive_reason && E.api_available) {
    E.inconclusive_reason = `not blocked after ${E.calls.length} calls; est spend $${E.est_spend_total_usd} vs cap $${E.cap_usd}. ${E.crossed_at_ms ? 'The cap WAS crossed by our estimate, so enforcement lagged or does not work for this key.' : 'The cap was not crossed by our estimate: re-run with more/larger enforcement calls.'}`;
  }
}

// ---- cost / usage polling ---------------------------------------------------------

async function queryReporting(ctx, kind) {
  const { cfg } = ctx;
  const pid = ctx.project.id;
  const startDay = Math.floor(ctx.runStartMs / 1000 / 86400) * 86400;
  const specs =
    kind === 'costs'
      ? { path: '/v1/organization/costs', params: { start_time: startDay, bucket_width: '1d', project_ids: [pid], group_by: ['project_id'], limit: 7 } }
      : {
          path: '/v1/organization/usage/completions',
          params: {
            start_time: Math.floor(ctx.runStartMs / 1000) - 120,
            bucket_width: '1m',
            project_ids: [pid],
            group_by: ['project_id'],
            limit: Math.min(1440, Math.ceil((Date.now() - ctx.runStartMs) / 60000) + 10),
          },
        };
  let r;
  for (let attempt = 0; attempt < 3; attempt++) {
    r = await admin(ctx, {
      step: `5_poll_${kind}`,
      path: specs.path,
      query: buildQuery(specs.params, ctx.arrayStyle),
      summarize: (j) => ({ buckets: j?.data?.length, has_more: j?.has_more, ...parseReporting(j, pid) }),
    });
    if (r.status !== 400) break;
    // 400 once: try the other array encoding, then drop group_by.
    if (attempt === 0) {
      ctx.arrayStyle = ctx.arrayStyle === 'brackets' ? 'repeat' : 'brackets';
      ctx.warnings.push(`${kind}: HTTP 400 with the first array encoding; switched to ${ctx.arrayStyle}`);
    } else if (attempt === 1) {
      delete specs.params.group_by;
      ctx.warnings.push(`${kind}: HTTP 400 again; retrying without group_by`);
    }
  }
  if (!r.ok) return { ok: false, http_status: r.status, error: errInfo(r.json) };
  return { ok: true, ...parseReporting(r.json, pid), http_status: r.status };
}

function parseReporting(j, pid) {
  const out = { total_usd: 0, requests: 0, input_tokens: 0, output_tokens: 0, foreign_results: 0 };
  for (const b of j?.data ?? []) {
    for (const r of b.results ?? []) {
      if (r.project_id != null && r.project_id !== pid) {
        out.foreign_results++;
        continue;
      }
      if (r.amount && typeof r.amount.value === 'number') out.total_usd += r.amount.value;
      out.requests += r.num_model_requests ?? 0;
      out.input_tokens += r.input_tokens ?? 0;
      out.output_tokens += r.output_tokens ?? 0;
    }
  }
  out.total_usd = round(out.total_usd, 8);
  out.has_more = !!j?.has_more;
  return out;
}

async function phasePoll(ctx) {
  const { cfg } = ctx;
  const P = (ctx.phases.polling = {
    array_param_style_first_try: ctx.arrayStyle,
    poll_interval_s: cfg.pollIntervalS,
    deadline_min: cfg.pollMinutes,
    polls: [],
    cost_first_seen_at: null,
    usage_first_seen_at: null,
  });
  const deadline = Date.now() + (cfg.pollMinutes * 60 * 1000) / cfg.timeScale;
  let pollsSinceCostSeen = 0;
  const t0 = ctx.tFirstBillable ?? ctx.runStartMs;
  for (let i = 1; ; i++) {
    const now = Date.now();
    const okCalls = ctx.completions.filter((c) => c.http_status === 200 && c.usage);
    const expectedUsd = okCalls.reduce((a, c) => a + callCost(cfg, c.usage), 0);
    const [cost, usage] = [await queryReporting(ctx, 'costs'), await queryReporting(ctx, 'usage')];
    const rec = {
      poll: i,
      at: iso(now),
      s_since_first_call: secs(now - t0),
      s_since_last_call: secs(now - (ctx.tLastBillable ?? t0)),
      billable_calls_sent: okCalls.length,
      expected_cost_usd_from_usage_tokens: round(expectedUsd, 8),
      costs: cost.ok ? { total_usd: cost.total_usd, foreign_results: cost.foreign_results } : { error: cost },
      usage: usage.ok ? { requests: usage.requests, input_tokens: usage.input_tokens, output_tokens: usage.output_tokens, foreign_results: usage.foreign_results } : { error: usage },
    };
    P.polls.push(rec);
    if (cost.ok && cost.foreign_results) P.project_filter_ineffective = true;
    if (cost.ok && cost.total_usd > 0 && !P.cost_first_seen_at) {
      P.cost_first_seen_at = iso(now);
      P.cost_first_seen_lag_from_first_call_s = secs(now - t0);
      P.cost_first_seen_lag_from_last_call_s = secs(now - (ctx.tLastBillable ?? t0));
    }
    if (cost.ok && P.cost_first_seen_at) pollsSinceCostSeen++;
    if (cost.ok && expectedUsd > 0 && cost.total_usd >= 0.9 * expectedUsd && !P.cost_complete_at) {
      P.cost_complete_at = iso(now);
      P.cost_complete_lag_from_last_call_s = secs(now - (ctx.tLastBillable ?? t0));
      P.cost_complete_definition = 'first poll where reported cost >= 90% of the cost computed from the token usage returned to us';
    }
    if (usage.ok && usage.requests > 0 && !P.usage_first_seen_at) {
      P.usage_first_seen_at = iso(now);
      P.usage_first_seen_lag_from_first_call_s = secs(now - t0);
      P.usage_first_seen_lag_from_last_call_s = secs(now - (ctx.tLastBillable ?? t0));
    }
    if (usage.ok && usage.requests >= okCalls.length && okCalls.length > 0 && !P.usage_complete_at) {
      P.usage_complete_at = iso(now);
      P.usage_complete_lag_from_last_call_s = secs(now - (ctx.tLastBillable ?? t0));
    }
    // Keep probing the hard spend limit while it is unresolved and budget allows (keep 3 for the revoke checks).
    const E = ctx.enf;
    if (E && !E.skipped && !E.done && budgetLeft(ctx) > 3) await enforcementCall(ctx);

    const seen = P.cost_first_seen_at && P.usage_first_seen_at;
    const enfSettled = !E || E.skipped || E.done || budgetLeft(ctx) <= 3;
    if (seen && (P.cost_complete_at || pollsSinceCostSeen >= 5) && enfSettled) {
      P.stopped_because = 'cost and usage observed';
      break;
    }
    if (Date.now() + (cfg.pollIntervalS * 1000) / cfg.timeScale > deadline) {
      P.stopped_because = 'poll deadline reached';
      ctx.warnings.push(`poll deadline reached; cost first seen: ${!!P.cost_first_seen_at}, usage first seen: ${!!P.usage_first_seen_at}, enforcement settled: ${enfSettled}`);
      break;
    }
    await sleep((cfg.pollIntervalS * 1000) / cfg.timeScale, ctx.aborter.signal);
  }
  const last = P.polls.at(-1);
  P.final_cost_usd = last?.costs.total_usd ?? null;
  P.final_usage_requests = last?.usage.requests ?? null;
}

// ---- revoke ------------------------------------------------------------------------

async function deleteServiceAccount(ctx, { step, signal }) {
  const r = await admin(ctx, {
    step,
    method: 'DELETE',
    path: `/v1/organization/projects/${ctx.project.id}/service_accounts/${ctx.sa.id}`,
    signal,
  });
  if (r.ok || r.status === 404) ctx.saDeleted = true;
  return r;
}

async function phaseRevoke(ctx) {
  const { cfg } = ctx;
  const P = (ctx.phases.revoke = { checks: [] });
  const tStart = Date.now();
  const r = await deleteServiceAccount(ctx, { step: '6_delete_service_account' });
  const tAck = r.at;
  P.delete_http_status = r.status;
  P.delete_ack_ms = tAck - tStart;
  if (!r.ok && r.status !== 404) {
    ctx.warnings.push(`service account delete returned HTTP ${r.status}; revoke latency not measured`);
    P.revoke_latency_s = null;
    return;
  }
  const isDead = (s) => s === 401 || s === 403 || s === 404;
  const checkpoints = [0, 10, 60];
  let ci = 0;
  let firstDeadAt = null;
  const waitMs = (cfg.revokeWaitS * 1000) / cfg.timeScale;
  const scaled = (s) => (s * 1000) / cfg.timeScale;
  while (true) {
    const elapsed = Date.now() - tAck;
    if (ci < checkpoints.length && elapsed >= scaled(checkpoints[ci])) {
      // The mandated checks use a real completion call (counts against --max-calls).
      const c = await completion(ctx, { step: '6_revoke_check', kind: 'revoke_check', prompt: tinyPrompt(`revoke${checkpoints[ci]}`) });
      P.checks.push({ via: 'completion', planned_offset_s: checkpoints[ci], actual_offset_s: secs((c.at_ms - tAck) * cfg.timeScale), http_status: c.http_status, error: c.error, dead: isDead(c.http_status) });
      if (isDead(c.http_status) && firstDeadAt == null) firstDeadAt = c.at_ms;
      ci++;
      continue;
    }
    if (ci >= checkpoints.length && firstDeadAt != null) break;
    if (elapsed > waitMs) break;
    const m = await request(ctx, { step: '6_revoke_check', name: 'revoke_poll_models', path: '/v1/models', auth: 'sa', retries: 0, summarize: (j) => (j?.error ? { error: errInfo(j) } : { n: j?.data?.length }), quiet: true });
    P.checks.push({ via: 'GET /v1/models (free)', actual_offset_s: secs((m.at - tAck) * cfg.timeScale), http_status: m.status, dead: isDead(m.status) });
    if (isDead(m.status) && firstDeadAt == null) firstDeadAt = m.at;
    const pace = elapsed < scaled(20) ? 2000 : 5000;
    const nextCp = ci < checkpoints.length ? scaled(checkpoints[ci]) - (Date.now() - tAck) : pace;
    await sleep(Math.max(100, Math.min(pace / cfg.timeScale, nextCp)), ctx.aborter.signal);
  }
  P.revoked = firstDeadAt != null;
  P.revoke_latency_s = firstDeadAt != null ? secs((firstDeadAt - tStart) * cfg.timeScale) : null;
  P.revoke_latency_definition = 'time from sending the DELETE until the first request with the old key got 401/403/404 (an upper bound; includes the DELETE round trip)';
  P.stayed_dead_at_60s = P.checks.filter((c) => c.via === 'completion' && c.planned_offset_s === 60).every((c) => c.dead) && ci === checkpoints.length;
  P.expected_status = 401;
  P.observed_dead_statuses = [...new Set(P.checks.filter((c) => c.dead).map((c) => c.http_status))];
  if (!P.revoked) ctx.warnings.push(`key STILL WORKED ${cfg.revokeWaitS}s after the service account was deleted - revoke-by-delete is not reliable`);
}

async function archiveProject(ctx, { step, signal }) {
  const r = await admin(ctx, { step, method: 'POST', path: `/v1/organization/projects/${ctx.project.id}/archive`, signal });
  if (r.ok || (r.status === 400 && /already archived/i.test(errInfo(r.json)?.message ?? ''))) ctx.archived = true;
  return r;
}

async function phaseArchive(ctx) {
  const r = await archiveProject(ctx, { step: '7_archive_project' });
  ctx.phases.archive = { http_status: r.status, ok: r.ok, error: errInfo(r.json) };
  const rv = ctx.phases.revoke;
  if (rv && rv.revoked === false && budgetLeft(ctx) > 0) {
    const c = await completion(ctx, { step: '7_post_archive_check', kind: 'post_archive_check', prompt: tinyPrompt('archived') });
    ctx.phases.archive.key_dead_after_archive = c.http_status === 401 || c.http_status === 403 || c.http_status === 404;
    ctx.phases.archive.post_archive_status = c.http_status;
  }
}

async function cleanup(ctx) {
  if (ctx.cleanedUp) return;
  ctx.cleanedUp = true;
  if (!ctx.project) return;
  const fresh = new AbortController().signal; // the run signal may already be aborted
  const out = (ctx.phases.cleanup = { service_account_deleted: ctx.saDeleted, project_archived: ctx.archived, ran_because: [] });
  try {
    if (ctx.sa && !ctx.saDeleted) {
      out.ran_because.push('service account not yet deleted');
      const r = await deleteServiceAccount(ctx, { step: 'cleanup_delete_service_account', signal: fresh });
      out.service_account_deleted = ctx.saDeleted;
      out.sa_delete_http_status = r.status;
    }
    if (!ctx.archived) {
      out.ran_because.push('project not yet archived');
      const r = await archiveProject(ctx, { step: 'cleanup_archive_project', signal: fresh });
      out.project_archived = ctx.archived;
      out.archive_http_status = r.status;
    }
  } catch (e) {
    out.error = scrubString(e.message);
  }
  if (!ctx.archived || (ctx.sa && !ctx.saDeleted)) {
    out.MANUAL_CLEANUP_NEEDED = `Archive project ${ctx.project.id} (${ctx.project.name}) in the OpenAI dashboard (Settings > Projects) and delete its service account.`;
    console.error(out.MANUAL_CLEANUP_NEEDED);
  }
}

// ---- reporting helpers -----------------------------------------------------------

const slim = (c) => ({ call_no: c.call_no, kind: c.kind, model: c.model, http_status: c.http_status, ms: c.ms, at: c.at, usage: c.usage, error: c.error, ratelimit_headers: Object.keys(c.ratelimit_headers ?? {}).length ? c.ratelimit_headers : undefined });

function histogram(arr) {
  const h = {};
  for (const x of arr) h[x ?? 'network_error'] = (h[x ?? 'network_error'] ?? 0) + 1;
  return h;
}
function sumUsage(calls) {
  const s = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, cached_tokens: 0 };
  for (const c of calls) for (const k of Object.keys(s)) s[k] += c.usage?.[k] ?? 0;
  return s;
}
function latencyStats(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return { min: s[0], p50: s[Math.floor(s.length / 2)], max: s.at(-1) };
}

function note(msg) {
  console.log(JSON.stringify({ note: scrubString(msg) }));
}

function buildReport(ctx, outcome, errorMsg) {
  const { cfg } = ctx;
  const P = ctx.phases;
  const poll = P.polling;
  const rev = P.revoke;
  const enf = ctx.enf;
  const okCalls = ctx.completions.filter((c) => c.http_status === 200 && c.usage);
  const totals = sumUsage(okCalls);
  const expectedUsd = okCalls.reduce((a, c) => a + callCost(cfg, c.usage), 0);
  const finalCost = poll?.final_cost_usd ?? null;
  const reqs = poll?.final_usage_requests ?? null;
  const observed = {
    billable_calls_sent: okCalls.length,
    tokens_sent: totals,
    expected_cost_usd_from_usage_tokens_and_price_flags: round(expectedUsd, 8),
    reported_cost_usd_last_poll: finalCost,
    reported_requests_last_poll: reqs,
    observed_cost_per_call_usd: finalCost != null && okCalls.length ? round(finalCost / okCalls.length, 8) : null,
    observed_cost_per_call_note: 'mixes tiny and large enforcement-test calls; use implied_blended_price_per_1m_tokens_usd for pricing',
    implied_blended_price_per_1m_tokens_usd: finalCost != null && totals.total_tokens ? round((finalCost / totals.total_tokens) * 1e6, 4) : null,
    reported_over_expected_ratio: finalCost != null && expectedUsd > 0 ? round(finalCost / expectedUsd, 3) : null,
    price_flags_are_defaults: cfg.pricesAreDefaults,
  };
  const costLag = poll?.cost_first_seen_lag_from_first_call_s ?? null;
  const costCompleteLag = poll?.cost_complete_lag_from_last_call_s ?? null;
  const lagUsed = costLag == null ? null : Math.max(costLag, costCompleteLag ?? 0);
  const exposure = computeExposure({
    tpm: cfg.tpm,
    inPer1m: cfg.inPer1m,
    outPer1m: cfg.outPer1m,
    pollMin: cfg.designPollMin,
    costLagS: lagUsed,
    revokeS: rev?.revoke_latency_s ?? null,
    capUsd: cfg.designCapUsd,
    enforcementLagS: enf?.blocked ? enf.enforcement_lag_s : null,
  });
  exposure.cost_reporting_lag_s_used = lagUsed;
  exposure.cost_reporting_lag_rule = 'max(first-seen lag measured from the FIRST billable call, cost-complete lag measured from the LAST call)';
  exposure.revoke_latency_s_used = rev?.revoke_latency_s ?? null;
  const rl = P.rate_limits;
  const report = {
    schema: SCHEMA,
    outcome,
    error: errorMsg ? scrubString(errorMsg) : undefined,
    started_at: iso(ctx.runStartMs),
    finished_at: iso(Date.now()),
    node: process.version,
    base_url: cfg.baseUrl,
    flags: { ...cfg },
    project: ctx.project ? { id: ctx.project.id, name: ctx.project.name } : null,
    service_account: ctx.sa ? { id: ctx.sa.id, key_id: ctx.sa.key_id ?? null, key_expires_at: ctx.sa.key_expires_at ?? null } : null,
    completion_calls_total: ctx.calls,
    completion_calls_cap: cfg.maxCalls,
    accepted_rate_limit_fields: rl
      ? {
          model: rl.model,
          accepted_in_conservative_update: rl.apply_conservative?.accepted ?? [],
          rejected_in_conservative_update: rl.apply_conservative?.rejected ?? [],
          combined_request_ok: rl.apply_conservative?.combined_ok ?? null,
          fields_present_in_listing: rl.fields_present_in_listing,
          read_back_matches_requested: rl.read_back_matches,
        }
      : null,
    hard_spend_limit: enf
      ? {
          api_available: enf.api_available,
          initial_get: P.spend_limit_initial ?? null,
          set_response: enf.limit_set_response,
          readback: enf.limit_readback,
          enforcement_test_skipped: enf.skipped,
          enforcement_blocked: enf.skipped ? null : enf.blocked,
          calls_before_block: enf.calls_before_block ?? null,
          time_from_limit_set_to_block_s: enf.time_from_limit_set_to_block_s ?? null,
          est_spend_at_first_block_usd: enf.first_block?.cum_est_usd_before_block ?? null,
          overshoot_est_usd: enf.overshoot_est_usd ?? null,
          enforcement_lag_s: enf.enforcement_lag_s ?? null,
          block_error: enf.first_block?.error ?? null,
          block_persisted: enf.block_persisted ?? null,
          inconclusive_reason: enf.inconclusive_reason ?? null,
        }
      : null,
    measured_lags_s: {
      rate_limit_change_effective: P.burst?.rate_limit_effective_lag_s ?? null,
      key_activation: P.service_account?.key_activation_lag_s ?? null,
      cost_first_seen_from_first_call: costLag,
      cost_first_seen_from_last_call: poll?.cost_first_seen_lag_from_last_call_s ?? null,
      cost_complete_from_last_call: costCompleteLag,
      usage_first_seen_from_first_call: poll?.usage_first_seen_lag_from_first_call_s ?? null,
      usage_first_seen_from_last_call: poll?.usage_first_seen_lag_from_last_call_s ?? null,
      usage_complete_from_last_call: poll?.usage_complete_lag_from_last_call_s ?? null,
      revoke_after_service_account_delete: rev?.revoke_latency_s ?? null,
      hard_spend_limit_enforcement: enf?.blocked ? enf.enforcement_lag_s : null,
    },
    observed,
    worst_case_exposure_per_key_usd: exposure.worst_case_exposure_per_key_usd,
    exposure,
    phases: P,
    warnings: ctx.warnings,
    steps: ctx.steps,
    secret_check: null,
  };
  return report;
}

function writeReport(ctx, report) {
  let text = JSON.stringify(redact(report), null, 2);
  const leaked = [...knownSecrets].some((k) => text.includes(k)) || /sk-[A-Za-z0-9_-]{8,}/.test(text);
  if (leaked) {
    text = scrubString(text);
    ctx.warnings.push('secret scrubber fired on the final report text; inspect before sharing');
  }
  const final = JSON.parse(text);
  final.secret_check = leaked ? 'scrubber fired - inspect' : 'passed: neither key value nor any key-shaped string appears in this file';
  writeFileSync(ctx.cfg.out, JSON.stringify(final, null, 2));
  return final;
}

// ---- orphan cleanup -----------------------------------------------------------------

async function cleanupOrphans(ctx) {
  let after;
  const found = [];
  for (let page = 0; page < 20; page++) {
    const r = await admin(ctx, { step: 'orphans_list_projects', path: '/v1/organization/projects', query: buildQuery({ limit: 100, after, include_archived: false }), summarize: (j) => ({ n: j?.data?.length, has_more: j?.has_more }) });
    if (!r.ok) fail(r, 'list projects');
    for (const p of r.json.data ?? []) if (typeof p.name === 'string' && p.name.startsWith(PROJECT_PREFIX) && p.status !== 'archived') found.push(p);
    if (!r.json.has_more) break;
    after = r.json.last_id ?? r.json.data?.at(-1)?.id;
    if (!after) break;
  }
  note(`found ${found.length} active project(s) named ${PROJECT_PREFIX}*`);
  for (const p of found) {
    ctx.project = { id: p.id, name: p.name };
    const sas = await admin(ctx, { step: 'orphans_list_service_accounts', path: `/v1/organization/projects/${p.id}/service_accounts`, query: buildQuery({ limit: 100 }), summarize: (j) => ({ n: j?.data?.length }) });
    for (const sa of sas.json?.data ?? []) {
      ctx.sa = { id: sa.id };
      await deleteServiceAccount(ctx, { step: 'orphans_delete_service_account' });
    }
    ctx.archived = false;
    await archiveProject(ctx, { step: 'orphans_archive_project' });
  }
}

// ---- main ---------------------------------------------------------------------------

function selfTest() {
  const results = [];
  const check = (name, cond) => results.push({ name, pass: !!cond });
  const fakeAdmin = 'sk-' + 'admin-ABCDEF1234567890abcdef'; // split so the repo secret scan does not match a fixture
  const fakeSa = 'sk-' + 'svcacct-ZZZZ9999yyyy8888XXXX';
  registerSecret(fakeSa);
  const sample = {
    object: 'organization.project.service_account',
    id: 'svc_acct_1',
    api_key: { object: 'x', value: fakeSa, id: 'key_1' },
    nested: [{ value: fakeSa }, { key: 'anything', secret: 123, note: `Incorrect API key provided: ${fakeAdmin}.` }],
    msg: `auth failed for Bearer ${fakeAdmin} and ${fakeSa}`,
    plain: 'sk-live-whatever',
    amount: { value: 0.0123, currency: 'usd' },
    ok: 'hello',
  };
  const out = redact(sample);
  const text = JSON.stringify(out);
  console.log('input :', JSON.stringify(sample));
  console.log('output:', text);
  check('field named api_key redacted', out.api_key === REDACTED);
  check('string field named value redacted', out.nested[0].value === REDACTED);
  check('fields named key and secret redacted', out.nested[1].key === REDACTED && out.nested[1].secret === REDACTED);
  check('sk- inside free text redacted', !text.includes(fakeAdmin) && !text.includes('ABCDEF1234567890'));
  check('registered secret removed from free text', !text.includes('ZZZZ9999'));
  check('string starting sk- redacted', out.plain === REDACTED);
  check('Bearer token redacted', !/Bearer\s+sk-/.test(text));
  check('numeric amount.value kept (costs API)', out.amount.value === 0.0123);
  check('harmless text kept', out.ok === 'hello' && out.id === 'svc_acct_1');
  check('input not mutated', sample.api_key.value === fakeSa);
  check('query brackets', buildQuery({ project_ids: ['p1', 'p2'], limit: 1 }) === 'project_ids%5B%5D=p1&project_ids%5B%5D=p2&limit=1');
  check('query repeat', buildQuery({ project_ids: ['p1'] }, 'repeat') === 'project_ids=p1');
  const ex = computeExposure({ tpm: 10000, inPer1m: 0.15, outPer1m: 0.6, pollMin: 15, costLagS: 600, revokeS: 30, capUsd: 5, enforcementLagS: 60 });
  check('exposure formula', Math.abs(ex.worst_case_exposure_per_key_usd - 10000 * (0.6 / 1e6) * (15 + 10 + 0.5)) < 1e-4);
  const p = parseArgs(['--calls', '5', '--dry-run', '--model=x']);
  check('arg parsing', p.flags.calls === 5 && p.flags['dry-run'] === true && p.flags.model === 'x' && p.errors.length === 0);
  check('unknown flag rejected', parseArgs(['--nope']).errors.length === 1);
  const c = makeConfig(parseArgs(['--max-calls', '10']).flags);
  check('max-calls below plan is refused', validateConfig(c).some((m) => m.includes('--max-calls')));
  check('default plan fits default cap', validateConfig(makeConfig(parseArgs([]).flags)).length === 0);
  check('non-openai base url refused', validateConfig(makeConfig(parseArgs(['--base-url', 'https://evil.example']).flags)).length > 0);
  for (const r of results) console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.name}`);
  const failed = results.filter((r) => !r.pass).length;
  console.log(failed ? `${failed} FAILED` : `all ${results.length} checks passed`);
  return failed === 0;
}

export async function main(argv, env) {
  const { flags, errors } = parseArgs(argv);
  if (flags.help) {
    console.log(helpText());
    return 0;
  }
  if (flags['self-test']) return selfTest() ? 0 : 1;
  if (errors.length) {
    console.error(errors.join('\n') + '\n\nRun with --help for flags.');
    return 2;
  }
  const cfg = makeConfig(flags);
  const cfgErrors = validateConfig(cfg);
  if (cfgErrors.length) {
    console.error('Refusing to run:\n  ' + cfgErrors.join('\n  '));
    return 2;
  }

  if (flags['cleanup-orphans']) {
    if (flags['dry-run']) {
      console.log(`Would GET ${cfg.baseUrl}/v1/organization/projects, then for each active project named ${PROJECT_PREFIX}*: list + DELETE its service accounts, POST .../archive. Authorization: Bearer ${REDACTED}`);
      return 0;
    }
    const k = env.OPENAI_ADMIN_KEY;
    if (!k) return console.error('OPENAI_ADMIN_KEY is not set; refusing to run.'), 2;
    if (!flags.yes) return console.error(`This will archive every active project named ${PROJECT_PREFIX}* in the org that owns this admin key. Re-run with --yes.`), 2;
    registerSecret(k);
    const ctx = makeCtx(cfg, k);
    try {
      await cleanupOrphans(ctx);
      return 0;
    } catch (e) {
      console.error(scrubString(e.message));
      return 1;
    }
  }

  const est = estimateSpend(cfg);
  if (flags['dry-run']) {
    console.log(formatPlan(cfg));
    console.log('\n(dry run: no network call was made, OPENAI_ADMIN_KEY was not read)');
    return 0;
  }

  const adminKey = env.OPENAI_ADMIN_KEY;
  if (!adminKey) {
    console.error('OPENAI_ADMIN_KEY is not set. Refusing to run. (Set it for this shell only; see README.md.)');
    return 2;
  }
  registerSecret(adminKey);
  console.log(formatPlan(cfg));
  console.log(`\nEstimated spend ~$${est.planned_usd.toFixed(4)}; absolute ceiling $${est.hard_ceiling_usd.toFixed(4)}.`);
  if (!flags.yes) {
    console.error('\nRe-run with --yes to proceed. Nothing has been sent.');
    return 2;
  }

  const ctx = makeCtx(cfg, adminKey);
  let outcome = 'complete';
  let errorMsg;
  let exitCode = 0;

  const onSignal = (sig) => {
    if (ctx.interrupted) {
      console.error(`\nSecond ${sig}: exiting now. ${ctx.project ? `MANUAL CLEANUP: archive project ${ctx.project.id} (${ctx.project.name}) and delete its service account.` : ''}`);
      process.exit(130);
    }
    ctx.interrupted = true;
    console.error(`\n${sig}: stopping, cleaning up (delete service account, archive project), then writing the report. Press again to force quit.`);
    ctx.aborter.abort();
  };
  for (const s of ['SIGINT', 'SIGTERM', 'SIGBREAK']) {
    try {
      process.on(s, () => onSignal(s));
    } catch {
      /* signal not supported on this platform */
    }
  }

  try {
    await phaseCreateProject(ctx);
    await phaseRateLimits(ctx);
    await phaseSpendLimitProbe(ctx);
    await phaseModelAllowlist(ctx);
    await phaseServiceAccount(ctx);
    await phaseTiny(ctx);
    await phaseAllowlistProbe(ctx);
    await phaseBurst(ctx);
    await phaseEnforcementSetup(ctx);
    ctx.enf ??= newEnf(ctx);
    await phasePoll(ctx);
    await phaseRevoke(ctx);
    await phaseArchive(ctx);
  } catch (e) {
    if (e instanceof AbortedError || ctx.interrupted) {
      outcome = 'interrupted';
      exitCode = 130;
    } else if (e instanceof BudgetError) {
      outcome = 'partial';
      errorMsg = e.message;
      exitCode = 1;
    } else {
      outcome = 'failed';
      errorMsg = e instanceof SpikeError ? e.message : `${e.name}: ${e.message}`;
      exitCode = 1;
    }
    console.error(`\n${outcome.toUpperCase()}: ${scrubString(errorMsg ?? 'interrupted')}`);
  } finally {
    try {
      await cleanup(ctx);
    } catch (e) {
      console.error('cleanup error: ' + scrubString(e.message));
    }
    finalizeEnforcement(ctx);
    const report = writeReport(ctx, buildReport(ctx, outcome, errorMsg));
    console.log(`\nReport written to ${cfg.out}  (outcome: ${outcome}; secret check: ${report.secret_check})`);
    console.log(`worst_case_exposure_per_key_usd = ${report.worst_case_exposure_per_key_usd}${report.exposure.complete ? '' : '  (LOWER BOUND - see exposure.missing_inputs)'}`);
  }
  return exitCode;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main(process.argv.slice(2), process.env).then(
    (code) => {
      process.exitCode = code;
    },
    (e) => {
      console.error('fatal: ' + scrubString(e?.message ?? String(e)));
      process.exitCode = 1;
    },
  );
}
