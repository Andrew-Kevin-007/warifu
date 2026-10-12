// Property tests for feasiblePlans() and the evaluator (docs/13 §1 "feasible-plan set closure", §4.1 packages/terms:
// "feasiblePlans() is deterministic, its planIds are stable and unique, every plan satisfies the reserve floor and
// evidence precondition"). 1,000 runs each. The oracles are the defining inequalities and the public amountDue(),
// not a re-run of the enumerator. Properties about payable plans count their cases (no vacuous passes).
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { FeasiblePlanSchema, PLAN_MODES, derivePlanId, epochSecondsFromIso, isoFromEpochSeconds, jcs, keccak256Utf8 } from "@symbolon/schemas";
import type { PaymentTerms } from "@symbolon/schemas";
import { amountDue, evaluatePlans, feasiblePlans, isSafePlan, scorePlan, topSafePlan } from "../src/index";
import type { PlanInput, TermsResult } from "../src/index";

const RUNS = { numRuns: 1000 };
const DAY = 86_400n;

function value<T>(r: TermsResult<T>): T {
  if (!r.ok) throw new Error(`expected ok, got ${r.error.code}: ${r.error.message}`);
  return r.value;
}

const termsArb: fc.Arbitrary<PaymentTerms | null> = fc.option(
  fc
    .record({
      netDays: fc.integer({ min: 0, max: 365 }),
      early: fc.option(fc.record({ discountBps: fc.integer({ min: 1, max: 2000 }), withinFrac: fc.nat() }), { nil: null }),
      payBeforeDueBufferHours: fc.integer({ min: 0, max: 240 }),
      allowImmediate: fc.boolean(),
    })
    .map(({ netDays, early, payBeforeDueBufferHours, allowImmediate }): PaymentTerms => ({
      netDays,
      earlyPay: early === null || netDays < 2 ? null : { discountBps: early.discountBps, withinDays: 1 + (early.withinFrac % (netDays - 1)) },
      payBeforeDueBufferHours,
      allowImmediate,
    })),
  { nil: null, freq: 4 },
);

export const planInputArb: fc.Arbitrary<PlanInput> = fc
  .record({
    receivedSec: fc.bigInt({ min: 1_577_836_800n, max: 3_786_912_000n }),
    nowOffset: fc.bigInt({ min: 0n, max: 60n * DAY }),
    evidenceOffset: fc.option(fc.bigInt({ min: -30n * DAY, max: 60n * DAY }), { nil: null, freq: 6 }),
    terms: termsArb,
    timing: fc.record({
      defaultNetDays: fc.integer({ min: 0, max: 365 }),
      payBeforeDueBufferHours: fc.integer({ min: 0, max: 240 }),
      allowImmediate: fc.boolean(),
      disputeWindowHours: fc.constantFrom(0, 0, 24, 72),
      windowSafetyMarginMinutes: fc.constantFrom(0, 60, 60, 1440),
    }),
    gross: fc.oneof(
      { arbitrary: fc.constant(1_000_000_000n), weight: 3 },
      { arbitrary: fc.bigInt({ min: 0n, max: 2_000_000_000n }), weight: 2 },
      { arbitrary: fc.bigInt({ min: 0n, max: 10n ** 15n }), weight: 1 },
    ),
    available: fc.oneof({ arbitrary: fc.constant(10_000_000_000n), weight: 3 }, { arbitrary: fc.bigInt({ min: 0n, max: 3_000_000_000n }), weight: 2 }),
    pending: fc.oneof(fc.constant(0n), fc.bigInt({ min: 0n, max: 1_000_000_000n })),
    floor: fc.bigInt({ min: 0n, max: 100_000_000n }),
    ceiling: fc.oneof({ arbitrary: fc.constant(null), weight: 4 }, { arbitrary: fc.bigInt({ min: 0n, max: 2_000_000_000n }), weight: 1 }),
    salt: fc.nat(),
  })
  .map(
    (r): PlanInput => ({
      intentId: keccak256Utf8(`intent ${r.salt}`),
      now: isoFromEpochSeconds(r.receivedSec + r.nowOffset),
      invoiceReceivedAt: isoFromEpochSeconds(r.receivedSec),
      grossBaseUnits: r.gross,
      terms: r.terms,
      policyTiming: r.timing,
      evidenceSatisfiedAt: r.evidenceOffset === null ? null : isoFromEpochSeconds(r.receivedSec + r.evidenceOffset),
      liquidity: { vaultAvailable: r.available, pendingReleases: r.pending, reserveFloor: r.floor },
      amountCeiling: r.ceiling,
    }),
  );

const sec = (iso: string): bigint => epochSecondsFromIso(iso);

describe("feasiblePlans properties", () => {
  it("total and deterministic: never throws, same input => byte-identical set", () => {
    fc.assert(
      fc.property(planInputArb, (input) => {
        const a = value(feasiblePlans(input));
        const b = value(feasiblePlans(structuredClone(input)));
        expect(jcs(b.plans)).toBe(jcs(a.plans));
        expect(b).toEqual(a);
      }),
      RUNS,
    );
  });

  it("closure: every mode appears exactly once (plan or exclusion); planIds are derived and unique; HOLD iff nothing is payable", () => {
    fc.assert(
      fc.property(planInputArb, (input) => {
        const s = value(feasiblePlans(input));
        expect([...s.plans.map((p) => p.mode), ...s.excluded.map((x) => x.mode)].sort()).toEqual([...PLAN_MODES].sort());
        expect(new Set(s.plans.map((p) => p.planId)).size).toBe(s.plans.length);
        for (const p of s.plans) {
          expect(FeasiblePlanSchema.safeParse(p).success).toBe(true);
          expect(p.planId).toBe(derivePlanId({ intentId: input.intentId, mode: p.mode, payAt: p.payAt }));
        }
        const payable = s.plans.filter((p) => p.mode !== "HOLD");
        expect(s.plans.some((p) => p.mode === "HOLD")).toBe(payable.length === 0);
        if (input.evidenceSatisfiedAt === null) expect(s.plans.map((p) => p.mode)).toEqual(["HOLD"]);
      }),
      RUNS,
    );
  });

  it("every payable plan is legal: inside [earliest, latest], after now and the evidence, reserve floor and ceiling hold, amountDue = amountDue(signed terms, payAt)", () => {
    let payablePlans = 0;
    let discounted = 0;
    fc.assert(
      fc.property(planInputArb, (input) => {
        const s = value(feasiblePlans(input));
        for (const p of s.plans) {
          if (p.mode === "HOLD") {
            expect(p.amountDue).toBe("0");
            continue;
          }
          payablePlans++;
          const w = s.window;
          if (w === null) throw new Error("payable plan without a legal window");
          const t = sec(p.payAt);
          expect(t >= sec(w.earliest) && t <= sec(w.latest)).toBe(true);
          expect(t >= sec(input.now)).toBe(true);
          expect(t >= sec(input.evidenceSatisfiedAt ?? "9999-12-31T23:59:59Z")).toBe(true);
          const due = value(amountDue({ grossBaseUnits: input.grossBaseUnits, terms: input.terms, invoiceReceivedAt: input.invoiceReceivedAt, payAt: p.payAt }));
          expect(p.amountDue).toBe(due.amountDue.toString());
          expect(p.discountValue).toBe(due.discountValue.toString());
          const amount = BigInt(p.amountDue);
          expect(amount >= 0n && amount <= input.grossBaseUnits).toBe(true);
          const after = input.liquidity.vaultAvailable - input.liquidity.pendingReleases - amount;
          expect(p.liquidityAfter).toBe(after.toString());
          expect(after >= input.liquidity.reserveFloor && p.reserveFloorOk).toBe(true);
          if (input.amountCeiling !== null) expect(amount <= input.amountCeiling).toBe(true);
          if (due.discountApplied) discounted++;
          if (p.mode === "TAKE_DISCOUNT") {
            const margin = BigInt(input.policyTiming.windowSafetyMarginMinutes) * 60n;
            expect(due.discountApplied).toBe(true);
            expect(t <= sec(p.windowEnd ?? "1970-01-01T00:00:00Z") - margin).toBe(true);
          }
          if (p.mode === "IMMEDIATE") expect(p.payAt).toBe(input.now);
        }
      }),
      RUNS,
    );
    // Non-vacuity floors, set well below the typical counts (~1,000+ payable plans, ~150+ discounted per 1,000 runs).
    expect(payablePlans, `payable plans: ${payablePlans}`).toBeGreaterThan(400);
    expect(discounted, `discounted plans: ${discounted}`).toBeGreaterThan(30);
  });

  it("the legal window: latest >= earliest, earliest = max(now, evidence, dispute end); LATE iff the due date minus buffer has passed", () => {
    fc.assert(
      fc.property(planInputArb, (input) => {
        const s = value(feasiblePlans(input));
        const w = s.window;
        if (w === null) return;
        const e = sec(input.evidenceSatisfiedAt ?? "");
        const r = sec(input.invoiceReceivedAt);
        const dispute = (e > r ? e : r) + BigInt(input.policyTiming.disputeWindowHours) * 3600n;
        const earliest = [sec(input.now), e, dispute].reduce((a, b) => (b > a ? b : a));
        expect(sec(w.earliest)).toBe(earliest);
        const latestRaw = sec(w.dueDate) - BigInt(s.terms.payBeforeDueBufferHours) * 3600n;
        expect(w.late).toBe(latestRaw < earliest);
        expect(sec(w.latest)).toBe(w.late ? earliest : latestRaw);
        expect(sec(w.dueDate)).toBe(r + BigInt(s.terms.netDays) * DAY);
      }),
      RUNS,
    );
  });
});

describe("evaluator properties", () => {
  it("regret >= 0, the top plan has regret 0, the top safe plan is a safe member of the set; cost 0 => benefit = discount", () => {
    let safeTops = 0;
    fc.assert(
      fc.property(planInputArb, fc.integer({ min: 0, max: 1_000_000 }), fc.boolean(), (input, bps, preferImmediate) => {
        const s = value(feasiblePlans(input));
        const ref = s.window?.latest ?? input.now;
        const params = { costOfCapitalBps: bps, referenceInstant: ref, preferImmediate };
        const e = value(evaluatePlans(s.plans, params));
        expect(e.plans.map((p) => p.planId)).toEqual(s.plans.map((p) => p.planId));
        for (const p of e.plans) expect(BigInt(p.regretBase) >= 0n).toBe(true);
        expect(e.plans.find((p) => p.planId === e.topPlanId)?.regretBase).toBe("0");
        const top = value(topSafePlan(s.plans, params));
        if (top === null) {
          expect(s.plans.every((p) => !isSafePlan(p))).toBe(true);
        } else {
          safeTops++;
          expect(isSafePlan(top) && s.plans.includes(top)).toBe(true);
          const best = e.plans.filter((p) => s.plans.find((q) => q.planId === p.planId && isSafePlan(q))).map((p) => BigInt(p.netBenefitBase));
          expect(BigInt(e.plans.find((p) => p.planId === top.planId)?.netBenefitBase ?? "x")).toBe(best.reduce((a, b) => (b > a ? b : a)));
        }
        const zero = { ...params, costOfCapitalBps: 0 };
        for (const p of s.plans) expect(value(scorePlan(p, zero))).toBe(p.mode === "HOLD" ? 0n : BigInt(p.discountValue));
      }),
      RUNS,
    );
    expect(safeTops, `cases with a safe top plan: ${safeTops}`).toBeGreaterThan(300);
  });

  it("a higher cost of capital never raises a plan's net benefit", () => {
    fc.assert(
      fc.property(planInputArb, fc.integer({ min: 0, max: 500_000 }), fc.integer({ min: 0, max: 500_000 }), (input, a, b) => {
        const s = value(feasiblePlans(input));
        const ref = s.window?.latest ?? input.now;
        const [lo, hi] = a <= b ? [a, b] : [b, a];
        for (const p of s.plans) {
          const low = value(scorePlan(p, { costOfCapitalBps: lo, referenceInstant: ref, preferImmediate: false }));
          const high = value(scorePlan(p, { costOfCapitalBps: hi, referenceInstant: ref, preferImmediate: false }));
          expect(high <= low).toBe(true);
        }
      }),
      RUNS,
    );
  });
});
