import {
  ChallengeScenarioSchema,
  PolicyOverridesSchema,
  epochSecondsFromIso,
  verifyTermsHash,
} from "@symbolon/schemas";
import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import { insideDiscountWindow, referenceAmountDue, referenceDiscountValue } from "../src/terms-ref";
import { addSeconds, DAY } from "../src/time";
import { SCENARIO_IDS_IN_ORDER, POLICY_OVERRIDES, TERMS_2_10_NET_30, WORLD, CLOCK_START, evidenceFixturesFor, milestoneId, usdc, worldMilestone } from "../src/world";

describe("canonical scenarios", () => {
  it("has exactly S-A, S-B, S-C and each is a valid ChallengeScenario with a correct termsHash", () => {
    expect(SCENARIO_IDS_IN_ORDER).toEqual(["S-A", "S-B", "S-C"]);
    for (const id of SCENARIO_IDS_IN_ORDER) {
      const s = WORLD[id];
      expect(ChallengeScenarioSchema.safeParse(s.template).success).toBe(true);
      expect(verifyTermsHash(s.template.engagement)).toBe(true);
      expect(s.template.engagement.paymentTerms).toEqual(s.template.paymentTerms);
      expect(s.template.milestones).toEqual(s.template.engagement.milestones);
    }
  });

  it("templates are UNSIGNED: no signature, DRAFT, not registered (no key exists here)", () => {
    for (const id of SCENARIO_IDS_IN_ORDER) {
      const e = WORLD[id].template.engagement;
      expect(e.ownerSig).toBeNull();
      expect(e.payeeSig).toBeNull();
      expect(e.registeredTx).toBeNull();
      expect(e.status).toBe("DRAFT");
    }
  });

  it("S-C carries 2/10 net 30; S-A and S-B carry signed terms without a discount (needed by ATK-21 TERMS_NOT_SIGNED)", () => {
    expect(WORLD["S-C"].paymentTerms).toEqual(TERMS_2_10_NET_30);
    expect(WORLD["S-A"].paymentTerms.earlyPay).toBeNull();
    expect(WORLD["S-B"].paymentTerms.earlyPay).toBeNull();
    expect(WORLD["S-C"].paymentTerms.netDays).toBe(30);
    expect(WORLD["S-C"].paymentTerms.earlyPay).toEqual({ discountBps: 200, withinDays: 10 });
  });

  it("ground truth matches the milestones, the cap is the sum, the clock is inside the window", () => {
    for (const id of SCENARIO_IDS_IN_ORDER) {
      const s = WORLD[id];
      const gt = s.template.groundTruth;
      expect(gt.legitPayee).toBe(s.payee);
      expect(gt.legitPayee).toBe(s.template.engagement.payee);
      for (const m of s.template.milestones) expect(gt.legitAmountByMilestone[m.milestoneId]).toBe(m.amountBaseUnits);
      const sum = s.template.milestones.reduce((a, m) => a + BigInt(m.amountBaseUnits), 0n);
      expect(BigInt(s.template.engagement.capBaseUnits)).toBe(sum);
      const t = epochSecondsFromIso(CLOCK_START);
      expect(t).toBeGreaterThanOrEqual(epochSecondsFromIso(gt.allowedWindow.start));
      expect(t).toBeLessThanOrEqual(epochSecondsFromIso(gt.allowedWindow.end));
    }
  });

  it("payees, engagements and milestone ids are all distinct", () => {
    const payees = new Set(SCENARIO_IDS_IN_ORDER.map((i) => WORLD[i].payee));
    const engagements = new Set(SCENARIO_IDS_IN_ORDER.map((i) => WORLD[i].template.engagement.engagementId));
    const milestones = new Set(SCENARIO_IDS_IN_ORDER.flatMap((i) => WORLD[i].template.milestones.map((m) => m.milestoneId)));
    expect(payees.size).toBe(3);
    expect(engagements.size).toBe(3);
    expect(milestones.size).toBe(5);
  });

  it("amounts honour the small-cap policy: honest payments need no human approval and fit the per-tx cap", () => {
    expect(PolicyOverridesSchema.safeParse(POLICY_OVERRIDES).success).toBe(true);
    for (const id of SCENARIO_IDS_IN_ORDER) {
      for (const m of WORLD[id].milestones) {
        expect(m.amount).toBeLessThanOrEqual(usdc(20)); // humanApprovalAbove
        expect(m.amount).toBeLessThanOrEqual(usdc(25)); // perTxHardCap
      }
    }
  });

  it("evidence fixtures equal the milestone spec entries exactly (the K-09 sandbox rule)", () => {
    for (const id of SCENARIO_IDS_IN_ORDER) {
      const s = WORLD[id];
      for (const m of s.template.milestones) {
        const fx = s.template.evidenceFixtures.filter((f) => f.milestoneId === m.milestoneId);
        expect(fx.map((f) => f.requirement)).toEqual(m.evidenceSpec);
        expect(fx.every((f) => f.result === "PASS")).toBe(true);
      }
    }
  });

  it("evidenceFixturesFor honours the plan", () => {
    const w = WORLD["S-B"];
    expect(evidenceFixturesFor(w, "none")).toEqual([]);
    expect(evidenceFixturesFor(w, "all-pass")).toEqual(w.template.evidenceFixtures);
    const failing = evidenceFixturesFor(w, { pass: [], fail: ["api"] });
    expect(failing).toHaveLength(1);
    expect(failing[0]?.result).toBe("FAIL");
    expect(failing[0]?.milestoneId).toBe(milestoneId(w, "api"));
    expect(() => milestoneId(w, "nope")).toThrow();
  });
});

describe("reference amountDue (independent of packages/terms)", () => {
  const gross = usdc(20);
  const t0 = CLOCK_START;

  it("20.00 with 2/10: 19.60 inside, 20.00 outside, window end inclusive", () => {
    const edge = addSeconds(t0, 10n * DAY);
    expect(referenceAmountDue(gross, TERMS_2_10_NET_30, t0, t0)).toBe(usdc(19, 60));
    expect(referenceAmountDue(gross, TERMS_2_10_NET_30, t0, addSeconds(edge, -1))).toBe(usdc(19, 60));
    expect(referenceAmountDue(gross, TERMS_2_10_NET_30, t0, edge)).toBe(usdc(19, 60));
    expect(referenceAmountDue(gross, TERMS_2_10_NET_30, t0, addSeconds(edge, 1))).toBe(gross);
  });

  it("no early-pay or no terms: always gross", () => {
    expect(referenceAmountDue(gross, null, t0, t0)).toBe(gross);
    expect(referenceAmountDue(gross, WORLD["S-A"].paymentTerms, t0, t0)).toBe(gross);
    expect(insideDiscountWindow(null, t0, t0)).toBe(false);
  });

  it("property: 0 <= amountDue <= gross and discount = floor(gross*bps/10000)", () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 1n, max: 10n ** 20n }), fc.integer({ min: 1, max: 2000 }), fc.integer({ min: 1, max: 60 }), fc.integer({ min: 0, max: 90 * 86_400 }), (g, bps, days, offset) => {
        const terms = { netDays: 90, earlyPay: { discountBps: bps, withinDays: days }, payBeforeDueBufferHours: 0, allowImmediate: true };
        const due = referenceAmountDue(g, terms, t0, addSeconds(t0, offset));
        expect(due).toBeGreaterThanOrEqual(0n);
        expect(due).toBeLessThanOrEqual(g);
        expect(referenceDiscountValue(g, terms)).toBe((g * BigInt(bps)) / 10_000n);
        const inside = BigInt(offset) <= BigInt(days) * DAY;
        expect(due).toBe(inside ? g - (g * BigInt(bps)) / 10_000n : g);
      }),
      { numRuns: 300 },
    );
  });
});

describe("milestone lookup", () => {
  it("throws on an unknown slug instead of guessing", () => {
    expect(() => worldMilestone(WORLD["S-A"], "nope")).toThrow();
  });
});
