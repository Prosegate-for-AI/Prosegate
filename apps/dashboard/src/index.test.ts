import { describe, expect, it } from "vitest";
import { dashboardPlaceholder } from "./index.js";

describe("@prosegate/dashboard", () => {
  it("exports its placeholder and wires its workspace deps", () => {
    expect(dashboardPlaceholder.id).toBe("prosegate:dashboard:placeholder");
    expect(dashboardPlaceholder.uses).toEqual(["prosegate:schema:placeholder"]);
  });
});
