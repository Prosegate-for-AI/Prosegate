import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { authorizedRelease } from "./lib/release-authorization.mjs";
import { githubStatement, attestStatement } from "./lib/release-attestation.mjs";

// First publication cannot use package-level trusted publishing before the
// package exists. Sign the CI-built tarball here; the maintainer can submit that
// exact file with npm's --provenance-file and local 2FA. No npm token enters CI.
const dir = process.env.RELEASE_DIR;
const { manifest, pkg } = authorizedRelease(dir);
if (pkg.version !== "0.1.0-alpha.5") throw new Error("Bootstrap attestation is only for the first publication candidate.");
const npmRoot = execFileSync("npm", ["root", "--global"], { encoding: "utf8" }).trim();
const npmDir = join(npmRoot, "npm");
if (JSON.parse(readFileSync(join(npmDir, "package.json"), "utf8")).version !== "12.2.0") {
  throw new Error("Attestation requires the reviewed npm 12.2.0 implementation.");
}
// Use npm's pinned Sigstore primitives with duplicate-entry recovery, and npm's
// own verifier. The statement format is checked against npm in CI.
const require = createRequire(import.meta.url);
const { verifyProvenance } = require(join(npmDir, "node_modules/libnpmpublish/lib/provenance.js"));
const npa = require(join(npmDir, "node_modules/npm-package-arg"));
const subject = {
  name: npa.toPurl(npa.resolve(pkg.name, pkg.version)),
  digest: { sha512: createHash("sha512").update(readFileSync(join(dir, manifest.tarball))).digest("hex") },
};
const bundle = await attestStatement(githubStatement(subject, process.env),
  require(join(npmDir, "node_modules/@sigstore/sign")),
  require(join(npmDir, "node_modules/@sigstore/bundle")));
const path = join(dir, "provenance.sigstore.json");
writeFileSync(path, `${JSON.stringify(bundle)}\n`, { flag: "wx" });
await verifyProvenance(subject, path);
console.log(`Verified npm provenance for ${pkg.name}@${pkg.version}. No registry publication performed.`);
