import { describe, expect, it } from "vitest";
import { parseProfileYaml } from "./profile.js";
import { profileYaml } from "./test-util.js";
import { MAX_PACK_NODES, MAX_PROFILE_NODES, estimateNodes, parseYamlStrict } from "./yaml.js";

const BIG = 1_000_000;

describe("node pre-scan counts sequence and complex-key indicators (cycle 2)", () => {
  it("a single line of nested '- - - …' is caught by the pre-scan, before the parser", () => {
    const text = `a: ${"- ".repeat(MAX_PACK_NODES + 10)}x`;
    const started = Date.now();
    const r = parseYamlStrict(text, BIG, MAX_PACK_NODES);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues[0]?.message).toBe(`document has more than ${MAX_PACK_NODES} nodes`);
    expect(Date.now() - started).toBeLessThan(250);
  });

  it("the same for '? ' indicators", () => {
    const r = parseYamlStrict(`${"? ".repeat(MAX_PROFILE_NODES + 5)}x`, BIG, MAX_PROFILE_NODES);
    expect(r.ok).toBe(false);
  });

  it("through the profile loader: 5,000 nested indicators in one line are refused", () => {
    const r = parseProfileYaml(profileYaml("a/b", `trigger:\n  patterns: ${"- ".repeat(MAX_PROFILE_NODES)}x`));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.issues[0]?.message).toMatch(/more than 5000 nodes/);
  });

  it("counts one node per '- ' or '? ' (a hyphen inside a word does not count)", () => {
    expect(estimateNodes("a")).toBe(1);
    expect(estimateNodes("- a")).toBe(2);
    expect(estimateNodes("- - a")).toBe(3);
    expect(estimateNodes("? a")).toBe(2);
    expect(estimateNodes("trade-offs")).toBe(1);
    expect(estimateNodes("-")).toBe(2);
    expect(estimateNodes("a\n- b\n- c\n")).toBe(1 + 3 + 2);
  });

  it("a nested-sequence line just under the cap still parses or fails cleanly, without throwing", () => {
    const text = `a: ${"- ".repeat(5000)}x`;
    expect(() => parseYamlStrict(text, BIG, BIG)).not.toThrow();
  });
});

describe("duplicate keys: ~, null and the empty key are one key (cycle 2)", () => {
  it("rejects '~' and '' as duplicates", () => {
    for (const text of ['~: a\n"": b\n', '"": a\n~: b\n', "null: a\n~: b\n", "? \n: a\n~: b\n"]) {
      const r = parseYamlStrict(text, BIG, BIG);
      expect(r.ok, JSON.stringify(text)).toBe(false);
      if (!r.ok) expect(r.issues[0]?.message, JSON.stringify(text)).toMatch(/duplicate map key/);
    }
  });

  it("two distinct non-null keys are still fine", () => {
    expect(parseYamlStrict("a: 1\nb: 2\n", BIG, BIG).ok).toBe(true);
  });
});
