import { describe, expect, it } from "vitest";
import { validatePublication } from "./publish-pack.js";

const pack = `schema: prosegate.rulepack/1
id: team
version: 1.0.0
findings_schema: 1
rules:
  - id: team.filler.001
    category: filler
    severity: block
    match: { kind: phrase, position: any, phrases: ["great question"] }
    instruction: { action: remove, text: "Remove the preamble." }
    examples:
      hit: ["Great question. The cache is local."]
      miss: ["The cache is local."]
`;
describe("separate pack publishing process", () => {
  it("runs the actual engine examples and latency measurement", () => {
    const result = validatePublication(pack);
    expect(result).toMatchObject({ passed: true, examples_pass: 2, examples_total: 2, failed_rule_ids: [] });
    expect(result.latency_p95_ms).toBeGreaterThan(0);
  });
  it("rejects a planted incorrect example and names the failing rule", () => {
    const result = validatePublication(pack.replace('miss: ["The cache is local."]', 'miss: ["Great question."]'));
    expect(result.passed).toBe(false);
    expect(result.failed_rule_ids).toEqual(["team.filler.001"]);
  });
});
