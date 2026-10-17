# Adapter obligations the resolver cannot enforce

Collected from the W1.3 security re-verification (2026-10-17). The Phase 3 adapter brief must cover every item; each needs a test.

1. Verify Ed25519 signatures on profiles, packs and policy before marking `signed: true`; pass `origin` / `signed` as exact literals and booleans.
2. Mark content `bundled` only when it comes from the adapter's own `bundled.generated.ts`, never from a network cache.
3. Pass the account's signed policy to every resolution, whatever the leaf namespace.
4. If the account has an `org_id` but no cached policy, fail closed. Replaying an older signed policy is equivalent to uninstalling and is accepted as residual.
5. Strip `signature` from the policy object before resolving (the strict schema rejects unknown fields).
6. Re-resolve at `session-start` and at every `turn-end` from cached signed or bundled sources. Never read policy, `required` or provider fields from `profile.json` (ADR-19).
7. Always include the bundled packs in `sources.packs`.
8. Refuse synced profiles in reserved namespaces (`local`, `prosegate`, `core`); bind pack ids to their publisher (synced `core` refused in v0).
9. Load each pack body by the exact (id, version, origin) in `snapshot.packs`; check that the loaded id and version match.
10. Compile RE2 and run hit/miss examples at load; resolve `<eval corpus ref: …>` placeholders.
11. Under `required`: `list_profiles`, `select_profile` and `prosegate profile` offer and accept only org-namespace profiles; handle `policy_requires_org_profile`; `advisory` and `off` refuse, including when the model runs them (D-15); fail closed when re-resolution fails.
12. Show the overlays-ignored notice once per session; pass `local` as plain records.
13. Apply `byok_required`, `allowed_providers` and `sharing_allowed` (the resolver only records them).
14. Run `injectedTextViolation` on model-bound strings outside the resolver: reviewer `register` instructions (≤ 160), the filled `vague_claim` slot, ids (denylist-only pass), and everything returned by `list_profiles` / `select_profile` errors.
15. Under `required`, the engine loads only `snapshot.packs`.
16. The adapter bundle needs a `createRequire` banner, and `check:bundle` must execute the bundle on a real resolve (D-17).
17. `encodeTelemetryBatch` is the only telemetry send path, called with the session's synced profile and pack id sets (ADR-20, 07).
18. Filter the assembled session-start inject block (profile name + register tone + format + description) as one string, or separate the fields with fixed labels, so a word split across adjacent fields cannot pass (W1.4 verify #9).
19. If `turn-end` re-resolution re-validates pack text, measure it: a 100-rule hostile pack costs about 240 ms of filter CPU. Cache validated pack bodies by content hash, so turn-end does not re-filter unchanged packs.
