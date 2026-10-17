# S2 spike - OpenAI reviewer-key vending (for the product owner)

This script runs one throwaway experiment on a **sandbox OpenAI org** and writes `s2-report.json`. The report decides how Prosegate vends reviewer keys and the "worst-case exposure per key" number the admin doc must state. Background and the API facts it relies on: `../S2.md`.

## What it does

1. Creates a project named `prosegate-s2-spike-<timestamp>`.
2. Reads its rate limits for one small model and sets conservative ones. Records which fields the API accepts and whether they read back.
3. Creates a service account in that project and keeps its one-time key in memory only.
4. With that key: 20 tiny completions (usage tokens recorded); a restriction of the project to one model and a call to a different model (expect refusal); a short burst after lowering requests/minute (expect HTTP 429, timed); then sets a **1 cent monthly hard spend limit** on the project and sends a few large prompts to see whether, how fast and how far past the cap OpenAI blocks.
5. Polls `/v1/organization/costs` and `/v1/organization/usage/completions` for this project every 60 s (up to 90 min) and records how long spend takes to appear.
6. Deletes the service account and tries the key again at once, after 10 s and after 60 s, recording when it dies.
7. Archives the project. A `finally` block deletes the service account and archives the project even after an error or Ctrl-C.

It prints one JSON line per HTTP request and finishes with the headline number, `worst_case_exposure_per_key_usd`, with its formula shown in the report.

## Cost and time

- Estimated spend with the default flags: **about USD 0.02**. The script prints an estimate and a hard ceiling (about USD 0.11) before it starts, and will not start without `--yes`.
- Hard safety: at most 40 completion calls in total (`--max-calls`), enforced in one place in the code. Rate limits on the project cap spend further.
- Wall clock: up to about 100 minutes, because it waits for OpenAI's reporting to catch up. Leave the terminal open. It stops early once spend has appeared.
- Requirements: Node 20 or newer, and an **Admin API key** (organization settings, Admin keys) for the sandbox org. Do not paste the key into chat or a file.

## Run it

Look at the plan first (no key needed, no network):

```bash
node docs/spikes/s2-openai-vending/spike.mjs --dry-run
```

**Git Bash** (the key is set for this shell session only and typed without echo):

```bash
cd /d/Dev/Projects/Prosegate
read -rs -p "OpenAI admin key: " OPENAI_ADMIN_KEY; echo; export OPENAI_ADMIN_KEY
node docs/spikes/s2-openai-vending/spike.mjs --yes --input-price-per-1m 0.15 --output-price-per-1m 0.60
unset OPENAI_ADMIN_KEY
```

**PowerShell** (works in Windows PowerShell 5.1 and 7; the variable lives only in this window):

```powershell
cd D:\Dev\Projects\Prosegate
$sec = Read-Host "OpenAI admin key" -AsSecureString
$env:OPENAI_ADMIN_KEY = [System.Net.NetworkCredential]::new('', $sec).Password
node docs/spikes/s2-openai-vending/spike.mjs --yes --input-price-per-1m 0.15 --output-price-per-1m 0.60
Remove-Item Env:OPENAI_ADMIN_KEY
```

The two price flags are the **list price per 1M tokens for the model you test** (defaults: gpt-4o-mini, USD 0.15 in / 0.60 out). Check them against your org's pricing page; the exposure number scales with them. Other useful flags: `--model`, `--tpm` (the per-minute token limit you are proposing for vended keys; it drives the exposure formula), `--poll-minutes`. Run with `--help` for the rest.

The script refuses to run without `OPENAI_ADMIN_KEY`, without `--yes`, or if `--max-calls` is too small for the plan.

If the report says the spend-limit test was **inconclusive** (OpenAI said enforcement is not instantaneous, so 8 calls may not be enough), run once more with a bigger budget: `--enforce-max-calls 20 --max-calls 60` (about USD 0.06).

## What to send back

Send `s2-report.json` (it is written to the folder you ran the command in). It contains project and service-account ids, rate-limit numbers, timings, token counts and cost figures, and **no keys**: the admin key and the service-account key are never written, and every response is redacted before logging (fields named `value`, `api_key`, `key`, `secret`, and anything starting `sk-`). The script also checks the finished file for key-shaped strings and records the result in the `secret_check` field. To confirm yourself:

```bash
grep -c "sk-" s2-report.json        # Git Bash: expect 0
```
```powershell
(Select-String -Path s2-report.json -Pattern 'sk-').Count   # PowerShell: expect 0
```

Also send the last screen of console output if anything looked wrong. Exit codes: 0 finished, 1 failed or partial (a report is still written), 2 refused to start, 130 interrupted.

## If the script dies

The cleanup normally runs even on error and Ctrl-C (press Ctrl-C once and wait; a second press quits immediately). If the process was killed hard, or the console says `MANUAL_CLEANUP_NEEDED`:

- Easiest: run `node docs/spikes/s2-openai-vending/spike.mjs --cleanup-orphans --yes` with the same environment variable set. It archives every active project whose name starts with `prosegate-s2-spike-` and deletes their service accounts. Nothing else is touched.
- By hand: OpenAI dashboard, Settings, Projects, find `prosegate-s2-spike-<timestamp>`, delete its service account(s), then archive the project. An archived project cannot spend.

Also unset the environment variable afterwards (commands above), or just close the shell.
