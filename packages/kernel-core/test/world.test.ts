// Sanity of the shared fixtures: the base world is schema-valid and passes K-01..K-08 (positive control for
// every negative test in this package), and the full evaluate() of this build never releases.
import { describe, expect, it } from "vitest";
import { CheckResultSchema, EngagementSchema, PaymentIntentSchema, verifyTermsHash } from "@symbolon/schemas";
import { KERNEL_VERSION, PACKAGE_NAME, evaluate } from "../src/index";
import { context, engagement, intent, phaseA, policy } from "./helpers";

describe("base world", () => {
  it("is schema-valid with a real termsHash", () => {
    expect(PACKAGE_NAME).toBe("@symbolon/kernel-core");
    expect(PaymentIntentSchema.safeParse(intent()).success).toBe(true);
    const e = engagement();
    expect(EngagementSchema.safeParse(e).success).toBe(true);
    expect(verifyTermsHash(e)).toBe(true);
  });

  it("passes every implemented check (K-01..K-08) and aggregates to RELEASE", () => {
    const e = phaseA(intent());
    expect(e.checks.map((c) => [c.id, c.status])).toEqual([
      ["K-01", "PASS"], ["K-02", "PASS"], ["K-03", "PASS"], ["K-04", "PASS"],
      ["K-05", "PASS"], ["K-06", "PASS"], ["K-07", "PASS"], ["K-08", "PASS"],
    ]);
    expect(e.verdict).toBe("RELEASE");
    expect(e.reasons).toEqual([]);
    expect(e.intentIdBound).toBe(true);
    expect(e.amountBaseUnits).toBe("1000000000");
    for (const c of e.checks) expect(CheckResultSchema.safeParse(c).success).toBe(true);
  });

  it("evaluate() in the WP-04 build returns every required check and HOLDs on the WP-05 placeholders", () => {
    const e = evaluate(intent(), context(), policy());
    expect(e.checks.map((c) => c.id)).toEqual(["K-16", "K-01", "K-02", "K-03", "K-04", "K-05", "K-06", "K-07", "K-08", "K-09", "K-10", "K-11", "K-12", "K-13", "K-14"]);
    expect(e.verdict).toBe("HOLD");
    expect(e.reasons).toEqual(["KERNEL_ERROR"]);
    expect(e.kernelVersion).toBe(KERNEL_VERSION);
    expect(e.checks.filter((c) => c.status === "PASS").map((c) => c.id)).toEqual(["K-01", "K-02", "K-03", "K-04", "K-05", "K-06", "K-07", "K-08"]);
  });
});
