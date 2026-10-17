import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { OUTPUT_FILE, render } from "./gen-bundled.mjs";

describe("bundled.generated.ts", () => {
  it("is up to date with bundled/profiles/*.yaml (run `pnpm --filter @prosegate/profiles gen:bundled`)", () => {
    const committed = readFileSync(OUTPUT_FILE, "utf8").replace(/\r\n/g, "\n");
    expect(committed).toBe(render());
  });
});
