// Persist one kernel evaluation as a Decision + signed Receipt (+ audit row), inside the caller's transaction. Shared by
// POST /intents, the re-evaluation flows (plan selection, owner approval, HOLD re-checks) and the payAt scheduler, so every
// decision is written the same way: built and signed through packages/receipts (WP-02), never by hand.
import { randomUUID } from "node:crypto";
import type { Evaluation, KernelContext } from "@symbolon/kernel-core";
import type { Decision, Hex32, Receipt, UUID } from "@symbolon/schemas";
import type { Queryable } from "../db/pool";
import * as repo from "../db/repo";
import type { DecisionExtras, PlanSummary } from "../db/repo";
import type { Logger } from "../log";
import { buildDecisionAndReceipt, signBuilt } from "../receipt/build";
import type { KernelSigner } from "../receipt/build";

export interface Recorded {
  readonly decision: Decision;
  readonly receipt: Receipt;
  readonly receiptHash: Hex32;
  readonly signature: string;
  readonly signer: string;
}

export interface RecordInput {
  readonly q: Queryable;
  readonly signer: KernelSigner;
  readonly logger: Logger;
  readonly evaluation: Evaluation;
  readonly ctx: KernelContext;
  readonly rawIntent: unknown;
  readonly supersedes: UUID | null;
  readonly policyHash: Hex32;
  /** Audit action, e.g. "intent.decided", "intent.reevaluated", "release.toctou". */
  readonly action: string;
  readonly actor: string;
  readonly newId?: () => string;
}

/** The scheduled plan of an evaluation, for ApprovalView.planSummary (null when nothing is scheduled). */
export function planSummaryOf(e: Evaluation): PlanSummary | null {
  if (e.planId === null) return null;
  const p = e.plans.find((x) => x.planId === e.planId);
  return p === undefined ? null : { planId: p.planId, mode: p.mode, payAt: p.payAt, discountValue: p.discountValue };
}

export function extrasOf(e: Evaluation): DecisionExtras {
  return { approvableFindings: e.approvableFindings, planSummary: planSummaryOf(e) };
}

/** Build, sign and insert. The intent row must already exist. Throws (and the caller's transaction rolls back) on any refusal. */
export async function recordDecision(i: RecordInput): Promise<Recorded> {
  const now = i.ctx.now;
  const built = buildDecisionAndReceipt({
    evaluation: i.evaluation,
    ctx: i.ctx,
    rawIntent: i.rawIntent,
    decisionId: (i.newId ?? randomUUID)(),
    supersedes: i.supersedes,
    now,
    policyHash: i.policyHash,
  });
  const signed = await signBuilt(built, i.signer, i.ctx);
  await repo.insertDecision(i.q, signed.decision, extrasOf(i.evaluation));
  await repo.insertReceipt(i.q, { receiptHash: signed.receiptHash, decisionId: signed.decision.decisionId, receipt: signed.receipt, signature: signed.signature, signer: signed.signer });
  await repo.writeAudit(i.q, i.actor, i.action, {
    intentId: signed.decision.intentId,
    decisionId: signed.decision.decisionId,
    verdict: signed.decision.verdict,
    receiptHash: signed.receiptHash,
    supersedes: i.supersedes,
  });
  i.logger.info(i.action, {
    intentId: signed.decision.intentId,
    decisionId: signed.decision.decisionId,
    receiptHash: signed.receiptHash,
    tenantId: signed.decision.tenantId,
    verdict: signed.decision.verdict,
    count: signed.decision.checks.length,
  });
  return { decision: signed.decision, receipt: signed.receipt, receiptHash: signed.receiptHash, signature: signed.signature, signer: signed.signer };
}
