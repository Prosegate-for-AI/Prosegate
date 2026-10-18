import { describe, expect, it } from "vitest";
import { parseProfileYaml } from "./profile.js";
import { parseRulePackYaml } from "./rulepack.js";
import { bestCpuMs, profileYaml } from "./test-util.js";
import { MAX_PACK_BYTES, MAX_PACK_NODES, MAX_PROFILE_BYTES, MAX_PROFILE_NODES, formatPath, parseYamlStrict } from "./yaml.js";

const BIG = 1_000_000;

function rejected(text: unknown, maxNodes = BIG) {
  const r = parseYamlStrict(text, BIG, maxNodes);
  if (r.ok) throw new Error("expected the YAML to be rejected");
  return r.issues;
}

/** Wall-clock milliseconds of one call. */
function timed<T>(fn: () => T): { ms: number; value: T } {
  const start = Date.now();
  const value = fn();
  return { ms: Date.now() - start, value };
}

describe("YAML hardening (ADR-19)", () => {
  it("caps: 64 KB / 5k nodes for a profile, 256 KB / 25k nodes for a pack", () => {
    expect([MAX_PROFILE_BYTES, MAX_PROFILE_NODES, MAX_PACK_BYTES, MAX_PACK_NODES]).toEqual([65536, 5000, 262144, 25000]);
  });

  it("input that is not a string is rejected, not thrown on", () => {
    for (const bad of [undefined, null, 5, {}, [], Symbol.iterator]) {
      expect(rejected(bad)[0]?.message).toBe("the document must be text");
    }
  });

  it("rejects any % directive, including after a byte order mark and with CR line ends", () => {
    for (const text of ["%YAML 1.1\n---\na: 1\n", "%TAG !e! tag:example.com,2000:\n---\na: 1\n", "a: 1\n%YAML 1.1\n", "\ufeff%YAML 1.1\n---\na: 1\n", "a: 1\r%YAML 1.1\r"]) {
      expect(rejected(text)[0]?.message, JSON.stringify(text)).toBe("YAML directives (%) are not allowed");
    }
    // a percent sign inside a value is fine
    expect(parseYamlStrict("a: 50% done\nb: '%x'\n", BIG, BIG).ok).toBe(true);
  });

  it("detects duplicate keys, at the top level and nested, with the line number", () => {
    const top = rejected("a: 1\nb: 2\na: 3\n");
    expect(top).toEqual([{ path: "", message: "duplicate map key (line 3)" }]);
    expect(rejected("m:\n  x: 1\n  y: 2\n  x: 3\n")[0]?.message).toBe("duplicate map key (line 4)");
    expect(rejected("m: {x: 1, x: 2}\n")[0]?.message).toMatch(/duplicate map key/);
    // the same key in different maps is fine
    expect(parseYamlStrict("a:\n  x: 1\nb:\n  x: 2\n", BIG, BIG).ok).toBe(true);
    // 1 and "1" collide as keys
    expect(rejected("1: a\n'1': b\n")[0]?.message).toMatch(/duplicate map key/);
  });

  it("rejects non-scalar keys", () => {
    expect(rejected("? [a, b]\n: x\n")[0]?.message).toMatch(/map keys must be plain scalars/);
    expect(rejected("{a: 1}: x\n")[0]?.message).toMatch(/map keys must be plain scalars/);
    expect(rejected("? {a: 1}\n: x\n")[0]?.message).toMatch(/map keys must be plain scalars/);
  });

  it("reports only the first YAML error, as a fixed message with the line number and no source text", () => {
    const secret = "SENTINEL-must-not-be-echoed";
    const issues = rejected(`a: [${secret}\nb: {\nc: ]\n  d: *\n`);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.message).toMatch(/^YAML error [A-Z_]+( at line \d+)?$/);
    expect(JSON.stringify(issues)).not.toContain(secret);
  });

  it("rejects non-decimal numbers: hex, octal, binary-looking and exponent forms", () => {
    for (const text of ["a: 0x10\n", "a: 0o17\n", "a: 1e3\n", "a: 1E3\n", "a: 2.5e-1\n"]) {
      expect(rejected(text)[0]?.message, text).toMatch(/only plain decimal numbers/);
    }
    expect(parseYamlStrict("a: 10\nb: 2.5\nc: -3\n", BIG, BIG).ok).toBe(true);
  });

  it("through the schemas: a hex version is rejected, not read as 16", () => {
    const r = parseProfileYaml(profileYaml("a/b").replace("version: 1", "version: 0x10"));
    expect(r.ok).toBe(false);
  });

  it("rejects a merge key (inline and by alias) because the key is not in the schema", () => {
    const inline = parseProfileYaml(profileYaml("a/b", "trigger:\n  <<: {sticky: true}"));
    expect(inline.ok).toBe(false);
    if (!inline.ok) expect(inline.error.issues).toContainEqual({ path: 'trigger["<<"]', message: "unknown field" });
    const aliased = parseProfileYaml(profileYaml("a/b", "x: &m {sticky: true}\ntrigger:\n  <<: *m"));
    expect(aliased.ok).toBe(false);
  });

  it("a %YAML 1.1 directive cannot re-enable merge keys or 1.1 typing", () => {
    const r = parseProfileYaml(`%YAML 1.1\n---\n${profileYaml("a/b", "trigger:\n  <<: {sticky: true}")}`);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.issues[0]?.message).toBe("YAML directives (%) are not allowed");
  });

  it("caps issues at 50 and clips path segments at 60 characters", () => {
    const dups = Array.from({ length: 300 }, () => "k: 1").join("\n");
    expect(rejected(dups).length).toBeLessThanOrEqual(50);
    const longKey = "k".repeat(500);
    const r = parseProfileYaml(profileYaml("a/b", `${longKey}: 1`));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.issues[0]?.path.length).toBeLessThanOrEqual(61);
    expect(formatPath(["x".repeat(100)]).length).toBeLessThanOrEqual(61);
    expect(formatPath(["a b".repeat(100)]).length).toBeLessThanOrEqual(70);
    const many = Array.from({ length: 200 }, (_, i) => `unknown${i}: 1`).join("\n");
    const r2 = parseProfileYaml(profileYaml("a/b", many));
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.error.issues.length).toBeLessThanOrEqual(50);
  });

  it("node-count pre-scan: at the limit parses, one over is rejected before parsing", () => {
    // "a: 1\n" counts 3 nodes (start 1, ':' and '\n').
    expect(parseYamlStrict("a: 1\n", BIG, 3).ok).toBe(true);
    expect(rejected("a: 1\n", 2)[0]?.message).toBe("document has more than 2 nodes");
    // each comma, bracket and colon counts too
    expect(parseYamlStrict("a: [1, 2]", BIG, 5).ok).toBe(true); // start, ':', '[', ',' = 4... plus none: within 5
    expect(rejected("a: [1, 2, 3, 4, 5, 6]", 5)[0]?.message).toBe("document has more than 5 nodes");
  });

  it("rejects flow collections nested more than 64 deep, without recursing", () => {
    const deep = `a: ${"[".repeat(65)}${"]".repeat(65)}`;
    expect(rejected(deep)[0]?.message).toBe("flow collections are nested too deeply");
    expect(parseYamlStrict(`a: ${"[".repeat(64)}${"]".repeat(64)}`, BIG, BIG).ok).toBe(true);
  });

  it("deep block nesting does not throw", () => {
    const deep = Array.from({ length: 4000 }, (_, i) => `${" ".repeat(i)}a:`).join("\n");
    expect(() => parseYamlStrict(deep, BIG, BIG)).not.toThrow();
  });
});

describe("YAML performance (ADR-19): hostile 256 KB documents parse or reject in under 250 ms", () => {
  const LIMIT_MS = 250;

  it("256 KB of unique one-line keys", () => {
    const text = Array.from({ length: 22_000 }, (_, i) => `key${i}: v`).join("\n");
    expect(text.length).toBeGreaterThan(200_000);
    expect(text.length).toBeLessThan(MAX_PACK_BYTES);
    const { ms, value } = timed(() => parseRulePackYaml(text));
    expect(value.ok).toBe(false);
    expect(ms).toBeLessThan(LIMIT_MS);
  });

  it("256 KB flow map", () => {
    const text = `a: {${Array.from({ length: 22_000 }, (_, i) => `k${i}: v`).join(", ")}}`;
    expect(text.length).toBeLessThan(MAX_PACK_BYTES);
    const { ms, value } = timed(() => parseRulePackYaml(text));
    expect(value.ok).toBe(false);
    expect(ms).toBeLessThan(LIMIT_MS);
  });

  it("'a: [' followed by 65k commas", () => {
    const text = `a: [${",".repeat(65_000)}`;
    const { ms, value } = timed(() => parseRulePackYaml(text));
    expect(value.ok).toBe(false);
    expect(ms).toBeLessThan(LIMIT_MS);
  });

  it("a document just under the node cap (about 24k nodes of unique keys) parses with the O(n) duplicate check", () => {
    const text = Array.from({ length: 12_000 }, (_, i) => `k${i}: v`).join("\n");
    // CPU time, best of 5 (a wall-clock budget fails on a loaded machine).
    const { ms, value } = bestCpuMs(() => parseYamlStrict(text, MAX_PACK_BYTES, MAX_PACK_NODES));
    expect(value.ok).toBe(true);
    // The library alone needs 120-220 ms for 24k nodes (measured); the check adds under 30 ms. The
    // quadratic check it replaced took 20-80 s on a 256 KB pack.
    expect(ms).toBeLessThan(1000);
  });

  it("the same under the profile caps is rejected on the node count in constant time", () => {
    const text = Array.from({ length: 12_000 }, (_, i) => `k${i}: v`).join("\n");
    const { ms, value } = timed(() => parseProfileYaml(text));
    expect(value.ok).toBe(false);
    expect(ms).toBeLessThan(LIMIT_MS);
  });

  it("a legal-sized pack of 100k one-character comment lines (cheap lines)", () => {
    const text = `${"#\n".repeat(100_000)}a: 1\n`;
    expect(text.length).toBeLessThan(MAX_PACK_BYTES);
    const { ms } = timed(() => parseRulePackYaml(text));
    expect(ms).toBeLessThan(LIMIT_MS);
  });
});
