# HUMAN-QUESTIONS

Questions only Murray can answer. Each has a default I am proceeding on. Newest last. Update the **Answer** line when answered.

---

## HQ-1 · Run the S2 OpenAI vending spike (credential)

- **Question:** Will you run `docs/spikes/s2-openai-vending/spike.mjs` against a sandbox OpenAI org with an admin key, or provide an environment where it can run?
- **Why it matters:** *Revenue* — vended inference is a cost Prosegate carries; the worst-case exposure per key is the number the admin doc must state, and it comes from this spike (rate-limit behaviour and cost-reporting lag). *Privacy* — none; the spike sends no user prose. *Quality/Marketability* — vending is the no-API-key onboarding path for subscription-only users (ADR-3).
- **Options:** (1, recommended) You create a sandbox org (or a throwaway project in an existing org), create an Admin API key, and run the script locally with `OPENAI_ADMIN_KEY` set in your shell only; paste me the redacted JSON report it writes. Estimated spend under USD 1. (2) Defer vending to after dogfood; ship BYOK only for v0.
- **Update 2026-10-17:** the S2 script found that OpenAI now has a per-project **hard spend limit** in the Administration API (official OpenAPI spec, added 2026-07-23); I verified it in the spec. Plan §1 was out of date. The run now also measures how late and how far past the limit OpenAI enforces, which sets the exposure number.
- **Default I'm proceeding on:** ADR-8 — per-user project with the provider hard spend limit ($5/month), per-model rate limits, a model allowlist, key expiry, plus 15-minute polling and revoke as a second line. Vending stays off for everyone until you accept the measured exposure number. Reversal cost: low until Phase 7 (week 6+); isolated to `services/config` vending.
- **Where the value goes:** Only in your shell's environment for the duration of the run. Never in a file, never in chat.
- **Needed by:** start of Phase 7 (target week 6).
- **Answer:** _pending_

---

## HQ-2 · Managed auth provider for the config service and dashboard

- **Question:** Which managed auth provider should the dashboard use?
- **Why it matters:** *Revenue* — SSO/SCIM is what an engineering lead's security team will ask for on the org plan. *Privacy* — the provider sees account emails, never prose. *Marketability* — device approval in the dashboard is part of the "install in under a minute" path for paid users. *Quality* — MFA is the mitigation for threat 7 in 07.
- **Options:** (1, recommended) **WorkOS AuthKit** — MFA, hosted UI, OIDC; SSO and SCIM available per org connection, which maps onto the org plan. (2) Clerk — strong DX; enterprise SSO is on a higher plan. (3) Auth0 — mature, costs rise fastest with MAU.
- **Default I'm proceeding on:** Build behind an `AuthProvider` interface (OIDC: verify ID token, map `sub` → `accounts.auth_subject`); device-key auth is independent of it. Reversal cost: one adapter class plus dashboard login screen.
- **Needed by:** week 8 (dashboard auth is the last piece of Phase 7).
- **Answer:** _pending_

---

## HQ-3 · Licences for the public repo (and a conflict between 07 and ADR-7)

- **Question:** Which licences for (a) the adapter, engine, `core` pack and starter profiles, and (b) the config service source?
- **Why it matters:** *Privacy/Marketability* — the 07 public wording says "both the adapter and the server are open source so you can check." That sentence is only true if the service is under an OSI licence. ADR-7 rejects "fully open including the service (nothing to sell)". The two are reconcilable only if the service's *source* is open while the *hosted service* is the paid product. *Revenue* — the licence on the service decides whether a competitor can host it.
- **Options:** (1, recommended) Apache-2.0 for `packages/*`, `eval/` runners and the bundled pack/profiles; **AGPL-3.0** for `services/config` and `apps/dashboard`. The 07 wording stays true; the paid product is the hosted sync, vending and org features; a competitor who hosts it must publish changes. (2) Apache-2.0 for packages, FSL/BSL (source-available) for the service — then 07's wording must change to "source-available", which I will not do without your sign-off. (3) MIT everywhere.
- **Default I'm proceeding on:** No LICENSE files committed yet; the code layout keeps the free surface (`packages/`, `eval/`) and the paid surface (`services/`, `apps/`) in separate trees so either answer applies cleanly. Nothing is published.
- **Needed by:** Phase 9 (release candidate).
- **Answer:** _pending_

---

## HQ-4 · Product name

- **Question:** Is "Prosegate" the shipping name? (02, open item.)
- **Why it matters:** *Marketability* — npm package name, CLI command `prosegate`, endpoint domain and every user-visible string carry it. *Revenue* — none directly.
- **Options:** (1) Keep Prosegate. (2) Pick another; I rename in one pass before the release candidate.
- **Default I'm proceeding on:** Keep the codename; packages are scoped `@prosegate/*` and private; the CLI binary name is a single constant.
- **Needed by:** Phase 9.
- **Answer:** _pending_

---

## HQ-5 · Re-login the `claude` CLI so S1 can observe a live Stop hook

- **Question:** Can you run `claude auth login` (or `claude` then `/login`) in a terminal on this machine, then run `node docs/spikes/s1-stop-hook/run.mjs` and do the 2-minute interactive check in `docs/spikes/s1-stop-hook/README.md`?
- **Why it matters:** *Marketability/Quality* — S1 decides how the user sees the notice: Claude Code's `systemMessage` channel (clean, reliable) or the fallback where the model is told to print the notice line (less reliable, measured as `notice_via_model`). The 09 golden transcripts and the shim's output format depend on it. *Privacy* — none; the spike uses a throwaway prompt. *Revenue* — none.
- **Why I can't:** the CLI's stored OAuth session on this machine has expired ("OAuth session expired and could not be refreshed"); logging in is a credential action only you can take.
- **Options:** (1, recommended) Re-login and run the script; it is headless, uses Haiku, costs a few cents of your plan. (2) I proceed doc-only and verify live at the end of Phase 3, when `init` is first run on your machine.
- **Default I'm proceeding on:** Option 2 — documentation evidence, plus a shim that supports both render paths behind one switch. Reversal cost: none; S1's live answer only flips the switch's default.
- **Needed by:** Phase 3 exit (target week 4).
- **Answer:** Answered 2026-10-17: Murray re-logged in and accepted the trust prompt; headless and interactive runs are done (ADR-11, ADR-13).

---

## HQ-6 · A private Git remote so CI actually runs

- **Question:** May I push this repo to a **private** GitHub repository so the CI workflow runs on Linux, Windows and macOS runners? You can create it, or tell me the org and name and I'll create it with `gh`.
- **Why it matters:** *Quality* — the CI file has never executed, and macOS (the keyring, plan §10 "all three platforms") can only be tested on a hosted runner. *Privacy* — the repo holds no user data or secrets; `check:secrets` gates every commit. *Revenue* — the paid service code stays private until HQ-3 is answered.
- **Options:** (1, recommended) A private GitHub repo with Actions enabled. (2) Stay local: I run the CI step list on Windows only, and macOS stays untested until release.
- **Default I'm proceeding on:** Option 2. Reversal cost: none; the first push runs everything.
- **Needed by:** Phase 3 exit (the macOS `init` test).
- **Answer:** _pending_
