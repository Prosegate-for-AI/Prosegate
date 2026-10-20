# Prosegate hooks and MCP tools

Build and pack the adapter from the repository, then install that tarball:

```sh
pnpm release:prepare .scratch/release-preview
npx --package=.scratch/release-preview/prosegate-0.1.0-alpha.3.tgz prosegate init --harness claude-code --local
```

Re-running init upgrades an existing hook installation and adds MCP. It checks both hook execution and MCP initialization/tool discovery before completing. Start a new Claude Code session afterward.

For a published preview, use `npx --package=prosegate@next prosegate init --harness claude-code --local`. For an unreleased build, use the prepared tarball above. Preview releases do not use npm's `latest` tag.

This is an alpha preview. Local tools are Apache-2.0; LICENSE, PRIVACY.md and bundled
dependency notices ship in the release tarball. Release preparation requires a new
output directory and includes an isolated installation check. The service and
dashboard are separate FSL-1.1-ALv2 components and are not included in this package.

By default, hooks go in the user Claude settings and the MCP server in `~/.claude.json`. With `CLAUDE_CONFIG_DIR`, both live under that directory; `PROSEGATE_CLAUDE_HOME` is an explicit adapter override. `--scope project` installs hooks in `.claude/settings.local.json` and an MCP entry in Claude's private **local** project scope in the user config. It creates no shared `.mcp.json`. Existing settings and unrelated servers are preserved; a conflicting server named `prosegate` is refused. `prosegate uninit` (with the same scope) removes only matching registrations. Backups live in the private Prosegate home.

## Tools

| Tool | Arguments | Result |
| --- | --- | --- |
| `list_profiles` | `{}` | Available profile IDs, names, descriptions and active flag |
| `select_profile` | `{"profile_id":"local/design-doc"}` | Active/previous IDs, sticky flag and style guidance |
| `review_prose` | `{"text":"Draft...", "profile_id":"local/email"}` | Advisory `prosegate.findings/1`; `profile_id` is optional |

The tools run through `prosegate mcp` over stdio. Normal hooks and `review_prose` use **local rules only**. Paid AI review remains an explicit preview command until the Phase 4 rollout gate is met. No API key is needed for these MCP tools.

A review requires a current user turn and accepts at most 102,400 UTF-16 code units. It always uses pass 1 and never requests a revision. The first result is cached for the turn, including across server restarts; later calls return that result even if the draft or requested profile changes. The optional review profile does not select a new active profile. Advisory checks do not consume the Stop hook's revision passes.

Cached findings contain excerpts of the checked draft. They remain in the private session directory until the turn completes, the next turn starts, or a fresh session starts. Compaction preserves the current turn. Abandoned files are swept on session start after one hour, like the stored user prompt.

## Profile suggestions

The selector checks literal, case-insensitive phrases in the first 2,000 characters of the prompt and exact harness tool hints. A hint or at least two distinct phrases prompts Claude to call `select_profile` immediately. A single-phrase match must win on two consecutive user turns. No match, a tie, or the active profile winning clears the candidate. Duplicate deliveries of one turn-start hook do not advance it.

The heuristic asks Claude to choose; it does not change profiles itself. Claude can also select without a prompt. A selection made before the first Stop review applies immediately. During a revision, the original profile remains pinned and the new choice applies to the next turn. The completed-turn notice shows profile changes, including for clean prose.

Profiles with `trigger.sticky: false` revert to the previous durable profile after the completed review, including after revisions. They do not become the remembered default for the working directory. The next prompt refreshes the active style guidance. `prosegate profile <id>` from your own terminal clears pending suggestions and changes the session profile.

## Session binding

The default server discovers exactly one recently active session in its launch directory (`CLAUDE_PROJECT_DIR` when provided by Claude). It refuses ambiguous same-folder sessions and never retargets an already bound server to a different session. It does not guess from the newest timestamp.

For a harness running several sessions in the same folder, give **each server instance** its own explicit binding:

```sh
prosegate mcp --session <session-id>
```

`PROSEGATE_SESSION` is the equivalent environment setting. The hook's `session_id` and the session directories under `~/.prosegate/sessions/` identify the sessions; `prosegate status` also lists candidates when the folder is ambiguous. Do not put one shared session ID in a registration used by several chats. Automatic per-process binding for concurrent Claude chats remains a follow-up because Claude's documented MCP environment does not supply a session ID.
