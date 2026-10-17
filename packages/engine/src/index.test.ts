import { describe, expect, it } from "vitest";
import { enginePlaceholder } from "./index.js";

describe("@prosegate/engine", () => {
  it("exports its placeholder and wires its workspace deps", () => {
    expect(enginePlaceholder.id).toBe("prosegate:engine:placeholder");
    expect(enginePlaceholder.uses).toEqual(["prosegate:schema:placeholder","prosegate:segmenter:placeholder","prosegate:profiles:placeholder"]);
  });
});
