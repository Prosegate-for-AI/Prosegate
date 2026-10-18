# 09 — Enforcement UX

## Principles

Silence is the success state: a turn that passes shows nothing. A turn that is revised shows the user exactly what was flagged, once, in at most seven lines, and then the model's revised response. The notice is the product's only visible surface in daily use, so it has to be worth reading every time it appears; if it is not, the user runs `prosegate advisory` and the product is over.

The model receives `feedback_text` (03). The user receives a notice. They are different strings: the model's is imperative and complete; the user's is a summary with the spans.

## Render modes

| Mode | Where it is the default | The user sees |
| --- | --- | --- |
| `diff` | Interactive sessions | One notice line, then one line per finding: category, rule id if any, the span trimmed to 60 chars; then the model's revised response |
| `summary` | Headless and CI; interactive on pass 2 | One notice line with counts by category |
| `none` | Never a default; set by profile or `prosegate quiet` | Nothing; the model is still continued |

Notice line format: `Prosegate · profile pr-description · 3 findings (hedge 1, unsupported claim 1, triad 1) · revising, pass 1 of 2`.

How the notice reaches the user depends on the harness. Where the shim has a user-visible channel separate from the model's output, it uses that. In Claude Code the harness always shows the user the continuation feedback itself ("Stop hook feedback: …"), so on a continuing turn `feedback_text` is the notice and no second notice is sent; the 09 notice line goes through `systemMessage` (displayed as "Stop says: …") only on turns that end without a continuation: advisory, "shipped as is", and the once-per-session key notice (ADR-11, ADR-13). Rendering details (order, columns, trimming, the first-notice override line, the pass-cap check) are fixed in ADR-12. Where a harness has no such channel, `feedback_text` ends with an instruction to begin the revised response with the notice line verbatim, so the model carries it. The second route is less reliable and is logged as `notice_via_model` in telemetry so its failure rate is known.

## Override and modes

| Command | Effect | Scope |
| --- | --- | --- |
| `prosegate advisory` | Findings are still computed and shown in `summary` form; the model is never continued | Session; cleared at next session start |
| `prosegate enforce` | Restores enforcement | Session |
| `prosegate quiet` | Enforcement stays on; the user notice is suppressed | Session |
| `prosegate off` | No review, no notice, no telemetry beyond `override_used` | Session |
| `prosegate profile <id>` | Sets the active profile and clears candidate state | Session |
| `prosegate rule off <id>` / `rule on <id>` / `rule list` | Disables or re-enables one rule in a local overlay of the active profile; lists local disables (ADR-27) | Persistent, local |
| `PROSEGATE_MODE=advisory\|off` | Same as the commands, for CI and scripts | Process |

Commands that lower enforcement refuse when run from an agent's tool context, with `prosegate <cmd> must be run by you in a terminal, not by the agent.` (ADR-27).

The `feedback_text` sent to the model always ends by telling the model not to run prosegate commands and telling the user how to pause (`prosegate advisory`), and the first notice of a session names the override too (ADR-16). Org policy can set `enforcement_default` to `required`, which makes `advisory` and `off` refuse with `Enforcement is required by <org>; ask an admin, or uninstall.` The same policy limits selection to the org's own profiles and ignores local overlays for the session (ADR-18). That is an org admin's call, and the doc for admins says plainly that it costs them adoption.

## Pass cap

- Pass 1: any `block` finding → continue, `diff` notice.
- Pass 2: only `block` findings that survived from pass 1 → continue, `summary` notice: `Prosegate · 1 of 3 findings remain · revising, pass 2 of 2`.
- After pass 2: allow regardless. If findings remain: `Prosegate · 1 finding remains after 2 passes · shipped as is` so the user knows to look.
- A pass that produces zero findings prints nothing, even on pass 2.

## Wrong profile

The notice always names the profile. If it is wrong, the user either types `prosegate profile <id>` or tells the model ("use the design-doc profile"), which calls `select_profile`. The correction applies from the next turn; the current turn is not re-reviewed, because the model already spent the pass on the wrong rules and a third pass is worse than a visible mistake.

At session start, if the active profile's version changed since the last session, one line says so: `Prosegate · profile pr-description updated to v5 (2 rules changed) · prosegate profile diff to see`.

## Headless and CI

No notice, no colour, no interactive prompts. The model is still continued with `feedback_text`, so the artifact the pipeline consumes is the revised one. `render` is forced to `summary`, written to `~/.prosegate/sessions/<id>/report.json` (findings, passes, cleared) and to stderr once at exit, so a CI log shows one line per reviewed turn. The harness's exit code is never changed by Prosegate.

## Mock transcripts

Pass 1 revise, interactive, Claude Code:

```text
> write the PR description for this branch

[model] This PR introduces a robust caching layer that significantly improves
performance. It's worth noting that the cache is per tenant, which makes the
system fast, simple, and reliable. …

Prosegate · profile pr-description · 3 findings (hedge 1, vocab 1, triad 1) · revising, pass 1 of 2
  hedge   core.hedge.001  "It's worth noting that"
  vocab   core.vocab.003  "robust"
  triad   core.triad.001  "fast, simple, and reliable"

[model] Add a per-tenant cache in front of the catalog reads. p95 latency on
/catalog drops from 410 ms to 95 ms on the staging dataset. …
```

Pass cap reached:

```text
Prosegate · profile design-doc · 2 findings (unsupported claim 2) · revising, pass 1 of 2
  unsupported claim  "reduces cost by 40%"
  unsupported claim  "the industry standard approach"

[model] … (revised; one claim cited, one left in)

Prosegate · 1 of 2 findings remain · revising, pass 2 of 2

[model] … (revised again; claim still present)

Prosegate · 1 finding remains after 2 passes · shipped as is
```

Advisory mode:

```text
$ prosegate advisory
Prosegate: advisory for this session. Findings will be shown, not enforced. Run prosegate enforce to restore.

> summarise the incident

[model] … (response as written)

Prosegate · profile chat-reply · 2 findings (filler 1, structure 1) · advisory, not enforced
```

## Noise budget

At most one notice per turn. Never more than the notice line plus six finding lines. No notice on pass, no "Prosegate is running" banners after the first line of a session, no emoji, no colour beyond dim for the finding lines where the terminal supports it. A user who sees a Prosegate line should always be able to act on it.
