import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { authorizedRelease } from "./lib/release-authorization.mjs";

const dir = process.env.RELEASE_DIR;
const { manifest } = authorizedRelease(dir);
execFileSync("npm", ["publish", join(dir, manifest.tarball), "--provenance", "--access", "public", "--tag", "next", "--ignore-scripts", "--registry=https://registry.npmjs.org/"], { stdio: "inherit" });
