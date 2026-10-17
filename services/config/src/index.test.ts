import { describe, expect, it } from "vitest";
import { configPlaceholder } from "./index.js";

describe("@prosegate/config", () => {
  it("exports its placeholder and wires its workspace deps", () => {
    expect(configPlaceholder.id).toBe("prosegate:config:placeholder");
    expect(configPlaceholder.uses).toEqual(["prosegate:schema:placeholder","prosegate:profiles:placeholder"]);
  });
});
