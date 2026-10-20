import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { executeRoundTrip } from "./check-bundle.mjs";
import { isMain } from "./lib/is-main.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const adapter = join(root, "packages/adapter");
export const payloadFiles = ["package.json", "README.md", "LICENSE", "NOTICE", "PRIVACY.md", "THIRD_PARTY_NOTICES.txt", "dist/prosegate.mjs", "shims/claude-code/hook.mjs", "shims/claude-code/launcher.mjs"].sort();
export const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
// npm 12 keys JSON results by package name; npm 11 and earlier return an array.
export function packedPackage(output, pkg) {
  const result = JSON.parse(output);
  const entries = Array.isArray(result) ? result : result && typeof result === "object" ? Object.values(result) : [];
  const packed = entries[0];
  if (entries.length !== 1 || packed?.name !== pkg.name || packed?.version !== pkg.version ||
      packed.filename !== `${pkg.name}-${pkg.version}.tgz` || !Array.isArray(packed.files) ||
      JSON.stringify(packed.files.map((file) => file?.path).sort()) !== JSON.stringify(payloadFiles)) {
    throw new Error("npm packed an unexpected package or file list.");
  }
  return packed;
}
const json = (path) => JSON.parse(readFileSync(path, "utf8"));
const writeJson = (path, value) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();

export function releaseProblems(pkg, { sha, dirty, tag, repository, report } = {}) {
  const problems = [];
  if (pkg.name !== "prosegate") problems.push("Shipping name must be prosegate.");
  if (!/^0\.1\.0-(alpha|rc)\.[1-9]\d*$/.test(pkg.version ?? "")) problems.push("Use an explicit 0.1.0-alpha.N or 0.1.0-rc.N preview version.");
  if (pkg.private !== false) problems.push("Adapter package is still private.");
  if (pkg.license !== "Apache-2.0") problems.push("Adapter license must be Apache-2.0.");
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository ?? "") || pkg.repository?.url !== `https://github.com/${repository}.git` || pkg.repository?.directory !== "packages/adapter") problems.push("Set the exact public GitHub repository metadata.");
  if (dirty !== false) problems.push("Release source must be a clean Git checkout.");
  if (!/^[a-f0-9]{40}$/.test(sha ?? "")) problems.push("Release source needs a full Git commit.");
  if (tag !== `v${pkg.version}`) problems.push("Publish only from the exact version tag.");
  if (pkg.version?.includes("-rc.")) {
    if (report?.schema !== "prosegate.eval-release/1" || report.result !== "pass" || report.git?.dirty !== false ||
        typeof report.git?.sha !== "string" || report.git.sha.length < 7 || !sha?.startsWith(report.git.sha) ||
        report.e2e?.result !== "pass" || report.e2e?.human_sample_complete !== true ||
        !Array.isArray(report.reviewers) || report.reviewers.length !== 2 ||
        new Set(report.reviewers.map((r) => r.model)).size !== 2 ||
        !["gpt-5.4-mini-2026-03-17", "claude-haiku-5-5"].every((model) => report.reviewers.some((r) => r.model === model)) ||
        report.reviewers.some((r) => r.result !== "pass" || r.supported !== true)) {
      problems.push("RC requires a passing release evaluation for this clean source, both reviewer candidates, and complete human e2e review.");
    }
    // D-40: current evaluator runs rules-only rewrites. It cannot certify the complete product.
    if (report?.e2e?.evidence?.stages !== "rules+reviewer") problems.push("RC requires reviewer-enabled end-to-end qualification (D-40 remains open).");
  }
  return problems;
}

export function verifyArtifact(directory) {
  const manifest = json(join(directory, "manifest.json"));
  if (manifest.schema !== "prosegate.release/1" || !/^[a-f0-9]{64}$/.test(manifest.bundle_sha256 ?? "") ||
      !/^prosegate-0\.1\.0-(alpha|rc)\.[1-9]\d*\.tgz$/.test(manifest.tarball ?? "") ||
      !/^[a-f0-9]{64}$/.test(manifest.tarball_sha256 ?? "")) throw new Error("Invalid release manifest.");
  const bytes = readFileSync(join(directory, manifest.tarball));
  if (hash(bytes) !== manifest.tarball_sha256) throw new Error("Tarball hash mismatch.");
  if (JSON.stringify(Object.keys(manifest.files ?? {}).sort()) !== JSON.stringify(payloadFiles)) throw new Error("Unexpected release payload file list.");
  for (const [path, digest] of Object.entries(manifest.files)) {
    if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error("Invalid payload hash.");
    if (hash(readFileSync(join(directory, "package", path))) !== digest) throw new Error(`Payload hash mismatch: ${path}`);
  }
  if (manifest.files["dist/prosegate.mjs"] !== manifest.bundle_sha256) throw new Error("Bundle hash mismatch.");
  return manifest;
}

export function bundledNotices() {
  const meta = json(join(adapter, "dist/metafile-esm.json"));
  const packages = new Map();
  for (const input of Object.keys(meta.inputs)) {
    if (!input.replaceAll("\\", "/").includes("node_modules/")) continue;
    let dir = dirname(resolve(adapter, input));
    while (dirname(dir) !== dir) {
      const path = join(dir, "package.json");
      if (existsSync(path)) {
        const pkg = json(path);
        if (pkg.name && pkg.version) { packages.set(`${pkg.name}@${pkg.version}`, { dir, pkg }); break; }
      }
      dir = dirname(dir);
    }
    if (dirname(dir) === dir) throw new Error("Cannot identify a bundled dependency.");
  }
  if (packages.size === 0) throw new Error("Missing bundled dependency inventory.");
  return [...packages.entries()].sort(([a], [b]) => a.localeCompare(b, "en")).map(([id, { dir, pkg }]) => {
    const files = readdirSync(dir).filter((name) => /^(licen[cs]e|copying|notice)(\.|$)/i.test(name) && statSync(join(dir, name)).isFile()).sort();
    if (!files.some((name) => /^(licen[cs]e|copying)/i.test(name))) throw new Error(`Missing license text for ${id}`);
    return `${id} (${pkg.license ?? "see text"})\n${"=".repeat(72)}\n${files.map((name) => readFileSync(join(dir, name), "utf8").replaceAll("\r\n", "\n")).join("\n")}\n`;
  }).join("\n");
}

function npm(args, cwd, env = process.env) {
  if (process.platform !== "win32") return execFileSync("npm", args, { cwd, env, encoding: "utf8", timeout: 120_000 });
  // Avoid a shell and never interpolate caller-controlled paths into command text.
  const cli = join(dirname(process.execPath), "node_modules/npm/bin/npm-cli.js");
  return execFileSync(process.execPath, [cli, ...args], { cwd, env, encoding: "utf8", timeout: 120_000 });
}

function isolatedEnvironment(home) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(PROSEGATE_|CLAUDE|ANTHROPIC_|OPENAI_|NPM_CONFIG_|NODE_AUTH_TOKEN|NPM_TOKEN|CI$)/i.test(key)));
  for (const [key, dir] of Object.entries({ HOME: "home", USERPROFILE: "home", APPDATA: "appdata", LOCALAPPDATA: "localappdata", XDG_CONFIG_HOME: "xdg", PROSEGATE_HOME: "prosegate", CLAUDE_CONFIG_DIR: "claude", PROSEGATE_CLAUDE_HOME: "claude", NPM_CONFIG_CACHE: "npm-cache" })) {
    env[key] = join(home, dir); mkdirSync(env[key], { recursive: true });
  }
  env.NPM_CONFIG_USERCONFIG = join(home, "empty.npmrc");
  env.NPM_CONFIG_GLOBALCONFIG = join(home, "empty-global.npmrc");
  writeFileSync(env.NPM_CONFIG_USERCONFIG, ""); writeFileSync(env.NPM_CONFIG_GLOBALCONFIG, "");
  env.PROSEGATE_KEY_STORE = "file";
  return env;
}

export function smokeArtifact(directory) {
  const manifest = verifyArtifact(directory);
  const home = join(directory, "smoke");
  mkdirSync(home); // Never reuse or erase an existing installation.
  const env = isolatedEnvironment(home);
  const project = join(home, "project"); mkdirSync(project);
  writeJson(join(project, "package.json"), { name: "prosegate-release-smoke", version: "1.0.0", private: true });
  npm(["install", join(directory, manifest.tarball), "--ignore-scripts", "--omit=optional", "--offline", "--no-audit", "--no-fund", "--package-lock=false"], project, env);
  const installed = join(project, "node_modules/prosegate");
  for (const [path, digest] of Object.entries(manifest.files)) if (hash(readFileSync(join(installed, path))) !== digest) throw new Error(`Installed payload mismatch: ${path}`);
  const bundle = join(installed, "dist/prosegate.mjs");
  const call = (...args) => execFileSync(process.execPath, [bundle, ...args], { cwd: project, env, encoding: "utf8", timeout: 60_000 });
  if (!call("--version").includes(manifest.version)) throw new Error("Installed version mismatch.");
  mkdirSync(join(project, ".claude"));
  writeJson(join(project, ".claude/settings.local.json"), { env: { PROSEGATE_RELEASE_UNRELATED: "keep" } });
  const mcpPath = join(env.CLAUDE_CONFIG_DIR, ".claude.json"), projectKey = project.replaceAll("\\", "/");
  writeJson(mcpPath, { mcpServers: { unrelated: { command: "fixture-only-never-launched", args: [] } } });
  try {
    call("init", "--harness", "claude-code", "--local", "--scope", "project");
  } catch (error) {
    // This home was created above exclusively for synthetic smoke data. Retain
    // bounded diagnostics in CI output before its ephemeral runner disappears.
    // Never read the caller's real Prosegate home or an error-supplied path.
    const logs = join(env.PROSEGATE_HOME, "logs");
    if (existsSync(logs)) for (const name of readdirSync(logs).filter((name) => /^\d{4}-\d{2}-\d{2}\.log$/.test(name)).sort().slice(-2)) {
      console.error(`Isolated init diagnostic (${name}):\n${readFileSync(join(logs, name), "utf8").slice(-12_000)}`);
    }
    throw error;
  }
  const initialized = json(join(project, ".claude/settings.local.json"));
  if (!initialized.hooks || initialized.env?.PROSEGATE_RELEASE_UNRELATED !== "keep") throw new Error("Package init failed.");
  if (!json(mcpPath).projects?.[projectKey]?.mcpServers?.prosegate) throw new Error("Package MCP registration missing.");
  const issues = executeRoundTrip(bundle);
  if (issues.length) throw new Error(issues.join("\n"));
  call("uninit", "--scope", "project", "--purge");
  const after = json(join(project, ".claude/settings.local.json"));
  if (after.env?.PROSEGATE_RELEASE_UNRELATED !== "keep" || JSON.stringify(after).includes("launcher.mjs")) throw new Error("Package uninstall damaged unrelated settings or left hooks.");
  const afterMcp = json(mcpPath);
  if (afterMcp.projects?.[projectKey]?.mcpServers?.prosegate || afterMcp.mcpServers?.unrelated?.command !== "fixture-only-never-launched") throw new Error("Package uninstall damaged unrelated MCP configuration or left its server.");
}

export function prepare(directory, { strict = false, repository, tag, report } = {}) {
  const pkg = json(join(adapter, "package.json"));
  const sha = git("rev-parse", "HEAD"), dirty = git("status", "--porcelain") !== "";
  const blockers = releaseProblems(pkg, { sha, dirty, repository, tag, report });
  for (const dir of ["services/config", "apps/dashboard"]) {
    const path = join(root, dir, "LICENSE");
    if (!existsSync(path) || /pending confirmation|\$\{licensor name\}/.test(readFileSync(path, "utf8"))) blockers.push(`Complete the approved copyright-holder notice in ${dir}/LICENSE.`);
  }
  if (strict && blockers.length) throw new Error(blockers.join("\n"));
  mkdirSync(directory); // Output must be new; no deletion or overwriting of previous releases.
  const stage = join(directory, "package"); mkdirSync(stage);
  const build = () => execFileSync(process.execPath, [join(root, "node_modules/tsup/dist/cli-default.js")], { cwd: adapter, stdio: "inherit" });
  build();
  const first = hash(readFileSync(join(adapter, "dist/prosegate.mjs")));
  build();
  if (first !== hash(readFileSync(join(adapter, "dist/prosegate.mjs")))) throw new Error("Repeated bundle build was not reproducible.");
  for (const path of payloadFiles.filter((path) => !["package.json", "THIRD_PARTY_NOTICES.txt"].includes(path))) {
    const from = ["LICENSE", "NOTICE", "PRIVACY.md"].includes(path) ? join(root, path) : join(adapter, path);
    mkdirSync(dirname(join(stage, path)), { recursive: true }); copyFileSync(from, join(stage, path));
  }
  const { name, version, type, bin, engines, optionalDependencies, license, repository: repo } = pkg;
  writeJson(join(stage, "package.json"), { name, version, type, bin, engines, optionalDependencies, license, repository: repo,
    description: "Local prose checks and writing profiles for Claude Code. Alpha preview.", files: payloadFiles.filter((p) => p !== "package.json"), private: blockers.length > 0,
    publishConfig: { access: "public", registry: "https://registry.npmjs.org/", tag: "next", provenance: true } });
  writeFileSync(join(stage, "THIRD_PARTY_NOTICES.txt"), bundledNotices());
  const packed = packedPackage(npm(["pack", "--ignore-scripts", "--json", "--pack-destination", directory], stage), pkg);
  const tarball = basename(packed.filename);
  const manifest = { schema: "prosegate.release/1", version, source: { sha, dirty }, repository: repository ?? null, tag: tag ?? null,
    blockers, publishable: blockers.length === 0, bundle_sha256: first, lockfile_sha256: hash(readFileSync(join(root, "pnpm-lock.yaml"))),
    tarball, tarball_sha256: hash(readFileSync(join(directory, tarball))), evaluation_sha256: report ? hash(JSON.stringify(report)) : null,
    files: Object.fromEntries(payloadFiles.map((path) => [path, hash(readFileSync(join(stage, path)))])) };
  writeJson(join(directory, "manifest.json"), manifest);
  writeFileSync(join(directory, "SHA256SUMS"), `${manifest.tarball_sha256}  ${tarball}\n${first}  package/dist/prosegate.mjs\n`);
  writeFileSync(join(directory, "RELEASE.md"), `# Prosegate ${version}\n\n${manifest.publishable ? "Preview candidate for publication" : "Local verification only; publication blocked"}.\n\nSource: ${sha}${dirty ? " (uncommitted changes included)" : ""}\n\nBundle SHA-256: ${first}\n\nTarball SHA-256: ${manifest.tarball_sha256}\n\nLocal hooks and MCP are rules-only. Explicit BYOK review is experimental. Hosted services, automatic paid review and full corpus qualification remain pending.\n\n${blockers.map((p) => `- ${p}`).join("\n")}\n`);
  smokeArtifact(directory);
  return manifest;
}

if (isMain(import.meta.url)) {
  try {
    const [command, directory, ...rest] = process.argv.slice(2);
    if (!directory || rest.some((arg) => arg !== "--strict")) throw new Error("Usage: node scripts/release.mjs prepare|verify OUTPUT [--strict]");
    if (command === "verify") { verifyArtifact(resolve(directory)); console.log("Release hashes verified."); }
    else if (command === "prepare") {
      const report = process.env.PROSEGATE_RELEASE_REPORT ? json(resolve(process.env.PROSEGATE_RELEASE_REPORT)) : undefined;
    const result = prepare(resolve(directory), { strict: rest.includes("--strict"), repository: process.env.GITHUB_REPOSITORY, tag: process.env.GITHUB_REF_TYPE === "tag" ? process.env.GITHUB_REF_NAME : undefined, report });
      console.log(`Prepared ${result.tarball}; isolated install/init/MCP/check/uninstall passed. ${result.blockers.length} publication blockers.`);
    } else throw new Error("Unknown release command.");
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
