import { describe, expect, it } from "vitest";
import { PACKAGE_NAME } from "../src/index";

// Placeholder: proves the workspace wiring works. WP-04 deletes this and adds the golden/property
// tests listed in docs/13 §4.1 (discountValue, impliedAprBps, window edges, feasiblePlans closure).
describe("@symbolon/terms scaffold", () => {
  it("is wired into the workspace", () => {
    expect(PACKAGE_NAME).toBe("@symbolon/terms");
  });
});
