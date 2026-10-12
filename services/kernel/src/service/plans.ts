// Treasury-plan routes (docs/03 s5, docs/05 s4): GET /intents/:id/plans, POST /intents/:id/plan-selection.
// The feasible-plan set and the deterministic evaluator are WP-05 (packages/terms/src/eval). Until they exist the service has
// nothing it may honestly return, so the default provider answers 501 and the kernel falls back to its own timing
// (K-14 legacy path). The seam is a provider so WP-05 plugs in without touching the routes.
import type { Decision, FeasiblePlan, PlanEvaluation, PlanSelection } from "@symbolon/schemas";
import { ApiError } from "../errors";

export interface PlanSet {
  readonly plans: readonly FeasiblePlan[];
  readonly evaluation: PlanEvaluation;
}

export interface PlanProvider {
  plans(tenantId: string, intentId: string): Promise<PlanSet>;
  /** Validate membership, re-evaluate, persist a superseding decision. */
  select(tenantId: string, intentId: string, selection: PlanSelection): Promise<Decision>;
}

const notYet = (): ApiError => new ApiError("NOT_IMPLEMENTED", "treasury plans are not available in this build (WP-05)");

export const unavailablePlanProvider: PlanProvider = {
  plans: () => Promise.reject(notYet()),
  select: () => Promise.reject(notYet()),
};
