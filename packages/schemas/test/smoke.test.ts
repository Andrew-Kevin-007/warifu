import { describe, expect, it } from "vitest";
import { PACKAGE_NAME } from "../src/index";

// Placeholder: proves the workspace wiring (exports, tsconfig, vitest include) works.
// The owning WP deletes this once it has real tests.
describe("@symbolon/schemas scaffold", () => {
  it("is wired into the workspace", () => {
    expect(PACKAGE_NAME).toBe("@symbolon/schemas");
  });
});
