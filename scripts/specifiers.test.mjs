import { describe, expect, it } from "vitest";
import { disallowedSpecifiers } from "./check-bundle.mjs";
import { extractSpecifiers, lineOf, maskNonCode } from "./lib/specifiers.mjs";

const specs = (text) => extractSpecifiers(text).map((s) => s.spec);

describe("specifier scan ignores comments and string literals that are not specifiers", () => {
  it("the shape that broke check:bundle: prose in a bundled dependency's comment", () => {
    const text = [
      "/**",
      " * Custom Node values that inherit from `Object` still refer to their original instances.",
      " */",
      "function f() {}",
    ].join("\n");
    expect(specs(text)).toEqual([]);
    expect(disallowedSpecifiers(text)).toEqual([]);
  });

  it("line comments and block comments, however they look like imports", () => {
    const text = [
      '// import x from "left-pad";',
      '/* const y = require("lodash"); */',
      "// from 'chalk'",
      "/* a\n * export * from \"kleur\";\n */",
      'import real from "node:fs";',
    ].join("\n");
    expect(specs(text)).toEqual(["node:fs"]);
  });

  it("string literals that merely contain the words", () => {
    const text = [
      "const a = \"Profile chain from 'x' is longer\";",
      "const b = 'say: import(\"y\")';",
      "const c = `copied from \"z\" and require('w')`;",
      "const d = `${a} from 'q'`;",
      'import real from "node:path";',
    ].join("\n");
    expect(specs(text)).toEqual(["node:path"]);
  });

  it("regular-expression literals that contain quotes and the words", () => {
    const text = [
      "const r1 = /from [\"']x[\"']/g;",
      "const r2 = x.replace(/require\\(\"y\"\\)/, '');",
      "const half = total / 2; const q = 'from';",
      'import real from "node:os";',
    ].join("\n");
    expect(specs(text)).toEqual(["node:os"]);
  });

  it("every real form is still found after all of the above", () => {
    const text = [
      "/* from `Object` */",
      'import a from "left-pad";',
      'import "side-effect";',
      'export * from "@prosegate/schema";',
      'export { b } from "./b.js";',
      "import {",
      "  c,",
      "  d,",
      '} from "multi-line";',
      'const e = require("lodash");',
      'const f = await import("chalk");',
      'const g = __require("kleur");',
      "const h = await import(`tpl`);",
      "const msg = `built ${a} ok`;",
      'import type { T } from "types-only";',
    ].join("\n");
    expect(specs(text).sort()).toEqual(
      ["./b.js", "@prosegate/schema", "chalk", "kleur", "left-pad", "lodash", "multi-line", "side-effect", "tpl", "types-only"].sort(),
    );
  });

  it("template literals with nested braces and interpolations do not hide the code after them", () => {
    const text = ["const m = `a ${ {x: 1}.x } b ${`inner ${1}`} c`;", 'import real from "after-template";'].join("\n");
    expect(specs(text)).toEqual(["after-template"]);
  });

  it("an unterminated string or comment does not throw and does not loop", () => {
    for (const text of ["const a = 'unterminated", "/* never closed", "const t = `never closed", "x = /unclosed"]) {
      expect(() => extractSpecifiers(text)).not.toThrow();
    }
  });

  it("masking keeps offsets: line numbers of real specifiers are unchanged", () => {
    const text = ["// from 'a'", "/* x", "y */", 'import real from "m";'].join("\n");
    expect(maskNonCode(text)).toHaveLength(text.length);
    const [found] = extractSpecifiers(text);
    expect(lineOf(text, found.index)).toBe(4);
  });

  it("a check:bundle run over the bundled yaml comment shape reports nothing", () => {
    const text = [
      'import fs from "node:fs";',
      "  /**",
      "   * Custom Node values that inherit from `Object` still refer to their original instances.",
      "   */",
      "  var x = 1;",
    ].join("\n");
    expect(disallowedSpecifiers(text)).toEqual([]);
  });
});
