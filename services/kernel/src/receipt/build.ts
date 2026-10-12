// Turn an Evaluation into a stored Decision and a signed Receipt (docs/04 s8, docs/05 s2). The kernel decided; this only
// assembles. Interim until packages/receipts (WP-02) ships its builder: the shapes are the frozen schemas-v1.0 ones and
// every object is re-parsed with its schema before it can be stored, so an inconsistent decision cannot be persisted.
//
//   receiptHash = keccak256(JCS(Receipt))          signature = EIP-712 Receipt(receiptHash,intentId,verdict,policyHash,issuedAt)
//
// Text hashes follow docs/QUESTIONS WP-01 item 2 (keccak256 of the UTF-8 bytes). An intent that did not even parse
// (K-01 SCHEMA_INVALID) still gets a receipt: its extraction inputs are recorded as the hash of the raw proposal and the
// model fields say "unparsed", never invented values.
import { privateKeyToAccount } from "viem/accounts";
import {
  DecisionSchema,
  PaymentIntentSchema,
  ReceiptSchema,
  VERDICT_CODE,
  computeReceiptHash,
  eip712Digest,
  epochSecondsFromIso,
  hashJcs,
  paymentTermsHash,
  symbolonDomain,
  toTypedDataJson,
} from "@symbolon/schemas";
import type { Decision, Hex32, ISODateTime, PaymentIntent, Receipt, UUID } from "@symbolon/schemas";
import { toJsonSafe } from "@symbolon/kernel-core";
import type { Evaluation, KernelContext } from "@symbolon/kernel-core";
import type { Secret } from "../secret";

/** The zero hash: used where the kernel could not compute a hash (the decision is then a fail-closed HOLD at best). */
export const ZERO_HASH: Hex32 = `0x${"0".repeat(64)}`;
/** Placeholder until WP-05 ships the versioned pattern list for K-11. */
export const PATTERNS_VERSION_PENDING = "pending-wp05";

export interface KernelSigner {
  readonly address: `0x${string}`;
  /** Sign a 32-byte EIP-712 digest (equivalent to signTypedData for the same typed data). */
  signDigest(digest: Hex32): Promise<`0x${string}`>;
}

export function createKernelSigner(privateKey: Secret): KernelSigner {
  const account = privateKeyToAccount(privateKey.reveal() as `0x${string}`);
  return {
    address: account.address,
    signDigest: (digest) => account.sign({ hash: digest }),
  };
}

export interface BuildInput {
  readonly evaluation: Evaluation;
  readonly ctx: KernelContext;
  /** The proposal exactly as received (untrusted JSON). */
  readonly rawIntent: unknown;
  readonly decisionId: UUID;
  readonly supersedes: UUID | null;
  readonly now: ISODateTime;
  readonly policyHash: Hex32;
}

export interface Built {
  readonly decision: Decision;
  readonly receipt: Receipt;
  readonly receiptHash: Hex32;
}

function safeHash(v: unknown): Hex32 {
  try {
    return hashJcs(toJsonSafe(v));
  } catch {
    return ZERO_HASH;
  }
}

export function buildDecisionAndReceipt(i: BuildInput): Built {
  const e = i.evaluation;
  const parsed = PaymentIntentSchema.safeParse(i.rawIntent);
  const intent: PaymentIntent | null = parsed.success ? parsed.data : null;

  const decision = DecisionSchema.parse({
    decisionId: i.decisionId,
    tenantId: i.ctx.tenantId,
    intentId: e.intentId,
    verdict: e.verdict,
    checks: e.checks,
    reasons: e.reasons,
    engagementId: e.engagementId,
    milestoneId: e.milestoneId,
    payee: e.payee,
    amountBaseUnits: e.amountBaseUnits,
    payAt: e.payAt,
    timingSource: null,
    releaseAmountBaseUnits: e.releaseAmountBaseUnits,
    planId: null,
    plannerFallback: false,
    invoiceReceivedAt: i.ctx.invoiceReceivedAt,
    policyHash: e.policyHash ?? i.policyHash,
    kernelVersion: e.kernelVersion,
    patternsVersion: PATTERNS_VERSION_PENDING,
    contextHash: e.contextHash ?? ZERO_HASH,
    agentRecommendation: intent?.agentRecommendation ?? null,
    humanExplanation: null,
    supersedes: i.supersedes,
    createdAt: i.now,
  });

  const { humanExplanation: _omit, ...receiptDecision } = decision;
  void _omit;
  const receipt = ReceiptSchema.parse({
    receiptVersion: 1,
    decision: receiptDecision,
    humanExplanationHash: null,
    inputs: {
      docHash: i.ctx.doc.hash,
      extractionHashA: intent === null ? safeHash(i.rawIntent) : hashJcs(toJsonSafe(intent.extraction.a)),
      extractionHashB: intent?.extraction.b == null ? null : hashJcs(toJsonSafe(intent.extraction.b)),
      promptHashA: intent?.extraction.promptHashA ?? ZERO_HASH,
      promptHashB: intent?.extraction.promptHashB ?? null,
      modelA: intent?.extraction.modelA ?? "unparsed",
      modelB: intent?.extraction.modelB ?? null,
      evidence: i.ctx.evidence.map((x) => ({ evidenceId: x.evidenceId, payloadHash: x.payloadHash, result: x.result })),
      engagementTermsHash: i.ctx.engagement?.termsHash ?? null,
      normalizedDocHash: i.ctx.doc.normalizedHash,
      paymentTermsHash: paymentTermsHash(i.ctx.paymentTerms),
      planEvaluationHash: null,
      profile: i.ctx.profile,
    },
    issuedAt: i.now,
  });
  return { decision, receipt, receiptHash: computeReceiptHash(receipt) };
}

/** The EIP-712 digest the kernel signs for a receipt: Receipt(receiptHash, intentId, verdict, policyHash, issuedAt). */
export function receiptDigest(built: Built, ctx: Pick<KernelContext, "chainId" | "vaultAddress">): Hex32 {
  const td = toTypedDataJson("Receipt", symbolonDomain(ctx.chainId, ctx.vaultAddress), {
    receiptHash: built.receiptHash,
    intentId: built.decision.intentId,
    verdict: String(VERDICT_CODE[built.decision.verdict]),
    policyHash: built.decision.policyHash,
    issuedAt: epochSecondsFromIso(built.receipt.issuedAt).toString(),
  });
  return eip712Digest(td);
}
