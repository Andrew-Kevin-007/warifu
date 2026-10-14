// GET /intents/:id/approval-view (INV-20, WYSIWYS). WP-14: the view and its OwnerApproval typed data come from
// packages/receipts (`buildApprovalView`, whose `buildApprovalTypedData` is the only producer of OwnerApproval typed data);
// this module only gathers the kernel's numbers. The amounts come from the stored decision (kernel-computed); the payee
// label from the SIGNED engagement, never from the invoice. The view is parsed by ApprovalViewSchema inside receipts, which
// refuses any view whose typed data, display strings, hash or expiry disagree with its own fields.
import { buildApprovalView as buildView } from "@symbolon/receipts";
import { symbolonDomain } from "@symbolon/schemas";
import type { ApprovalView, Decision, Engagement, Hex32, ISODateTime } from "@symbolon/schemas";
import { ApiError } from "../errors";
import { plusSeconds } from "../time";

/** The approval is valid for ten minutes (the same lifetime as an attestation, docs/04 s5). */
export const APPROVAL_TTL_SECONDS = 600;

export interface ApprovalInput {
  readonly decision: Decision;
  readonly receiptHash: Hex32;
  readonly engagement: Engagement;
  readonly chainId: number;
  readonly vault: `0x${string}`;
  readonly now: ISODateTime;
  /** The scheduled plan, when the kernel chose one (stored with the decision). */
  readonly planSummary?: ApprovalView["planSummary"];
}

export function buildApprovalView(i: ApprovalInput): ApprovalView {
  const d = i.decision;
  if (d.verdict !== "ESCALATE") throw new ApiError("CONFLICT", "the decision is not awaiting an owner approval", { verdict: d.verdict });
  if (d.engagementId === null || d.milestoneId === null || d.payee === null || d.amountBaseUnits === null) {
    throw new ApiError("CONFLICT", "the decision is not bound to an engagement, milestone, payee and amount");
  }
  if (d.engagementId !== i.engagement.engagementId) throw new ApiError("CONFLICT", "the decision does not belong to this engagement");
  // The amount the owner signs is the amount that would be released. Without one the owner is never asked to sign a number
  // the kernel has not produced.
  if (d.releaseAmountBaseUnits === null) throw new ApiError("CONFLICT", "the kernel has not computed a release amount for this decision yet");
  const diffs: ApprovalView["diffVsEngagement"] = [];
  if (d.payee !== i.engagement.payee) diffs.push({ field: "payee", expected: i.engagement.payee, actual: d.payee as never });
  const milestone = i.engagement.milestones.find((m) => m.milestoneId === d.milestoneId);
  if (milestone !== undefined && milestone.amountBaseUnits !== d.amountBaseUnits) {
    diffs.push({ field: "grossAmount", expected: milestone.amountBaseUnits, actual: d.amountBaseUnits as never });
  }
  const r = buildView({
    intentId: d.intentId,
    receiptHash: i.receiptHash,
    engagementId: d.engagementId,
    milestoneId: d.milestoneId,
    payee: { address: i.engagement.payee, label: i.engagement.payeeLabel },
    decimals: i.engagement.currencyDecimals,
    grossBaseUnits: d.amountBaseUnits,
    releaseBaseUnits: d.releaseAmountBaseUnits,
    diffVsEngagement: diffs,
    reasons: d.reasons,
    planSummary: i.planSummary ?? null,
    expiresAt: plusSeconds(i.now, APPROVAL_TTL_SECONDS),
    advisory: null,
    domain: symbolonDomain(i.chainId, i.vault),
  });
  if (!r.ok) throw new ApiError("CONFLICT", "an approval view cannot be built for this decision", { code: r.error.code });
  return r.value;
}
