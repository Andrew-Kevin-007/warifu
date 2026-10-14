// Golden and edge-case tests for feasiblePlans() and the plan evaluator (docs/04 K-14, docs/03 §5.2-§5.4,
// docs/13 §4.1 "packages/terms"). Every expected instant and amount is computed by hand in the comment next to it.
import { describe, expect, it } from "vitest";
import { derivePlanId, keccak256Utf8 } from "@symbolon/schemas";
import type { FeasiblePlan, PaymentTerms } from "@symbolon/schemas";
import { effectiveTerms, evaluatePlans, feasiblePlans, isSafePlan, rankPlans, scorePlan, topSafePlan } from "../src/index";
import type { PlanInput, PlanSet, PolicyTiming, ScoreParams, TermsErrorCode, TermsResult } from "../src/index";

function value<T>(r: TermsResult<T>): T {
  if (!r.ok) throw new Error(`expected ok, got ${r.error.code}: ${r.error.message}`);
  return r.value;
}
function code<T>(r: TermsResult<T>): TermsErrorCode {
  if (r.ok) throw new Error("expected an error");
  return r.error.code;
}

const INTENT = keccak256Utf8("intent under test");
const TWO_TEN_NET_30: PaymentTerms = { netDays: 30, earlyPay: { discountBps: 200, withinDays: 10 }, payBeforeDueBufferHours: 24, allowImmediate: true };
const TIMING: PolicyTiming = { defaultNetDays: 30, payBeforeDueBufferHours: 24, allowImmediate: true, disputeWindowHours: 0, windowSafetyMarginMinutes: 60 };
const GROSS = 1_000_000_000n; // 1,000.000000 USDC

function input(over: Partial<PlanInput> = {}): PlanInput {
  return {
    intentId: INTENT,
    now: "2026-10-02T12:00:00Z",
    invoiceReceivedAt: "2026-10-01T09:30:00Z",
    grossBaseUnits: GROSS,
    terms: TWO_TEN_NET_30,
    policyTiming: TIMING,
    evidenceSatisfiedAt: "2026-10-02T08:00:00Z",
    liquidity: { vaultAvailable: 10_000_000_000n, pendingReleases: 0n, reserveFloor: 10_000_000n },
    amountCeiling: null,
    ...over,
  };
}

const modes = (s: PlanSet) => s.plans.map((p) => p.mode);
const plan = (s: PlanSet, mode: string): FeasiblePlan => {
  const p = s.plans.find((x) => x.mode === mode);
  if (p === undefined) throw new Error(`no ${mode} plan`);
  return p;
};
const reason = (s: PlanSet, mode: string) => s.excluded.find((x) => x.mode === mode)?.reason;

describe("feasiblePlans: 2/10 net 30, evidence in, comfortable liquidity", () => {
  // R = 10-01T09:30; due = R + 30 d = 10-31T09:30; latest = due - 24 h = 10-30T09:30; earliest = now = 10-02T12:00.
  // windowEnd = R + 10 d = 10-11T09:30; safe end = windowEnd - 60 min = 10-11T08:30.
  const s = value(feasiblePlans(input()));

  it("legal window and effective terms", () => {
    expect(s.window).toEqual({
      earliest: "2026-10-02T12:00:00Z",
      latest: "2026-10-30T09:30:00Z",
      late: false,
      dueDate: "2026-10-31T09:30:00Z",
      disputeWindowEnd: "2026-10-02T08:00:00Z", // max(R, E) + 0 h
      windowEnd: "2026-10-11T09:30:00Z",
    });
    expect(s.terms).toEqual({ netDays: 30, payBeforeDueBufferHours: 24, allowImmediate: true, earlyPay: { discountBps: 200, withinDays: 10 }, signed: true });
  });

  it("plans in PLAN_MODES order with hand-computed amounts", () => {
    expect(modes(s)).toEqual(["TAKE_DISCOUNT", "DUE_MINUS_BUFFER", "IMMEDIATE"]);
    // discount = floor(1e9 * 200 / 10000) = 20,000,000; amountDue = 980,000,000;
    // APR = floor(200*365*10000 / (9800*20)) = floor(730,000,000 / 196,000) = 3724
    expect(plan(s, "TAKE_DISCOUNT")).toEqual({
      planId: derivePlanId({ intentId: INTENT, mode: "TAKE_DISCOUNT", payAt: "2026-10-11T08:30:00Z" }),
      mode: "TAKE_DISCOUNT",
      payAt: "2026-10-11T08:30:00Z",
      amountDue: "980000000",
      discountValue: "20000000",
      impliedAprBps: 3724,
      liquidityAfter: "9020000000", // 10,000,000,000 - 980,000,000
      reserveFloorOk: true,
      windowEnd: "2026-10-11T09:30:00Z",
    });
    expect(plan(s, "DUE_MINUS_BUFFER")).toMatchObject({ payAt: "2026-10-30T09:30:00Z", amountDue: "1000000000", discountValue: "0", impliedAprBps: null, liquidityAfter: "9000000000" });
    expect(plan(s, "IMMEDIATE")).toMatchObject({ payAt: "2026-10-02T12:00:00Z", amountDue: "980000000", discountValue: "20000000", impliedAprBps: 3724 });
    expect(reason(s, "AFTER_EVIDENCE")).toBe("NOT_APPLICABLE");
    expect(reason(s, "AFTER_DISPUTE_WINDOW")).toBe("NOT_APPLICABLE");
    expect(reason(s, "HOLD")).toBe("NOT_APPLICABLE");
  });

  it("planIds are keccak256(JCS({intentId, mode, payAt})) and unique; same input => same set", () => {
    for (const p of s.plans) expect(p.planId).toBe(derivePlanId({ intentId: INTENT, mode: p.mode, payAt: p.payAt }));
    expect(new Set(s.plans.map((p) => p.planId)).size).toBe(s.plans.length);
    expect(value(feasiblePlans(input()))).toEqual(s);
  });
});

describe("feasiblePlans: timing edges", () => {
  it("LATE: the due date minus buffer has passed => latest = earliest = now", () => {
    const s = value(feasiblePlans(input({ now: "2026-11-02T00:00:00Z" })));
    expect(s.window?.late).toBe(true);
    expect(s.window?.latest).toBe("2026-11-02T00:00:00Z");
    expect(modes(s)).toEqual(["DUE_MINUS_BUFFER", "IMMEDIATE"]);
    expect(plan(s, "DUE_MINUS_BUFFER")).toMatchObject({ payAt: "2026-11-02T00:00:00Z", amountDue: "1000000000" });
    expect(reason(s, "TAKE_DISCOUNT")).toBe("OUTSIDE_WINDOW");
  });

  it("dispute window binds: AFTER_DISPUTE_WINDOW at max(R, E) + 48 h; IMMEDIATE is outside the window", () => {
    // E = 10-05T10:00 (future); disputeEnd = 10-07T10:00 = earliest; still inside the discount window
    const s = value(feasiblePlans(input({ evidenceSatisfiedAt: "2026-10-05T10:00:00Z", policyTiming: { ...TIMING, disputeWindowHours: 48 } })));
    expect(s.window?.earliest).toBe("2026-10-07T10:00:00Z");
    expect(modes(s)).toEqual(["TAKE_DISCOUNT", "DUE_MINUS_BUFFER", "AFTER_DISPUTE_WINDOW"]);
    expect(plan(s, "AFTER_DISPUTE_WINDOW")).toMatchObject({ payAt: "2026-10-07T10:00:00Z", amountDue: "980000000" });
    expect(reason(s, "IMMEDIATE")).toBe("OUTSIDE_WINDOW");
    expect(reason(s, "AFTER_EVIDENCE")).toBe("NOT_APPLICABLE");
  });

  it("future evidence without a dispute window: AFTER_EVIDENCE at evidenceSatisfiedAt", () => {
    const s = value(feasiblePlans(input({ evidenceSatisfiedAt: "2026-10-05T10:00:00Z" })));
    expect(modes(s)).toEqual(["TAKE_DISCOUNT", "DUE_MINUS_BUFFER", "AFTER_EVIDENCE"]);
    expect(plan(s, "AFTER_EVIDENCE").payAt).toBe("2026-10-05T10:00:00Z");
  });

  it("the discount safety margin is respected to the second", () => {
    // safe end = 10-11T08:30:00. earliest exactly there => feasible (payAt = safe end); one second later => not.
    const at = value(feasiblePlans(input({ now: "2026-10-11T08:30:00Z" })));
    expect(plan(at, "TAKE_DISCOUNT").payAt).toBe("2026-10-11T08:30:00Z");
    const after = value(feasiblePlans(input({ now: "2026-10-11T08:30:01Z" })));
    expect(reason(after, "TAKE_DISCOUNT")).toBe("OUTSIDE_WINDOW");
    // ...but paying "now" at 08:30:01 is still inside the inclusive window, so IMMEDIATE is discounted
    expect(plan(after, "IMMEDIATE").amountDue).toBe("980000000");
    const closed = value(feasiblePlans(input({ now: "2026-10-11T09:30:01Z" })));
    expect(plan(closed, "IMMEDIATE").amountDue).toBe("1000000000");
  });

  it("a large buffer can end the legal window before the discount safe end: TAKE_DISCOUNT pays at legalLatest", () => {
    // netDays 12, withinDays 10, buffer 72 h: latest = R + 12 d - 72 h = 10-10T09:30 < safe end 10-11T08:30
    const terms: PaymentTerms = { netDays: 12, earlyPay: { discountBps: 200, withinDays: 10 }, payBeforeDueBufferHours: 72, allowImmediate: true };
    const s = value(feasiblePlans(input({ terms })));
    expect(plan(s, "TAKE_DISCOUNT").payAt).toBe("2026-10-10T09:30:00Z");
    expect(plan(s, "DUE_MINUS_BUFFER").payAt).toBe("2026-10-10T09:30:00Z");
    expect(plan(s, "TAKE_DISCOUNT").planId).not.toBe(plan(s, "DUE_MINUS_BUFFER").planId);
  });
});

describe("feasiblePlans: terms sources (INV-19)", () => {
  it("no signed terms => policy defaults, no discount", () => {
    const s = value(feasiblePlans(input({ terms: null, policyTiming: { ...TIMING, defaultNetDays: 15, payBeforeDueBufferHours: 0 } })));
    expect(s.terms).toEqual({ netDays: 15, payBeforeDueBufferHours: 0, allowImmediate: true, earlyPay: null, signed: false });
    expect(s.window?.dueDate).toBe("2026-10-16T09:30:00Z"); // R + 15 d
    expect(modes(s)).toEqual(["DUE_MINUS_BUFFER", "IMMEDIATE"]);
    expect(reason(s, "TAKE_DISCOUNT")).toBe("NOT_APPLICABLE");
    expect(s.plans.every((p) => p.windowEnd === null && p.discountValue === "0")).toBe(true);
  });

  it("signed terms set netDays and the buffer even when policy differs", () => {
    const s = value(feasiblePlans(input({ policyTiming: { ...TIMING, defaultNetDays: 5, payBeforeDueBufferHours: 200 } })));
    expect(s.window?.latest).toBe("2026-10-30T09:30:00Z");
  });

  it("immediate payment needs both the signed terms and the policy to allow it", () => {
    const noTerms = value(feasiblePlans(input({ terms: { ...TWO_TEN_NET_30, allowImmediate: false } })));
    expect(reason(noTerms, "IMMEDIATE")).toBe("NOT_ALLOWED");
    const noPolicy = value(feasiblePlans(input({ policyTiming: { ...TIMING, allowImmediate: false } })));
    expect(reason(noPolicy, "IMMEDIATE")).toBe("NOT_ALLOWED");
    const neither = value(feasiblePlans(input({ terms: null, policyTiming: { ...TIMING, allowImmediate: false } })));
    expect(reason(neither, "IMMEDIATE")).toBe("NOT_ALLOWED");
  });
});

describe("feasiblePlans: reserve floor, ceiling and missing evidence", () => {
  it("evidence not satisfied => only HOLD (pays nothing)", () => {
    const s = value(feasiblePlans(input({ evidenceSatisfiedAt: null })));
    expect(s.window).toBeNull();
    expect(s.plans).toEqual([
      {
        planId: derivePlanId({ intentId: INTENT, mode: "HOLD", payAt: "2026-10-02T12:00:00Z" }),
        mode: "HOLD",
        payAt: "2026-10-02T12:00:00Z",
        amountDue: "0",
        discountValue: "0",
        impliedAprBps: null,
        liquidityAfter: "10000000000",
        reserveFloorOk: true,
        windowEnd: "2026-10-11T09:30:00Z",
      },
    ]);
    expect(s.excluded.map((x) => x.reason)).toEqual(Array(5).fill("EVIDENCE_NOT_SATISFIED"));
    const noTerms = value(feasiblePlans(input({ evidenceSatisfiedAt: null, terms: null })));
    expect(noTerms.plans[0]?.windowEnd).toBeNull();
  });

  it("a plan that would breach the reserve floor is not feasible (boundary at exactly the floor)", () => {
    // available - floor = 995,000,000: 980,000,000 fits, 1,000,000,000 does not
    const tight = value(feasiblePlans(input({ liquidity: { vaultAvailable: 1_005_000_000n, pendingReleases: 0n, reserveFloor: 10_000_000n } })));
    expect(modes(tight)).toEqual(["TAKE_DISCOUNT", "IMMEDIATE"]);
    expect(reason(tight, "DUE_MINUS_BUFFER")).toBe("RESERVE_FLOOR");
    // pendingReleases count against the vault: available 1,010,000,000 - pending 0 - floor = 1e9 exactly => fits
    const exact = value(feasiblePlans(input({ liquidity: { vaultAvailable: 1_010_000_000n, pendingReleases: 0n, reserveFloor: 10_000_000n } })));
    expect(modes(exact)).toContain("DUE_MINUS_BUFFER");
    const pending = value(feasiblePlans(input({ liquidity: { vaultAvailable: 1_010_000_000n, pendingReleases: 1n, reserveFloor: 10_000_000n } })));
    expect(reason(pending, "DUE_MINUS_BUFFER")).toBe("RESERVE_FLOOR");
  });

  it("when no payable plan fits, the set is the HOLD plan alone", () => {
    const s = value(feasiblePlans(input({ liquidity: { vaultAvailable: 500_000_000n, pendingReleases: 600_000_000n, reserveFloor: 10_000_000n } })));
    expect(modes(s)).toEqual(["HOLD"]);
    expect(s.plans[0]).toMatchObject({ amountDue: "0", liquidityAfter: "-100000000", reserveFloorOk: false });
    expect(isSafePlan(s.plans[0] as FeasiblePlan)).toBe(false);
  });

  it("an authority ceiling excludes plans above it", () => {
    const s = value(feasiblePlans(input({ amountCeiling: 990_000_000n })));
    expect(modes(s)).toEqual(["TAKE_DISCOUNT", "IMMEDIATE"]);
    expect(reason(s, "DUE_MINUS_BUFFER")).toBe("AMOUNT_CEILING");
    expect(modes(value(feasiblePlans(input({ amountCeiling: GROSS }))))).toContain("DUE_MINUS_BUFFER");
  });
});

describe("feasiblePlans: refuses bad input (never throws)", () => {
  const bad: Array<[string, Partial<PlanInput>, TermsErrorCode]> = [
    ["uppercase intentId", { intentId: INTENT.toUpperCase().replace("0X", "0x") as `0x${string}` }, "INVALID_AMOUNT"],
    ["now not canonical", { now: "2026-10-02T12:00:00.000Z" }, "INVALID_TIME"],
    ["received not canonical", { invoiceReceivedAt: "yesterday" }, "INVALID_TIME"],
    ["received after now", { invoiceReceivedAt: "2026-10-02T12:00:01Z" }, "INVALID_TIME"],
    ["negative gross", { grossBaseUnits: -1n }, "INVALID_AMOUNT"],
    ["gross beyond 30 digits", { grossBaseUnits: 10n ** 30n }, "INVALID_AMOUNT"],
    ["negative available", { liquidity: { vaultAvailable: -1n, pendingReleases: 0n, reserveFloor: 0n } }, "INVALID_AMOUNT"],
    ["negative pending", { liquidity: { vaultAvailable: 0n, pendingReleases: -1n, reserveFloor: 0n } }, "INVALID_AMOUNT"],
    ["negative floor", { liquidity: { vaultAvailable: 0n, pendingReleases: 0n, reserveFloor: -1n } }, "INVALID_AMOUNT"],
    ["negative ceiling", { amountCeiling: -1n }, "INVALID_AMOUNT"],
    ["terms violate the schema", { terms: { ...TWO_TEN_NET_30, earlyPay: { discountBps: 200, withinDays: 30 } } }, "INVALID_TERMS"],
    ["policy netDays out of range", { policyTiming: { ...TIMING, defaultNetDays: 366 } }, "INVALID_DAYS"],
    ["policy margin not an integer", { policyTiming: { ...TIMING, windowSafetyMarginMinutes: 1.5 } }, "INVALID_DAYS"],
    ["policy allowImmediate not boolean", { policyTiming: { ...TIMING, allowImmediate: "yes" as unknown as boolean } }, "INVALID_DAYS"],
    ["policy timing missing", { policyTiming: null as unknown as PolicyTiming }, "INVALID_DAYS"],
    ["evidence time not canonical", { evidenceSatisfiedAt: "2026-10-02" }, "INVALID_TIME"],
    ["due date beyond year 9999", { now: "9999-12-30T00:00:00Z", invoiceReceivedAt: "9999-12-30T00:00:00Z", evidenceSatisfiedAt: "9999-12-30T00:00:00Z" }, "INVALID_TIME"],
  ];
  it.each(bad)("%s", (_name, over, expected) => {
    expect(code(feasiblePlans(input(over)))).toBe(expected);
  });

  it("a dispute window ending after year 9999 is refused (the due date itself fits)", () => {
    const r = feasiblePlans(input({ terms: { netDays: 0, earlyPay: null, payBeforeDueBufferHours: 0, allowImmediate: true }, now: "9999-12-31T23:00:00Z", invoiceReceivedAt: "9999-12-31T23:00:00Z", evidenceSatisfiedAt: "9999-12-31T23:00:00Z", policyTiming: { ...TIMING, disputeWindowHours: 2 } }));
    expect(code(r)).toBe("INVALID_TIME");
  });

  it("a liquidity projection beyond 78 digits cannot be a FeasiblePlan: refused, not truncated", () => {
    const huge = 10n ** 80n;
    expect(code(feasiblePlans(input({ evidenceSatisfiedAt: null, liquidity: { vaultAvailable: huge, pendingReleases: 0n, reserveFloor: 0n } })))).toBe("INVALID_AMOUNT");
    expect(code(feasiblePlans(input({ liquidity: { vaultAvailable: huge, pendingReleases: 0n, reserveFloor: 0n } })))).toBe("INVALID_AMOUNT");
    // every payable plan breaks the (huge) floor, so the HOLD plan is built, and it cannot be represented either
    expect(code(feasiblePlans(input({ liquidity: { vaultAvailable: huge, pendingReleases: 0n, reserveFloor: huge } })))).toBe("INVALID_AMOUNT");
  });

  it("non-bigint amounts are refused", () => {
    expect(code(feasiblePlans(input({ grossBaseUnits: 5 as unknown as bigint })))).toBe("INVALID_AMOUNT");
  });

  it("effectiveTerms refuses bad timing and bad terms", () => {
    expect(code(effectiveTerms(null, { ...TIMING, disputeWindowHours: -1 }))).toBe("INVALID_DAYS");
    expect(code(effectiveTerms({ ...TWO_TEN_NET_30, netDays: 400 }, TIMING))).toBe("INVALID_TERMS");
  });
});

describe("plan evaluator", () => {
  const s = value(feasiblePlans(input()));
  const params = (over: Partial<ScoreParams> = {}): ScoreParams => ({ costOfCapitalBps: 0, referenceInstant: s.window?.latest ?? "", preferImmediate: false, ...over });

  it("cost of capital 0: net benefit = discount; ties go to the later plan, regret vs top", () => {
    const e = value(evaluatePlans(s.plans, params()));
    expect(e.costOfCapitalBps).toBe(0);
    expect(e.plans).toEqual([
      { planId: plan(s, "TAKE_DISCOUNT").planId, netBenefitBase: "20000000", regretBase: "0" },
      { planId: plan(s, "DUE_MINUS_BUFFER").planId, netBenefitBase: "0", regretBase: "20000000" },
      { planId: plan(s, "IMMEDIATE").planId, netBenefitBase: "20000000", regretBase: "0" },
    ]);
    expect(e.topPlanId).toBe(plan(s, "TAKE_DISCOUNT").planId); // tie with IMMEDIATE: TAKE_DISCOUNT ranks first
    expect(value(topSafePlan(s.plans, params()))?.mode).toBe("TAKE_DISCOUNT");
  });

  it("cost of capital 1,000 bps: hand-computed costs (rounded up)", () => {
    // TAKE_DISCOUNT: early = 10-30T09:30 - 10-11T08:30 = 1,645,200 s;
    //   cost = ceil(980,000,000 * 1000 * 1,645,200 / 315,360,000,000) = ceil(5,112,557.08) = 5,112,558 => 14,887,442
    // IMMEDIATE: early = 10-30T09:30 - 10-02T12:00 = 2,410,200 s;
    //   cost = ceil(980,000,000 * 1000 * 2,410,200 / 315,360,000,000) = ceil(7,489,840.18) = 7,489,841 => 12,510,159
    const p = params({ costOfCapitalBps: 1000 });
    expect(value(scorePlan(plan(s, "TAKE_DISCOUNT"), p))).toBe(14_887_442n);
    expect(value(scorePlan(plan(s, "IMMEDIATE"), p))).toBe(12_510_159n);
    expect(value(scorePlan(plan(s, "DUE_MINUS_BUFFER"), p))).toBe(0n);
    const e = value(evaluatePlans(s.plans, p));
    expect(e.plans.map((x) => x.regretBase)).toEqual(["0", "14887442", "2377283"]);
    expect(e.topPlanId).toBe(plan(s, "TAKE_DISCOUNT").planId);
  });

  it("a cost of capital above the discount APR makes paying at the due date the top plan", () => {
    // APR 3724 bps: at 5,000 bps the discount is not worth taking
    const e = value(evaluatePlans(s.plans, params({ costOfCapitalBps: 5000 })));
    expect(e.topPlanId).toBe(plan(s, "DUE_MINUS_BUFFER").planId);
  });

  it("without a discount, ties prefer DUE_MINUS_BUFFER; an `immediate` milestone prefers IMMEDIATE", () => {
    const n = value(feasiblePlans(input({ terms: null })));
    const ref = n.window?.latest ?? "";
    expect(value(topSafePlan(n.plans, { costOfCapitalBps: 0, referenceInstant: ref, preferImmediate: false }))?.mode).toBe("DUE_MINUS_BUFFER");
    expect(value(topSafePlan(n.plans, { costOfCapitalBps: 0, referenceInstant: ref, preferImmediate: true }))?.mode).toBe("IMMEDIATE");
  });

  it("ranking falls back to planId for identical mode and score; HOLD scores 0 and is never safe", () => {
    const hold = value(feasiblePlans(input({ evidenceSatisfiedAt: null }))).plans[0] as FeasiblePlan;
    expect(value(scorePlan(hold, params()))).toBe(0n);
    expect(value(topSafePlan([hold], params()))).toBeNull();
    const twin = { ...hold, planId: keccak256Utf8("another hold") };
    const ranked = value(rankPlans([twin, hold], params()));
    const ids = [hold.planId, twin.planId].sort();
    expect(ranked.map((r) => r.plan.planId)).toEqual(ids);
    expect(value(rankPlans([hold, twin], params())).map((r) => r.plan.planId)).toEqual(ids);
  });

  it("refuses empty sets, duplicate ids, malformed plans and bad parameters", () => {
    expect(code(evaluatePlans([], params()))).toBe("INVALID_AMOUNT");
    const p0 = s.plans[0] as FeasiblePlan;
    expect(code(evaluatePlans([p0, p0], params()))).toBe("INVALID_AMOUNT");
    expect(code(evaluatePlans([{ ...p0, amountDue: "-1" }], params()))).toBe("INVALID_AMOUNT");
    expect(code(scorePlan({ ...p0, payAt: "soon" }, params()))).toBe("INVALID_AMOUNT");
    expect(code(scorePlan(p0, params({ costOfCapitalBps: -1 })))).toBe("INVALID_BPS");
    expect(code(scorePlan(p0, params({ costOfCapitalBps: 1_000_001 })))).toBe("INVALID_BPS");
    expect(code(scorePlan(p0, params({ costOfCapitalBps: 0.5 })))).toBe("INVALID_BPS");
    expect(code(scorePlan(p0, params({ referenceInstant: "later" })))).toBe("INVALID_TIME");
    expect(code(scorePlan(p0, params({ preferImmediate: 1 as unknown as boolean })))).toBe("INVALID_BPS");
    expect(code(rankPlans(s.plans, params({ referenceInstant: "later" })))).toBe("INVALID_TIME");
    expect(code(topSafePlan([], params()))).toBe("INVALID_AMOUNT");
    expect(code(rankPlans(null as unknown as FeasiblePlan[], params()))).toBe("INVALID_AMOUNT");
  });

  it("an evaluation that cannot satisfy the schema (more than 64 plans) is refused", () => {
    const many = Array.from({ length: 65 }, (_, i) => ({ ...(s.plans[1] as FeasiblePlan), planId: keccak256Utf8(`p${i}`) }));
    expect(code(evaluatePlans(many, params()))).toBe("INVALID_AMOUNT");
  });
});
