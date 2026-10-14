// The output of evaluate(): every CheckResult (PASS included), the verdict, and the decision fields the kernel
// derived. services/kernel turns it into a Decision (decisionId, createdAt, supersedes) and a receipt.
import type { Address, CheckResult, FeasiblePlan, Hex32, ISODateTime, PlanEvaluation, ReasonCode, TimingSource, UUID, Verdict } from "@symbolon/schemas";
import type { DecisionSummary, FindingRef } from "./context";
import { err, ok } from "./result";
import type { Result } from "./result";

export interface Evaluation {
  readonly verdict: Verdict;
  /** In evaluation order, AFTER the verdict gates; fewer than all when K-01 rejected (SCHEMA_INVALID) or K-04 returned REPLAY. */
  readonly checks: readonly CheckResult[];
  /** Reason codes of the FAILs, in check order, without duplicates (empty for REPLAY). */
  readonly reasons: readonly ReasonCode[];
  readonly intentId: Hex32;
  /** false => intentId derived from the context only (the intent could not be bound; never a RELEASE). */
  readonly intentIdBound: boolean;
  readonly normInvoiceNo: string | null;
  readonly docHash: Hex32 | null;
  readonly engagementId: Hex32 | null;
  readonly milestoneId: Hex32 | null;
  /** Payout address: always the engagement payee. */
  readonly payee: Address | null;
  /** GROSS invoiced amount (base units). */
  readonly amountBaseUnits: string | null;
  /** amountDue(payAt) computed by the kernel from the signed terms, when a release instant is known. */
  readonly releaseAmountBaseUnits: string | null;
  readonly payAt: ISODateTime | null;
  /** WP-05: how payAt was chosen (null when nothing is scheduled, and at a TOCTOU re-evaluation). */
  readonly timingSource: TimingSource | null;
  /** WP-05: the scheduled plan (null when nothing is scheduled, and at a TOCTOU re-evaluation). */
  readonly planId: Hex32 | null;
  /** WP-05: the planner's selection was absent or discarded and the evaluator's top safe plan was used. */
  readonly plannerFallback: boolean;
  /** WP-05: the kernel-feasible plans at ctx.now (the planner's only view; empty when none could be computed). */
  readonly plans: readonly FeasiblePlan[];
  readonly planEvaluation: PlanEvaluation | null;
  /** keccak256(JCS(planEvaluation)): Receipt.inputs.planEvaluationHash. */
  readonly planEvaluationHash: Hex32 | null;
  /** WP-05: non-blocking timing flags (PLAN_OUT_OF_ENVELOPE, TIMING_CLAMPED, LATE). */
  readonly timingFlags: readonly ReasonCode[];
  readonly invoiceReceivedAt: ISODateTime | null;
  /** The original decision when verdict = REPLAY (docs/04 K-04), else null. */
  readonly replayOf: DecisionSummary | null;
  /**
   * WP-05: the ESCALATE findings an owner approval could resolve (before the gates). The service shows them in the
   * ApprovalView and passes them back as ctx.approvedEscalation.findings with the escalation receipt hash.
   */
  readonly approvableFindings: readonly FindingRef[];
  /** WP-05: the findings a bound owner approval resolved in this evaluation. */
  readonly resolvedByApproval: readonly FindingRef[];
  /** WP-05: the kernel's templated explanation (INV-20; src/explain). */
  readonly humanExplanation: string;
  readonly contextHash: Hex32 | null;
  readonly policyHash: Hex32 | null;
  readonly kernelVersion: string;
  readonly patternsVersion: string;
}

/**
 * The DecisionSummary the service stores for a new decision (and later passes back in ctx.priorDecisions).
 * A REPLAY is not a new decision, and an evaluation without a document hash cannot be summarized.
 */
export function summarizeEvaluation(e: Evaluation, meta: { readonly decisionId: UUID; readonly createdAt: ISODateTime }): Result<DecisionSummary> {
  if (e.verdict === "REPLAY") return err("CONTEXT_INVALID", "a REPLAY is not a new decision; store nothing");
  if (e.docHash === null) return err("CONTEXT_INVALID", "evaluation has no document hash");
  return ok({
    decisionId: meta.decisionId,
    intentId: e.intentId,
    verdict: e.verdict,
    docHash: e.docHash,
    engagementId: e.engagementId,
    milestoneId: e.milestoneId,
    payee: e.payee,
    normInvoiceNo: e.normInvoiceNo,
    amountBaseUnits: e.amountBaseUnits === null ? null : BigInt(e.amountBaseUnits),
    releaseAmountBaseUnits: e.releaseAmountBaseUnits === null ? null : BigInt(e.releaseAmountBaseUnits),
    createdAt: meta.createdAt,
  });
}
