# Prosegate privacy

This describes the current preview and the optional configuration service.
The operator of a hosted installation must identify its contact, hosting and
identity providers, and applicable provider terms before inviting users.

## Local checks

Deterministic checks run on your machine. Claude Code hooks default to local rules, and MCP tools
always use local rules. Neither uploads drafts or telemetry to Prosegate.
Session-start hooks supply writing instructions to Claude. The adapter reads the
current user message and relevant turn information from the local session.
Private session files can contain the current prompt and cached MCP findings with
draft excerpts. They are cleared as turns or sessions advance; abandoned session
data is swept on a later session start after one hour, not by a background timer.
Local settings, profiles and count-only diagnostics persist until removed.
Headless reports can include finding excerpts. Explicit debug mode can save local
turn text with a warning. Treat these files and local backups as sensitive data.

## Optional AI review

The explicit BYOK review command sends your draft, up to 2,000 characters of the
last user message, style constraints and register requirements directly to the
selected AI provider using your key. Optional audience context (up to 500 UTF-16
code units), original draft and source material (up to 20,000 each), and selected
local findings are included when supplied. Code segments in the candidate draft
are replaced with placeholders; original text and source material are sent verbatim.
Prosegate does not relay these requests. The provider's data terms and your
contract apply. A request setting is not a guarantee of zero provider retention.
Automatic Stop-hook review is off by default. Enabling `prosegate reviewer on
--provider openai` (or `anthropic`) opts this Prosegate home into paid provider
calls across its installed projects. Eligible Stop hooks send candidate prose, the
current user message, register requirements and selected local findings directly
to that provider using the saved key. They do not read conversation history or
retrieve source documents. Code in the draft is masked as for explicit review.
MCP stays local-only. `prosegate reviewer off` disables automatic calls.

Per-session duplicate-call receipts contain only hashed turn IDs, pass numbers
and timestamps. They contain no keys, drafts or provider responses, are pruned
on later attempts, and disappear when the session directory is swept. Automatic
review failures retain local checks; failed attempts also consume their receipt.

## Configuration service

When you use a configured dashboard, its service receives account identifiers,
profiles, rule packs, organization settings, device records and key metadata.
Profile content and preview requests may contain text you enter. Unsaved profile
previews are processed without persistence. The service has no draft-review
endpoint, but it can receive text through profiles and explicitly shared samples.
Adapter enrollment, remote synchronization and telemetry upload are not yet wired
into the local preview. Hosted deployment still needs operator configuration.

The service accepts only allowlisted telemetry fields: counts, rule and profile
identifiers, coarse text-length and latency buckets, and fixed error codes.
It adds account and device identifiers. Rule identifiers can reveal that particular
phrases occurred, and events can be correlated within a minute or batch.
Raw events and pending telemetry are deleted after 180 days by scheduled cleanup.
Historical aggregate counts are retained. Idempotency records expire after 24 hours.

## Optional sample sharing

Sample sharing is off by default for each profile and may be prohibited by your
organization. When enabled in a connected client, short excerpts around blocking
findings may reach the service for rule tuning. The server limits submissions to
20 per device per day, with excerpts and spans capped at 600 UTF-16 code units.
It redacts email addresses, URLs, long numbers and key-shaped tokens. Redaction is
heuristic: other sensitive information can remain. Samples appear in the dashboard
and can be deleted there. Scheduled cleanup deletes samples after 90 days.
Cleanup depends on the operator keeping the scheduled service running. The current
local adapter does not submit samples, even when dashboard sharing is enabled.

## Credentials and browser storage

BYOK keys stay in your OS keychain or an owner-restricted file fallback announced
by the adapter. An administrator of your machine may still access them. Keys are
not included in findings or telemetry. Hosted key vending is disabled pending
provider integration and accepted exposure measurements; its design delivers a
provider key once and retains identifiers rather than the key value.

Dashboard sign-in uses the operator's identity provider. Tokens stay in browser
memory; the short-lived login transaction uses session storage. Signing out clears
dashboard state but does not end the identity provider's SSO session. Prosegate
does not add analytics or advertising trackers. The identity and hosting providers
may receive connection metadata such as your IP address under their own policies.

## Deletion and inspection

You can delete editable profiles and shared samples and revoke devices through
the dashboard. Account-wide deletion and backup retention require the operator;
the preview has no account-deletion endpoint. Uninstalling hooks does not erase
profiles, keys, local session data or hosted records. Remove BYOK keys with the key
command before retiring an installation, and ask its operator about hosted data.

Local tools are open source under Apache-2.0. The configuration service and
dashboard are source-available under FSL-1.1-ALv2, converting each version to
Apache-2.0 after two years. Source access lets you inspect these data flows;
it does not prove that a particular hosted deployment matches this source.
