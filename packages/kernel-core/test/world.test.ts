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

  it("evaluate() runs every required check and RELEASEs the base world (K-13 SKIP: screening off by policy)", () => {
    const e = evaluate(intent(), context(), policy());
    expect(e.checks.map((c) => [c.id, c.status])).toEqual([
      ["K-16", "PASS"], ["K-01", "PASS"], ["K-02", "PASS"], ["K-03", "PASS"], ["K-04", "PASS"], ["K-05", "PASS"], ["K-06", "PASS"],
      ["K-07", "PASS"], ["K-08", "PASS"], ["K-09", "PASS"], ["K-10", "PASS"], ["K-11", "PASS"], ["K-12", "PASS"], ["K-13", "SKIP"], ["K-14", "PASS"],
    ]);
    expect(e.verdict).toBe("RELEASE");
    expect(e.reasons).toEqual([]);
    expect(e.kernelVersion).toBe(KERNEL_VERSION);
    // no signed terms: net 30 from receipt (10-05T10:00), minus the 24 h buffer; the evaluator prefers the later plan
    expect([e.payAt, e.releaseAmountBaseUnits, e.timingSource, e.plannerFallback]).toEqual(["2026-11-03T10:00:00Z", "1000000000", "DEFAULT", true]);
    expect(e.plans.map((p) => p.mode)).toEqual(["DUE_MINUS_BUFFER", "IMMEDIATE"]);
    expect(e.planId).toBe(e.plans[0]?.planId);
    expect(e.humanExplanation.startsWith("Release scheduled: every check passed.")).toBe(true);
    for (const c of e.checks) expect(CheckResultSchema.safeParse(c).success).toBe(true);
  });
});
