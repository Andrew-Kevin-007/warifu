// K-14 LIQUIDITY_AND_TIMING + terms binding (INV-19, RT-15), the schedule (feasible plans, planner selection,
// PLAN_OUT_OF_ENVELOPE fallback, legacy timing proposals, LATE) and the TOCTOU re-evaluation (docs/04 §5;
// DISCOUNT_WINDOW_CLOSED). docs/13 §4.1 K-14 and TOCTOU.
import { describe, expect, it } from "vitest";
import { PaymentIntentSchema, hashJcs } from "@symbolon/schemas";
import type { FeasiblePlan } from "@symbolon/schemas";
import { evaluate, reevaluate } from "../src/index";
import type { Evaluation, KernelContext, ScheduledRelease } from "../src/index";
import { checkK14 } from "../src/checks/k14-timing";
import { deriveFacts } from "../src/facts";
import { deriveSchedule } from "../src/schedule";
import { ok } from "../src/result";
import { ATTACKER, GROSS, H, M1, M2, PAYEE, TWO_TEN_NET_30, context, engagement, expectCheck, intent, milestone, ownerAck, policy } from "./helpers";
import type { RawIntent } from "./helpers";

const termsEng = engagement({ paymentTerms: TWO_TEN_NET_30 });
const termsCtx = (over: Partial<KernelContext> = {}) => context({ engagement: termsEng, milestone: termsEng.milestones[0] ?? null, ...over });
const at = (now: string, over: Partial<KernelContext> = {}) => termsCtx({ now, evidence: [ownerAck(M1, { collectedAt: now })], ...over });
const stated = (s: Record<string, unknown>, which: "both" | "a" | "b" = "both"): RawIntent => {
  const raw = intent();
  if (which !== "b") raw.extraction.a.statedTerms = { raw: null, netDays: null, earlyPay: null, ambiguous: false, ...s };
  if (which !== "a" && raw.extraction.b !== null) raw.extraction.b.statedTerms = { raw: null, netDays: null, earlyPay: null, ambiguous: false, ...s };
  return raw;
};
const plan = (e: Evaluation, mode: FeasiblePlan["mode"]): FeasiblePlan => {
  const p = e.plans.find((x) => x.mode === mode);
  if (p === undefined) throw new Error(`no ${mode} plan`);
  return p;
};
const withSelection = (planId: string): RawIntent => ({ ...intent(), planSelection: { planId, rationale: "because", factorsConsidered: ["discount_window"], riskFlags: [], deviatesFromEvaluator: false, deviationReason: null } });

describe("K-14 terms binding: invoice-stated terms are compared, never adopted (INV-19)", () => {
  it("an invoice discount the signed terms do not contain => ESCALATE TERMS_NOT_SIGNED (no signed terms, or signed without early pay)", () => {
    expectCheck(evaluate(stated({ earlyPay: { discountBps: 200, withinDays: 10 } }), context(), policy()), "K-14", "ESCALATE", "TERMS_NOT_SIGNED");
    const net30 = engagement({ paymentTerms: { ...TWO_TEN_NET_30, earlyPay: null } });
    expectCheck(evaluate(stated({ earlyPay: { discountBps: 200, withinDays: 10 } }), context({ engagement: net30, milestone: net30.milestones[0] ?? null, paymentTerms: net30.paymentTerms }), policy()), "K-14", "ESCALATE", "TERMS_NOT_SIGNED");
  });

  it.each([
    [{ earlyPay: { discountBps: 300, withinDays: 10 } }],
    [{ earlyPay: { discountBps: 100, withinDays: 10 } }],
    [{ earlyPay: { discountBps: 200, withinDays: 5 } }],
    [{ earlyPay: { discountBps: 200, withinDays: 15 } }],
    [{ netDays: 15 }],
    [{ netDays: 45 }],
    [{ raw: "2/10 net 30 maybe", ambiguous: true }],
  ])("a stated term that differs in either direction (%j) => ESCALATE TERMS_MISMATCH", (s) => {
    expectCheck(evaluate(stated(s), termsCtx({ paymentTerms: TWO_TEN_NET_30 }), policy()), "K-14", "ESCALATE", "TERMS_MISMATCH");
  });

  it("matching stated terms, no stated terms, or 'ambiguous' with nothing stated raise nothing; one extraction is enough to flag", () => {
    const ctx = termsCtx({ paymentTerms: TWO_TEN_NET_30 });
    expectCheck(evaluate(stated({ netDays: 30, earlyPay: { discountBps: 200, withinDays: 10 } }), ctx, policy()), "K-14", null, null);
    expectCheck(evaluate(stated({ ambiguous: true }), ctx, policy()), "K-14", null, null);
    expectCheck(evaluate(stated({ netDays: 30 }), context(), policy()), "K-14", null, null); // policy default net 30
    const onlyB = evaluate(stated({ netDays: 60 }, "b"), ctx, policy());
    expectCheck(onlyB, "K-14", "ESCALATE", "TERMS_MISMATCH");
    expect(String(onlyB.checks.find((c) => c.id === "K-14")?.detail)).toContain("extraction B");
  });

  it("the invoice's printed due date never moves payAt", () => {
    const raw = intent();
    raw.extraction.a.dueDate = "2026-10-06";
    if (raw.extraction.b !== null) raw.extraction.b.dueDate = "2026-10-06";
    const ctx = termsCtx({ paymentTerms: TWO_TEN_NET_30 });
    expect(evaluate(raw, ctx, policy()).payAt).toBe(evaluate(intent(), ctx, policy()).payAt);
  });

  it("context faults fail closed: terms mismatch with the signed engagement, unusable signed terms; binding failures reported", () => {
    expectCheck(evaluate(intent(), termsCtx({ paymentTerms: null }), policy()), "K-14", "HOLD", "KERNEL_ERROR");
    const bad = engagement({ paymentTerms: { netDays: 10, earlyPay: { discountBps: 200, withinDays: 10 }, payBeforeDueBufferHours: 0, allowImmediate: true } });
    expectCheck(evaluate(intent(), context({ engagement: bad, milestone: bad.milestones[0] ?? null }), policy()), "K-14", "HOLD", "KERNEL_ERROR");
    expectCheck(evaluate({ ...intent(), engagementId: null }, context(), policy()), "K-14", "REJECT", "NO_ENGAGEMENT");
    expectCheck(evaluate({ ...intent(), milestoneId: H("nope") }, context(), policy()), "K-14", "REJECT", "UNKNOWN_MILESTONE");
    const amb = intent();
    amb.extraction.a.amount.printed = "1,000";
    amb.extraction.a.amount.parsedBaseUnits = null;
    expectCheck(evaluate(amb, context(), policy()), "K-14", "ESCALATE", "AMOUNT_AMBIGUOUS");
  });
});

describe("schedule: feasible plans, evaluator fallback and the planner (docs/03 §5.4)", () => {
  const ctx = termsCtx({ paymentTerms: TWO_TEN_NET_30 });
  const base = evaluate(intent(), ctx, policy());

  it("without a planner the evaluator's top safe plan is scheduled (DEFAULT, plannerFallback); plans and their evaluation are reported", () => {
    expect(base.verdict).toBe("RELEASE");
    expect(base.plans.map((p) => p.mode)).toEqual(["TAKE_DISCOUNT", "DUE_MINUS_BUFFER", "IMMEDIATE"]);
    expect([base.planId, base.payAt, base.releaseAmountBaseUnits, base.timingSource, base.plannerFallback]).toEqual([plan(base, "TAKE_DISCOUNT").planId, "2026-10-15T09:00:00Z", "980000000", "DEFAULT", true]);
    expect(base.planEvaluation?.topPlanId).toBe(plan(base, "TAKE_DISCOUNT").planId);
    expect(base.planEvaluationHash).toBe(hashJcs(base.planEvaluation));
    expect(base.amountBaseUnits).toBe("1000000000"); // the intent stays on the gross
  });

  it("a planner pick inside the set is scheduled as chosen (AGENT, no fallback)", () => {
    const e = evaluate(withSelection(plan(base, "DUE_MINUS_BUFFER").planId), ctx, policy());
    expect([e.verdict, e.planId, e.payAt, e.releaseAmountBaseUnits, e.timingSource, e.plannerFallback]).toEqual(["RELEASE", plan(base, "DUE_MINUS_BUFFER").planId, "2026-11-03T10:00:00Z", "1000000000", "AGENT", false]);
    expectCheck(e, "K-14", null, null);
  });

  it("a pick outside the set is discarded: PLAN_OUT_OF_ENVELOPE recorded (PASS code), top safe plan scheduled; money never waits", () => {
    const e = evaluate(withSelection(H("invented plan")), ctx, policy());
    expect([e.verdict, e.planId, e.timingSource, e.plannerFallback, e.timingFlags]).toEqual(["RELEASE", plan(base, "TAKE_DISCOUNT").planId, "DEFAULT", true, ["PLAN_OUT_OF_ENVELOPE"]]);
    expect(e.checks.find((c) => c.id === "K-14")).toMatchObject({ status: "PASS", code: "PLAN_OUT_OF_ENVELOPE" });
    expect(e.reasons).toEqual([]);
  });

  it("planningAsOf: a pick from the set as offered is re-derived at now (same mode, same amount); otherwise discarded", () => {
    const asOf = "2026-10-05T11:30:00Z";
    const offered = evaluate(intent(), { ...ctx, now: asOf }, policy());
    const immediateThen = plan(offered, "IMMEDIATE");
    const e = evaluate(withSelection(immediateThen.planId), { ...ctx, planningAsOf: asOf }, policy());
    expect([e.timingSource, e.plannerFallback, e.payAt, e.planId]).toEqual(["AGENT", false, "2026-10-05T12:00:00Z", plan(base, "IMMEDIATE").planId]);
    const stale = evaluate(withSelection(immediateThen.planId), ctx, policy()); // no planningAsOf: not in the current set
    expect(stale.timingFlags).toEqual(["PLAN_OUT_OF_ENVELOPE"]);
  });

  it("a pick whose window passed, or whose amount changed, between the offer and now is discarded", () => {
    const evidence = [ownerAck(M1, { collectedAt: "2026-10-15T07:00:00Z" })]; // collected before both offers
    const offeredAt = "2026-10-15T08:00:00Z";
    const offered = evaluate(intent(), at(offeredAt, { evidence }), policy());
    const late = evaluate(withSelection(plan(offered, "TAKE_DISCOUNT").planId), at("2026-10-15T09:30:00Z", { evidence, planningAsOf: offeredAt }), policy());
    expect([late.timingFlags, late.payAt, late.releaseAmountBaseUnits]).toEqual([["PLAN_OUT_OF_ENVELOPE"], "2026-10-15T09:30:00Z", "980000000"]);
    const before = "2026-10-15T09:59:00Z";
    const offeredImm = plan(evaluate(intent(), at(before, { evidence }), policy()), "IMMEDIATE");
    expect(offeredImm.amountDue).toBe("980000000");
    const after = evaluate(withSelection(offeredImm.planId), at("2026-10-15T10:01:00Z", { evidence, planningAsOf: before }), policy());
    expect([after.timingFlags, after.releaseAmountBaseUnits]).toEqual([["PLAN_OUT_OF_ENVELOPE"], "1000000000"]);
  });

  it.each([["after now", "2026-10-05T12:00:01Z"], ["before the invoice was received", "2026-10-05T09:59:59Z"], ["not canonical", "yesterday"]])(
    "a planningAsOf %s is a context fault => HOLD KERNEL_ERROR",
    (_l, asOf) => {
      expectCheck(evaluate(withSelection(H("x")), { ...ctx, planningAsOf: asOf }, policy()), "K-14", "HOLD", "KERNEL_ERROR");
    },
  );

  it("legacy timing proposals map onto the plan set: an exact plan instant is AGENT, anything else CLAMPED to the nearest plan", () => {
    const exact = evaluate({ ...intent(), timingProposal: { payAt: "2026-11-03T10:00:00Z", rationale: "due" } }, ctx, policy());
    expect([exact.timingSource, exact.plannerFallback, exact.payAt, exact.timingFlags]).toEqual(["AGENT", true, "2026-11-03T10:00:00Z", []]);
    const mid = evaluate({ ...intent(), timingProposal: { payAt: "2026-10-20T00:00:00Z", rationale: "x" } }, ctx, policy());
    expect([mid.timingSource, mid.payAt, mid.timingFlags]).toEqual(["CLAMPED", "2026-10-15T09:00:00Z", ["TIMING_CLAMPED"]]);
    expect(mid.checks.find((c) => c.id === "K-14")).toMatchObject({ status: "PASS", code: "TIMING_CLAMPED" });
    const early = evaluate({ ...intent(), timingProposal: { payAt: "2026-01-01T00:00:00Z", rationale: "x" } }, ctx, policy());
    expect([early.timingSource, early.payAt]).toEqual(["CLAMPED", "2026-10-05T12:00:00Z"]);
    const later = evaluate({ ...intent(), timingProposal: { payAt: "2027-06-01T00:00:00Z", rationale: "x" } }, ctx, policy());
    expect([later.timingSource, later.payAt]).toEqual(["CLAMPED", "2026-11-03T10:00:00Z"]);
    // equidistant between IMMEDIATE (12:00) and TAKE_DISCOUNT (10-15T09:00): the later plan wins
    const tie = evaluate({ ...intent(), timingProposal: { payAt: "2026-10-10T10:30:00Z", rationale: "x" } }, ctx, policy());
    expect(tie.payAt).toBe("2026-10-15T09:00:00Z");
  });

  it("a proposal without evidence or without a payable plan schedules nothing (HOLD)", () => {
    expectCheck(evaluate({ ...intent(), timingProposal: { payAt: "2026-10-20T00:00:00Z", rationale: "x" } }, { ...ctx, evidence: [] }, policy()), "K-14", "HOLD", "EVIDENCE_MISSING");
    const short = { ...ctx, balances: { vaultAvailable: 100_000_000n, pendingReleases: 0n, obligations14d: 0n } };
    expectCheck(evaluate({ ...intent(), timingProposal: { payAt: "2026-10-20T00:00:00Z", rationale: "x" } }, short, policy()), "K-14", "HOLD", "LIQUIDITY");
  });

  it("LATE: the due date minus the buffer has passed => pay at legalEarliest, flagged", () => {
    const e = evaluate(intent(), at("2026-11-04T00:00:00Z", { paymentTerms: TWO_TEN_NET_30 }), policy());
    expect([e.verdict, e.payAt, e.timingFlags]).toEqual(["RELEASE", "2026-11-04T00:00:00Z", ["LATE"]]);
    expect(e.checks.find((c) => c.id === "K-14")).toMatchObject({ status: "PASS", code: "LATE" });
  });

  it("liquidity: no payable plan => HOLD LIQUIDITY; a tight vault still takes the discounted plan; missing evidence => HOLD EVIDENCE_MISSING", () => {
    expectCheck(evaluate(intent(), { ...ctx, balances: { vaultAvailable: 100_000_000n, pendingReleases: 0n, obligations14d: 0n } }, policy()), "K-14", "HOLD", "LIQUIDITY");
    const tight = evaluate(intent(), { ...ctx, balances: { vaultAvailable: 1_009_999_999n, pendingReleases: 0n, obligations14d: 0n } }, policy());
    expect([tight.verdict, tight.releaseAmountBaseUnits, tight.plans.map((p) => p.mode)]).toEqual(["RELEASE", "980000000", ["TAKE_DISCOUNT", "IMMEDIATE"]]);
    expectCheck(evaluate(intent(), { ...ctx, evidence: [] }, policy()), "K-14", "HOLD", "EVIDENCE_MISSING");
  });

  it("cost of capital above the discount APR, and an `immediate` milestone, change the evaluator's pick", () => {
    expect(evaluate(intent(), ctx, policy({ treasury: { costOfCapitalBps: 5000 } })).payAt).toBe("2026-11-03T10:00:00Z");
    const imm = engagement({ milestones: [milestone(M1, "design", { immediate: true }), milestone(M2, "build")] });
    expect(evaluate(intent(), context({ engagement: imm, milestone: imm.milestones[0] ?? null }), policy()).payAt).toBe("2026-10-05T12:00:00Z");
  });

  it("an unusable context fails closed: unreadable balances, or a receipt time after now", () => {
    expectCheck(evaluate(intent(), { ...ctx, balances: null as unknown as KernelContext["balances"] }, policy()), "K-14", "HOLD", "KERNEL_ERROR");
    expectCheck(evaluate(intent(), { ...ctx, invoiceReceivedAt: "2026-10-05T12:00:01Z" }, policy()), "K-14", "HOLD", "KERNEL_ERROR");
  });

  it("defence in depth: a schedule whose plan would break the reserve floor is refused by K-14 itself", () => {
    const parsed = PaymentIntentSchema.parse(intent());
    const facts = deriveFacts(parsed, ctx, policy());
    const s = deriveSchedule(parsed, ctx, policy(), facts, ok({ requirements: [], satisfied: true, satisfiedAt: ctx.invoiceReceivedAt, ignored: 0, overrideBy: null }));
    if (!s.ok || s.value.chosen === null) throw new Error("fixture");
    const forged = { ...s.value, chosen: { ...s.value.chosen, amountDue: (GROSS * 100n).toString() } };
    expect(checkK14(parsed, ctx, policy(), facts, ok(forged))).toMatchObject({ status: "FAIL", onFail: "HOLD", code: "LIQUIDITY" });
    expect(deriveSchedule(parsed, ctx, policy(), { ...facts, gross: null }, ok({ requirements: [], satisfied: true, satisfiedAt: null, ignored: 0, overrideBy: null })).ok).toBe(false);
  });
});

describe("TOCTOU re-evaluation at payAt (reevaluate)", () => {
  const ctx = (now: string, over: Partial<KernelContext> = {}) => at(now, { paymentTerms: TWO_TEN_NET_30, ...over });
  const first = evaluate(intent(), ctx("2026-10-05T12:00:00Z"), policy());
  const scheduled: ScheduledRelease = {
    decisionId: "11111111-2222-4333-8444-555555555555",
    intentId: first.intentId,
    payee: PAYEE,
    payAt: "2026-10-15T09:00:00Z",
    releaseAmountBaseUnits: 980_000_000n,
    planId: first.planId,
    timingSource: "DEFAULT",
    plannerFallback: true,
  };

  it("an unchanged world at payAt is attestable with a 10-minute deadline; timing fields are carried over", () => {
    const r = reevaluate(intent(), ctx("2026-10-15T09:00:00Z"), policy(), scheduled);
    expect([r.attestable, r.mismatches, r.supersedes, r.attestationDeadline]).toEqual([true, [], null, "2026-10-15T09:10:00Z"]);
    expect([r.evaluation.verdict, r.evaluation.releaseAmountBaseUnits, r.evaluation.planId, r.evaluation.timingSource]).toEqual(["RELEASE", "980000000", first.planId, "DEFAULT"]);
  });

  it("the discount window closed before the payment => ESCALATE DISCOUNT_WINDOW_CLOSED (K-08 and K-14), never a silent switch", () => {
    const r = reevaluate(intent(), ctx("2026-10-15T10:00:01Z"), policy(), scheduled);
    expect(r.evaluation.verdict).toBe("ESCALATE");
    expect(r.evaluation.reasons).toEqual(["DISCOUNT_WINDOW_CLOSED"]);
    expectCheck(r.evaluation, "K-14", "ESCALATE", "DISCOUNT_WINDOW_CLOSED");
    expect([r.attestable, r.mismatches, r.supersedes]).toEqual([false, ["NOT_RELEASE", "AMOUNT"], scheduled.decisionId]);
  });

  it.each([
    ["evidence revoked", { evidence: [] }, "EVIDENCE_MISSING"],
    ["breaker tripped", { breaker: { halted: true, reason: "unknown release" } }, "BREAKER_HALTED"],
    ["payee change proposed", { payeeChangePending: true }, "PAYEE_CHANGE_PENDING"],
    ["vault drained", { balances: { vaultAvailable: 1n, pendingReleases: 0n, obligations14d: 0n } }, "LIQUIDITY"],
  ] as const)("%s between decision and payAt => not attestable (%s)", (_l, over, code) => {
    const r = reevaluate(intent(), ctx("2026-10-15T09:00:00Z", over as Partial<KernelContext>), policy(), scheduled);
    expect(r.attestable).toBe(false);
    expect(r.evaluation.reasons).toContain(code);
    expect(r.mismatches).toContain("NOT_RELEASE");
  });

  it("early, another payee, another intent or an unreadable schedule are not attestable", () => {
    expect(reevaluate(intent(), ctx("2026-10-15T08:59:59Z"), policy(), scheduled).mismatches).toEqual(["EARLY"]);
    expect(reevaluate(intent(), ctx("2026-10-15T09:00:00Z"), policy(), { ...scheduled, payee: ATTACKER }).mismatches).toEqual(["PAYEE"]);
    expect(reevaluate(intent(), ctx("2026-10-15T09:00:00Z"), policy(), { ...scheduled, intentId: H("other") }).mismatches).toEqual(["NOT_RELEASE", "INTENT_ID"]);
    expect(reevaluate(intent(), ctx("2026-10-15T09:00:00Z"), policy(), { ...scheduled, payAt: "soon" }).mismatches).toContain("EARLY");
  });

  it("an attestation deadline after year 9999 cannot be issued (DEADLINE)", () => {
    const far = engagement({ end: "9999-12-31T23:59:59Z" });
    const now = "9999-12-31T23:55:00Z";
    const c = context({ engagement: far, milestone: far.milestones[0] ?? null, now, invoiceReceivedAt: now, evidence: [ownerAck(M1, { collectedAt: now }, { deadline: "253402300799" })] });
    const id = evaluate(intent(), c, policy()).intentId;
    const r = reevaluate(intent(), c, policy(), { ...scheduled, intentId: id, payAt: now, releaseAmountBaseUnits: GROSS });
    expect([r.evaluation.verdict, r.attestable, r.mismatches, r.attestationDeadline]).toEqual(["RELEASE", false, ["DEADLINE"], null]);
  });
});
