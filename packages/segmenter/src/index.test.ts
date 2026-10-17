import { describe, expect, it } from "vitest";
import { segmenterPlaceholder } from "./index.js";

describe("@prosegate/segmenter", () => {
  it("exports its placeholder and wires its workspace deps", () => {
    expect(segmenterPlaceholder.id).toBe("prosegate:segmenter:placeholder");
    expect(segmenterPlaceholder.uses).toEqual(["prosegate:schema:placeholder"]);
  });
});
