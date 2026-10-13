// Deterministic plan evaluator (owner: KERNEL-CORE, WP-05). Imported by kernel-core (K-14 fallback schedule), the
// kernel service (GET /intents/:id/plans) and the planner corpus (WP-35, packages/extractor/eval/planner).
export { TIE_BREAK_DEFAULT, TIE_BREAK_IMMEDIATE, evaluatePlans, isSafePlan, rankPlans, scorePlan, topSafePlan } from "./score";
export type { RankedPlan, ScoreParams } from "./score";
