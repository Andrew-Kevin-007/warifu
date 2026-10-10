// @symbolon/terms — scaffold placeholder (WP-04). The owning WP replaces this file.
// Contract (docs/04 K-14, docs/03 §5, docs/02 INV-19): pure, bigint-only, no clock (time is an argument).
//   discountValue    = floor(gross * bps / 10000)
//   impliedAprBps    = floor(bps * 365 * 10000 / ((10000 - bps) * (netDays - withinDays)))
//   discount applies iff payAt <= invoiceReceivedAt + withinDays
//   feasiblePlans(ctx, policy) -> FeasiblePlan[]   (deterministic; stable planIds)
export const PACKAGE_NAME = "@symbolon/terms" as const;
