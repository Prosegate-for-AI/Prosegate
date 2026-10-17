# 01 — Scope brief

## Problem

Agent-written prose reads as machine output: throat-clearing, hedges, fingerprint vocabulary, reflexive triads, uniform sentence rhythm, headings on a four-sentence reply, and claims with no specifics behind them. Teams whose agents write PR descriptions, design docs, release notes and incident writeups spend reviewer time stripping this out or ship it. Style instructions in a system prompt reduce it but decay over a long context; nothing enforces them at the point the text is produced.

## What Prosegate does

It lints the prose an agent produces, at turn end, on the user's machine, and sends the findings back to the same model with the context it already holds, so the model fixes its own writing. Deterministic rules catch the mechanical tics; a cheap reviewer model catches vague and unsupported claims and register mismatches. The originating model is the only thing that ever rewrites.

## Customer

Engineering teams running agentic harnesses, Claude Code first. The buyer is an engineering lead who wants one house voice enforced across every agent on the team without reviewing every artifact. The first user is the author's own team; nothing ships to anyone else until it has run there for a month.

The individual developer is a funnel, not a business: the deterministic tier is free and local, and a solo user can stay on it indefinitely.

## Non-goals

- Not a detector evader. Prosegate does not optimise against GPTZero or any classifier, does not report a "human score", and refuses the framing in docs and marketing.
- Not paste-and-rewrite. There is no text box that returns a humanised version; a one-shot rewriter without the author's context destroys meaning and competes with a commodity.
- Not a consumer product. No browser extension, no Word add-in, no chat-app integration in v0.
- Not a hosted proxy. Prose does not transit Prosegate's servers; a relay with confidential compute is a documented option (02), not a plan.

## Decisions fixed for v0

- Enforcement is on by default. A session can be dropped to advisory with one command, and the turn-end message names it. Enforcement that cannot be switched off gets uninstalled.
- Agent-agnostic contract, one shipped adapter. Design the shim interface neutral (05); build Claude Code; add others after the findings format has survived a month.
- Reviewer model is any cheap competent model; keys are vended or the user's own on one code path.

## Success criteria for v0

- Runs on the author's team for 30 days with enforcement on and fewer than 5% of sessions dropped to advisory.
- False-positive rate on the human control set under the per-rule budgets in 10.
- Pass-1 `block` findings cleared on pass 2 at or above 80%, measured by telemetry.
- Median added latency at turn end under 2 s with the reviewer on.
- At least three profiles in daily use (PR description, design doc, chat reply).
