// Hindsight evaluation for the planner eval (docs/03 §5.5; WP-35). Given the scenario's TRUE facts (when the
// evidence really arrived, whether a later obligation could be met), what would each feasible plan have been worth?
// Scoring reuses the deterministic evaluator from @symbolon/terms (scorePlan); only the hindsight facts, the
// penalties and the exhaustive search over the feasible set live here. bigint only; no clock, no randomness.
//
//   hindsightPayAt  = max(plan.payAt, trueEvidenceAt, max(invoiceReceivedAt, trueEvidenceAt) + disputeWindowHours)
//   amountDue       = amountDue(gross, SIGNED terms, invoiceReceivedAt, hindsightPayAt)   (window may have closed)
//   netBenefit      = scorePlan(plan at hindsightPayAt) - latePenalty - shortfallPenalty
//   latePenalty     = ceil(gross * LATE_PENALTY_BPS / 10000)           if hindsightPayAt > due date
//   shortfallPenalty= ceil(shortfall * SHORTFALL_PENALTY_BPS / 10000)  if paying before a later obligation leaves it unmet
// The penalty rates are DISCLOSED assumptions of the simulation, not measurements.
import { epochSecondsFromIso, isoFromEpochSeconds, type FeasiblePlan, type ISODateTime } from "@symbolon/schemas";
import { amountDue, effectiveTerms, scorePlan, topSafePlan, type ScoreParams } from "@symbolon/terms";
import type { PlannerScenario } from "./scenarios";

export const LATE_PENALTY_BPS = 500n;
export const SHORTFALL_PENALTY_BPS = 1_000n;

const BPS = 10_000n;
const DAY = 86_400n;
const HOUR = 3_600n;
const ceilDiv = (a: bigint, b: bigint): bigint => (a + b - 1n) / b;
const maxOf = (a: bigint, b: bigint): bigint => (a > b ? a : b);

export interface HindsightOutcome {
  readonly planId: string;
  readonly mode: FeasiblePlan["mode"];
  readonly paid: boolean;
  readonly payAt: ISODateTime;
  readonly amountDue: bigint;
  readonly discountApplied: boolean;
  readonly late: boolean;
  readonly shortfall: bigint;
  readonly netBenefit: bigint;
}

function unwrap<T>(r: { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: { readonly code: string } }): T {
  if (!r.ok) throw new RangeError(`terms error ${r.error.code}`);
  return r.value;
}

export function hindsightOutcome(s: PlannerScenario, plan: FeasiblePlan, params: ScoreParams): HindsightOutcome {
  if (plan.mode === "HOLD") {
    return { planId: plan.planId, mode: plan.mode, paid: false, payAt: plan.payAt, amountDue: 0n, discountApplied: false, late: false, shortfall: 0n, netBenefit: 0n };
  }
  const received = epochSecondsFromIso(s.invoiceReceivedAt);
  const now = epochSecondsFromIso(s.now);
  const slip = BigInt(s.hindsight.evidenceSlipSeconds);
  const projected = s.evidenceSatisfiedAt === null ? now : epochSecondsFromIso(s.evidenceSatisfiedAt);
  const trueEvidence = projected + slip;
  const trueEarliest = maxOf(received, trueEvidence) + BigInt(s.policyTiming.disputeWindowHours) * HOUR;
  const payAtSec = maxOf(maxOf(epochSecondsFromIso(plan.payAt), trueEvidence), trueEarliest);
  const payAt = isoFromEpochSeconds(payAtSec);

  const due = unwrap(amountDue({ grossBaseUnits: s.grossBaseUnits, terms: s.terms, invoiceReceivedAt: s.invoiceReceivedAt, payAt }));
  const realized: FeasiblePlan = { ...plan, payAt, amountDue: due.amountDue.toString(), discountValue: due.discountValue.toString() };
  const score = unwrap(scorePlan(realized, params));

  const eff = unwrap(effectiveTerms(s.terms, s.policyTiming));
  const dueDate = received + BigInt(eff.netDays) * DAY;
  const late = payAtSec > dueDate;
  const latePenalty = late ? ceilDiv(s.grossBaseUnits * LATE_PENALTY_BPS, BPS) : 0n;

  let shortfall = 0n;
  const ob = s.hindsight.obligation;
  if (ob !== null && payAtSec <= now + BigInt(ob.atOffsetSeconds)) {
    const balance = s.liquidity.vaultAvailable - s.liquidity.pendingReleases - due.amountDue + ob.inflow;
    const need = ob.amount + s.liquidity.reserveFloor;
    shortfall = need > balance ? need - balance : 0n;
  }
  const shortfallPenalty = ceilDiv(shortfall * SHORTFALL_PENALTY_BPS, BPS);

  return {
    planId: plan.planId,
    mode: plan.mode,
    paid: true,
    payAt,
    amountDue: due.amountDue,
    discountApplied: due.discountApplied,
    late,
    shortfall,
    netBenefit: score - latePenalty - shortfallPenalty,
  };
}

/** Exhaustive search over the feasible set with hindsight; HOLD (benefit 0) only when nothing is payable. */
export function hindsightOracle(s: PlannerScenario, plans: readonly FeasiblePlan[], params: ScoreParams): { readonly best: HindsightOutcome; readonly all: readonly HindsightOutcome[] } {
  const all = plans.map((p) => hindsightOutcome(s, p, params));
  const payable = all.filter((o) => o.paid);
  const pool = payable.length > 0 ? payable : all;
  let best = pool[0] as HindsightOutcome;
  for (const o of pool) if (o.netBenefit > best.netBenefit) best = o;
  return { best, all };
}

const MODE_ORDER: readonly FeasiblePlan["mode"][] = ["DUE_MINUS_BUFFER", "TAKE_DISCOUNT", "AFTER_DISPUTE_WINDOW", "AFTER_EVIDENCE", "IMMEDIATE", "HOLD"];

function payable(plans: readonly FeasiblePlan[]): FeasiblePlan[] {
  return plans.filter((p) => p.mode !== "HOLD");
}

/** Baseline: pay as early as the kernel legally allows (earliest payable plan). */
export function baselinePayImmediately(plans: readonly FeasiblePlan[]): FeasiblePlan | null {
  const xs = payable(plans);
  if (xs.length === 0) return null;
  return [...xs].sort((a, b) => {
    const d = epochSecondsFromIso(a.payAt) - epochSecondsFromIso(b.payAt);
    if (d !== 0n) return d < 0n ? -1 : 1;
    return MODE_ORDER.indexOf(b.mode) - MODE_ORDER.indexOf(a.mode); // earlier-in-list modes lose ties: take the most eager
  })[0] as FeasiblePlan;
}

/** Baseline: pay as late as the kernel legally allows (due date minus the buffer). */
export function baselineDueMinusBuffer(plans: readonly FeasiblePlan[]): FeasiblePlan | null {
  const xs = payable(plans);
  if (xs.length === 0) return null;
  return [...xs].sort((a, b) => {
    const d = epochSecondsFromIso(b.payAt) - epochSecondsFromIso(a.payAt);
    if (d !== 0n) return d < 0n ? -1 : 1;
    return MODE_ORDER.indexOf(a.mode) - MODE_ORDER.indexOf(b.mode);
  })[0] as FeasiblePlan;
}

/** The deterministic default the kernel schedules without a planner. */
export function evaluatorTop(plans: readonly FeasiblePlan[], params: ScoreParams): FeasiblePlan | null {
  const r = topSafePlan(plans, params);
  return r.ok ? r.value : null;
}
