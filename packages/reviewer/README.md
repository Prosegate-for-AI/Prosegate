# Reviewer preview

The reviewer detects unsupported claims, generic answers to specific questions, and mismatches with a profile's tone, format or length. It never rewrites. The originating agent remains responsible for revisions.

This is an explicit preview. Normal Claude Code hooks still run deterministic rules only. The plan requires one week of rules-only dogfood before reviewer wiring, and live rubric/latency evaluation is still required before either provider is release-qualified.

## Try it

Build the workspace (`pnpm install`, `pnpm build`). In your own terminal, save a provider key using hidden input:

```text
node packages/adapter/dist/prosegate.mjs key set openai
node packages/adapter/dist/prosegate.mjs key status openai
node packages/adapter/dist/prosegate.mjs key remove openai
```

Use `anthropic` instead for Anthropic. A password-manager pipe can supply `key set openai --stdin`. Never place a key in command arguments, a chat, a request JSON file, or a committed file. The command reports presence only and never displays the key. `PROSEGATE_KEY_STORE=file` explicitly selects an owner-only local file; `keychain` requires a successful OS keychain probe. With neither, a failed probe selects the file store and prints a one-time notice. Administrator access remains possible. Changing the backend from keychain to file requires entering the key again; it does not copy inaccessible OS credentials onto disk.

The preview reads a `prosegate.review/1` JSON request on stdin. For example, save this structure as `request.json`, replacing `text` with a draft of at least 150 prose words for the default profile:

```json
{
  "schema": "prosegate.review/1",
  "text": "Your draft goes here.",
  "context": { "user_message": "What is the measured latency?", "style_constraints": "", "mode": "interactive" },
  "profile_id": "local/base",
  "pass": 1,
  "stages": ["rules", "reviewer"],
  "session_id": "manual",
  "turn_id": "manual",
  "prior_findings": []
}
```

PowerShell:

```powershell
Get-Content -Raw request.json | node packages/adapter/dist/prosegate.mjs review --provider openai
```

POSIX shells:

```sh
node packages/adapter/dist/prosegate.mjs review --provider openai < request.json
```

Stdout is a findings JSON result. Stderr explains a missing key or reviewer failure; deterministic findings remain available. Exit 0 means a result was produced, not that prose passed: inspect `verdict` and `stats.reviewer`. A null reviewer statistic means no successful AI review occurred. Pass 2 accepts the prior finding IDs, ignores word floors, and does not promote newly introduced findings. If the reviewer fails on pass 2, the preview conservatively reports no cleared IDs.

## Data and failure boundaries

- The draft, last user message (at most 2,000 characters), style constraints (at most 1,500), and register specification go directly to the selected provider. Code segments are replaced with `[code block omitted]`. Provider retention terms still apply; OpenAI requests set `store: false`.
- Only fixed HTTPS endpoints are used. Redirects are refused. There is no Prosegate server request, transcript upload, conversation history, telemetry upload or logging of input/provider bodies.
- The transport candidates are `gpt-5.4-mini-2026-03-17` (OpenAI Responses, strict JSON schema, no reasoning) and `claude-haiku-5-5` (Anthropic Messages, forced findings tool). These are not yet certified by live rubric or latency evals.
- A maximum of six validated findings survive. The reviewer re-finds exact UTF-16 spans only within prose, excluding inline masks and quoted/code/table segments. Unsupported claims receive the fixed citation/softening/removal fork. Register findings cannot block. Injection filters and the profile category/provider policy apply locally.
- One retry total for network or schema errors, none for HTTP failures, refusals or incomplete model output. All attempts and response-body reads share a maximum four-second budget. Bodies are capped at 64 KiB. Drafts over 100 Ki UTF-16 code units skip the reviewer.
- Key-store metadata is in `key-store.json`; secrets are separate in the OS keychain or `keys.json`. Native operations run in a bounded child with private pipes. File writes use an owner-only temporary directory, exclusive creation, fsync, and atomic rename. A migration deletes the file only after all keys have been read back from the keychain.
- Key mutations and migrations are serialized. A process killed while holding `key-store.lock` leaves that lock behind: close all key/review commands, then remove only that lock from the Prosegate home and retry. Locks are never stolen from a potentially live process.

## Verification

`pnpm exec vitest run packages/reviewer packages/adapter/test/key-store.test.ts packages/adapter/test/reviewer-command.test.ts` uses synthetic provider responses and temporary homes. The 30-draft span smoke test verifies local mapping, not real-model recall. Live provider latency, rubric quality, macOS native keychain behavior, and the one-week rollout gate remain unverified.
