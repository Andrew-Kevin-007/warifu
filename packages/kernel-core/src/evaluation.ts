// The output of evaluate(): every CheckResult (PASS included), the verdict, and the decision fields the kernel
// derived. services/kernel turns it into a Decision (decisionId, createdAt, supersedes, explanation) and a receipt.
import type { Address, CheckResult, Hex32, ISODateTime, ReasonCode, UUID, Verdict } from "@symbolon/schemas";
import type { DecisionSummary } from "./context";
import { err, ok } from "./result";
import type { Result } from "./result";

export interface Evaluation {
  readonly verdict: Verdict;
  /** In evaluation order; fewer than all when K-01 rejected (SCHEMA_INVALID) or K-04 returned REPLAY. */
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
  readonly invoiceReceivedAt: ISODateTime | null;
  /** The original decision when verdict = REPLAY (docs/04 K-04), else null. */
  readonly replayOf: DecisionSummary | null;
  readonly contextHash: Hex32 | null;
  readonly policyHash: Hex32 | null;
  readonly kernelVersion: string;
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
