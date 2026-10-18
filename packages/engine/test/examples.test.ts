import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CORE, hits } from "./helpers.js";

// Exit gate for Phase 2: every hit example of every `core` rule fires that rule and no miss example
// does, evaluated as a standalone document with the floors bypassed, under local/base.

const CORPUS = join(dirname(fileURLToPath(import.meta.url)), "../../../eval/corpora/rule-examples/core");

function resolveExample(example: string): string {
  if (!example.startsWith("<eval corpus ref: ")) return example;
  const name = /core\/([a-z0-9-]+)>$/.exec(example)?.[1];
  if (name === undefined) throw new Error(`bad corpus ref ${example}`);
  return readFileSync(join(CORPUS, `${name}.md`), "utf8");
}

interface Row {
  rule: string;
  hit: string;
  miss: string;
}

const rows: Row[] = [];

describe("core.yaml examples", () => {
  it("has 23 rules", () => {
    expect(CORE.rules).toHaveLength(23);
  });

  for (const rule of CORE.rules) {
    describe(rule.id, () => {
      const row: Row = { rule: rule.id, hit: "", miss: "" };
      rows.push(row);
      const hitResults: boolean[] = [];
      const missResults: boolean[] = [];

      rule.examples.hit.forEach((example, i) => {
        it(`hit ${i + 1} fires ${rule.id}`, () => {
          const found = hits(resolveExample(example)).filter(([id]) => id === rule.id);
          hitResults.push(found.length > 0);
          expect(found.length, `no ${rule.id} finding in: ${example.slice(0, 80)}`).toBeGreaterThan(0);
        });
      });
      rule.examples.miss.forEach((example, i) => {
        it(`miss ${i + 1} does not fire ${rule.id}`, () => {
          const found = hits(resolveExample(example)).filter(([id]) => id === rule.id);
          missResults.push(found.length === 0);
          expect(found, `${rule.id} fired on: ${example.slice(0, 80)}`).toEqual([]);
        });
      });
      it("recorded", () => {
        row.hit = `${hitResults.filter(Boolean).length}/${rule.examples.hit.length}`;
        row.miss = `${missResults.filter(Boolean).length}/${rule.examples.miss.length}`;
      });
    });
  }

  it("prints the table", () => {
    const lines = ["rule                  hit     miss", ...rows.map((r) => `${r.rule.padEnd(22)}${r.hit.padEnd(8)}${r.miss}`)];
    console.log(`\n${lines.join("\n")}\n`);
    expect(rows).toHaveLength(23);
    for (const r of rows) {
      const [hitOk, hitAll] = r.hit.split("/");
      const [missOk, missAll] = r.miss.split("/");
      expect(hitOk, `${r.rule} hit`).toBe(hitAll);
      expect(missOk, `${r.rule} miss`).toBe(missAll);
    }
  });
});
