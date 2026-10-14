// @symbolon/terms (owner: KERNEL-CORE): pure payment-terms math (docs/03 §5.2, docs/04 K-08/K-14,
// INV-9/10/19). bigint only, no clock (time is an argument), no I/O; imports only @symbolon/schemas.
// WP-04: amountDue, discount window, implied APR. WP-05: feasiblePlans() and the plan evaluator (src/eval/).
export const PACKAGE_NAME = "@symbolon/terms" as const;

export { err, ok } from "./result";
export type { TermsError, TermsErrorCode, TermsResult } from "./result";
export {
  BPS_DENOMINATOR,
  DAYS_PER_YEAR,
  MAX_DAYS,
  SECONDS_PER_DAY,
  addDays,
  amountDue,
  discountValue,
  discountWindowEnd,
  dueDate,
  impliedAprBps,
  isWithinDiscountWindow,
  termsImpliedAprBps,
} from "./terms";
export type { AmountDue, AmountDueInput, ImpliedAprInput } from "./terms";
export { effectiveTerms, feasiblePlans } from "./plans";
export type { EffectiveTerms, LegalWindow, PlanExclusion, PlanInput, PlanLiquidity, PlanSet, PolicyTiming } from "./plans";
export { TIE_BREAK_DEFAULT, TIE_BREAK_IMMEDIATE, evaluatePlans, isSafePlan, rankPlans, scorePlan, topSafePlan } from "./eval/index";
export type { RankedPlan, ScoreParams } from "./eval/index";
