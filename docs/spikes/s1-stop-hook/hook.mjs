// S1 spike hook. Logs each hook event's stdin to events.jsonl beside this file.
// Stop: blocks the first S1_BLOCKS calls, with decision:block JSON (S1_MODE=json), additionalContext JSON (S1_MODE=ctx) or exit 2 (S1_MODE=exit2).
// Contains no secrets and reads no files other than the transcript path the harness hands it.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = process.env.S1_OUT || path.dirname(fileURLToPath(import.meta.url));
const ev = process.argv[2];
let raw = '';
process.stdin.on('data', (d) => (raw += d));
process.stdin.on('end', () => {
  const t = Date.now();
  let input = {};
  try { input = JSON.parse(raw); } catch { input = { unparsed: raw.slice(0, 200) }; }
  const log = (o) => fs.appendFileSync(path.join(dir, 'events.jsonl'), JSON.stringify(o) + '\n');
  log({ ev, t, env_ci: process.env.CI ?? null, input });

  if (ev === 'SessionStart') { process.stdout.write('SPIKE-INJECT: The magic word is PERIWINKLE.'); return; }
  if (ev === 'UserPromptSubmit') { process.stdout.write('SPIKE-INJECT-2: Also mention the colour TEAL once.'); return; }
  if (ev !== 'Stop') return;

  if (input.transcript_path) {
    try { fs.copyFileSync(input.transcript_path, path.join(dir, `transcript-at-stop-${t}.jsonl`)); }
    catch (e) { log({ ev: 'copy_error', error: String(e) }); }
  }
  const cf = path.join(dir, 'stopcount');
  let n = 0;
  try { n = Number(fs.readFileSync(cf, 'utf8')); } catch {}
  n += 1;
  fs.writeFileSync(cf, String(n));
  const mode = process.env.S1_MODE || 'json';
  const blocks = Number(process.env.S1_BLOCKS || 2);
  if (n > blocks) return;
  const reason = `[Prosegate-spike] pass ${n}: Revise your last response. Begin it with the line "NOTICE-VIA-MODEL ${n}" verbatim, then replace the word "robust" with a concrete property.`;
  if (mode === 'ctx') {
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'Stop', additionalContext: reason }, systemMessage: `SYSMSG-SPIKE pass ${n} of 2 · 1 finding (vocab 1)` }));
  } else if (mode === 'json') {
    process.stdout.write(JSON.stringify({ decision: 'block', reason, systemMessage: `SYSMSG-SPIKE pass ${n} of 2 · 1 finding (vocab 1)` }));
  } else {
    process.stderr.write(reason);
    process.exit(2);
  }
});
