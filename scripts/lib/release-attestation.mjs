// SLSA v1 GitHub statement compatible with npm 12.2.0 libnpmpublish.
// Keep this in parity with the pinned npm implementation when updating it.
export function githubStatement(subject, env) {
  const workflow = `.github/workflows/release.yml@${env.GITHUB_REF}`;
  if (env.GITHUB_SERVER_URL !== "https://github.com" ||
      env.GITHUB_WORKFLOW_REF !== `${env.GITHUB_REPOSITORY}/${workflow}` ||
      env.GITHUB_REF !== `refs/tags/${env.GITHUB_REF_NAME}` ||
      env.GITHUB_EVENT_NAME !== "workflow_dispatch" || env.RUNNER_ENVIRONMENT !== "github-hosted" ||
      ![env.GITHUB_RUN_ID, env.GITHUB_RUN_ATTEMPT, env.GITHUB_REPOSITORY_ID, env.GITHUB_REPOSITORY_OWNER_ID]
        .every((value) => typeof value === "string" && /^\d+$/.test(value))) {
    throw new Error("Attestation requires the expected tagged GitHub release workflow context.");
  }
  return {
    _type: "https://in-toto.io/Statement/v1",
    subject: [subject],
    predicateType: "https://slsa.dev/provenance/v1",
    predicate: {
      buildDefinition: {
        buildType: "https://slsa-framework.github.io/github-actions-buildtypes/workflow/v1",
        externalParameters: { workflow: {
          ref: env.GITHUB_REF,
          repository: `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}`,
          path: ".github/workflows/release.yml",
        } },
        internalParameters: { github: {
          event_name: env.GITHUB_EVENT_NAME,
          repository_id: env.GITHUB_REPOSITORY_ID,
          repository_owner_id: env.GITHUB_REPOSITORY_OWNER_ID,
        } },
        resolvedDependencies: [{
          uri: `git+${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}@${env.GITHUB_REF}`,
          digest: { gitCommit: env.GITHUB_SHA },
        }],
      },
      runDetails: {
        builder: { id: `https://github.com/actions/runner/${env.RUNNER_ENVIRONMENT}` },
        metadata: { invocationId: `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}/attempts/${env.GITHUB_RUN_ATTEMPT}` },
      },
    },
  };
}

export function releaseWitness(RekorWitness, options = {}) {
  // A POST may succeed server-side before its response times out. A retry then
  // returns 409. Fetch that entry using Sigstore's own implementation; the final
  // npm verifier still checks signature, certificate, log proof and subject.
  return new RekorWitness({
    ...options, entryType: "dsse", fetchOnConflict: true,
    timeout: 30_000, retry: { retries: 2 },
  });
}

export async function attestStatement(statement, sign, bundle) {
  const builder = new sign.DSSEBundleBuilder({
    signer: new sign.FulcioSigner({
      identityProvider: new sign.CIContextProvider("sigstore"),
      timeout: 30_000, retry: { retries: 2 },
    }),
    witnesses: [releaseWitness(sign.RekorWitness)],
  });
  return bundle.bundleToJSON(await builder.create({
    data: Buffer.from(JSON.stringify(statement)), type: "application/vnd.in-toto+json",
  }));
}
