// reevaluate(): the TOCTOU guard at payAt (docs/04 §5; WP-05). A RELEASE is a schedule, not a payment: at payAt the
// service rebuilds the KernelContext and calls this helper, which runs evaluate() with ctx.reevaluation set to the
// scheduled release. Only a fresh RELEASE with the identical (intentId, release amount, payee), at or after the
// scheduled payAt, is attestable; anything else is a changed outcome: the service records the new Decision with
// supersedes = the scheduled decision. A discount window that closed before payAt shows up as ESCALATE
// DISCOUNT_WINDOW_CLOSED (K-08/K-14), never as a silent switch to the full amount. Pure; never throws.
import { epochSecondsFromIso, isoFromEpochSeconds } from "@symbolon/schemas";
import type { Address, Hex32, ISODateTime, TimingSource, UUID } from "@symbolon/schemas";
import type { LoadedPolicy } from "@symbolon/policy";
import type { KernelContext } from "./context";
import { evaluate } from "./evaluate";
import type { Evaluation } from "./evaluation";
import { attempt } from "./result";

/** The scheduled RELEASE being re-evaluated (from the stored Decision). */
export interface ScheduledRelease {
  readonly decisionId: UUID;
  readonly intentId: Hex32;
  readonly payee: Address;
  readonly payAt: ISODateTime;
  readonly releaseAmountBaseUnits: bigint;
  readonly planId: Hex32 | null;
  readonly timingSource: TimingSource | null;
  readonly plannerFallback: boolean;
}

/** Why a re-evaluation is not attestable. DEADLINE: now + 10 min is not representable (after year 9999). */
export type ReevaluationMismatch = "NOT_RELEASE" | "INTENT_ID" | "AMOUNT" | "PAYEE" | "EARLY" | "DEADLINE";

export interface Reevaluated {
  /** The fresh evaluation; planId/timingSource/plannerFallback are carried over from the schedule. */
  readonly evaluation: Evaluation;
  readonly attestable: boolean;
  readonly mismatches: readonly ReevaluationMismatch[];
  /** The scheduled decision this outcome supersedes, when it is not attestable. */
  readonly supersedes: UUID | null;
  /** now + 10 minutes (docs/04 §5), only when attestable. */
  readonly attestationDeadline: ISODateTime | null;
}

export const ATTESTATION_TTL_SECONDS = 600n;

export function reevaluate(rawIntent: unknown, ctx: KernelContext, policy: LoadedPolicy, scheduled: ScheduledRelease): Reevaluated {
  const rebuilt: KernelContext = {
    ...ctx,
    reevaluation: { decisionId: scheduled.decisionId, intentId: scheduled.intentId, payAt: scheduled.payAt, releaseAmountBaseUnits: scheduled.releaseAmountBaseUnits },
  };
  const fresh = evaluate(rawIntent, rebuilt, policy);
  const evaluation: Evaluation = { ...fresh, planId: scheduled.planId, timingSource: scheduled.timingSource, plannerFallback: scheduled.plannerFallback };
  const mismatches: ReevaluationMismatch[] = [];
  if (fresh.verdict !== "RELEASE") mismatches.push("NOT_RELEASE");
  if (fresh.intentId !== scheduled.intentId) mismatches.push("INTENT_ID");
  if (fresh.releaseAmountBaseUnits !== scheduled.releaseAmountBaseUnits.toString()) mismatches.push("AMOUNT");
  if (fresh.payee !== scheduled.payee) mismatches.push("PAYEE");
  const times = attempt(() => [epochSecondsFromIso(ctx.now), epochSecondsFromIso(scheduled.payAt)] as const, "CONTEXT_INVALID", "times");
  if (!times.ok || times.value[0] < times.value[1]) mismatches.push("EARLY");
  let attestationDeadline: ISODateTime | null = null;
  if (mismatches.length === 0 && times.ok) {
    const d = attempt(() => isoFromEpochSeconds(times.value[0] + ATTESTATION_TTL_SECONDS), "CONTEXT_INVALID", "deadline");
    if (d.ok) attestationDeadline = d.value;
    else mismatches.push("DEADLINE");
  }
  const attestable = mismatches.length === 0;
  return { evaluation, attestable, mismatches, supersedes: attestable ? null : scheduled.decisionId, attestationDeadline };
}
