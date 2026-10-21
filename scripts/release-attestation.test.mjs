import { describe, expect, it } from "vitest";
import { githubStatement, attestStatement } from "./lib/release-attestation.mjs";

const env = {
  GITHUB_SERVER_URL: "https://github.com", GITHUB_REPOSITORY: "Prosegate-for-AI/Prosegate",
  GITHUB_REF: "refs/tags/v0.1.0-alpha.5", GITHUB_REF_NAME: "v0.1.0-alpha.5",
  GITHUB_WORKFLOW_REF: "Prosegate-for-AI/Prosegate/.github/workflows/release.yml@refs/tags/v0.1.0-alpha.5",
  GITHUB_EVENT_NAME: "workflow_dispatch", RUNNER_ENVIRONMENT: "github-hosted",
  GITHUB_REPOSITORY_ID: "1", GITHUB_REPOSITORY_OWNER_ID: "2",
  GITHUB_RUN_ID: "3", GITHUB_RUN_ATTEMPT: "4", GITHUB_SHA: "a".repeat(40),
};
const subject = { name: "pkg:npm/prosegate@0.1.0-alpha.5", digest: { sha512: "b".repeat(128) } };
describe("release provenance", () => {
  it("binds the package digest, source, tag and particular run attempt", () => {
    const statement = githubStatement(subject, env);
    expect(statement.subject).toEqual([subject]);
    expect(statement.predicate.buildDefinition.resolvedDependencies[0]).toEqual({
      uri: `git+https://github.com/${env.GITHUB_REPOSITORY}@${env.GITHUB_REF}`,
      digest: { gitCommit: env.GITHUB_SHA },
    });
    expect(statement.predicate.runDetails.metadata.invocationId).toBe(
      `https://github.com/${env.GITHUB_REPOSITORY}/actions/runs/3/attempts/4`);
  });
  it.each(Object.keys(env).filter((key) => key !== "GITHUB_SHA"))("rejects missing %s", (key) => {
    expect(() => githubStatement(subject, { ...env, [key]: undefined })).toThrow();
  });
  it.each([
    ["GITHUB_WORKFLOW_REF", `${env.GITHUB_REPOSITORY}/.github/workflows/other.yml@${env.GITHUB_REF}`],
    ["GITHUB_EVENT_NAME", "pull_request"], ["RUNNER_ENVIRONMENT", "self-hosted"],
    ["GITHUB_RUN_ID", "1/attempts/2"], ["GITHUB_REF", "refs/heads/main"],
  ])("rejects incompatible %s", (key, value) => {
    expect(() => githubStatement(subject, { ...env, [key]: value })).toThrow();
  });
  it("requires a transparency witness and propagates signing failures", async () => {
    let captured;
    function Options(options) { this.options = options; }
    class Builder {
      constructor(options) { captured = options; }
      async create() { throw new Error("log verification unavailable"); }
    }
    await expect(attestStatement(githubStatement(subject, env), {
      DSSEBundleBuilder: Builder, FulcioSigner: Options, CIContextProvider: Options, RekorWitness: Options,
    }, { bundleToJSON() { throw new Error("must not return unsigned bundle"); } })).rejects.toThrow("log verification unavailable");
    expect(captured.witnesses).toHaveLength(1);
    expect(captured.witnesses[0].options.fetchOnConflict).toBe(true);
    expect(captured.signer.options.identityProvider.options).toBe("sigstore");
  });
});
