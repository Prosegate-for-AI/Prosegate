import { readFileSync } from "node:fs";
import { join } from "node:path";
import { verifyArtifact } from "../release.mjs";

/** Shared by publishing and first-release attestation; neither may bypass CI's source checks. */
export function authorizedRelease(dir, env = process.env) {
  if (!dir || env.GITHUB_ACTIONS !== "true" || env.GITHUB_REF_TYPE !== "tag" || !env.ACTIONS_ID_TOKEN_REQUEST_URL) {
    throw new Error("Publish requires the protected GitHub release job with OIDC.");
  }
  const manifest = verifyArtifact(dir);
  const pkg = JSON.parse(readFileSync(join(dir, "package/package.json"), "utf8"));
  if (!manifest.publishable || manifest.blockers?.length !== 0 || manifest.source?.dirty !== false || pkg.private !== false ||
      manifest.source.sha !== env.GITHUB_SHA || manifest.repository !== env.GITHUB_REPOSITORY ||
      manifest.tag !== env.GITHUB_REF_NAME || manifest.tag !== `v${pkg.version}` || manifest.version !== pkg.version ||
      pkg.repository?.url !== `https://github.com/${manifest.repository}.git`) {
    throw new Error("Release artifact does not match the authorized source/tag/repository.");
  }
  return { manifest, pkg };
}
