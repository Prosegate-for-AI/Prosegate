// S1 spike runner: drives headless Claude Code with an isolated --settings file
// (user settings are not touched) and records what the Stop hook sees and what it can do.
// Usage: node docs/spikes/s1-stop-hook/run.mjs [--model haiku]
// Requires a logged-in `claude` CLI. Writes s1-report.json into the system temp dir and prints its path.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const model = process.argv.includes('--model') ? process.argv[process.argv.indexOf('--model') + 1] : 'haiku';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'prosegate-s1-'));
const fwd = (p) => p.replace(/\\/g, '/');

const PROMPT =
  'First run the shell command `echo spike-tool-call` with the Bash tool. Then answer in markdown: ' +
  'a "## Cache" heading, one paragraph that uses the word "robust" and a curly apostrophe (it’s), ' +
  'a two-item bullet list, and a ```js code block with `const a = 1;`. If you know a magic word, include it.';

// Strip host-session variables so a nested run uses the CLI's own login.
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(CLAUDECODE|CLAUDE_CODE_|ANTHROPIC_BASE_URL)/.test(k)));

function runMode(mode) {
  const out = path.join(root, mode);
  const work = path.join(out, 'work');
  fs.mkdirSync(work, { recursive: true });
  const hook = (ev, timeout) => ({ type: 'command', command: `node "${fwd(path.join(here, 'hook.mjs'))}" ${ev}`, timeout });
  const settings = {
    hooks: {
      SessionStart: [{ hooks: [hook('SessionStart', 30)] }],
      UserPromptSubmit: [{ hooks: [hook('UserPromptSubmit', 30)] }],
      Stop: [{ hooks: [hook('Stop', 10)] }],
    },
  };
  const sfile = path.join(out, 'settings.json');
  fs.writeFileSync(sfile, JSON.stringify(settings, null, 2));
  const t0 = Date.now();
  const r = spawnSync('claude', ['-p', PROMPT, '--settings', sfile, '--model', model, '--allowedTools', 'Bash(echo *)', '--output-format', 'stream-json', '--verbose'], {
    cwd: work, env: { ...env, S1_MODE: mode, S1_BLOCKS: '2', S1_OUT: out }, encoding: 'utf8', timeout: 300_000,
  });
  fs.writeFileSync(path.join(out, 'stream.jsonl'), r.stdout ?? '');
  fs.writeFileSync(path.join(out, 'stderr.txt'), r.stderr ?? '');
  return analyse(mode, out, r.status, Date.now() - t0);
}

function readJsonl(f) {
  if (!fs.existsSync(f)) return [];
  return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return { unparsed: l.slice(0, 120) }; } });
}

function assistantTexts(lines) {
  return lines.filter((l) => l.type === 'assistant').map((l) => (l.message?.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('')).filter(Boolean);
}
function toolUseNames(lines) {
  return lines.filter((l) => l.type === 'assistant').flatMap((l) => (l.message?.content ?? []).filter((c) => c.type === 'tool_use').map((c) => c.name));
}

function analyse(mode, out, exit, ms) {
  const events = readJsonl(path.join(out, 'events.jsonl'));
  const stream = readJsonl(path.join(out, 'stream.jsonl'));
  const stops = events.filter((e) => e.ev === 'Stop');
  const transcripts = fs.readdirSync(out).filter((f) => f.startsWith('transcript-at-stop-')).sort();
  const streamTexts = assistantTexts(stream);
  const result = stream.find((l) => l.type === 'result');
  const streamStr = fs.readFileSync(path.join(out, 'stream.jsonl'), 'utf8');
  return {
    mode, exit, wall_ms: ms,
    auth_error: /Failed to authenticate/.test(streamStr) || null,
    session_start_fields: Object.keys(events.find((e) => e.ev === 'SessionStart')?.input ?? {}),
    user_prompt_fields: Object.keys(events.find((e) => e.ev === 'UserPromptSubmit')?.input ?? {}),
    stop_calls: stops.length,
    stop_fields: [...new Set(stops.flatMap((s) => Object.keys(s.input)))],
    stop_hook_active_sequence: stops.map((s) => s.input.stop_hook_active ?? null),
    prompt_id_sequence: stops.map((s) => s.input.prompt_id ?? null),
    last_assistant_message: stops.map((s) => s.input.last_assistant_message ?? null),
    last_message_equals_final_stream_text: stops.map((s, i) => (s.input.last_assistant_message ?? null) === (streamTexts[streamTexts.length - stops.length + i] ?? undefined)),
    contains_curly_apostrophe: stops.map((s) => (s.input.last_assistant_message ?? '').includes('’')),
    contains_code_fence: stops.map((s) => (s.input.last_assistant_message ?? '').includes('```')),
    transcript_at_stop: transcripts.map((f) => {
      const lines = readJsonl(path.join(out, f));
      const texts = assistantTexts(lines);
      return { file: f, lines: lines.length, tool_use_names: toolUseNames(lines), last_text_head: (texts.at(-1) ?? '').slice(0, 80) };
    }),
    revisions_begin_with_notice: streamTexts.map((t) => (t.match(/^\s*NOTICE-VIA-MODEL \d/) ?? [null])[0]),
    system_message_in_stream: /SYSMSG-SPIKE/.test(streamStr),
    user_notifications: stream.filter((l) => l.type === 'system' && (l.subtype === 'notification' || l.subtype === 'informational')).map((l) => l.text ?? l.content),
    feedback_as_seen_by_model: stream.filter((l) => l.type === 'user').flatMap((l) => (Array.isArray(l.message?.content) ? l.message.content : [])).filter((c) => c.type === 'text').map((c) => c.text.slice(0, 60)),
    reason_in_stream: /\[Prosegate-spike\]/.test(streamStr),
    stream_event_types: [...new Set(stream.map((l) => `${l.type}${l.subtype ? ':' + l.subtype : ''}`))],
    inject_seen_by_model: streamTexts.some((t) => /PERIWINKLE/i.test(t)),
    prompt_inject_seen_by_model: streamTexts.some((t) => /TEAL/i.test(t)),
    final_result_head: (result?.result ?? '').slice(0, 120),
    out_dir: out,
  };
}

const report = { claude_version: spawnSync('claude', ['--version'], { encoding: 'utf8', env }).stdout?.trim(), model, ran_at: new Date().toISOString(), runs: (process.env.S1_MODES || 'json,ctx,exit2').split(',').map(runMode) };
const rf = path.join(root, 's1-report.json');
fs.writeFileSync(rf, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
console.log(`\nreport: ${rf}`);
