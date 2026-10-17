import { describe, expect, it } from "vitest";
import { evalPlaceholder } from "./index.js";

describe("@prosegate/eval", () => {
  it("exports its placeholder and wires its workspace deps", () => {
    expect(evalPlaceholder.id).toBe("prosegate:eval:placeholder");
    expect(evalPlaceholder.uses).toEqual(["prosegate:schema:placeholder","prosegate:segmenter:placeholder","prosegate:engine:placeholder","prosegate:profiles:placeholder","prosegate:reviewer:placeholder"]);
  });
});
