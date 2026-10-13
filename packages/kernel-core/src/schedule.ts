// The payment schedule of a first evaluation (docs/04 K-14, docs/03 §5.3-§5.4; WP-05): the kernel-feasible plan set
// (packages/terms feasiblePlans), its deterministic evaluation, and which plan is scheduled.
//   planSelection present  => its planId must belong to the set AS OFFERED (ctx.planningAsOf, else now) and the same
//                             mode must still be feasible now with the same amountDue; then that plan is scheduled
//                             (timingSource AGENT). Otherwise the selection is discarded: PLAN_OUT_OF_ENVELOPE is
//                             recorded and the evaluator's top SAFE plan is scheduled (DEFAULT, plannerFallback).
//   timingProposal only    => legacy path: the proposed instant is clamped into [legalEarliest, legalLatest] and
//                             mapped to the nearest feasible plan (ties: the later one). An exact plan instant is
//                             AGENT; anything else is CLAMPED with TIMING_CLAMPED. A proposal never creates an
//                             instant or an amount outside the plan set (guardrail 9, the stricter reading).
//   neither                => the top safe plan (DEFAULT, plannerFallback=true): money never waits on the LLM.
// LATE is flagged when the due date minus the buffer has passed. No safe payable plan => nothing is scheduled and
// K-14 holds. A TOCTOU re-evaluation (ctx.reevaluation) does not re-plan: the scheduled payAt stands (facts.release).
import { epochSecondsFromIso, hashJcs, isIsoDateTime } from "@symbolon/schemas";
import type { FeasiblePlan, Hex32, ISODateTime, PaymentIntent, PlanEvaluation, PlanSelection, ReasonCode, TimingProposal, TimingSource } from "@symbolon/schemas";
import type { LoadedPolicy } from "@symbolon/policy";
import { evaluatePlans, feasiblePlans, topSafePlan } from "@symbolon/terms";
import type { PlanInput, PlanSet, ScoreParams, TermsResult } from "@symbolon/terms";
import type { KernelContext } from "./context";
import type { EvidenceAssessment } from "./evidence";
import type { Facts } from "./facts";
import { attempt, err, ok } from "./result";
import type { Result } from "./result";

export interface Schedule {
  /** The feasible set at ctx.now. */
  readonly planSet: PlanSet;
  readonly evaluation: PlanEvaluation;
  /** keccak256(JCS(evaluation)): Receipt.inputs.planEvaluationHash. */
  readonly evaluationHash: Hex32;
  /** The scheduled payable plan, or null when no safe payable plan exists (nothing is paid). */
  readonly chosen: FeasiblePlan | null;
  /** planId of the scheduled plan; null when nothing is scheduled. */
  readonly planId: Hex32 | null;
  readonly timingSource: TimingSource | null;
  readonly plannerFallback: boolean;
  /** Non-blocking timing flags for the receipt: PLAN_OUT_OF_ENVELOPE, TIMING_CLAMPED, LATE. */
  readonly flags: readonly ReasonCode[];
  readonly detail: string;
}

function planInput(facts: Facts, ctx: KernelContext, policy: LoadedPolicy, evidence: Result<EvidenceAssessment>, now: ISODateTime): Result<PlanInput> {
  const e = facts.engagement;
  const gross = facts.gross;
  if (e === null || facts.milestoneTerms === null || gross === null || !facts.intentIdBound) return err("CONTEXT_INVALID", "the intent is not bound to an engagement, milestone and amount");
  if (!evidence.ok) return err("CONTEXT_INVALID", "evidence could not be assessed");
  return ok({
    intentId: facts.intentId,
    now,
    invoiceReceivedAt: ctx.invoiceReceivedAt,
    grossBaseUnits: gross,
    terms: e.paymentTerms,
    policyTiming: policy.policy.timing,
    evidenceSatisfiedAt: evidence.value.satisfiedAt,
    liquidity: { vaultAvailable: ctx.balances.vaultAvailable, pendingReleases: ctx.balances.pendingReleases, reserveFloor: policy.amounts.reserveFloor },
    amountCeiling: null,
  });
}

const seconds = (iso: ISODateTime): bigint => epochSecondsFromIso(iso);

/** The payable plan nearest to `t` (ties: the later plan, then the later mode position). */
function nearest(plans: readonly FeasiblePlan[], t: bigint): FeasiblePlan | null {
  let best: FeasiblePlan | null = null;
  let bestDistance = 0n;
  for (const p of plans) {
    if (p.mode === "HOLD") continue;
    const at = seconds(p.payAt);
    const d = at > t ? at - t : t - at;
    if (best === null || d < bestDistance || (d === bestDistance && at >= seconds(best.payAt))) {
      best = p;
      bestDistance = d;
    }
  }
  return best;
}

interface Choice {
  readonly chosen: FeasiblePlan | null;
  readonly source: TimingSource | null;
  readonly fallback: boolean;
  readonly flags: ReasonCode[];
  readonly detail: string;
}

/**
 * TermsResult -> value, inside deriveSchedule only. Every call below runs on inputs feasiblePlans() has already
 * validated, so a failure means a kernel bug; the throw is caught by deriveSchedule's own `attempt` and becomes a
 * typed TERMS error (K-14 then fails closed). Nothing escapes this module.
 */
function unwrap<T>(r: TermsResult<T>): T {
  if (!r.ok) throw new RangeError(r.error.code);
  return r.value;
}

function fromSelection(selection: PlanSelection, input: PlanInput, ctx: KernelContext, current: PlanSet, safe: FeasiblePlan | null): Result<Choice> {
  const asOf = ctx.planningAsOf ?? ctx.now;
  if (typeof asOf !== "string" || !isIsoDateTime(asOf) || seconds(asOf) > seconds(ctx.now) || seconds(asOf) < seconds(ctx.invoiceReceivedAt)) {
    return err("CONTEXT_INVALID", "planningAsOf must be a canonical instant in [invoiceReceivedAt, now]");
  }
  const offered = asOf === ctx.now ? current : unwrap(feasiblePlans({ ...input, now: asOf }));
  const picked = offered.plans.find((p) => p.planId === selection.planId && p.mode !== "HOLD");
  const still = picked === undefined ? undefined : current.plans.find((p) => p.mode === picked.mode && p.amountDue === picked.amountDue);
  if (still !== undefined) return ok({ chosen: still, source: "AGENT", fallback: false, flags: [], detail: `planner plan ${still.mode} (in the feasible set)` });
  const why = picked === undefined ? "planId is not in the feasible plan set as offered" : `the chosen ${picked.mode} plan is no longer feasible with the same amount`;
  return ok({ chosen: safe, source: safe === null ? null : "DEFAULT", fallback: true, flags: ["PLAN_OUT_OF_ENVELOPE"], detail: `planner selection discarded (${why}); evaluator's top safe plan used` });
}

function fromProposal(proposal: TimingProposal, current: PlanSet): Choice {
  const w = current.window;
  if (w === null) return { chosen: null, source: null, fallback: true, flags: [], detail: "no payment time: evidence precondition not satisfied" };
  const p = seconds(proposal.payAt);
  const lo = seconds(w.earliest);
  const hi = seconds(w.latest);
  const clamped = p < lo ? lo : p > hi ? hi : p;
  const plan = nearest(current.plans, clamped);
  if (plan === null) return { chosen: null, source: null, fallback: true, flags: [], detail: "no feasible payable plan for the timing proposal" };
  const exact = seconds(plan.payAt) === p;
  return {
    chosen: plan,
    source: exact ? "AGENT" : "CLAMPED",
    fallback: true,
    flags: exact ? [] : ["TIMING_CLAMPED"],
    detail: exact ? `timing proposal matches the ${plan.mode} plan` : `timing proposal clamped to the nearest feasible plan (${plan.mode})`,
  };
}

function schedule(intent: PaymentIntent, ctx: KernelContext, policy: LoadedPolicy, facts: Facts, input: PlanInput): Result<Schedule> {
  const current = unwrap(feasiblePlans(input));
  const params: ScoreParams = {
    costOfCapitalBps: policy.policy.treasury.costOfCapitalBps,
    referenceInstant: current.window?.latest ?? ctx.now,
    preferImmediate: (facts.milestoneTerms as NonNullable<Facts["milestoneTerms"]>).immediate,
  };
  const evaluation = unwrap(evaluatePlans(current.plans, params));
  const safe = unwrap(topSafePlan(current.plans, params));
  let choice: Choice;
  if (intent.planSelection !== null) {
    const c = fromSelection(intent.planSelection, input, ctx, current, safe);
    if (!c.ok) return c;
    choice = c.value;
  } else if (intent.timingProposal !== null) {
    choice = fromProposal(intent.timingProposal, current);
  } else {
    choice = { chosen: safe, source: safe === null ? null : "DEFAULT", fallback: true, flags: [], detail: "no planner selection; evaluator's top safe plan" };
  }
  const flags = [...choice.flags];
  if (choice.chosen !== null && current.window?.late === true) flags.push("LATE");
  return ok({
    planSet: current,
    evaluation,
    evaluationHash: hashJcs(evaluation),
    chosen: choice.chosen,
    planId: choice.chosen === null ? null : choice.chosen.planId,
    timingSource: choice.chosen === null ? null : choice.source,
    plannerFallback: choice.fallback,
    flags,
    detail: choice.detail,
  });
}

/** The schedule of a first evaluation (see the module comment). Never throws. */
export function deriveSchedule(intent: PaymentIntent, ctx: KernelContext, policy: LoadedPolicy, facts: Facts, evidence: Result<EvidenceAssessment>): Result<Schedule> {
  const input = planInput(facts, ctx, policy, evidence, ctx.now);
  if (!input.ok) return input;
  const r = attempt(() => schedule(intent, ctx, policy, facts, input.value), "TERMS", "the plan set could not be computed from the signed terms and the context");
  return r.ok ? r.value : r;
}
