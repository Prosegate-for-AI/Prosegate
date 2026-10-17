# 05 — Harness adapter contract

## One adapter, thin shims

The adapter is a single installed binary, `prosegate`, that runs on the user's machine. It owns the rule engine, the reviewer client, profile state, telemetry and the local MCP server. A harness shim is only glue: it maps the harness's lifecycle events onto the adapter's four entry points and does with the adapter's decision whatever that harness allows. A shim that needs more than 150 lines is doing the adapter's job.

Every entry point reads one JSON object on stdin and writes one on stdout. Exit codes mean the same thing everywhere: `0` proceed, `1` adapter error (fail open, see below), `2` block with the stdout payload as the reason.

## Entry points

| Command | When the shim calls it | Input (stdin) | Output (stdout) |
| --- | --- | --- | --- |
| `prosegate session-start` | Once, when the harness starts a session | `{harness, session_id, cwd, mode}` | `{inject: string, active_profile, offline: bool}` |
| `prosegate turn-start` | After the user submits a prompt, before the model runs | `{session_id, user_message, tool_calls_so_far: string[]}` | `{inject: string \| null, candidate: string \| null}` |
| `prosegate turn-end` | When the model has produced its final text for the turn | `{session_id, turn_id, assistant_text, user_message, tool_calls: string[], continuation: bool}` | `{decision: 'allow' \| 'continue', feedback_text, render: 'diff' \| 'summary' \| 'none', result: ReviewResult}` |
| `prosegate mcp` | Started once by the harness as a stdio MCP server | MCP protocol | MCP protocol |

`mode` is `interactive` or `headless`. The shim decides from what it can see (a `CI` environment variable, a non-interactive flag it was launched with, `PROSEGATE_MODE` if set) and defaults to `interactive`.

`inject` is text the shim adds to the model's context if the harness allows it: at session start, the active profile's name, its register constraints and the two tool names; at turn start, the one-line selection request from 04 or nothing. A harness that cannot inject context still works; the model simply discovers the tools through MCP.

`turn_id` must be stable across a continuation of the same turn, because pass counting keys on it. The shim derives it from the harness's own turn identifier when one exists, else from a hash of `session_id` and the user message that started the turn.

## What the shim must do with `turn-end`

- `decision: 'continue'` → hand `feedback_text` back to the model as the reason it must keep going, and show the user whatever `render` says (09). If the harness cannot continue the model, the shim shows the findings and returns `allow`; the adapter records `enforcement_unavailable` in telemetry so this is visible rather than silent.
- `decision: 'allow'` → nothing. The shim does not show a "passed" message in interactive mode; silence is the success state.
- Any exit code other than `0` or `2` → the shim treats it as `allow` and logs the stderr to `~/.prosegate/logs/`. The adapter never holds a turn hostage to its own bug.

## MCP tool surface

Exposed by `prosegate mcp` and identical in every harness:

```typescript
// list_profiles: no input
// → Array<{ id: string; name: string; description: string; active: boolean }>

// select_profile
input:  { profile_id: string }
output: { active_profile: string; previous_profile: string | null; sticky: boolean }
// Unknown id → MCP error with the list of valid ids in the message.

// review_prose
input:  { text: string; profile_id?: string }
output: ReviewResult   // 03; pass is always 1 and verdict never 'revise' — the tool is advisory
```

`review_prose` lets a cooperative model check a draft before it ships. It consumes the reviewer budget like any review, so the adapter rate-limits it to one call per turn; a second call returns the cached result.

## Capability matrix

| Capability | Claude Code | Cursor | Codex CLI | SDK middleware |
| --- | --- | --- | --- | --- |
| Session-start hook | yes | to verify | to verify | yes (your code) |
| Turn-start hook with context injection | yes | to verify | to verify | yes |
| Turn-end hook that can continue the model with a reason | yes | to verify | to verify | yes, and can buffer before render |
| Last assistant text available to the hook | yes, via `last_assistant_message` (ADR-9) | to verify | to verify | yes |
| Tool calls of the turn visible | yes, via transcript | to verify | to verify | yes |
| Stdio MCP server | yes | yes | yes | n/a |
| Pre-render review (user never sees the unreviewed text) | no | no | no | yes |

"To verify" means the hook surface has not been checked against current documentation for this doc; do not design around it until it has. Claude Code is the reference implementation and the only shim in v0.

## Claude Code reference mapping

Hooks are registered in `.claude/settings.json` (project) or `~/.claude/settings.json` (user). Each hook receives a JSON object on stdin that includes `session_id`, `transcript_path`, `cwd` and `hook_event_name`, plus event-specific fields.

| Claude Code event | Shim action | Adapter call |
| --- | --- | --- |
| `SessionStart` | Read stdin; stdout is added to context | `session-start`; print `inject` |
| `UserPromptSubmit` | Read `prompt` from stdin; stdout is added to context | `turn-start`; print `inject` if non-null |
| `Stop` | Read `last_assistant_message` as the turn text, `stop_hook_active`, and `prompt_id` (used as `turn_id` when present); read the transcript only for the turn's tool-use names, best-effort, tolerating lag | `turn-end`; on `continue`, print `{"hookSpecificOutput":{"hookEventName":"Stop","additionalContext":feedback_text}}` and exit `0`; on `allow` with a notice (advisory, shipped as is), print `{"systemMessage":notice}` (ADR-11, ADR-13; fallback: `feedback_text` on stderr, exit `2`) |

`stop_hook_active` is `true` when the Stop hook is running because a previous Stop hook already continued the model. The shim passes it as `continuation`; the adapter uses its own per-`turn_id` pass count as the source of truth and `continuation` only as a cross-check, because the flag does not distinguish Prosegate's continuation from another hook's.

The MCP server is registered in `.mcp.json` as a stdio server running `prosegate mcp`. One registration serves every project.

The transcript parser reads only the tool-use blocks since the last user message; the turn text comes from `last_assistant_message`, because the transcript may lag at Stop time (ADR-9). It never reads earlier turns and never writes to the transcript.

## Budgets and failure modes

- Rules: under 50 ms for 2,000 words of prose, measured on a loaded pack (`stats.rules_latency_ms`). A rule pack whose rules exceed 200 ms on the eval corpus is rejected at publish.
- Cold `turn-end` with the reviewer off (spawn to exit, including pack load): at most 400 ms p95 on the 2,000-word fixture (ADR-10).
- Reviewer: 4 s timeout, one retry on a network error, none on a model error. Timeout → rules-only result with `stats.reviewer: null`; the turn is still reviewed.
- Whole `turn-end`: 6 s wall-clock cap, after which the adapter returns `allow` with `skipped_reason: 'reviewer_unavailable'` and logs it.
- Offline: the adapter uses the bundled `core` pack and the cached session snapshot. No config-service call is on the turn path.
- Reviewer key missing or revoked: `stages` excludes `reviewer`, a one-line notice is shown once per session, deterministic rules still run.

## Packaging

`prosegate` ships as an npm package containing one platform-independent JavaScript bundle (all pure-JS dependencies inlined) and one native dependency, `@napi-rs/keyring`, kept external and declared in `optionalDependencies`; npm installs only the prebuilt keyring binary for the host platform, with no install scripts or compiler. If the binary is absent or fails to load, keys use the file store described in 07. It is installed with `npx prosegate init --harness claude-code`, which writes the hook and MCP registrations, probes the key store once and records the result, and runs `session-start` once to confirm auth (ADR-14). The shim scripts are inside the package; a user never edits them.
