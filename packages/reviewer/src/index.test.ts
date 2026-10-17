import { describe, expect, it } from "vitest";
import { reviewerPlaceholder } from "./index.js";

describe("@prosegate/reviewer", () => {
  it("exports its placeholder and wires its workspace deps", () => {
    expect(reviewerPlaceholder.id).toBe("prosegate:reviewer:placeholder");
    expect(reviewerPlaceholder.uses).toEqual(["prosegate:schema:placeholder","prosegate:segmenter:placeholder","prosegate:profiles:placeholder"]);
  });
});
