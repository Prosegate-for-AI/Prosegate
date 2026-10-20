import { afterEach, describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { releaseProblems, verifyArtifact, payloadFiles, hash } from "./release.mjs";
import { authorizedRelease } from "./lib/release-authorization.mjs";

const pkg = { name: "prosegate", version: "0.1.0-alpha.1", private: false, license: "Apache-2.0", repository: { url: "https://github.com/example/prosegate.git", directory: "packages/adapter" } };
const context = { sha: "a".repeat(40), dirty: false, tag: "v0.1.0-alpha.1", repository: "example/prosegate" };
const dirs = [];
afterEach(() => { for (const dir of dirs.splice(0)) {
  if (!resolve(dir).startsWith(`${resolve(tmpdir())}${sep}pg-release-test-`)) throw new Error("Unsafe cleanup path");
  rmSync(dir, { recursive: true, force: true });
} });
describe("publication checks", () => {
  it("permits an explicitly labeled alpha from a clean version tag", () => expect(releaseProblems(pkg, context)).toEqual([]));
  it("preserves the exact case of the actual GitHub repository", () => {
    const repository = "Prosegate-for-AI/Prosegate";
    const actual = { ...pkg, repository: { ...pkg.repository, url: `https://github.com/${repository}.git` } };
    expect(releaseProblems(actual, { ...context, repository })).toEqual([]);
    expect(releaseProblems(actual, { ...context, repository: repository.toLowerCase() })).toContain("Set the exact public GitHub repository metadata.");
  });
  it.each([
    ["dirty source", pkg, { ...context, dirty: true }],
    ["missing source", pkg, { ...context, sha: undefined }],
    ["wrong tag", pkg, { ...context, tag: "main" }],
    ["wrong repository", pkg, { ...context, repository: "other/prosegate" }],
    ["missing license", { ...pkg, license: undefined }, context],
    ["private package", { ...pkg, private: true }, context],
    ["stable release", { ...pkg, version: "0.1.0" }, context],
  ])("rejects %s", (_name, p, c) => expect(releaseProblems(p, c).length).toBeGreaterThan(0));
  it("refuses an RC with absent, partial, stale or rules-only evidence", () => {
    const rc = { ...pkg, version: "0.1.0-rc.1" }, ctx = { ...context, tag: "v0.1.0-rc.1" };
    for (const report of [undefined, { result: "partial" }, { schema: "prosegate.eval-release/1", result: "pass", git: { sha: "b".repeat(40), dirty: false } }]) {
      expect(releaseProblems(rc, { ...ctx, report }).length).toBeGreaterThan(0);
    }
  });
  it("does not let a passing rules-only report qualify a release candidate", () => {
    const rc = { ...pkg, version: "0.1.0-rc.1" };
    const report = { schema: "prosegate.eval-release/1", result: "pass", git: { sha: context.sha, dirty: false },
      reviewers: ["gpt-5.4-mini-2026-03-17", "claude-haiku-5-5"].map((model) => ({ model, result: "pass", supported: true })),
      e2e: { result: "pass", human_sample_complete: true, evidence: { stages: "rules" } } };
    expect(releaseProblems(rc, { ...context, tag: `v${rc.version}`, report })).toEqual(["RC requires reviewer-enabled end-to-end qualification (D-40 remains open)."]);
    report.e2e.evidence.stages = "rules+reviewer";
    expect(releaseProblems(rc, { ...context, tag: `v${rc.version}`, report })).toEqual([]);
    report.reviewers[0].model = "unqualified-model";
    expect(releaseProblems(rc, { ...context, tag: `v${rc.version}`, report }).length).toBeGreaterThan(0);
  });
});
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "pg-release-test-")); dirs.push(dir);
  const files = {};
  for (const path of payloadFiles) {
    const target = join(dir, "package", path); mkdirSync(resolve(target, ".."), { recursive: true });
    writeFileSync(target, path); files[path] = hash(path);
  }
  const tarball = "prosegate-0.1.0-alpha.1.tgz"; writeFileSync(join(dir, tarball), "fixture archive");
  const manifest = { schema: "prosegate.release/1", tarball, tarball_sha256: hash("fixture archive"), bundle_sha256: files["dist/prosegate.mjs"], files };
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest)); return { dir, manifest };
}
it("verifies hashes and refuses archive or staged payload changes", () => {
  const { dir } = fixture(); expect(verifyArtifact(dir).schema).toBe("prosegate.release/1");
  writeFileSync(join(dir, "package/dist/prosegate.mjs"), "tampered"); expect(() => verifyArtifact(dir)).toThrow("Payload hash mismatch");
  writeFileSync(join(dir, "prosegate-0.1.0-alpha.1.tgz"), "tampered"); expect(() => verifyArtifact(dir)).toThrow("Tarball hash mismatch");
});
it("rejects unrecognized paths before reading them", () => {
  const { dir, manifest } = fixture(); manifest.tarball = "../other.tgz";
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest)); expect(() => verifyArtifact(dir)).toThrow("Invalid release manifest");
  manifest.tarball = "prosegate-0.1.0-alpha.1.tgz"; manifest.files["../../secret"] = hash("x");
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest)); expect(() => verifyArtifact(dir)).toThrow("Unexpected release payload");
});
it("binds publishing and bootstrap attestation to the exact checked source and tag", () => {
  const { dir, manifest } = fixture();
  const body = JSON.stringify(pkg);
  writeFileSync(join(dir, "package/package.json"), body);
  manifest.files["package.json"] = hash(body);
  Object.assign(manifest, { publishable: true, blockers: [], source: { sha: context.sha, dirty: false }, repository: context.repository, tag: context.tag, version: pkg.version });
  const save = () => writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest));
  save();
  const env = { GITHUB_ACTIONS: "true", GITHUB_REF_TYPE: "tag", ACTIONS_ID_TOKEN_REQUEST_URL: "https://example.com/oidc", GITHUB_SHA: context.sha, GITHUB_REPOSITORY: context.repository, GITHUB_REF_NAME: context.tag };
  expect(authorizedRelease(dir, env).pkg.version).toBe(pkg.version);
  for (const changed of [{ GITHUB_SHA: "b".repeat(40) }, { GITHUB_REPOSITORY: "other/repo" }, { GITHUB_REF_NAME: "v0.1.0-alpha.2" }, { GITHUB_REF_TYPE: "branch" }, { ACTIONS_ID_TOKEN_REQUEST_URL: "" }]) {
    expect(() => authorizedRelease(dir, { ...env, ...changed })).toThrow();
  }
  manifest.source.dirty = true; save();
  expect(() => authorizedRelease(dir, env)).toThrow("authorized source");
  manifest.source.dirty = false; manifest.publishable = false; save();
  expect(() => authorizedRelease(dir, env)).toThrow("authorized source");
});
it("refuses bootstrap attestation outside the protected OIDC job", () => {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL("attest-release.mjs", import.meta.url))], {
    env: { ...process.env, GITHUB_ACTIONS: "false", RELEASE_DIR: "" }, encoding: "utf8",
  });
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain("Publish requires the protected GitHub release job");
});
it("refuses publishing outside the GitHub OIDC job before invoking npm", () => {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL("publish-release.mjs", import.meta.url))], {
    env: { ...process.env, GITHUB_ACTIONS: "false", RELEASE_DIR: "" }, encoding: "utf8",
  });
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain("Publish requires the protected GitHub release job");
});
it("accepts evaluation evidence only from the designated successful same-commit workflow", () => {
  const { dir } = fixture(); const path = join(dir, "run.json");
  const run = { head_sha: context.sha, conclusion: "success", path: ".github/workflows/eval-paid.yml", event: "workflow_dispatch", repository: { full_name: context.repository } };
  const invoke = (value) => {
    writeFileSync(path, JSON.stringify(value));
    return spawnSync(process.execPath, [fileURLToPath(new URL("release-evidence.mjs", import.meta.url)), path], {
      env: { ...process.env, GITHUB_SHA: context.sha, GITHUB_REPOSITORY: context.repository }, encoding: "utf8",
    }).status;
  };
  expect(invoke(run)).toBe(0);
  for (const override of [{ head_sha: "b".repeat(40) }, { conclusion: "failure" }, { path: "other.yml" }, { event: "pull_request" }, { repository: { full_name: "other/prosegate" } }]) expect(invoke({ ...run, ...override })).not.toBe(0);
});
