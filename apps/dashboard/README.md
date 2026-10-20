# Prosegate dashboard

Phase 8's minimal Cloudflare Pages app. It includes managed sign-in, device approval
and revocation, profile YAML editing and unsaved resolution previews, rule-pack
browsing, reviewer-key status/usage/revocation, sample deletion, daily finding
charts, and organization membership/policy.

## Run locally

Install workspace dependencies with `pnpm install`. Configure these **public**
build variables in your shell, then run `pnpm --filter @prosegate/dashboard dev`:

| Variable | Meaning |
| --- | --- |
| `PROSEGATE_API_ORIGIN` | Configuration Worker origin, without `/v1` |
| `PROSEGATE_OIDC_AUTHORITY` | Managed provider's exact OIDC issuer |
| `PROSEGATE_OIDC_CLIENT_ID` | Public SPA client ID, also the Worker's `OIDC_AUDIENCE` |

The local server listens on `http://127.0.0.1:4173`. Restart it after source or
configuration changes. Loopback HTTP is allowed for local development only.
An ordinary build without these variables displays a setup screen and does not
load account information.

The Worker needs its existing D1 migration, signing secret and auth configuration;
see [service setup](../../services/config/README.md). This dashboard does not create
accounts, provide a mock production login, or turn on key vending.

## Managed sign-in contract

Register a public browser client using Authorization Code + PKCE (S256), no client
secret. Register exactly `<dashboard-origin>/auth/callback` as its callback and
the dashboard origin as an allowed browser origin. Enable MFA at the provider.
Discovery and token endpoints must be accessible from that browser origin and
hosted on the issuer's origin (the generated CSP permits that origin only).

The dashboard requests `openid profile`, sends an explicit nonce, checks the
response transaction through `oidc-client-ts`, and sends the **ID token** to this
app's configuration backend. This is the backend of the same OIDC client, not a
general third-party resource API. Configure `OIDC_ISSUER`, `OIDC_AUDIENCE` (the SPA
client ID), and the provider's public `OIDC_JWKS_URL` on the Worker. The Worker
verifies signature, issuer, audience, expiry, an age of at most one hour and
`amr: ["mfa", ...]`. The provider must issue that claim in its ID token; asking for
MFA without the claim does not grant access. RS256 and ES256 are supported.

An operator must provision the verified `sub` into `accounts.auth_subject`,
reserve its namespace and assign membership. Unknown identities are denied.
Provider selection and its account lifecycle integration remain D-41/HQ-2.

Tokens live in memory only. `sessionStorage` holds only the short-lived PKCE
transaction, which is consumed at callback; no tokens or profile drafts are
saved to local/session storage. Reloading requires sign-in again (provider SSO
may make it immediate). There is no refresh token or silent renewal.
The callback removes authorization query parameters even on failure.
Sign-out clears this dashboard session; it does not sign out of the provider.

## Publish to Pages

Set the three public variables above plus `PROSEGATE_DASHBOARD_DEPLOY=1` in the
Pages build environment. Use build command `pnpm --filter @prosegate/dashboard build`
from the repo root and output directory `apps/dashboard/dist`. Deployment mode
requires complete HTTPS configuration. Do not put provider admin keys, signing
keys, client secrets, or user tokens in Pages variables or `config.json`.

Set the Worker's `DASHBOARD_ORIGIN` to the exact deployed origin. Register that
same origin/callback at the provider. Preview deployments need a separate
authorized test installation, not the production API or a wildcard origin.

The build emits SPA routing and security headers: strict CSP without inline
scripts/styles, exact API/issuer connections, no framing, no referrer, no-store
caching and disabled camera/microphone/location. Keep `_headers` and `_redirects`
in the deployed artifact. There are no analytics, third-party fonts, service
workers, or external image requests. Check these headers after hosting; this
phase has not deployed a production installation.

## Editing and data behavior

- **Preview draft** calls the authenticated read-only
  `POST /v1/profiles/{namespace}/{slug}/preview`. It uses the service's real
  resolver and policy checks, returns field/resolution errors, and writes no
  profile, history, audit, or idempotency record. Viewing an existing read-only
  profile uses `GET .../resolved`.
- Profile creation uses `If-None-Match: *`; editing/deletion and policy updates
  use `If-Match`. Conflicts keep the editor contents so the user can copy and
  reconcile their draft. Saved version numbers are assigned by the service.
  Actual saves also validate affected descendants.
- Mutations use a new idempotency key per action. Only explicit rolled-back
  `state_changed_retry` conflicts are automatically retried with the same key.
  An ambiguous network failure is not retried; the user checks current state.
- Navigation asks before discarding changed YAML/policy. Requests disable their
  controls. Expired authentication leaves unsaved text visible to copy.
- Shared excerpts require an explicit per-profile opt-in and organization
  permission. The screen explains the 600-character, 20-per-device/day and
  90-day limits and imperfect redaction. All returned text uses DOM text nodes.
- Reviewer-key screens show metadata only. Provider revocation can stay pending
  during an outage; the UI never presents pending revocation as complete.
- Usage charts count findings, not sessions. Dates, daily totals and a detailed
  table share the same aggregate response. Lists inherit the service's v0
  bounds (D-42); no pagination is claimed.

## Verify

`pnpm test` includes API client/config tests and the Worker regression suite.
For actual browser workflows:

```text
pnpm install:dashboard-browser
pnpm test:dashboard
```

On a Linux CI runner, install browser system dependencies with
`pnpm install:dashboard-browser --with-deps`. The browser binary is stored under
the ignored `.scratch/browsers` directory (override `PLAYWRIGHT_BROWSERS_PATH` if
needed). The suite starts a temporary OIDC issuer, the built Pages assets with
their actual CSP, and a real Miniflare Worker/D1. It uses isolated homes, ephemeral
signing keys, temporary browser profiles and fixture accounts. External browser
requests are blocked. Screenshots go to `.scratch/dashboard`.

Live provider interoperability, deployed Pages headers, onboarding, remote adapter
sync/trust and S2-gated administrative/email bridges still need rollout qualification.
These local tests do not certify paid-provider exposure or Phase 6 corpus quality.

## Public privacy page

The build renders the root PRIVACY.md into /privacy, available without JavaScript, API configuration or login. The same text ships in the adapter tarball. Service/dashboard licensing is FSL-1.1-ALv2; local packages are Apache-2.0. Operators must supply their identity/privacy contact and deployment-provider terms before rollout. See ../../docs/ADMIN.md and ../../RELEASING.md.
