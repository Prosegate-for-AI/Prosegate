import { describe, expect, it } from "vitest";
import { profilesPlaceholder } from "./index.js";

describe("@prosegate/profiles", () => {
  it("exports its placeholder and wires its workspace deps", () => {
    expect(profilesPlaceholder.id).toBe("prosegate:profiles:placeholder");
    expect(profilesPlaceholder.uses).toEqual(["prosegate:schema:placeholder"]);
  });
});
