# Prosegate administrator guide

The current distribution is `0.1.0-alpha.5`. Local rules, Claude Code hooks and
MCP tools work without an account. Explicit BYOK review is experimental. Hosted
enrollment/sync, automatic paid review and live key vending are not enabled by
installing this package. Do not present the preview as a qualified release candidate.

## Install and verify

Use a supported Node runtime satisfying the package's Node 20+ floor. Test on your
organization's actual OS/architecture, including its keychain configuration.
Until npm publication is confirmed, use the reviewed tarball from `release:prepare`.
Compare its SHA-256 against the release's SHA256SUMS. A checksum detects changes;
it establishes identity only when you trust the source of that checksum.

From a trusted terminal in the target project:

```sh
npx --package=/absolute/path/prosegate-0.1.0-alpha.5.tgz prosegate init --harness claude-code --local --scope project
```

Omit `--scope project` for user-wide installation. Start a new Claude Code session.
Initialization checks hook execution and MCP initialization/tool discovery. It
preserves unrelated settings and refuses conflicting MCP registrations. A session
start supplies the active profile's writing instructions; MCP lists/selects profiles
and offers advisory draft checks. Stop hooks may request up to two revision passes.
Hooks default to deterministic checks; MCP stays deterministic. An explicit
`prosegate reviewer on --provider openai` (or `anthropic`) opt-in enables paid
Stop-hook review across projects using that Prosegate home. Use `reviewer status`
and `reviewer off` to inspect and disable it. This experimental opt-in does not
replace your organization's rollout qualification.

Project hooks live in `.claude/settings.local.json`; MCP uses Claude's private
project scope in its user configuration. User-scope hooks use Claude's user settings.
No shared `.mcp.json` is created. See [the adapter guide](../packages/adapter/README.md)
for explicit session bindings when several Claude sessions share one folder.

After a public npm release, pin the reviewed version in installation instructions.
Verify registry signatures and provenance with `npm audit signatures` in an
installation project, and inspect the npm provenance link for the source commit
and workflow. An alpha on `next` is an opt-in preview, not a production endorsement.
See [release procedure](../RELEASING.md).

## Upgrade, rollback and removal

Re-run `init` from the new verified package using the same scope. It copies the
versioned program into the private Prosegate home, writes backups and validates
the result; failed initialization rolls back the registrations. Start a fresh session.
For rollback, run `init` from the previous retained, verified tarball, then start
a fresh session. Preserve profiles and backups; do not overwrite the whole Claude
configuration with an old backup that would discard unrelated changes.

Run `prosegate uninit --scope project` in each project that was initialized that
way, or `prosegate uninit` for user scope. `--purge` additionally removes Prosegate
program files; other projects still referring to those files will need cleanup.
It does not delete profiles, saved keys, session data or hosted account records.
Remove each BYOK key using `prosegate key remove openai` or `anthropic` before
retiring the installation. Review remaining local data before deleting it manually.

## Credentials and provider failures

Enter BYOK keys using hidden terminal input or a password-manager pipe, never
command arguments or chat. The native keychain is preferred; the adapter announces
an owner-only file fallback when no usable keychain exists. Administrators of the
machine can still access its data. Inspect presence with `key status`, which does
not disclose values. See [reviewer operations](../packages/reviewer/README.md).

Explicit review sends prose directly to the chosen provider. On failure, inspect
the returned reviewer status; a successful CLI exit alone does not mean AI review
succeeded. Deterministic results remain usable. The provider's retention terms and
your own contract apply. Never request request-body logs as a troubleshooting step.

If a key is exposed, revoke it at the provider, remove it locally and replace it.
A dashboard device revocation affects service access; it does not revoke a separate
BYOK provider key. Hosted reviewer-key revocation is only complete when the provider
bridge confirms it. A pending or suspended service record does not stop a stolen
key being used directly at the provider.

## Operate a hosted installation

Follow [configuration-service provisioning](../services/config/README.md) and
[dashboard deployment](../apps/dashboard/README.md). You must select a managed
identity provider, require MFA, provision accounts and namespaces, apply the D1
migration, configure Queues, and install the signing key. The current adapter still
needs remote enrollment/sync and trust-key integration before hosted settings affect
its checks. Do not advertise dashboard edits as enforced on disconnected clients.

The dashboard needs only public issuer/client/API settings. Keep the service
signing key and publisher credentials in secret storage. Configure exact HTTPS
origins, callback URLs and ID-token audience; verify deployment headers and real
MFA login. The dashboard's public `/privacy` page is available without sign-in.
Identify the installation operator and privacy contact alongside it before rollout.

Organization admins manage policy and membership; maintain at least one admin.
Profile previews do not save changes. Conflicts preserve editor drafts: reload the
current version and reconcile deliberately. Service writes use idempotency keys
and conditional versions; retry concurrency conflicts without creating duplicate
financial operations. Pack publication is a separate validated workflow; only
vetted publishers should receive access. Versioned packs are immutable.

The code enforces bounded list sizes and serializes writes through a global
optimistic revision. This is a small-installation design, not a claim of large-scale
throughput. Watch rejected writes and list truncation before increasing team size.

## Retention, recovery and monitoring

The 15-minute scheduled handler performs retention and maintenance. Monitor cron
failures, old telemetry-outbox entries, dead-letter Queue messages, stale usage
polls, pending revocations and undelivered notifications. Keep request bodies,
provider responses and secrets out of operational logs. Error codes are sufficient
for the application's error telemetry.

Raw telemetry/outbox records expire after 180 days, shared samples after 90 days,
and idempotency records after 24 hours. Historical aggregates remain. Sharing is
off by default and organization policy can forbid it. Redaction is heuristic;
review whether sample collection is appropriate for your organization. Users can
delete visible samples. Account-wide deletion requires an operator procedure.

Set and disclose a backup-retention policy; none is implemented by this repository.
Test restoring D1 and signing configuration in an isolated environment. After a
restore, reconcile pending provider operations with the provider before resuming
vending; old database state is not proof that a key is absent or a budget is unused.
Signing-key rotation needs the documented 90-day trust overlap before retiring
the old key. A compromised service requires provider revocation and device-key
rotation as well as replacing service credentials.

## Vending is gated

There is no accepted S2 exposure measurement, live administrative bridge or email
delivery integration. Leave vending disabled. The planned $5 monthly provider
budget is not a measured maximum exposure: enforcement and reporting lag matter.
The eventual bound must include rate-limited spend during measured lag and receive
written owner acceptance. A configuration flag alone is not acceptance evidence.
Until those requirements are met, use user-supplied keys for explicit review.

## Licenses and the next trial

Local tools are Apache-2.0. Service and dashboard are FSL-1.1-ALv2; internal use is
permitted, while competing commercial offerings are restricted under the license.
Each version converts to Apache-2.0 after two years. See [licensing](../LICENSE.md).

Phase 10 is a 30-day team trial after service integration. Review advisory sessions
and dominant rule IDs weekly. Track false positives, at least 80% pass-two
clearance, under 5% advisory sessions, median added latency under two seconds and
three profiles in daily use. Do not count an incomplete hosted rollout as satisfying
the full trial. A user's experimental automatic-review opt-in is not evidence that
the separate organization-wide rollout gates have passed.
