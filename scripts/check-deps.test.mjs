import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { EDGE_ALLOWLIST, findEdgeViolations, findInexactSpecs, findViolations, workspacePatterns } from "./check-deps.mjs";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "check-deps.mjs");

// ---- pure functions ---------------------------------------------------------------------------

const ws = (rel, edges = []) => [`ws:${rel}`, { name: rel, rel, edges }];
const ext = (id, edges = []) => [id, { name: id.replace(/@[^@]+$/, ""), edges }];

describe("findViolations (synthetic graphs)", () => {
  const clean = () =>
    new Map([
      ws("packages/schema"),
      ws("packages/profiles", ["ws:packages/schema"]),
      ws("packages/engine", ["ws:packages/schema", "re2js@1.0.0"]),
      ws("services/config", ["ws:packages/schema", "ws:packages/profiles", "zod@3.0.0"]),
      ext("re2js@1.0.0"),
      ext("zod@3.0.0"),
    ]);

  it("passes a clean graph", () => {
    expect(findViolations(clean())).toEqual([]);
  });

  it("reports the shortest path through externals to re2js", () => {
    const g = clean();
    g.set(...ext("foo@1.0.0", ["bar@1.0.0"]));
    g.set(...ext("bar@1.0.0", ["re2js@1.0.0"]));
    g.get("ws:services/config").edges.push("foo@1.0.0");
    expect(findViolations(g)).toEqual([
      { rule: "a", path: ["services/config", "foo", "bar", "re2js"] },
    ]);
  });

  it("rule (b) catches an external that depends on a paid workspace package", () => {
    const g = clean();
    g.set(...ext("wrapper@1.0.0", ["ws:services/config"]));
    g.get("ws:packages/schema").edges.push("wrapper@1.0.0");
    expect(findViolations(g)).toContainEqual({ rule: "b", path: ["packages/schema", "wrapper", "services/config"] });
  });

  it("reports a missing config package as a setup violation", () => {
    const g = clean();
    g.delete("ws:services/config");
    expect(findViolations(g)).toEqual([{ rule: "setup", path: ["services/config not found in workspace"] }]);
  });
});

describe("findEdgeViolations", () => {
  it("accepts exactly the allow-list and rejects anything else", () => {
    const rels = Object.keys(EDGE_ALLOWLIST);
    const all = rels.flatMap((from) => EDGE_ALLOWLIST[from].map((to) => ({ from, to })));
    expect(findEdgeViolations(all, rels)).toEqual([]);
    expect(findEdgeViolations([{ from: "packages/segmenter", to: "packages/profiles" }], rels)).toHaveLength(1);
    expect(findEdgeViolations([], [...rels, "packages/new"])).toHaveLength(1);
  });
});

describe("findInexactSpecs", () => {
  it.each(["^1.0.0", "~1.0.0", "*", "latest", "1.x", ">=1.0.0", "1", "npm:foo@^1.0.0", "file:../x", "link:../x"])(
    "rejects %s",
    (spec) => {
      expect(findInexactSpecs("p", { dependencies: { a: spec } })).toHaveLength(1);
    },
  );
  it.each(["1.2.3", "1.2.3-beta.1", "1.2.3+build.5", "npm:foo@1.2.3", "workspace:*"])("accepts %s", (spec) => {
    expect(findInexactSpecs("p", { devDependencies: { a: spec } })).toEqual([]);
  });
  it("checks optionalDependencies and devDependencies too", () => {
    expect(findInexactSpecs("p", { optionalDependencies: { a: "^1.0.0" }, devDependencies: { b: "*" } })).toHaveLength(2);
  });
});

describe("workspacePatterns", () => {
  it("reads the packages list and ignores other keys", () => {
    const yaml = 'packages:\n  - "packages/*"\n  - eval # runners\n\nignoredBuiltDependencies:\n  - esbuild\n';
    expect(workspacePatterns(yaml)).toEqual(["packages/*", "eval"]);
  });
  it("throws on forms it cannot read instead of skipping them", () => {
    expect(() => workspacePatterns('packages: ["a", "b"]\n')).toThrow();
    expect(() => workspacePatterns("other:\n  - x\n")).toThrow();
    expect(() => workspacePatterns("packages:\n  - { a: b }\n")).toThrow();
  });
});

// ---- subprocess tests against fixture workspaces ----------------------------------------------

const NAMES = {
  "packages/schema": "@prosegate/schema",
  "packages/segmenter": "@prosegate/segmenter",
  "packages/profiles": "@prosegate/profiles",
  "packages/engine": "@prosegate/engine",
  "packages/reviewer": "@prosegate/reviewer",
  "packages/adapter": "prosegate",
  "services/config": "@prosegate/config",
  "apps/dashboard": "@prosegate/dashboard",
  eval: "@prosegate/eval",
};

const dirs = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "pg-deps-"));
  dirs.push(root);
  const abs = (p) => join(root, p);
  const writeJson = (p, v) => {
    mkdirSync(dirname(abs(p)), { recursive: true });
    writeFileSync(abs(p), JSON.stringify(v, null, 2));
  };
  const f = {
    root,
    json: (p) => JSON.parse(readFileSync(abs(p), "utf8")),
    writeJson,
    file(p, text) {
      mkdirSync(dirname(abs(p)), { recursive: true });
      writeFileSync(abs(p), text);
    },
    /** Edit a workspace package's package.json. */
    edit(rel, fn) {
      const pj = f.json(`${rel}/package.json`);
      fn(pj);
      writeJson(`${rel}/package.json`, pj);
    },
    addDep(rel, kind, key, spec) {
      f.edit(rel, (pj) => {
        pj[kind] = { ...(pj[kind] ?? {}), [key]: spec };
      });
    },
    /** A fake installed external package at <root>/node_modules/<name>. */
    external(name, pkg = {}) {
      writeJson(`node_modules/${name}/package.json`, { name, version: "1.0.0", ...pkg });
    },
    link(from, toRel) {
      mkdirSync(dirname(abs(from)), { recursive: true });
      symlinkSync(abs(toRel), abs(from), "junction");
    },
    run(script = SCRIPT) {
      const r = spawnSync(process.execPath, [script, root], { encoding: "utf8" });
      return { code: r.status, out: r.stdout, err: r.stderr };
    },
  };
  f.file("pnpm-workspace.yaml", 'packages:\n  - "packages/*"\n  - "services/*"\n  - "apps/*"\n  - "eval"\n');
  writeJson("package.json", { name: "prosegate-monorepo", private: true, devDependencies: { typescript: "5.9.3" } });
  for (const [rel, name] of Object.entries(NAMES)) {
    const deps = Object.fromEntries(EDGE_ALLOWLIST[rel].map((d) => [NAMES[d], "workspace:*"]));
    writeJson(`${rel}/package.json`, { name, version: "0.0.0", private: true, dependencies: deps });
    f.file(`${rel}/src/index.ts`, `${EDGE_ALLOWLIST[rel].map((d, i) => `import { x${i} } from "${NAMES[d]}";`).join("\n")}\nexport const y = 1;\n`);
  }
  return f;
}

describe("check-deps (subprocess)", () => {
  it("passes the intended layout and prints ok", () => {
    const res = fixture().run();
    expect(res.err).toBe("");
    expect(res.code).toBe(0);
    expect(res.out).toContain("check:deps: ok (9 workspace packages");
  });

  describe("rule (a): services/config", () => {
    it.each([
      ["packages/engine", "@prosegate/engine"],
      ["packages/reviewer", "@prosegate/reviewer"],
      ["packages/adapter", "prosegate"],
      ["packages/segmenter", "@prosegate/segmenter"],
    ])("fails on a direct dependency on %s", (_rel, name) => {
      const f = fixture();
      f.addDep("services/config", "dependencies", name, "workspace:*");
      const res = f.run();
      expect(res.code).toBe(1);
      expect(res.err).toContain("rule (a)");
      // The path must END at the dependency itself: a longer path through it means it was not
      // recognised as forbidden in its own right.
      expect(res.err).toContain(`rule (a) services/config must not reach engine/reviewer/adapter/segmenter/re2js:
    @prosegate/config → ${name}
`);
    });

    it.each(["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"])(
      "fails on a %s edge to engine",
      (kind) => {
        const f = fixture();
        f.addDep("services/config", kind, "@prosegate/engine", "workspace:*");
        const res = f.run();
        expect(res.code).toBe(1);
        expect(res.err).toContain("rule (a)");
      },
    );

    it("fails on a transitive workspace path", () => {
      const f = fixture();
      f.addDep("packages/profiles", "dependencies", "@prosegate/reviewer", "workspace:*");
      const res = f.run();
      expect(res.code).toBe(1);
      expect(res.err).toContain("@prosegate/config → @prosegate/profiles → @prosegate/reviewer");
    });

    it("fails on a declared re2js even when it is not installed", () => {
      const f = fixture();
      f.addDep("services/config", "dependencies", "re2js", "1.2.0");
      const res = f.run();
      expect(res.code).toBe(1);
      expect(res.err).toContain("@prosegate/config → re2js");
    });

    it("fails on a dev-dependency alias of re2js, resolved by real package name", () => {
      const f = fixture();
      f.addDep("services/config", "devDependencies", "innocent", "npm:re2js@1.2.0");
      const res = f.run();
      expect(res.code).toBe(1);
      expect(res.err).toContain("@prosegate/config → re2js");
    });

    it.each(["dependencies", "optionalDependencies", "peerDependencies"])(
      "fails when an installed external reaches re2js through %s",
      (kind) => {
        const f = fixture();
        f.external("re2js");
        f.external("bar", { dependencies: { re2js: "1.0.0" } });
        f.external("foo", { [kind]: { bar: "1.0.0" } });
        f.addDep("services/config", "dependencies", "foo", "1.0.0");
        const res = f.run();
        expect(res.code).toBe(1);
        expect(res.err).toContain("foo → bar → re2js");
      },
    );

    it("fails when services/config is missing from the workspace", () => {
      const f = fixture();
      rmSync(join(f.root, "services/config"), { recursive: true });
      f.writeJson("services/other/package.json", { name: "@prosegate/other", version: "0.0.0", private: true });
      const res = f.run();
      expect(res.code).toBe(1);
      expect(res.err).toContain("services/config not found in workspace");
    });
  });

  describe("rule (b): the free tier must not reach services/ or apps/", () => {
    it("fails on engine -> config", () => {
      const f = fixture();
      f.addDep("packages/engine", "dependencies", "@prosegate/config", "workspace:*");
      const res = f.run();
      expect(res.code).toBe(1);
      expect(res.err).toContain("rule (b)");
      expect(res.err).toContain("@prosegate/engine → @prosegate/config");
    });

    it("fails on eval -> dashboard (eval is free tier)", () => {
      const f = fixture();
      f.addDep("eval", "devDependencies", "@prosegate/dashboard", "workspace:*");
      const res = f.run();
      expect(res.code).toBe(1);
      expect(res.err).toContain("@prosegate/eval → @prosegate/dashboard");
    });

    it("treats a directory outside packages/ and eval/ as free tier", () => {
      const f = fixture();
      f.file("pnpm-workspace.yaml", 'packages:\n  - "packages/*"\n  - "services/*"\n  - "apps/*"\n  - "eval"\n  - "tools/*"\n');
      f.writeJson("tools/gen/package.json", {
        name: "@prosegate/gen",
        version: "0.0.0",
        private: true,
        dependencies: { "@prosegate/config": "workspace:*" },
      });
      const res = f.run();
      expect(res.code).toBe(1);
      expect(res.err).toContain("@prosegate/gen → @prosegate/config");
    });

    it("fails on a link: spec pointing at services/config", () => {
      const f = fixture();
      f.addDep("packages/schema", "dependencies", "sneaky", "link:../../services/config");
      const res = f.run();
      expect(res.code).toBe(1);
      expect(res.err).toContain("rule (b)");
    });

    it("fails on a workspace: alias of a paid package", () => {
      const f = fixture();
      f.addDep("packages/schema", "devDependencies", "sneaky", "workspace:@prosegate/config@*");
      const res = f.run();
      expect(res.code).toBe(1);
      expect(res.err).toContain("rule (b)");
      expect(res.err).toContain("@prosegate/schema → @prosegate/config");
    });

    it("fails when an installed external package depends on a paid workspace package", () => {
      const f = fixture();
      f.link("node_modules/@prosegate/dashboard", "apps/dashboard");
      f.external("wrapper", { dependencies: { "@prosegate/dashboard": "1.0.0" } });
      f.addDep("packages/schema", "dependencies", "wrapper", "1.0.0");
      const res = f.run();
      expect(res.code).toBe(1);
      expect(res.err).toContain("@prosegate/schema → wrapper → @prosegate/dashboard");
    });

    it("fails on an installed alias whose real path is a paid package", () => {
      const f = fixture();
      f.link("packages/schema/node_modules/pretty-name", "services/config");
      f.addDep("packages/schema", "dependencies", "pretty-name", "1.0.0");
      const res = f.run();
      expect(res.code).toBe(1);
      expect(res.err).toContain("@prosegate/schema → @prosegate/config");
    });
  });

  describe("rule (c): intended edges only", () => {
    it("fails on an edge that is not on the allow-list", () => {
      const f = fixture();
      f.addDep("packages/segmenter", "dependencies", "@prosegate/profiles", "workspace:*");
      const res = f.run();
      expect(res.code).toBe(1);
      expect(res.err).toContain("packages/segmenter → packages/profiles is not on the edge allow-list");
    });

    it("fails on a workspace package that has no allow-list entry", () => {
      const f = fixture();
      f.writeJson("packages/newone/package.json", { name: "@prosegate/newone", version: "0.0.0", private: true });
      const res = f.run();
      expect(res.code).toBe(1);
      expect(res.err).toContain("packages/newone has no entry in EDGE_ALLOWLIST");
    });
  });

  describe("rule (d): exact versions", () => {
    it.each([
      ["package.json", "devDependencies", "^5.0.0"],
      ["services/config/package.json", "dependencies", "~3.1.0"],
      ["packages/schema/package.json", "dependencies", "*"],
      ["packages/schema/package.json", "devDependencies", "latest"],
      ["packages/schema/package.json", "optionalDependencies", ">=1.0.0"],
    ])("fails on %s %s = %s", (file, kind, spec) => {
      const f = fixture();
      const pj = f.json(file);
      pj[kind] = { ...(pj[kind] ?? {}), zod: spec };
      f.writeJson(file, pj);
      f.external("zod");
      const res = f.run();
      expect(res.code).toBe(1);
      expect(res.err).toContain("rule (d)");
      expect(res.err).toContain(spec);
    });
  });

  describe("rule (e): source imports", () => {
    it("fails on a relative import that leaves the package", () => {
      const f = fixture();
      f.file("services/config/src/a.ts", 'import "../../../packages/engine/src/index.js";\n');
      const res = f.run();
      expect(res.code).toBe(1);
      expect(res.err).toContain("rule (e)");
      expect(res.err).toContain("services/config/src/a.ts:1");
    });

    it.each([
      ['export * from "../../engine/src/index.js";'],
      ['const m = await import("../../../packages/engine/src/index.js");'],
      ['const m = require("../../../packages/engine/src/index.js");'],
    ])("fails on %s", (line) => {
      const f = fixture();
      f.file("services/config/src/b.mts", `${line}\n`);
      expect(f.run().code).toBe(1);
    });

    it("fails on an undeclared bare workspace import, in every source extension", () => {
      for (const ext of ["ts", "tsx", "mts", "js", "mjs"]) {
        const f = fixture();
        f.file(`services/config/src/c.${ext}`, 'import { x } from "@prosegate/engine";\n');
        const res = f.run();
        expect(res.code, ext).toBe(1);
        expect(res.err).toContain("does not declare");
      }
    });

    it("fails on an undeclared import of the adapter by its unscoped name and subpaths", () => {
      const f = fixture();
      f.file("services/config/src/d.ts", 'import "prosegate/anything";\n');
      expect(f.run().code).toBe(1);
    });

    it("allows declared imports, same-package relative imports and imports inside dist/ or node_modules/", () => {
      const f = fixture();
      f.file("services/config/src/ok.ts", 'import { a } from "./lib/a.js";\nimport "@prosegate/schema";\n');
      f.file("services/config/dist/bundle.js", 'import "../../../packages/engine/src/index.js";\n');
      f.file("services/config/node_modules/x/index.js", 'import "@prosegate/engine";\n');
      expect(f.run().code).toBe(0);
    });
  });

  describe("workspace patterns", () => {
    it.each([
      ['packages:\n  - "packages/**"\n'],
      ['packages:\n  - "!packages/x"\n  - "packages/*"\n'],
      ['packages: ["packages/*"]\n'],
      ['packages:\n  - "nope/*"\n'],
      ['packages:\n  - "nothere"\n'],
      ["other: 1\n"],
    ])("exits 2 instead of skipping an unexpandable list: %j", (yaml) => {
      const f = fixture();
      f.file("pnpm-workspace.yaml", yaml);
      const res = f.run();
      expect(res.code).toBe(2);
      expect(res.err).toContain("cannot read the workspace");
    });
  });

  it("exits 2 when a declared dependency is not installed and nothing else is wrong", () => {
    const f = fixture();
    f.addDep("packages/schema", "dependencies", "zod", "3.0.0");
    const res = f.run();
    expect(res.code).toBe(2);
    expect(res.err).toContain("run `pnpm install`");
  });

  it("reports violations (exit 1) even when something is also not installed", () => {
    const f = fixture();
    f.addDep("packages/schema", "dependencies", "zod", "3.0.0");
    f.addDep("services/config", "dependencies", "@prosegate/engine", "workspace:*");
    expect(f.run().code).toBe(1);
  });

  it("still runs when started through a symlinked or junctioned path", () => {
    const f = fixture();
    f.addDep("services/config", "dependencies", "@prosegate/engine", "workspace:*");
    const holder = mkdtempSync(join(tmpdir(), "pg-link-"));
    dirs.push(holder);
    const link = join(holder, "scripts-link");
    symlinkSync(dirname(SCRIPT), link, "junction");
    const res = f.run(join(link, "check-deps.mjs"));
    expect(res.code).toBe(1);
    expect(res.err).toContain("rule (a)");
  });

  it("copies of the script elsewhere behave the same (no hidden dependence on the repo layout)", () => {
    const f = fixture();
    const holder = mkdtempSync(join(tmpdir(), "pg-copy-"));
    dirs.push(holder);
    cpSync(dirname(SCRIPT), join(holder, "scripts"), { recursive: true });
    expect(f.run(join(holder, "scripts", "check-deps.mjs")).code).toBe(0);
  });
});
