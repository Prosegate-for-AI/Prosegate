import { describe, expect, it } from "vitest";
import { schemaPlaceholder } from "./index.js";

describe("@prosegate/schema", () => {
  it("exports its placeholder and wires its workspace deps", () => {
    expect(schemaPlaceholder.id).toBe("prosegate:schema:placeholder");
    expect(schemaPlaceholder.uses).toEqual([]);
  });
});
