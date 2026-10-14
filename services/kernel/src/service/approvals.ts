// POST /approvals (docs/05 s4, INV-20, K-12): the owner's OwnerApproval signature for the escalation receipt they were shown.
//
// Accepted only when ALL of these hold; each is checked here and again by the kernel (gates.ts), which is what binds it:
//   - the intent's CURRENT decision is an ESCALATE whose receiptHash is the signed receiptHash (the pending ApprovalView)
//   - the signed amount is that decision's release amount (what the vault would send), never the gross
//   - the deadline is in the future and no later than the approval lifetime (APPROVAL_TTL_SECONDS)
//   - the signature verifies for the engagement OWNER under the tenant vault's EIP-712 domain (EOA ecrecover or ERC-1271,
//     the same rule the vault applies)
// Then the approval is stored (bound to that escalation decision) and the intent is evaluated again with it in context. A stored
// approval grants nothing by itself: the verdict still comes from evaluate().
import { buildApprovalTypedData } from "@symbolon/receipts";
import { EIP712_MESSAGE_SCHEMAS, HexBytesSchema, eip712Digest, epochSecondsFromIso, isoFromEpochSeconds, symbolonDomain } from "@symbolon/schemas";
import type { Decision, Hex32 } from "@symbolon/schemas";
import { z } from "zod";
import { APPROVAL_TTL_SECONDS } from "../approval/build";
import type { EngagementChain } from "../chain/engagement-chain";
import { resolveTenantVault } from "../context/build";
import * as base from "../db/repo";
import { ApiError } from "../errors";
import { insertApproval } from "../release/repo";
import { nowIso } from "../time";
import { contextFailure } from "./intents";
import { IntentNotFound } from "./intent-context";
import { reevaluateStored } from "./reeval";
import type { ReevalDeps } from "./reeval";

export interface ApprovalsDeps extends ReevalDeps {
  readonly engagementChain: Pick<EngagementChain, "isValidSignature">;
}

const ApprovalBodySchema = z.strictObject({
  intentId: EIP712_MESSAGE_SCHEMAS.OwnerApproval.shape.intentId,
  receiptHash: EIP712_MESSAGE_SCHEMAS.OwnerApproval.shape.receiptHash,
  amount: EIP712_MESSAGE_SCHEMAS.OwnerApproval.shape.amount,
  deadline: EIP712_MESSAGE_SCHEMAS.OwnerApproval.shape.deadline,
  signature: HexBytesSchema,
});

export interface ApprovalResult {
  readonly decision: Decision;
  readonly receiptHash: Hex32;
}

export async function submitApproval(d: ApprovalsDeps, tenantId: string, rawBody: unknown): Promise<ApprovalResult> {
  const parsed = ApprovalBodySchema.safeParse(rawBody);
  if (!parsed.success) throw new ApiError("BAD_REQUEST", "not a valid owner approval");
  const body = parsed.data;
  try {
    // --- stage 1: read-only checks and the (network) signature verification, outside any transaction ---
    const head = await base.getLatestStoredDecisionForIntent(d.db, tenantId, body.intentId);
    if (head === null) throw new ApiError("NOT_FOUND", "not found");
    const dec = head.decision;
    if (dec.verdict !== "ESCALATE") throw new ApiError("CONFLICT", "the decision is not awaiting an owner approval", { verdict: dec.verdict });
    if (head.receiptHash !== body.receiptHash) throw new ApiError("CONFLICT", "the approval is for a receipt that is no longer the pending one");
    if (dec.releaseAmountBaseUnits === null || dec.releaseAmountBaseUnits !== body.amount) throw new ApiError("CONFLICT", "the approval amount is not the amount the kernel would release");
    if (dec.engagementId === null) throw new ApiError("CONFLICT", "the decision is not bound to an engagement");
    const now = nowIso(d.clock);
    const nowSec = epochSecondsFromIso(now);
    const deadline = BigInt(body.deadline);
    if (deadline <= nowSec) throw new ApiError("CONFLICT", "the approval has expired");
    if (deadline > nowSec + BigInt(APPROVAL_TTL_SECONDS)) throw new ApiError("BAD_REQUEST", "the approval deadline is later than an approval may last");
    const engagement = await base.loadEngagement(d.db, tenantId, dec.engagementId);
    if (engagement === null) throw new ApiError("NOT_FOUND", "not found");
    const tv = await resolveTenantVault(d.db, tenantId, d.chain);
    const td = buildApprovalTypedData({
      intentId: body.intentId,
      receiptHash: body.receiptHash,
      releaseBaseUnits: body.amount,
      expiresAt: isoFromEpochSeconds(deadline),
      domain: symbolonDomain(tv.chainId, tv.vault),
    });
    if (!td.ok) throw new ApiError("BAD_REQUEST", "not a valid owner approval");
    if (!(await d.engagementChain.isValidSignature(engagement.owner, eip712Digest(td.value), body.signature as `0x${string}`))) {
      throw new ApiError("BAD_SIGNATURE", "the signature is not a valid owner approval for these terms");
    }

    // --- stage 2: store the approval and re-evaluate, atomically under the tenant lock ---
    const r = await reevaluateStored(d, tenantId, body.intentId, {
      action: "intent.approved",
      actor: `owner:${engagement.owner.toLowerCase()}`,
      heads: ["ESCALATE"],
      async prepare(q, current) {
        if (current.receiptHash !== body.receiptHash) throw new ApiError("CONFLICT", "the approval is for a receipt that is no longer the pending one");
        await insertApproval(q, {
          tenantId,
          intentId: body.intentId,
          receiptHash: body.receiptHash,
          decisionId: current.decision.decisionId,
          signer: engagement.owner,
          amount: body.amount,
          deadline: body.deadline,
          signature: body.signature,
        });
      },
    });
    if (r.recorded === null) throw new ApiError("CONFLICT", "the approval produced no new decision");
    return { decision: r.recorded.decision, receiptHash: r.recorded.receiptHash };
  } catch (e) {
    if (e instanceof IntentNotFound) throw new ApiError("NOT_FOUND", "not found");
    throw contextFailure(e, d.logger);
  }
}
