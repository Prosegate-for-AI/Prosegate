import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { OUTPUT_FILE, render } from "./gen-bundled.mjs";
import { BUNDLED_PARSED_JSON } from "../src/bundled.generated.js";
import { parseYamlStrict, MAX_PACK_BYTES, MAX_PACK_NODES } from "../src/yaml.js";

describe("bundled.generated.ts", () => {
  it("is up to date with bundled/profiles/*.yaml (run `pnpm --filter @prosegate/profiles gen:bundled`)", () => {
    const committed = readFileSync(OUTPUT_FILE, "utf8").replace(/\r\n/g, "\n");
    expect(committed).toBe(render());
  });
  it("every cached document passes the complete strict parser and matches its result", () => {
    expect(Object.keys(BUNDLED_PARSED_JSON)).toHaveLength(6);
    for (const text of Object.keys(BUNDLED_PARSED_JSON)) {
      const strict = parseYamlStrict(text, MAX_PACK_BYTES, MAX_PACK_NODES, false);
      expect(strict.ok).toBe(true);
      expect(parseYamlStrict(text, MAX_PACK_BYTES, MAX_PACK_NODES)).toEqual(strict);
      expect(parseYamlStrict(text + "\n", MAX_PACK_BYTES, MAX_PACK_NODES)).toEqual(strict);
    }
  });
  it("cached values are independent and still honor resource limits", () => {
    const text = Object.keys(BUNDLED_PARSED_JSON)[0];
    const first = parseYamlStrict(text, MAX_PACK_BYTES, MAX_PACK_NODES);
    first.value.name = "changed";
    expect(parseYamlStrict(text, MAX_PACK_BYTES, MAX_PACK_NODES).value.name).not.toBe("changed");
    expect(parseYamlStrict(text, 1, MAX_PACK_NODES).ok).toBe(false);
    expect(parseYamlStrict(text, MAX_PACK_BYTES, 1).ok).toBe(false);
    expect(parseYamlStrict(text + "\nextra: &value x\n", MAX_PACK_BYTES, MAX_PACK_NODES).ok).toBe(false);
  });
});
