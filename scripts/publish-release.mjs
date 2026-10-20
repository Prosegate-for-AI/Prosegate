import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { verifyArtifact } from "./release.mjs";

const dir = process.env.RELEASE_DIR;
if (!dir || process.env.GITHUB_ACTIONS !== "true" || process.env.GITHUB_REF_TYPE !== "tag" || !process.env.ACTIONS_ID_TOKEN_REQUEST_URL) throw new Error("Publish requires the protected GitHub release job with OIDC.");
const manifest = verifyArtifact(dir);
const pkg = JSON.parse(readFileSync(join(dir, "package/package.json"), "utf8"));
if (!manifest.publishable || manifest.blockers?.length !== 0 || manifest.source?.dirty !== false || pkg.private !== false ||
    manifest.source.sha !== process.env.GITHUB_SHA || manifest.repository !== process.env.GITHUB_REPOSITORY ||
    manifest.tag !== process.env.GITHUB_REF_NAME || manifest.tag !== `v${pkg.version}` || manifest.version !== pkg.version ||
    pkg.repository?.url !== `https://github.com/${manifest.repository}.git`) throw new Error("Release artifact does not match the authorized source/tag/repository.");
execFileSync("npm", ["publish", join(dir, manifest.tarball), "--provenance", "--access", "public", "--tag", "next", "--ignore-scripts", "--registry=https://registry.npmjs.org/"], { stdio: "inherit" });
