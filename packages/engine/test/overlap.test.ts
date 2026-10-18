import { describe, expect, it } from "vitest";
import { placementProblems, type Category, type Severity } from "@prosegate/schema";
import { resolveOverlaps, type Resolvable } from "../src/index.js";
import { hits, packOf, ruleYaml, review, run } from "./helpers.js";

interface F extends Resolvable {
  name: string;
}

function rule(name: string, start: number, end: number, severity: Severity = "warn", category: Category = "vocab", ruleId = `core.${category}.001`): F {
  return { name, source: "rule", category, rule_id: ruleId, severity, span: { start, end } };
}
function rev(name: string, start: number, end: number, severity: Severity = "warn", category: Category = "vague_claim"): F {
  return { name, source: "reviewer", category, rule_id: null, severity, span: { start, end } };
}
const names = (fs: F[]): string[] => resolveOverlaps(fs).map((f) => f.name);

describe("overlap resolution (03, ADR-17)", () => {
  it("higher severity wins, whatever the start or source", () => {
    expect(names([rule("w", 0, 10, "warn"), rule("b", 5, 15, "block")])).toEqual(["b"]);
    expect(names([rule("i", 0, 10, "info"), rule("w", 5, 15, "warn")])).toEqual(["w"]);
    expect(names([rule("rw", 0, 10, "warn"), rev("rb", 5, 15, "block")])).toEqual(["rb"]);
  });

  it("at equal severity a rule beats a reviewer finding, whatever the start", () => {
    expect(names([rev("r", 0, 10), rule("x", 5, 15)])).toEqual(["x"]);
    expect(names([rule("x", 5, 15), rev("r", 0, 10)])).toEqual(["x"]);
  });

  it("at equal severity and source the earlier start wins", () => {
    expect(names([rule("late", 5, 15), rule("early", 0, 10)])).toEqual(["early"]);
    expect(names([rev("late", 5, 15, "warn", "register"), rev("early", 0, 10)])).toEqual(["early"]);
  });

  it("beyond the stated order: same start goes to the longer span, then the smaller rule id", () => {
    expect(names([rule("short", 0, 5), rule("long", 0, 9)])).toEqual(["long"]);
    expect(names([rule("b", 0, 5, "warn", "vocab", "core.vocab.002"), rule("a", 0, 5, "warn", "vocab", "core.vocab.001")])).toEqual(["a"]);
  });

  it("the loser is dropped, not merged; a dropped finding suppresses nobody", () => {
    // A beats B, B overlaps C, A does not overlap C: A and C stay.
    expect(names([rule("A", 0, 10, "block"), rule("B", 8, 20, "warn"), rule("C", 18, 30, "warn")]).sort()).toEqual(["A", "C"]);
  });

  it("touching spans do not intersect", () => {
    expect(names([rule("a", 0, 5), rule("b", 5, 9)])).toEqual(["a", "b"]);
  });

  it("a reviewer finding that fully contains a rule finding of a different category is kept, container first", () => {
    expect(names([rule("inner", 3, 7), rev("outer", 0, 10)])).toEqual(["outer", "inner"]);
    expect(names([rule("inner", 3, 7, "block"), rev("outer", 0, 10, "warn")])).toEqual(["outer", "inner"]);
    expect(names([rule("inner", 0, 10), rev("outer", 0, 10)])).toEqual(["outer", "inner"]);
  });

  it("a reviewer finding with the same category as the rule finding it contains loses to it", () => {
    expect(names([rule("inner", 3, 7, "info", "register"), rev("outer", 0, 10, "block", "register")])).toEqual(["inner"]);
    expect(names([rev("outer", 0, 10, "block", "register"), rule("inner", 3, 7, "info", "register")])).toEqual(["inner"]);
  });

  it("a partial overlap between sources is an ordinary conflict, and a rule that contains a reviewer finding is too", () => {
    expect(names([rev("r", 0, 10, "warn"), rule("x", 8, 20, "warn")])).toEqual(["x"]);
    expect(names([rule("outer", 0, 10, "warn"), rev("inner", 3, 7, "warn")])).toEqual(["outer"]);
    expect(names([rule("outer", 0, 10, "warn"), rev("inner", 3, 7, "block")])).toEqual(["inner"]);
  });

  it("a container with several contained rule findings keeps them all", () => {
    expect(names([rev("outer", 0, 30), rule("a", 2, 6), rule("b", 10, 14), rule("c", 20, 29)])).toEqual(["outer", "a", "b", "c"]);
  });

  it("sorts by start ascending, then end descending", () => {
    const out = resolveOverlaps([rule("c", 20, 25), rule("a", 0, 5), rule("b", 10, 15)]);
    expect(out.map((f) => f.name)).toEqual(["a", "b", "c"]);
  });

  it("does not modify its input and does not depend on its order", () => {
    const input = [rule("a", 0, 10, "block"), rule("b", 5, 15), rev("c", 12, 40, "warn", "register"), rule("d", 20, 25), rule("e", 24, 30, "warn", "hedge", "core.hedge.001")];
    const copy = JSON.stringify(input);
    const expected = names(input);
    expect(JSON.stringify(input)).toBe(copy);
    for (let i = 0; i < input.length; i++) {
      expect(names([...input.slice(i), ...input.slice(0, i)])).toEqual(expected);
      expect(names([...input].reverse())).toEqual(expected);
    }
  });
});

describe("overlap resolution, randomised", () => {
  const RULE_CATS: Category[] = ["filler", "hedge", "vocab", "triad", "structure", "repetition"];
  const REV_CATS: Category[] = ["vague_claim", "unsupported_claim", "register"];
  const SEVS: Severity[] = ["block", "warn", "info"];

  function prng(seed: number): () => number {
    let s = seed >>> 0;
    return () => {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      return s / 2 ** 32;
    };
  }

  function random(rand: () => number, n: number): F[] {
    const out: F[] = [];
    for (let i = 0; i < n; i++) {
      const a = Math.floor(rand() * 60);
      const len = 1 + Math.floor(rand() * 18);
      const sev = SEVS[Math.floor(rand() * 3)] as Severity;
      if (rand() < 0.65) {
        const cat = RULE_CATS[Math.floor(rand() * RULE_CATS.length)] as Category;
        out.push(rule(`r${i}`, a, a + len, sev, cat, `core.${cat}.00${1 + Math.floor(rand() * 3)}`));
      } else {
        out.push(rev(`v${i}`, a, a + len, sev === "info" ? "warn" : sev, REV_CATS[Math.floor(rand() * 3)] as Category));
      }
    }
    return out;
  }

  const segments = new Map([["s1", { id: "s1", kind: "prose", start: 0, end: 1000 }]]);

  it("the output always satisfies the strict ReviewResult placement rule, and is maximal and order independent", () => {
    const rand = prng(20261017);
    for (let round = 0; round < 400; round++) {
      const input = random(rand, 2 + Math.floor(rand() * 14));
      const out = resolveOverlaps(input);
      // (a) the schema's own check, finding by finding in output order
      out.forEach((f, i) => {
        const earlier = out.slice(0, i).map((e) => ({ category: e.category, source: e.source, span: { segment_id: "s1", ...e.span } }));
        const problems = placementProblems(earlier, { category: f.category, source: f.source, span: { segment_id: "s1", ...f.span } }, segments);
        expect(problems, JSON.stringify(out)).toEqual([]);
      });
      // (b) every dropped finding conflicts with a kept one that outranks it
      const kept = new Set(out);
      for (const d of input.filter((f) => !kept.has(f))) {
        const blockers = out.filter((k) => k.span.start < d.span.end && d.span.start < k.span.end);
        expect(blockers.length, `${d.name} was dropped with nothing in its way: ${JSON.stringify(input)}`).toBeGreaterThan(0);
      }
      // (c) order independence
      const shuffled = [...input].sort(() => rand() - 0.5);
      expect(resolveOverlaps(shuffled).map((f) => f.name).sort()).toEqual(out.map((f) => f.name).sort());
    }
  });
});

describe("overlap resolution through the engine", () => {
  it("a higher-severity rule finding hides a lower one that overlaps it", () => {
    // hedge.001 (block) "it's worth noting that" vs a warn rule that matches inside it
    const pack = packOf(
      ruleYaml("core.hedge.001", '{ kind: phrase, phrases: ["it\'s worth noting that"] }', "block"),
      ruleYaml("core.vocab.001", '{ kind: phrase, phrases: ["worth noting"] }', "warn"),
    );
    expect(hits("It's worth noting that it works.", { packs: [pack] })).toEqual([["core.hedge.001", "It's worth noting that"]]);
  });

  it("equal severity: the earlier start wins", () => {
    const pack = packOf(ruleYaml("core.vocab.001", '{ kind: phrase, phrases: ["alpha beta"] }'), ruleYaml("core.vocab.002", '{ kind: phrase, phrases: ["beta gamma"] }'));
    expect(hits("An alpha beta gamma here.", { packs: [pack] })).toEqual([["core.vocab.001", "alpha beta"]]);
  });

  it("the same span found by two parts of one rule is reported once", () => {
    const pack = packOf(ruleYaml("core.vocab.001", "{ kind: any, parts: [{ kind: phrase, phrases: [\"robust\"] }, { kind: regex, pattern: 'robust' }] }"));
    expect(hits("A robust one.", { packs: [pack] })).toEqual([["core.vocab.001", "robust"]]);
  });

  it("output findings are sorted and non-overlapping on a busy text", () => {
    const text =
      "Great question! It's worth noting that the robust and seamless design could potentially delve into various realms. It is fast, simple, and reliable.";
    const r = review(text);
    for (let i = 1; i < r.findings.length; i++) {
      const a = (r.findings[i - 1] as { span: { start: number; end: number } }).span;
      const b = (r.findings[i] as { span: { start: number; end: number } }).span;
      expect(b.start >= a.end || (b.start === a.start && b.end <= a.end)).toBe(true);
      expect(b.start).toBeGreaterThanOrEqual(a.start);
    }
    expect(r.findings.length).toBeGreaterThan(4);
    expect(run(text).diagnostics.all_findings.length).toBeGreaterThanOrEqual(r.findings.length);
  });
});
