// check:deps - dependency-graph guard (plan section 7; doc 06 "cannot do, by construction"; ADR-7).
//
// Graph rules, read from the real installed tree:
//   (a) services/config must not reach packages/{engine,reviewer,adapter,segmenter} or `re2js`,
//       directly or transitively, through workspace packages or installed external packages.
//   (b) nothing outside services/ and apps/ (packages/, eval/, anything else) may reach anything
//       under services/ or apps/: the free tier must not depend on the paid service.
//   (c) every direct workspace-to-workspace edge must be on EDGE_ALLOWLIST.
// Hygiene rules:
//   (d) every external dependency spec in every package.json is an exact version.
//   (e) source scan: no relative import leaves its own package dir, and no bare workspace-package
//       import is missing from that package's package.json.
//
// Identity is by real path, not by name or spec: `link:`, `workspace:alias@*`, `npm:` aliases and
// external packages that themselves depend on a workspace package all resolve to the same node.
//
// TODO(plan section 6.7 / section 7): once the Worker exists (Phase 7), add a second check on the
// built Worker bundle's import graph (esbuild metafile of services/config) that fails if
// packages/engine or re2js appears in it. This script checks declared and installed packages plus
// source imports; it does not see a bundle.
//
// Usage: node scripts/check-deps.mjs [repo-root]      exit 0 ok, 1 violations, 2 cannot analyse

import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { isMain } from "./lib/is-main.mjs";
import { extractSpecifiers, lineOf } from "./lib/specifiers.mjs";

/** Tier of a workspace package, from its directory. Everything not paid is free tier. */
export const PAID_ROOTS = ["services/", "apps/"];
export const isPaid = (rel) => PAID_ROOTS.some((r) => rel.startsWith(r));

export const CONFIG_REL = "services/config";
export const CONFIG_FORBIDDEN_RELS = new Set([
  "packages/engine",
  "packages/reviewer",
  "packages/adapter",
  "packages/segmenter",
]);
export const CONFIG_FORBIDDEN_EXTERNALS = new Set(["re2js"]);

/** Intended direct workspace edges, by directory. A workspace package missing from here fails too. */
export const EDGE_ALLOWLIST = {
  "packages/schema": [],
  "packages/segmenter": ["packages/schema"],
  "packages/profiles": ["packages/schema"],
  "packages/engine": ["packages/schema", "packages/segmenter", "packages/profiles"],
  "packages/reviewer": ["packages/schema", "packages/segmenter", "packages/profiles"],
  "packages/adapter": [
    "packages/schema",
    "packages/segmenter",
    "packages/engine",
    "packages/profiles",
    "packages/reviewer",
  ],
  "services/config": ["packages/schema", "packages/profiles"],
  "apps/dashboard": ["packages/schema"],
  eval: [
    "packages/schema",
    "packages/segmenter",
    "packages/engine",
    "packages/profiles",
    "packages/reviewer",
    "packages/adapter",
  ],
};

export const RUNTIME_KINDS = ["dependencies", "optionalDependencies", "peerDependencies"];
export const ALL_KINDS = [...RUNTIME_KINDS, "devDependencies"];
const EXACT_KINDS = ["dependencies", "optionalDependencies", "devDependencies"]; // peer ranges are contracts, not installs

// ---- pure graph analysis (unit tested with synthetic graphs) ---------------------------------

/**
 * Graph: Map<id, { name: string, rel?: string, edges: string[] }>; `rel` (posix, relative to the
 * repo root) is set for workspace packages only.
 */

/** Shortest path from `start` to every forbidden node reachable from it; stops at forbidden nodes. */
export function pathsToForbidden(graph, start, isForbidden) {
  const parent = new Map([[start, null]]);
  const queue = [start];
  const found = [];
  while (queue.length > 0) {
    const id = queue.shift();
    const node = graph.get(id);
    if (!node) continue;
    for (const next of node.edges) {
      if (parent.has(next)) continue;
      parent.set(next, id);
      const target = graph.get(next);
      if (target && isForbidden(target)) {
        const path = [];
        for (let cur = next; cur !== null; cur = parent.get(cur)) path.unshift(graph.get(cur)?.name ?? cur);
        found.push(path);
        continue;
      }
      queue.push(next);
    }
  }
  return found;
}

const isConfigForbidden = (n) =>
  n.rel !== undefined ? CONFIG_FORBIDDEN_RELS.has(n.rel) : CONFIG_FORBIDDEN_EXTERNALS.has(n.name);

/** Rules (a), (b) and the setup rule. Returns [{ rule, path }]. */
export function findViolations(graph) {
  const violations = [];

  const config = [...graph.entries()].find(([, n]) => n.rel === CONFIG_REL);
  if (!config) {
    violations.push({ rule: "setup", path: [`${CONFIG_REL} not found in workspace`] });
  } else {
    for (const path of pathsToForbidden(graph, config[0], isConfigForbidden)) {
      violations.push({ rule: "a", path });
    }
  }

  for (const [id, node] of graph) {
    if (node.rel === undefined || isPaid(node.rel)) continue;
    for (const path of pathsToForbidden(graph, id, (n) => n.rel !== undefined && isPaid(n.rel))) {
      violations.push({ rule: "b", path });
    }
  }
  return violations;
}

/** Rule (c). `edges`: [{ from: rel, to: rel }]. */
export function findEdgeViolations(edges, workspaceRels) {
  const out = [];
  for (const rel of workspaceRels) {
    if (!(rel in EDGE_ALLOWLIST)) out.push(`${rel} has no entry in EDGE_ALLOWLIST (add it deliberately)`);
  }
  for (const { from, to } of edges) {
    if (!(EDGE_ALLOWLIST[from] ?? []).includes(to)) out.push(`${from} → ${to} is not on the edge allow-list`);
  }
  return out;
}

const EXACT_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/** Rule (d) for one package.json object. Returns messages. */
export function findInexactSpecs(label, pkg) {
  const out = [];
  for (const kind of EXACT_KINDS) {
    for (const [key, spec] of Object.entries(pkg[kind] ?? {})) {
      if (typeof spec !== "string") {
        out.push(`${label}: ${kind}.${key} is not a string`);
        continue;
      }
      if (spec.startsWith("workspace:")) continue;
      const exact = spec.startsWith("npm:") ? EXACT_RE.test(spec.slice(spec.lastIndexOf("@") + 1)) : EXACT_RE.test(spec);
      if (!exact) out.push(`${label}: ${kind}.${key} = "${spec}" is not an exact version`);
    }
  }
  return out;
}

// ---- reading the real tree -------------------------------------------------------------------

const norm = (p) => (process.platform === "win32" ? p.toLowerCase() : p);
const toPosix = (p) => p.split(sep).join("/");

function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

/** Entries of the `packages:` list in pnpm-workspace.yaml. Throws on a shape it does not understand. */
export function workspacePatterns(yamlText) {
  const patterns = [];
  let inPackages = false;
  let sawKey = false;
  for (const line of yamlText.split(/\r?\n/)) {
    if (/^packages\s*:\s*(#.*)?$/.test(line)) {
      inPackages = true;
      sawKey = true;
      continue;
    }
    if (/^packages\s*:/.test(line)) throw new Error(`pnpm-workspace.yaml: unsupported inline form: ${line.trim()}`);
    if (!inPackages) continue;
    if (/^\s*(#.*)?$/.test(line)) continue;
    if (/^\S/.test(line)) {
      inPackages = false;
      continue;
    }
    const m = /^\s+-\s+(?:"([^"]+)"|'([^']+)'|([^\s#"']+))\s*(?:#.*)?$/.exec(line);
    const pattern = m?.[1] ?? m?.[2] ?? m?.[3];
    if (pattern === undefined) throw new Error(`pnpm-workspace.yaml: cannot parse packages entry: ${line.trim()}`);
    patterns.push(pattern);
  }
  if (!sawKey || patterns.length === 0) throw new Error("pnpm-workspace.yaml: no `packages:` list found");
  return patterns;
}

/** Expands `dir/*` and literal `dir` patterns. Throws on anything it cannot expand exactly. */
function workspaceDirs(root) {
  const dirs = [];
  for (const pattern of workspacePatterns(readFileSync(join(root, "pnpm-workspace.yaml"), "utf8"))) {
    if (!/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*(?:\/\*)?$/.test(pattern) || pattern.split("/").includes("..")) {
      throw new Error(`workspace pattern "${pattern}" is not supported by check:deps (only "dir/*" and "dir")`);
    }
    if (pattern.endsWith("/*")) {
      const base = join(root, pattern.slice(0, -2));
      if (!existsSync(base)) throw new Error(`workspace pattern "${pattern}": directory does not exist`);
      const found = readdirSync(base, { withFileTypes: true })
        .filter((e) => e.isDirectory() && existsSync(join(base, e.name, "package.json")))
        .map((e) => join(base, e.name));
      if (found.length === 0) throw new Error(`workspace pattern "${pattern}" matches no packages`);
      dirs.push(...found);
    } else {
      if (!existsSync(join(root, pattern, "package.json"))) {
        throw new Error(`workspace pattern "${pattern}": no package.json there`);
      }
      dirs.push(join(root, pattern));
    }
  }
  return dirs;
}

/** Node-style lookup of an installed package; returns its real directory or null. */
function resolveInstalled(fromDir, key) {
  let dir = fromDir;
  for (;;) {
    const candidate = join(dir, "node_modules", key, "package.json");
    if (existsSync(candidate)) return realpathSync(dirname(candidate));
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** The package name a dependency entry really points at, from its spec alone. */
function targetNameFromSpec(key, spec) {
  if (typeof spec !== "string") return key;
  if (spec.startsWith("npm:")) {
    const rest = spec.slice(4);
    const at = rest.lastIndexOf("@");
    return at > 0 ? rest.slice(0, at) : rest;
  }
  if (spec.startsWith("workspace:")) {
    const m = /^(@[^/@]+\/[^@]+|[^@./][^@]*)@/.exec(spec.slice(10));
    return m?.[1] ?? key;
  }
  return key;
}

/**
 * Reads the workspace into a graph.
 * @returns {{ graph: Map, edges: {from:string,to:string}[], rels: string[], packages: {rel:string,dir:string,pkg:object}[], problems: string[] }}
 */
export function buildGraph(root) {
  const graph = new Map();
  const problems = [];
  const edges = []; // direct workspace-to-workspace edges, by rel
  const packages = [];
  const wsByName = new Map();
  const wsByReal = new Map();
  for (const dir of workspaceDirs(root)) {
    const pkg = readJson(join(dir, "package.json"));
    const rel = toPosix(relative(root, dir));
    const ws = { rel, dir, pkg, id: `ws:${rel}` };
    packages.push(ws);
    wsByName.set(pkg.name, ws);
    wsByReal.set(norm(realpathSync(dir)), ws);
  }

  /** Workspace package a dependency entry points at, by spec (works before install). */
  const staticWorkspaceTarget = (pkgDir, key, spec) => {
    if (typeof spec !== "string") return null;
    if (spec.startsWith("link:") || spec.startsWith("file:")) {
      const target = resolve(pkgDir, spec.slice(5));
      return existsSync(target) ? (wsByReal.get(norm(realpathSync(target))) ?? null) : null;
    }
    const name = targetNameFromSpec(key, spec);
    return spec.startsWith("workspace:") ? (wsByName.get(name) ?? null) : null;
  };

  const leaf = (name) => {
    const id = `declared:${name}`;
    graph.set(id, { name, edges: [] });
    return id;
  };

  /** Edge targets (node ids) for the dependency entries of one package.json. */
  const edgesOf = (ownerLabel, dir, pkg, kinds, { traverseDev, fromWorkspace }) => {
    const ids = [];
    for (const kind of kinds) {
      for (const [key, spec] of Object.entries(pkg[kind] ?? {})) {
        const dev = kind === "devDependencies";
        const staticWs = staticWorkspaceTarget(dir, key, spec);
        const installed = resolveInstalled(dir, key);
        const installedWs = installed ? wsByReal.get(norm(installed)) : undefined;
        const target = staticWs ?? installedWs;
        if (target) {
          ids.push(target.id);
          if (fromWorkspace) edges.push({ from: fromWorkspace.rel, to: target.rel });
          continue;
        }
        const name = targetNameFromSpec(key, spec);
        if (installed && (!dev || traverseDev)) {
          ids.push(visitExternal(installed));
        } else {
          if (!installed && kind === "dependencies") problems.push(`${ownerLabel} -> ${key} (dependencies) is not installed`);
          // Dev tooling is not traversed and an uninstalled package cannot be walked, but a declared
          // edge to a package we forbid must still be caught.
          if (CONFIG_FORBIDDEN_EXTERNALS.has(name)) ids.push(leaf(name));
        }
      }
    }
    return ids;
  };

  const visitExternal = (realDir) => {
    const id = `ext:${norm(realDir)}`;
    if (graph.has(id)) return id;
    const pkg = readJson(join(realDir, "package.json"));
    const node = { name: pkg.name, edges: [] };
    graph.set(id, node);
    node.edges = edgesOf(`${pkg.name}@${pkg.version}`, realDir, pkg, RUNTIME_KINDS, {
      traverseDev: false,
      fromWorkspace: null,
    });
    return id;
  };

  for (const ws of packages) {
    const node = { name: ws.pkg.name, rel: ws.rel, edges: [] };
    graph.set(ws.id, node);
    node.edges = edgesOf(ws.pkg.name, ws.dir, ws.pkg, ALL_KINDS, { traverseDev: false, fromWorkspace: ws });
  }
  return { graph, edges, rels: packages.map((p) => p.rel), packages, problems };
}

// ---- source scan (rule e) --------------------------------------------------------------------

const SOURCE_EXT = /\.(?:[cm]?[jt]s|[jt]sx)$/;
const SKIP_DIRS = new Set(["node_modules", "dist"]);

function* sourceFiles(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name) || e.name.startsWith(".")) continue;
      yield* sourceFiles(join(dir, e.name));
    } else if (SOURCE_EXT.test(e.name) && !e.name.endsWith(".d.ts")) {
      yield join(dir, e.name);
    }
  }
}

const bareName = (spec) => {
  const parts = spec.split("/");
  return spec.startsWith("@") ? parts.slice(0, 2).join("/") : (parts[0] ?? spec);
};

export function scanSources(root, packages) {
  const out = [];
  const wsNames = new Set(packages.map((p) => p.pkg.name));
  for (const ws of packages) {
    const declared = new Set(ALL_KINDS.flatMap((k) => Object.keys(ws.pkg[k] ?? {})));
    for (const file of sourceFiles(ws.dir)) {
      const text = readFileSync(file, "utf8");
      for (const { spec, index } of extractSpecifiers(text)) {
        const where = `${toPosix(relative(root, file))}:${lineOf(text, index)}`;
        if (spec.startsWith("./") || spec.startsWith("../") || spec === "." || spec === "..") {
          const rel = relative(ws.dir, resolve(dirname(file), spec));
          if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
            out.push(`${where}: relative import "${spec}" leaves its package (${ws.rel}/)`);
          }
        } else if (isAbsolute(spec)) {
          out.push(`${where}: absolute import "${spec}"`);
        } else {
          const name = bareName(spec);
          if (wsNames.has(name) && name !== ws.pkg.name && !declared.has(name)) {
            out.push(`${where}: imports ${name}, which ${ws.pkg.name} does not declare in package.json`);
          }
        }
      }
    }
  }
  return out;
}

// ---- main ------------------------------------------------------------------------------------

const RULE_LABEL = {
  a: "rule (a) services/config must not reach engine/reviewer/adapter/segmenter/re2js",
  b: "rule (b) free tier (everything outside services/ and apps/) must not reach the paid tier",
  setup: "setup",
};

export function run(root) {
  let built;
  try {
    built = buildGraph(root);
  } catch (e) {
    return { code: 2, stdout: "", stderr: `check:deps: cannot read the workspace: ${e.message}\n` };
  }
  const { graph, edges, rels, packages, problems } = built;
  const failures = [];

  for (const v of findViolations(graph)) {
    failures.push(`${RULE_LABEL[v.rule]}:\n    ${v.path.join(" → ")}`);
  }
  for (const m of findEdgeViolations(edges, rels)) failures.push(`rule (c) ${m}`);

  const pkgJsons = [{ label: "package.json", pkg: readJson(join(root, "package.json")) }].concat(
    packages.map((p) => ({ label: `${p.rel}/package.json`, pkg: p.pkg })),
  );
  for (const { label, pkg } of pkgJsons) {
    for (const m of findInexactSpecs(label, pkg)) failures.push(`rule (d) ${m}`);
  }
  for (const m of scanSources(root, packages)) failures.push(`rule (e) ${m}`);

  if (failures.length > 0) {
    return { code: 1, stdout: "", stderr: `check:deps: FAILED\n${failures.map((f) => `  ${f}`).join("\n")}\n` };
  }
  if (problems.length > 0) {
    return {
      code: 2,
      stdout: "",
      stderr: `check:deps: cannot read the installed dependency tree (run \`pnpm install\` first):\n${problems.map((p) => `  ${p}`).join("\n")}\n`,
    };
  }
  const ws = [...graph.values()].filter((n) => n.rel !== undefined).length;
  return {
    code: 0,
    stdout: `check:deps: ok (${ws} workspace packages, ${graph.size - ws} other nodes in graph)\n`,
    stderr: "",
  };
}

function main() {
  const root = resolve(process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), ".."));
  const r = run(root);
  process.stdout.write(r.stdout);
  process.stderr.write(r.stderr);
  process.exitCode = r.code;
}

if (isMain(import.meta.url)) main();
