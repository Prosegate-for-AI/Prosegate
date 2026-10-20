# Preview releases

Phase 9 provides the packaging and publishing path. Actual npm publication and
hosted qualification are separate outcomes. `0.1.0-alpha.1` describes today's
preview. `0.1.0-rc.1` is reserved for qualified evidence; no stable version or
automatic promotion to `latest` is supported by this workflow.

## Local preparation

Install the pinned dependencies and run the repository checks. Then, from the root:

```sh
pnpm release:prepare .scratch/release-preview
pnpm release:verify .scratch/release-preview
```

The output directory must not exist and its parent must exist. Preparation builds
the adapter twice, compares bundle bytes, includes actual bundled dependency
licenses from the build graph, and packs an explicit nine-file allowlist. It
installs the tarball offline with lifecycle scripts and optional native dependencies
disabled, verifies installed hashes, runs project init and MCP self-checks, checks
revise/pass behavior and uninstalls while preserving an unrelated setting. Every
home/config/cache path for installation is isolated under the output directory.
The retained `smoke/` directory is disposable test data and is never published.

`manifest.json`, `SHA256SUMS` and `RELEASE.md` record source identity, whether local
changes were included, the lockfile and bundle hashes, tarball hash and publication
blockers. Local output with blockers has `private: true`; it can be installed but
cannot be published by the supplied workflow. Hash verification checks integrity,
not the trustworthiness of a manifest obtained from an unknown source.

The optional native keyring is installed separately by npm with its own license.
The offline smoke validates fallback operation. CI also installs the package with
optional dependencies on Windows, Linux and macOS, covering x64 and arm64 through
the main and package-architectures jobs. Runner labels follow the
[GitHub runner reference](https://docs.github.com/en/actions/reference/runners/github-hosted-runners).
Initial architecture package jobs passed on Windows/Linux ARM and Intel macOS;
full functional suites now pass on every main runner. The adapter cold-start
performance gate still fails on hosted Windows/macOS (D-44), so no release tag or
publication is ready. See [the latest qualification run](https://github.com/Prosegate-for-AI/Prosegate/actions/runs/39494876819). Actual native keychain access
still depends on the host's keychain/session; architecture and native-store evidence
must be recorded before claiming support beyond the tested runner matrix.

Do not publish directly from the workspace: its package manifest contains development
dependencies and does not collect bundled notices. Use the staged release tarball.

## Repository and npm setup

1. Use the public repository [Prosegate-for-AI/Prosegate](https://github.com/Prosegate-for-AI/Prosegate). Copyright notices name Andrew Murray le Roux.
   Set the adapter's `repository.url` to its exact case-sensitive HTTPS Git URL
   and `repository.directory` to `packages/adapter`. Preserve the FSL licenses for
   the service/dashboard and Apache licensing for local packages.
2. Configure tag protection and a GitHub environment named `npm-release` with
   required reviewers and release-tag deployment restrictions. The workflow refers
   to that environment but cannot create its approval rules from YAML.
3. Configure npm's GitHub trusted publisher with the exact owner, repository,
   workflow filename `release.yml`, and environment `npm-release`. Grant direct
   publishing for this workflow. No long-lived npm token is used by it.
4. The package currently does not exist on npm. Establish its ownership and first
   publication/bootstrap through the npm account before relying on package-level
   trusted-publisher settings. If npm requires a token for bootstrap, arrange a
   separate reviewed, short-lived CI bootstrap with provenance; do not add a token
   fallback to the normal release workflow or upload a placeholder package silently.
5. Review [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/) and
   [provenance](https://docs.npmjs.com/generating-provenance-statements/) when setting
   up the account. Provenance requires public source. A new publisher configuration
   currently expires if it does not publish successfully within two days.

Current GitHub configuration: `npm-release` requires review by `Murraylr` and accepts
only `v0.1.0-*` tags. The active Immutable preview tags ruleset prevents updates
and deletion of these tags. The sole reviewer may approve their own dispatched
release; the workflow does not approve itself. npm login/bootstrap and trusted
publisher configuration are still pending.

## Publish a preview

Commit the reviewed source and version, create its matching `v0.1.0-alpha.N` tag,
and dispatch **npm preview release** against that tag. The workflow must also exist
on the repository's default branch for manual dispatch to be available. Merely pushing a branch or
tag does not publish. The reusable CI runs before preparation, including browser,
performance, dependency, secret, bundle and installation checks. The prepared
`npm-preview` artifact contains the exact tarball, staged payload and checksums.
Review it before approving the protected publishing job.

Publishing downloads that same run's artifact, checks its hashes and exact
commit/tag/repository, and uses npm 12.2.0 on Node 24 with GitHub OIDC. It publishes
to `next` with provenance, without rebuilding or running package lifecycle scripts.
Only the publishing job can request an OIDC token. An alpha release does not claim
corpus qualification, production hosting, automatic AI review or live vending.

For an RC, the workflow additionally requires a passing corpus audit and a
successful manual `eval-paid.yml` run from the same repository and commit. Supply
its run ID. That artifact must contain one full release report with passing results
for both reviewers, complete human review and reviewer-enabled end-to-end evidence.
Current e2e tooling is rules-only (D-40), so it cannot pass this RC gate. The
packaging workflow never starts paid evaluation itself. Resolve corpus permissions,
budget, annotations, live reviewer checks and D-40 before attempting an RC.

After publication, verify the npm package page's provenance source/workflow and
install the exact version into a fresh project, then run `npm audit signatures`.
Copy the artifact's hashes and source commit into the release notes. Registry
provenance is a build-origin attestation; it is separate from the service's
Ed25519 configuration signatures and does not prove the program is bug-free.

## Recovery

If a job fails before publication, fix the cause and rerun against the reviewed
tag. If publication's outcome is unknown, inspect the registry before retrying;
versions are immutable. Do not replace an existing version. Withdraw a broken
preview through a deliberate deprecation/tag decision and ship a new version.
Users can reinstall a retained prior tarball and re-run init as described in the
[administrator guide](docs/ADMIN.md). Do not automatically unpublish or move
`latest` as a recovery action.
