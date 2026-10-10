import { describe, expect, it } from "vitest";
import { ORACLE_VERSION, PACKAGE_NAME } from "../src/index";

// Placeholder: proves the workspace wiring works. WP-23 deletes this and adds a positive and a negative
// fixture per predicate O1..O8 (docs/15 §2) plus the oracle/harness disagreement test (must be 0).
describe("@symbolon/oracle scaffold", () => {
  it("is wired into the workspace", () => {
    expect(PACKAGE_NAME).toBe("@symbolon/oracle");
    expect(ORACLE_VERSION).toBe("oracle-v1");
  });
});
