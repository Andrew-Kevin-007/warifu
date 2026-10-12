// @symbolon/terms (owner: KERNEL-CORE; WP-04): pure payment-terms math (docs/03 §5.2, docs/04 K-08/K-14,
// INV-9/10/19). bigint only, no clock (time is an argument), no I/O; imports only @symbolon/schemas.
// feasiblePlans() and the plan evaluator (src/eval/) arrive in WP-05.
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
