import { describe, expect, it } from "vitest";
import { resolveProfile } from "./resolve.js";
import { canonicalJson, contentHash, parseSnapshot, serializeSnapshot, type ResolvedProfile } from "./snapshot.js";
import { CORE_PIN, makeSources, profileYaml } from "./test-util.js";

/** Resolves a one-profile chain from the given body, with core 0.1.0 available. */
function resolveBody(body: string, opts: { id?: string; version?: number } = {}): ResolvedProfile {
  const id = opts.id ?? "t/a";
  return resolveProfile(id, makeSources({ [id]: profileYaml(id, body, { version: opts.version ?? 3 }) }));
}

const BODY = `${CORE_PIN}
overrides:
  categories:
    triad: { severity: info }
    structure: { severity: block }
    hedge: { severity: warn }
  rules:
    core.hedge.003: { severity: info }
    core.vocab.003: { enabled: false }
  allow_terms: [robust, idempotent, comprehensive]
  thresholds:
    token_floor_words: 40
    reviewer_floor_words: 120
reviewer:
  enabled: true
  categories: [unsupported_claim, register]
  register:
    max_words: 300
    tone: "Terse."
    format: "Plain."
`;

describe("canonicalJson", () => {
  it("sorts keys recursively, drops whitespace, keeps array order", () => {
    expect(canonicalJson({ b: 1, a: [2, { d: 1, c: 2 }], c: null, e: "x" })).toBe('{"a":[2,{"c":2,"d":1}],"b":1,"c":null,"e":"x"}');
  });

  it("is independent of the order keys were inserted in", () => {
    expect(canonicalJson({ a: 1, b: { y: 1, x: 2 } })).toBe(canonicalJson({ b: { x: 2, y: 1 }, a: 1 }));
  });

  it("omits undefined members and rejects values JSON cannot represent", () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}');
    expect(() => canonicalJson({ a: Number.NaN })).toThrow();
    expect(() => canonicalJson({ a: () => 1 })).toThrow();
  });

  it("escapes strings exactly as JSON does", () => {
    expect(canonicalJson({ "k\"ey": 'a"b\\c\n ' })).toBe(JSON.stringify({ "k\"ey": 'a"b\\c\n ' }));
  });
});

describe("snapshot version: '<leaf version>+<8 hex>'", () => {
  it("has the leaf version and an 8-hex suffix", () => {
    expect(resolveBody(BODY).version).toMatch(/^3\+[0-9a-f]{8}$/);
  });

  it("the suffix is the first 8 hex of the content hash, and the version field is not part of it", () => {
    const r = resolveBody(BODY);
    expect(r.version.endsWith(`+${contentHash(r)}`)).toBe(true);
    expect(contentHash({ ...r, version: "999+deadbeef" })).toBe(contentHash(r));
  });

  it("is stable: resolving twice gives the same version", () => {
    expect(resolveBody(BODY).version).toBe(resolveBody(BODY).version);
  });

  it("does not change when YAML key order changes", () => {
    const reordered = `reviewer:
  register:
    format: "Plain."
    tone: "Terse."
    max_words: 300
  categories: [unsupported_claim, register]
  enabled: true
overrides:
  thresholds:
    reviewer_floor_words: 120
    token_floor_words: 40
  allow_terms: [robust, idempotent, comprehensive]
  rules:
    core.vocab.003: { enabled: false }
    core.hedge.003: { severity: info }
  categories:
    hedge: { severity: warn }
    structure: { severity: block }
    triad: { severity: info }
rule_packs:
  - { version: ">=0.1.0 <1.0.0", id: core }
`;
    expect(resolveBody(reordered).version).toBe(resolveBody(BODY).version);
    // and the objects really were built in different key orders, so the test exercises the sort
    expect(Object.keys(resolveBody(reordered).categories)).not.toEqual(Object.keys(resolveBody(BODY).categories));
  });

  it("does not change when allow_terms order or duplicates change", () => {
    const shuffled = BODY.replace("[robust, idempotent, comprehensive]", "[comprehensive, robust, robust, idempotent]");
    expect(resolveBody(shuffled).allow_terms).toEqual(["comprehensive", "idempotent", "robust"]);
    expect(resolveBody(shuffled).version).toBe(resolveBody(BODY).version);
  });

  it("does not change when the reviewer category list is reordered", () => {
    expect(resolveBody(BODY.replace("[unsupported_claim, register]", "[register, unsupported_claim]")).version).toBe(resolveBody(BODY).version);
  });

  it("changes when a severity changes", () => {
    const base = resolveBody(BODY).version;
    expect(resolveBody(BODY.replace("triad: { severity: info }", "triad: { severity: warn }")).version).not.toBe(base);
    expect(resolveBody(BODY.replace("core.hedge.003: { severity: info }", "core.hedge.003: { severity: block }")).version).not.toBe(base);
  });

  it("changes when anything else resolved changes", () => {
    const base = resolveBody(BODY).version;
    for (const [from, to] of [
      ["token_floor_words: 40", "token_floor_words: 41"],
      ["[robust, idempotent, comprehensive]", "[robust, idempotent]"],
      ["max_words: 300", "max_words: 301"],
      ['tone: "Terse."', 'tone: "Terse!"'],
      ["enabled: true", "enabled: false"],
      ["core.vocab.003: { enabled: false }", "core.vocab.003: { enabled: true }"],
      ['">=0.1.0 <1.0.0"', '">=0.1.0 <2.0.0"'],
    ] as const) {
      expect(resolveBody(BODY.replace(from, to)).version, `${from} -> ${to}`).not.toBe(base);
    }
  });

  it("the hash suffix changes when the leaf's profile version does not, and the number changes when the profile version does", () => {
    const a = resolveBody(BODY, { version: 3 }).version;
    const b = resolveBody(BODY, { version: 4 }).version;
    expect(a.split("+")[1]).not.toBe(b.split("+")[1]); // sources lists the version, so the content differs
    expect(b.startsWith("4+")).toBe(true);
  });

  it("known answer: a fixed profile has a fixed canonical form and hash (guards against an accidental algorithm or field change; the digest was cross-checked against node:crypto sha256)", () => {
    const r = resolveBody(CORE_PIN);
    const content = Object.fromEntries(Object.entries(r).filter(([k]) => k !== "version"));
    expect(canonicalJson(content)).toBe(
      '{"allow_terms":[],"categories":{},"enforcement":{"mode":"enforce","pass_cap":2,"render":"diff","required":false},"id":"t/a","name":"t/a","packs":[{"id":"core","origin":"synced","pinned_by":"t/a","range":">=0.1.0 <1.0.0","signed":true,"version":"0.1.0"}],"policy":null,"resolved_from":["t/a"],"reviewer":{"categories":[],"enabled":false,"register":{}},"rules":{},"schema":"prosegate.resolved/1","sources":[{"id":"t/a","origin":"synced","signed":true,"version":3}],"thresholds":{"reviewer_floor_words":150,"token_floor_words":60},"trigger":{"description":null,"harness_hints":[],"patterns":[],"sticky":true}}',
    );
    expect(r.version).toBe("3+8a9c91d8");
  });
});

describe("snapshot serialisation", () => {
  const resolved = resolveBody(BODY);

  it("round-trips: parse(serialize(x)) equals x", () => {
    const parsed = parseSnapshot(serializeSnapshot(resolved));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value).toEqual(resolved);
  });

  it("serialising is deterministic and idempotent through a parse", () => {
    const text = serializeSnapshot(resolved);
    expect(text).toBe(serializeSnapshot(resolved));
    const parsed = parseSnapshot(text);
    if (!parsed.ok) throw new Error("parse failed");
    expect(serializeSnapshot(parsed.value)).toBe(text);
    expect(text.endsWith("}\n")).toBe(true);
  });

  it("round-trips a policy, a local overlay and an empty profile", () => {
    const withPolicy = resolveProfile("t/a", makeSources({ "t/a": profileYaml("t/a", BODY) }), {
      policy: { org: "acme", enforcement_default: "required", byok_required: true, allowed_providers: ["openai"] },
      local: { profiles: { "t/a": { yaml: profileYaml("t/a", "", { version: 1 }) } } },
    });
    const parsed = parseSnapshot(serializeSnapshot(withPolicy));
    expect(parsed.ok && parsed.value).toEqual(withPolicy);
    const bare = resolveBody("");
    expect(parseSnapshot(serializeSnapshot(bare))).toEqual({ ok: true, value: bare });
  });

  it("keeps the schema marker", () => {
    expect(resolved.schema).toBe("prosegate.resolved/1");
  });

  function reject(text: string) {
    const r = parseSnapshot(text);
    if (r.ok) throw new Error("expected the snapshot to be rejected");
    expect(r.error.code).toBe("invalid_profile");
    return r.error;
  }

  it("rejects text that is not JSON", () => {
    expect(reject("{").message).toMatch(/not valid JSON/);
    expect(reject("").message).toMatch(/not valid JSON/);
  });

  it("rejects an unknown field at the top level and nested", () => {
    const obj = JSON.parse(serializeSnapshot(resolved)) as Record<string, unknown>;
    expect(reject(JSON.stringify({ ...obj, extra: 1 })).issues).toContainEqual({ path: "extra", message: "unknown field" });
    const nested = { ...obj, enforcement: { ...(obj.enforcement as object), surprise: true } };
    expect(reject(JSON.stringify(nested)).issues).toContainEqual({ path: "enforcement.surprise", message: "unknown field" });
  });

  it("rejects a missing field and a wrong type", () => {
    const obj = JSON.parse(serializeSnapshot(resolved)) as Record<string, unknown>;
    const noPolicy = { ...obj };
    delete noPolicy.policy;
    expect(reject(JSON.stringify(noPolicy)).issues.map((i) => i.path)).toContain("policy");
    expect(reject(JSON.stringify({ ...obj, thresholds: { token_floor_words: "60", reviewer_floor_words: 150 } })).issues.map((i) => i.path)).toContain("thresholds.token_floor_words");
  });

  it("rejects a snapshot whose content no longer matches its version hash", () => {
    const text = serializeSnapshot(resolved);
    const edited = text.replace('"severity": "info"', '"severity": "block"');
    expect(edited).not.toBe(text);
    expect(reject(edited).message).toMatch(/does not match its version hash/);
    const relaxed = text.replace('"enabled": true', '"enabled": false');
    expect(reject(relaxed).message).toMatch(/does not match its version hash/);
  });

  it("rejects a version with no hash suffix", () => {
    const obj = JSON.parse(serializeSnapshot(resolved)) as Record<string, unknown>;
    expect(reject(JSON.stringify({ ...obj, version: "3" })).issues.map((i) => i.path)).toContain("version");
  });
});
