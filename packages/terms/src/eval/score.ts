// The deterministic plan evaluator (docs/03 §5.2/§5.5, docs/04 K-14; WP-05). Economics are never produced by the
// LLM: this module scores every feasible plan, names the top plan and the top SAFE plan that the kernel schedules
// when the planner is unavailable or its selection is rejected (PLAN_OUT_OF_ENVELOPE). Pure bigint math.
//
//   netBenefitBase = discountValue - costOfCapital
//   costOfCapital  = ceil(amountDue * costOfCapitalBps * secondsEarly / (10000 * 365 * 86400))
//   secondsEarly   = max(0, referenceInstant - payAt)     (referenceInstant = legalLatest: paying then costs nothing)
//   regretBase     = netBenefit(top plan) - netBenefitBase  (>= 0; hindsight regret vs an oracle is WP-35's)
// The cost is rounded UP so a plan's benefit is never overstated. costOfCapitalBps is the disclosed owner parameter
// (policy.treasury.costOfCapitalBps, default 0 = "any safe positive discount is worth taking"). A HOLD plan pays
// nothing: benefit 0. Ties are broken by a fixed mode preference: by default the later, liquidity-preserving plan
// (DUE_MINUS_BUFFER first); for a milestone flagged `immediate`, IMMEDIATE first. A plan is SAFE when it pays
// (mode != HOLD) and keeps the reserve floor (reserveFloorOk).
import { FeasiblePlanSchema, PlanEvaluationSchema, epochSecondsFromIso, isIsoDateTime } from "@symbolon/schemas";
import type { FeasiblePlan, ISODateTime, PlanEvaluation, PlanMode } from "@symbolon/schemas";
import { err, ok } from "../result";
import type { TermsResult } from "../result";
import { BPS_DENOMINATOR, DAYS_PER_YEAR, SECONDS_PER_DAY } from "../terms";

export interface ScoreParams {
  /** policy.treasury.costOfCapitalBps (0..1,000,000). */
  readonly costOfCapitalBps: number;
  /** The legal latest payment instant: paying at or after it costs no capital. */
  readonly referenceInstant: ISODateTime;
  /** Tie-break for a milestone flagged `immediate`: prefer IMMEDIATE among equal scores. */
  readonly preferImmediate: boolean;
}

/** Tie-break order among equal net benefits (earlier in the list wins). */
export const TIE_BREAK_DEFAULT: readonly PlanMode[] = Object.freeze(["DUE_MINUS_BUFFER", "TAKE_DISCOUNT", "AFTER_DISPUTE_WINDOW", "AFTER_EVIDENCE", "IMMEDIATE", "HOLD"] as const);
export const TIE_BREAK_IMMEDIATE: readonly PlanMode[] = Object.freeze(["IMMEDIATE", "AFTER_EVIDENCE", "AFTER_DISPUTE_WINDOW", "TAKE_DISCOUNT", "DUE_MINUS_BUFFER", "HOLD"] as const);

const YEAR_SECONDS_BPS = BPS_DENOMINATOR * DAYS_PER_YEAR * SECONDS_PER_DAY;
const MAX_COST_OF_CAPITAL_BPS = 1_000_000;

function checkParams(p: ScoreParams): TermsResult<bigint> {
  if (!Number.isSafeInteger(p.costOfCapitalBps) || p.costOfCapitalBps < 0 || p.costOfCapitalBps > MAX_COST_OF_CAPITAL_BPS) {
    return err("INVALID_BPS", `costOfCapitalBps must be an integer in [0, ${MAX_COST_OF_CAPITAL_BPS}]`);
  }
  if (typeof p.referenceInstant !== "string" || !isIsoDateTime(p.referenceInstant)) return err("INVALID_TIME", "referenceInstant must be a canonical ISODateTime");
  if (typeof p.preferImmediate !== "boolean") return err("INVALID_BPS", "preferImmediate must be a boolean");
  return ok(epochSecondsFromIso(p.referenceInstant));
}

const ceilDiv = (a: bigint, b: bigint): bigint => (a + b - 1n) / b;

function planBenefit(plan: FeasiblePlan, costBps: bigint, reference: bigint): bigint {
  if (plan.mode === "HOLD") return 0n;
  const amount = BigInt(plan.amountDue);
  const discount = BigInt(plan.discountValue);
  const payAt = epochSecondsFromIso(plan.payAt);
  const early = reference > payAt ? reference - payAt : 0n;
  return discount - ceilDiv(amount * costBps * early, YEAR_SECONDS_BPS);
}

/** netBenefitBase of one plan (see the module comment). */
export function scorePlan(plan: FeasiblePlan, params: ScoreParams): TermsResult<bigint> {
  const ref = checkParams(params);
  if (!ref.ok) return ref;
  if (!FeasiblePlanSchema.safeParse(plan).success) return err("INVALID_AMOUNT", "plan does not satisfy FeasiblePlanSchema");
  return ok(planBenefit(plan, BigInt(params.costOfCapitalBps), ref.value));
}

function tieRank(mode: PlanMode, preferImmediate: boolean): number {
  return (preferImmediate ? TIE_BREAK_IMMEDIATE : TIE_BREAK_DEFAULT).indexOf(mode);
}

export interface RankedPlan {
  readonly plan: FeasiblePlan;
  readonly netBenefit: bigint;
}

/**
 * Score and order the plans best first: higher net benefit, then the tie-break mode order, then planId. Fails on an
 * empty set, duplicate planIds or a plan that does not parse (the kernel then schedules nothing: fail closed).
 */
export function rankPlans(plans: readonly FeasiblePlan[], params: ScoreParams): TermsResult<readonly RankedPlan[]> {
  const ref = checkParams(params);
  if (!ref.ok) return ref;
  if (!Array.isArray(plans) || plans.length === 0) return err("INVALID_AMOUNT", "no plans to evaluate");
  if (!plans.every((p) => FeasiblePlanSchema.safeParse(p).success)) return err("INVALID_AMOUNT", "a plan does not satisfy FeasiblePlanSchema");
  const ids = new Set(plans.map((p) => p.planId));
  if (ids.size !== plans.length) return err("INVALID_AMOUNT", "duplicate planId");
  const cost = BigInt(params.costOfCapitalBps);
  const ranked = plans.map((plan) => ({ plan, netBenefit: planBenefit(plan, cost, ref.value) }));
  ranked.sort((a, b) => {
    if (a.netBenefit !== b.netBenefit) return a.netBenefit > b.netBenefit ? -1 : 1;
    const t = tieRank(a.plan.mode, params.preferImmediate) - tieRank(b.plan.mode, params.preferImmediate);
    if (t !== 0) return t;
    return a.plan.planId < b.plan.planId ? -1 : 1; // planIds are unique (checked above)
  });
  return ok(ranked);
}

/** PlanEvaluation (docs/03 §5.3): per-plan net benefit and regret vs the top plan, in the input order. */
export function evaluatePlans(plans: readonly FeasiblePlan[], params: ScoreParams): TermsResult<PlanEvaluation> {
  const ranked = rankPlans(plans, params);
  if (!ranked.ok) return ranked;
  const top = ranked.value[0] as RankedPlan; // rankPlans refuses an empty set
  const byId = new Map(ranked.value.map((r) => [r.plan.planId, r.netBenefit] as const));
  const evaluation = {
    plans: plans.map((p) => {
      const benefit = byId.get(p.planId) as bigint;
      return { planId: p.planId, netBenefitBase: benefit.toString(), regretBase: (top.netBenefit - benefit).toString() };
    }),
    topPlanId: top.plan.planId,
    costOfCapitalBps: params.costOfCapitalBps,
  };
  const parsed = PlanEvaluationSchema.safeParse(evaluation);
  if (!parsed.success) return err("INVALID_AMOUNT", "evaluation does not satisfy PlanEvaluationSchema");
  return ok(parsed.data);
}

/** A plan the kernel may schedule without a planner: it pays and keeps the reserve floor. */
export function isSafePlan(plan: FeasiblePlan): boolean {
  return plan.mode !== "HOLD" && plan.reserveFloorOk;
}

/**
 * The evaluator's top SAFE plan (the kernel's fallback schedule, `plannerFallback=true`), or null when no plan is
 * safe (the kernel then holds: nothing is paid).
 */
export function topSafePlan(plans: readonly FeasiblePlan[], params: ScoreParams): TermsResult<FeasiblePlan | null> {
  const ranked = rankPlans(plans, params);
  if (!ranked.ok) return ranked;
  const safe = ranked.value.find((r) => isSafePlan(r.plan));
  return ok(safe === undefined ? null : safe.plan);
}
