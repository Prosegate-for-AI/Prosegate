// Exercise the actual pinned npm dependencies, without OIDC or public services.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { githubStatement, releaseWitness } from "./lib/release-attestation.mjs";

const npmDir = resolve(process.argv[2] || join(execFileSync("npm", ["root", "--global"], { encoding: "utf8" }).trim(), "npm"));
assert.equal(JSON.parse(readFileSync(join(npmDir, "package.json"), "utf8")).version, "12.2.0");
const require = createRequire(import.meta.url);
const { RekorWitness } = require(join(npmDir, "node_modules/@sigstore/sign"));
const env = {
  GITHUB_SERVER_URL: "https://github.com", GITHUB_REPOSITORY: "Prosegate-for-AI/Prosegate",
  GITHUB_REF: "refs/tags/v0.1.0-alpha.5", GITHUB_REF_NAME: "v0.1.0-alpha.5",
  GITHUB_WORKFLOW_REF: "Prosegate-for-AI/Prosegate/.github/workflows/release.yml@refs/tags/v0.1.0-alpha.5",
  GITHUB_EVENT_NAME: "workflow_dispatch", RUNNER_ENVIRONMENT: "github-hosted",
  GITHUB_REPOSITORY_ID: "1", GITHUB_REPOSITORY_OWNER_ID: "2",
  GITHUB_RUN_ID: "3", GITHUB_RUN_ATTEMPT: "4", GITHUB_SHA: "a".repeat(40),
};
const subject = { name: "pkg:npm/prosegate@0.1.0-alpha.5", digest: { sha512: "b".repeat(128) } };
const sandbox = {
  module: { exports: {} }, Buffer, process: { env },
  require(name) {
    if (name === "ci-info") return { GITHUB_ACTIONS: true };
    if (name === "sigstore") return { attest: async (data) => JSON.parse(data.toString()) };
    if (name === "node:fs/promises") return require(name);
    throw new Error(`Unexpected npm provenance dependency: ${name}`);
  },
};
runInNewContext(readFileSync(join(npmDir, "node_modules/libnpmpublish/lib/provenance.js"), "utf8"), sandbox);
assert.equal(JSON.stringify(githubStatement(subject, env)),
  JSON.stringify(await sandbox.module.exports.generateProvenance([subject], {})));

const entry = {
  body: Buffer.from(JSON.stringify({ kind: "dsse", apiVersion: "0.0.1" })).toString("base64"),
  logID: "ab".repeat(32), logIndex: 123, integratedTime: 456,
};
let mode = "conflict";
const requests = [];
const server = createServer((req, res) => {
  requests.push(`${req.method} ${req.url}`);
  req.resume();
  res.setHeader("Content-Type", "application/json");
  if (req.method === "POST" && mode !== "created") {
    res.statusCode = mode === "unauthorized" ? 401 : 409;
    if (mode !== "missing-location") res.setHeader("Location", "/api/v1/log/entries/test-entry");
    res.end(JSON.stringify({ message: "fixture error" }));
  } else if (req.method === "GET" && mode === "missing-entry") {
    res.statusCode = 404;
    res.end(JSON.stringify({ message: "fixture not found" }));
  } else {
    res.statusCode = req.method === "POST" ? 201 : 200;
    res.end(JSON.stringify({ "test-entry": entry }));
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
try {
  const witness = releaseWitness(RekorWitness, { rekorBaseURL: `http://127.0.0.1:${server.address().port}` });
  const content = { $case: "dsseEnvelope", dsseEnvelope: {
    payload: Buffer.from("fixture"), payloadType: "application/vnd.in-toto+json",
    signatures: [{ keyid: "", sig: Buffer.from("fixture signature") }],
  } };
  for (const scenario of ["conflict", "created", "missing-location", "missing-entry", "unauthorized"]) {
    mode = scenario;
    requests.length = 0;
    if (["conflict", "created"].includes(mode)) {
      const result = await witness.testify(content, "fixture public key");
      assert.equal(result.tlogEntries[0].logIndex, "123");
      assert.deepEqual(requests, mode === "conflict"
        ? ["POST /api/v1/log/entries", "GET /api/v1/log/entries/test-entry"]
        : ["POST /api/v1/log/entries"]);
    } else {
      await assert.rejects(witness.testify(content, "fixture public key"));
      assert.equal(requests.length, mode === "missing-entry" ? 2 : 1);
    }
  }
} finally {
  await new Promise((resolve) => server.close(resolve));
}
console.log("Pinned npm statement parity and Sigstore conflict recovery checks passed (local fixtures only).");
