import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { BUNDLED_PACK_YAML, parseRulePackYaml } from "@prosegate/profiles";
import { compilePack } from "../src/index.js";
import { CORE_COMPILED, profile, run } from "./helpers.js";
const WRITING_FIXTURES = JSON.parse(readFileSync(new URL("../../../eval/fixtures/writing-review.json", import.meta.url), "utf8")) as [string, string, string][];

const parsed = parseRulePackYaml(BUNDLED_PACK_YAML["writing@0.1.0"]);
if (!parsed.ok) throw parsed.error;
const writing = compilePack(parsed.value);
const options = { profile: profile("local/writing-review"), packs: [CORE_COMPILED, writing] };

describe("warning-only contextual writing profile: local checks", () => {
  it.each(WRITING_FIXTURES)("does not let legacy heuristics flag the %s exception", (_id, _hit, exception) => {
    expect(run(exception, options).result.findings).toEqual([]);
  });
  for (const rule of parsed.value.rules) {
    it.each(rule.examples.hit)(`${rule.id} warns on %s without forcing revision`, (text) => {
      const out = run(text, options).result;
      expect(out.findings).toHaveLength(1);
      expect(out.findings[0]).toMatchObject({ rule_id: rule.id, severity: "warn" });
      expect(out.verdict).toBe("pass");
    });
    it.each(rule.examples.miss)(`${rule.id} accepts %s`, (text) => {
      expect(run(text, options).result.findings).toEqual([]);
    });
  }
  it.each([
    "The vendor may terminate only after giving 30 days' written notice.",
    "The estimate might rise because two regions have not reported.",
    "The phrase `might possibly` is redundant.",
    "> At this point in time, the patch might possibly work.\n\nThese are the source's words.",
    "```text\nin order to\nmight possibly\n```",
    "| Example | Type |\n| --- | --- |\n| might possibly | hedge |",
  ])("preserves permissions, necessary uncertainty and protected text: %s", (text) => {
    expect(run(text, options).result.findings).toEqual([]);
  });
});
