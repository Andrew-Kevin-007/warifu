// Treasury-plan routes (docs/03 s5, docs/05 s4): GET /intents/:id/plans, POST /intents/:id/plan-selection.
//
// GET   evaluates the stored intent against the current context and returns the kernel-feasible plan set + its deterministic
//       evaluation (the planner's only view). The set is recorded as an OFFER (plan_offers) with its instant: that instant is
//       the selection's `planningAsOf`, the set K-14 validates the planner's choice against.
// POST  merges the PlanSelection into the stored proposal and re-evaluates. Membership, feasibility and the amount are the
//       kernel's call (K-14); a selection that was never offered, or that is no longer feasible, is discarded by K-14 and the
//       evaluator's top safe plan is scheduled with plannerFallback=true (money never waits on the LLM).
import { evaluate } from "@symbolon/kernel-core";
import type { Decision, FeasiblePlan, PlanEvaluation, PlanSelection } from "@symbolon/schemas";
import { ApiError } from "../errors";
import * as base from "../db/repo";
import { offerContaining, recordPlanOffer, releaseForIntent } from "../release/repo";
import { nowIso } from "../time";
import { IntentNotFound, intentContext, readIntentChain } from "./intent-context";
import { reevaluateStored } from "./reeval";
import type { ReevalDeps } from "./reeval";
import { contextFailure } from "./intents";

export interface PlanSet {
  readonly plans: readonly FeasiblePlan[];
  readonly evaluation: PlanEvaluation;
}

export interface PlanProvider {
  plans(tenantId: string, intentId: string): Promise<PlanSet>;
  /** Validate membership, re-evaluate, persist a superseding decision. */
  select(tenantId: string, intentId: string, selection: PlanSelection): Promise<Decision>;
}

const notYet = (): ApiError => new ApiError("NOT_IMPLEMENTED", "treasury plans are not available in this build");

export const unavailablePlanProvider: PlanProvider = {
  plans: () => Promise.reject(notYet()),
  select: () => Promise.reject(notYet()),
};

/** Heads whose schedule a planner may still change: nothing has been sent yet (releaseForIntent is checked too). */
const SELECTABLE = ["RELEASE", "HOLD", "ESCALATE"] as const;

export function pgPlanProvider(d: ReevalDeps): PlanProvider {
  return {
    async plans(tenantId, intentId) {
      try {
        const view = await readIntentChain(d.db, d.chain, tenantId, intentId);
        return await d.db.tx(async (q): Promise<PlanSet> => {
          await base.lockTenantForDecisions(q, tenantId);
          const now = nowIso(d.clock);
          const ic = await intentContext(q, { tenantId, intentId, profile: d.profile, now, view });
          if (!SELECTABLE.includes(ic.head.decision.verdict as (typeof SELECTABLE)[number])) throw new ApiError("CONFLICT", "no payment plan applies to this decision", { verdict: ic.head.decision.verdict });
          const release = await releaseForIntent(q, tenantId, intentId);
          if (release !== null && release.status !== "FAILED") throw new ApiError("CONFLICT", "a release for this intent is already in flight");
          const e = evaluate(view.intent.payload, ic.ctx, ic.policy);
          if (e.planEvaluation === null || e.plans.length === 0) throw new ApiError("CONFLICT", "no feasible payment plan exists at this time", { reasons: [...e.reasons] });
          await recordPlanOffer(q, tenantId, intentId, now, e.plans.map((p) => p.planId));
          return { plans: e.plans, evaluation: e.planEvaluation };
        });
      } catch (e) {
        if (e instanceof IntentNotFound) throw new ApiError("NOT_FOUND", "not found");
        throw contextFailure(e, d.logger);
      }
    },
    async select(tenantId, intentId, selection) {
      try {
        const r = await reevaluateStored(d, tenantId, intentId, {
          action: "intent.plan_selected",
          actor: `tenant:${tenantId}`,
          heads: SELECTABLE,
          selection,
          async prepare(q) {
            const intent = await base.getIntentRow(q, tenantId, intentId);
            if (intent === null) throw new IntentNotFound();
            // The instant the plan set containing this plan was offered; none = never offered = K-14 sees the current set.
            return { planningAsOf: await offerContaining(q, tenantId, intentId, selection.planId, intent.createdAt) };
          },
        });
        if (r.recorded === null) throw new ApiError("CONFLICT", "the selection produced no new decision");
        return r.recorded.decision;
      } catch (e) {
        if (e instanceof IntentNotFound) throw new ApiError("NOT_FOUND", "not found");
        throw contextFailure(e, d.logger);
      }
    },
  };
}
