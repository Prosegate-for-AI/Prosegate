import { describe, expect, it } from "vitest";
import { adapterPlaceholder } from "./index.js";

describe("prosegate", () => {
  it("exports its placeholder and wires its workspace deps", () => {
    expect(adapterPlaceholder.id).toBe("prosegate:adapter:placeholder");
    expect(adapterPlaceholder.uses).toEqual(["prosegate:schema:placeholder","prosegate:segmenter:placeholder","prosegate:engine:placeholder","prosegate:profiles:placeholder","prosegate:reviewer:placeholder"]);
  });
});
