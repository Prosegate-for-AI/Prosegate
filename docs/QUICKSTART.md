# Install and use the writing-review build

These instructions install the current source from `main`. Pushing source does
not publish a new npm version; an existing `prosegate@next` package may not contain
these writing rules. Use Node.js 22 and pnpm 10.33.2 (the versions used by this
workspace). Git and npm must also be on your PATH.

## Build and install — PowerShell

For a fresh checkout:

```powershell
git clone https://github.com/Prosegate-for-AI/Prosegate.git
Set-Location Prosegate
pnpm install --frozen-lockfile
pnpm release:prepare .scratch/writing-preview
npm install --global ./.scratch/writing-preview/prosegate-0.1.0-alpha.5.tgz
prosegate --version
```

Release preparation builds and checks the package in an isolated installation.
It needs a new output directory; choose another name if `.scratch/writing-preview`
already exists. This is a local preview artifact, not an npm publication. Its
`manifest.json` and `SHA256SUMS` identify the source and package contents. The
package still reports `0.1.0-alpha.5`, so use the manifest's source commit to
distinguish this build from earlier artifacts with that version.

For an existing clean checkout, pull `main` before the install/build steps above.
In the working directory of the project where you use Claude Code, run:

```powershell
prosegate init --harness claude-code --local --scope project
```

Start a new Claude Code session afterward. Omit `--scope project` for user-wide
installation. Re-running `init` from the updated package upgrades registrations
and the installed program. Initialization supplies profile guidance at session
start and installs Stop hooks plus MCP tools. It preserves unrelated settings.

## Local checks in Claude Code

Ask Claude: **“Select the Prosegate `local/writing-review` profile and review my
writing.”** It can use `list_profiles`, `select_profile`, and `review_prose`.
You can also run `prosegate profile local/writing-review` in the same project
after a Claude session starts, and inspect `prosegate status`.

This profile's automatic checks are the two local warning rules for redundant
padding and hedging. **The 34 contextual checks run only through the explicit
review command below.** Selecting a profile does not enable paid calls in hooks
or MCP. The existing profiles retain their own local-rule settings.

## Full contextual review

Save an Anthropic API key through the hidden terminal prompt:

```powershell
prosegate key set anthropic
prosegate key status anthropic
```

From the repository root, copy and edit the supplied request example, then run:

```powershell
Copy-Item examples/writing-review.request.json .scratch/my-review.json
# Edit text and context in .scratch/my-review.json.
Get-Content -Raw .scratch/my-review.json | prosegate review --provider anthropic
```

The [example](../examples/writing-review.request.json) selects
`local/writing-review` and includes both `rules` and `reviewer` stages. Replace
`text` with your draft and `context.user_message` with the actual writing task.
Supply `source_material` when checking factual support, `audience` when specialist
language matters, and `original_text` when checking a revision for lost meaning.
Omit unavailable optional fields; do not leave unrelated example evidence in place.

Results are JSON with findings, instructions and reviewer statistics. A supported
claim can correctly return no findings. These checks start as warnings. Inspect
`stats.reviewer`: if it is null, no successful AI review occurred, even if the
command exited successfully. Stderr reports provider/key failures. Calls use your
provider account and send the draft and supplied context to that provider.
Enter keys only at the hidden prompt, never in the request file.

OpenAI is also supported with `key set openai` and `review --provider openai`;
the latest live writing evaluation used Anthropic. These synthetic regression
results do not qualify either provider for automatic rollout.

## Update or remove

To update, pull `main`, install pinned dependencies, prepare into a fresh output
directory, install that tarball globally and re-run `init` with the same scope.
Start a new Claude session.

To remove this project's hooks and MCP registration:

```powershell
prosegate uninit --scope project
```

Use `prosegate uninit` for a user-wide installation. If retiring Prosegate entirely,
remove saved keys with `prosegate key remove anthropic` (and/or `openai`), then run
`npm uninstall --global prosegate`. Uninstalling the global command alone does not
remove hook registrations or saved keys.

See [writing rules](WRITING-REVIEW.md), [hook/MCP behavior](../packages/adapter/README.md)
and [reviewer details](../packages/reviewer/README.md) for limits and session binding.
