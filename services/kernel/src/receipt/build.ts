// Turn an Evaluation into a stored Decision and a signed Receipt (docs/04 s8, docs/05 s2). The kernel decided; this only
// assembles. WP-14: the receipt itself is built and signed by packages/receipts (WP-02) -- `buildReceipt` (pure, re-parses with
// the frozen schemas, refuses an inconsistent RELEASE) and `signReceipt` (signs through the INJECTED ReceiptSigner, then
// self-verifies: wrong key, malleated or non-canonical signature => refused). Nothing here sees a private key except
// createKernelSigner(), which wraps the env-held key at the process edge (docs/06 B.3, V-02).
//
//   receiptHash = keccak256(JCS(Receipt))          signature = EIP-712 Receipt(receiptHash,intentId,verdict,policyHash,issuedAt)
//
// An intent that did not even parse (K-01 SCHEMA_INVALID) still gets a receipt: its extraction inputs are recorded as the
// hash of the raw proposal and the model fields say "unparsed", never invented values.
import { buildReceipt, signReceipt } from "@symbolon/receipts";
import type { ReceiptSigner } from "@symbolon/receipts";
import { DecisionSchema, PaymentIntentSchema, hashJcs, paymentTermsHash, symbolonDomain } from "@symbolon/schemas";
import type { Address, Decision, Hex32, ISODateTime, PaymentIntent, Receipt, UUID } from "@symbolon/schemas";
import { toJsonSafe } from "@symbolon/kernel-core";
import type { Evaluation, KernelContext } from "@symbolon/kernel-core";
import { privateKeyToAccount } from "viem/accounts";
import type { Secret } from "../secret";

/** The zero hash: used where the kernel could not compute a hash (the decision is then a fail-closed HOLD at best). */
export const ZERO_HASH: Hex32 = `0x${"0".repeat(64)}`;

/** The kernel signer: exactly packages/receipts' injected ReceiptSigner (address + signDigest over a 32-byte EIP-712 digest). */
export type KernelSigner = ReceiptSigner;

export function createKernelSigner(privateKey: Secret): KernelSigner {
  const account = privateKeyToAccount(privateKey.reveal() as `0x${string}`);
  return {
    address: account.address as Address,
    signDigest: (digest) => account.sign({ hash: digest }),
  };
}

/** A receipt could not be built or signed: nothing is stored (fail closed). The code is packages/receipts' error code. */
export class ReceiptError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = "ReceiptError";
    this.code = code;
  }
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

export interface SignedBuilt extends Built {
  readonly signature: `0x${string}`;
  readonly signer: Address;
}

function safeHash(v: unknown): Hex32 {
  try {
    return hashJcs(toJsonSafe(v));
  } catch {
    return ZERO_HASH;
  }
}

/** The Decision the service stores for an evaluation (decisionId, createdAt and supersedes are the service's). */
export function decisionFromEvaluation(i: BuildInput): Decision {
  const e = i.evaluation;
  const parsed = PaymentIntentSchema.safeParse(i.rawIntent);
  const intent: PaymentIntent | null = parsed.success ? parsed.data : null;
  return DecisionSchema.parse({
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
    timingSource: e.timingSource,
    releaseAmountBaseUnits: e.releaseAmountBaseUnits,
    planId: e.planId,
    plannerFallback: e.plannerFallback,
    invoiceReceivedAt: i.ctx.invoiceReceivedAt,
    policyHash: e.policyHash ?? i.policyHash,
    kernelVersion: e.kernelVersion,
    patternsVersion: e.patternsVersion,
    contextHash: e.contextHash ?? ZERO_HASH,
    agentRecommendation: intent?.agentRecommendation ?? null,
    humanExplanation: e.humanExplanation,
    supersedes: i.supersedes,
    createdAt: i.now,
  });
}

/** Receipt.inputs: what the kernel read (hashes and ids only; no invoice text, no LLM prose). */
export function receiptInputs(i: BuildInput): Receipt["inputs"] {
  const parsed = PaymentIntentSchema.safeParse(i.rawIntent);
  const intent: PaymentIntent | null = parsed.success ? parsed.data : null;
  return {
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
    planEvaluationHash: i.evaluation.planEvaluationHash,
    profile: i.ctx.profile,
  };
}

/** Decision + Receipt via packages/receipts buildReceipt. Throws ReceiptError (nothing is stored) when it refuses. */
export function buildDecisionAndReceipt(i: BuildInput): Built {
  const decision = decisionFromEvaluation(i);
  const r = buildReceipt(decision, receiptInputs(i), { issuedAt: i.now });
  if (!r.ok) throw new ReceiptError(r.error.code, r.error.message);
  return { decision, receipt: r.value.receipt, receiptHash: r.value.receiptHash };
}

/** Sign through the injected signer under the tenant vault's EIP-712 domain; refuses a signature that does not self-verify. */
export async function signBuilt(built: Built, signer: KernelSigner, ctx: Pick<KernelContext, "chainId" | "vaultAddress">): Promise<SignedBuilt> {
  const r = await signReceipt({ receipt: built.receipt, receiptHash: built.receiptHash }, signer, symbolonDomain(ctx.chainId, ctx.vaultAddress));
  if (!r.ok) throw new ReceiptError(r.error.code, r.error.message);
  return { ...built, signature: r.value.signature as `0x${string}`, signer: r.value.signer };
}
