// GET /intents/:id/approval-view (INV-20, WYSIWYS). Interim builder until packages/receipts (WP-02) ships
// buildApprovalTypedData(): it uses only the frozen schema helpers, and the result is parsed by ApprovalViewSchema, which
// refuses any view whose typed data, display strings, hash or expiry disagree with the view's own fields. The numbers come
// from the stored decision (kernel-computed); the payee label from the SIGNED engagement, never from the invoice.
import {
  ApprovalViewSchema,
  computeTypedDataHash,
  epochSecondsFromIso,
  formatBaseUnits,
  symbolonDomain,
  toTypedDataJson,
} from "@symbolon/schemas";
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
}

export function buildApprovalView(i: ApprovalInput): ApprovalView {
  const d = i.decision;
  if (d.verdict !== "ESCALATE") throw new ApiError("CONFLICT", "the decision is not awaiting an owner approval", { verdict: d.verdict });
  if (d.engagementId === null || d.milestoneId === null || d.payee === null || d.amountBaseUnits === null) {
    throw new ApiError("CONFLICT", "the decision is not bound to an engagement, milestone, payee and amount");
  }
  if (d.engagementId !== i.engagement.engagementId) throw new ApiError("CONFLICT", "the decision does not belong to this engagement");
  // The amount the owner signs is the amount that would be released. Until K-14 computes it (WP-05) there is none, and a
  // view cannot be built: the owner is never asked to sign a number the kernel has not produced.
  if (d.releaseAmountBaseUnits === null) throw new ApiError("CONFLICT", "the kernel has not computed a release amount for this decision yet");
  const expiresAt = plusSeconds(i.now, APPROVAL_TTL_SECONDS);
  const decimals = i.engagement.currencyDecimals;
  const typedData = toTypedDataJson("OwnerApproval", symbolonDomain(i.chainId, i.vault), {
    intentId: d.intentId,
    receiptHash: i.receiptHash,
    amount: d.releaseAmountBaseUnits,
    deadline: epochSecondsFromIso(expiresAt).toString(),
  });
  const diffs: ApprovalView["diffVsEngagement"] = [];
  if (d.payee !== i.engagement.payee) diffs.push({ field: "payee", expected: i.engagement.payee, actual: d.payee as never });
  const milestone = i.engagement.milestones.find((m) => m.milestoneId === d.milestoneId);
  if (milestone !== undefined && milestone.amountBaseUnits !== d.amountBaseUnits) {
    diffs.push({ field: "grossAmount", expected: milestone.amountBaseUnits, actual: d.amountBaseUnits as never });
  }
  return ApprovalViewSchema.parse({
    intentId: d.intentId,
    receiptHash: i.receiptHash,
    engagementId: d.engagementId,
    milestoneId: d.milestoneId,
    payee: { address: i.engagement.payee, label: i.engagement.payeeLabel },
    decimals,
    grossBaseUnits: d.amountBaseUnits,
    releaseBaseUnits: d.releaseAmountBaseUnits,
    display: {
      gross: formatBaseUnits(d.amountBaseUnits, decimals),
      release: formatBaseUnits(d.releaseAmountBaseUnits, decimals),
    },
    diffVsEngagement: diffs,
    reasons: d.reasons,
    planSummary: null,
    expiresAt,
    typedData,
    typedDataHash: computeTypedDataHash(typedData),
    advisory: null,
  });
}
