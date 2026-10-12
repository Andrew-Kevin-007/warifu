// Shared fixtures for kernel-core tests (not a test file). Everything is built from real components:
// real termsHash (computeTermsHash), real intentId preimage, real policy loader (@symbolon/policy), real hashes.
// The base world passes K-01..K-08; each test breaks exactly one thing (and keeps a positive control).
import { normalizePolicy } from "@symbolon/policy";
import type { LoadedPolicy } from "@symbolon/policy";
import {
  computeTermsHash,
  deriveEntityId,
  deriveMilestoneId,
  isChecksumAddress,
  keccak256Utf8,
  untrusted,
} from "@symbolon/schemas";
import type { CheckId, Engagement, Hex32, Milestone, PaymentTerms } from "@symbolon/schemas";
import { expect } from "vitest";
import type { DecisionSummary, Evaluation, KernelContext } from "../src/index";
import { KERNEL_PIPELINE } from "../src/index";
import { PENDING_CHECKS } from "../src/checks/pending";
import { runPipeline } from "../src/pipeline";
import type { PipelineConfig } from "../src/pipeline";

// EIP-55 test vectors (checksummed).
export const PAYEE = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed";
export const ATTACKER = "0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359";
export const OWNER = "0xdbF03B407c01E7cD3CBea99509d93f8DDDC8C6FB";
export const VAULT = "0xD1220A0cf47c7B9Be7A2E6BA89F429762e7b9aDb";
for (const a of [PAYEE, ATTACKER, OWNER, VAULT]) if (!isChecksumAddress(a)) throw new Error(`fixture address not EIP-55: ${a}`);

export const TENANT = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
export const OTHER_TENANT = "9b2c1d3e-5f60-4a71-8b92-a3b4c5d6e7f8";
export const DOCUMENT_ID = "6fa459ea-ee8a-4ca4-894e-db77e160355e";
export const ENGAGEMENT_ID = deriveEntityId({ tenantId: TENANT, slug: "edith-site" });
export const M1 = deriveMilestoneId({ tenantId: TENANT, uuid: "1b4e28ba-2fa1-41d2-883f-0016d3cca427" });
export const M2 = deriveMilestoneId({ tenantId: TENANT, uuid: "2c5f39cb-3fb2-42e3-994a-1127e4ddb538" });
export const H = (label: string): Hex32 => keccak256Utf8(label);

export const NOW = "2026-10-05T12:00:00Z";
export const RECEIVED = "2026-10-05T10:00:00Z";
export const START = "2026-10-01T00:00:00Z";
export const END = "2026-12-31T23:59:59Z";

/** 1,000.000000 USDC */
export const GROSS = 1_000_000_000n;
export const CAP = 3_000_000_000n;

export const TWO_TEN_NET_30: PaymentTerms = { netDays: 30, earlyPay: { discountBps: 200, withinDays: 10 }, payBeforeDueBufferHours: 24, allowImmediate: true };

export function policy(overrides: Record<string, unknown> = {}): LoadedPolicy {
  return normalizePolicy({
    version: 1,
    tenant: "edith-studio",
    currency: { code: "USDC", decimals: 6, treatUsdAsUsdc: true },
    caps: { perTxHardCap: "2000", dailyCap: "5000", weeklyCap: "10000", humanApprovalAbove: "1500" },
    categories: { design: "5000", dev: "5000" },
    ...overrides,
  });
}

export function milestone(id: Hex32, slug: string, over: Partial<Milestone> = {}): Milestone {
  return {
    milestoneId: id,
    slug,
    description: `${slug} milestone`,
    amountBaseUnits: GROSS.toString(),
    partialAllowed: false,
    immediate: false,
    dueDate: null,
    category: "design",
    evidenceSpec: [{ type: "OWNER_ACK" }],
    status: "PENDING",
    ...over,
  };
}

/** A signed, ACTIVE engagement whose termsHash is recomputed from its contents. */
export function engagement(over: Partial<Engagement> = {}): Engagement {
  const base: Engagement = {
    engagementId: ENGAGEMENT_ID,
    tenantId: TENANT,
    owner: OWNER,
    payee: PAYEE,
    payeeLabel: "Acme Design",
    currency: "USDC",
    currencyDecimals: 6,
    capBaseUnits: CAP.toString(),
    start: START,
    end: END,
    sequential: false,
    milestones: [milestone(M1, "design"), milestone(M2, "build")],
    paymentTerms: null,
    termsHash: H("placeholder"),
    ownerSig: `0x${"11".repeat(65)}`,
    payeeSig: `0x${"22".repeat(65)}`,
    nonce: "1",
    status: "ACTIVE",
    registeredTx: H("registered-tx"),
    ...over,
  };
  return { ...base, termsHash: over.termsHash ?? computeTermsHash(base) };
}

export const DOC_TEXT = "INVOICE INV-0042\nAcme Design\nWebsite design milestone\nTotal: 1,000.00 USDC\n";
export const DOC_HASH = H("raw document bytes INV-0042");

export function extraction(over: Record<string, unknown> = {}) {
  return {
    docType: "INVOICE",
    invoiceNumber: "INV-0042",
    issueDate: "2026-10-04",
    dueDate: null,
    payee: { legalName: "Acme Design", walletAddress: PAYEE as string | null, claimsAddressChange: false },
    amount: { printed: "1,000.00", currencyPrinted: "USDC", decimalSeparatorGuess: ".", parsedBaseUnits: "1000000000" as string | null, decimals: 6 as number | null },
    references: { engagementId: null, milestoneId: null, poNumber: null } as Record<string, string | null>,
    statedTerms: { raw: null, netDays: null, earlyPay: null, ambiguous: false } as Record<string, unknown>,
    lineItems: [{ description: "Website design", amountPrinted: "1,000.00" as string | null }],
    anomalies: [] as Array<{ code: string; quote: string }>,
    confidence: 0.93,
    ...over,
  };
}

export type RawExtraction = ReturnType<typeof extraction>;

export function intent(over: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    tenantId: TENANT,
    documentId: DOCUMENT_ID,
    docHash: DOC_HASH,
    extraction: {
      a: extraction(),
      b: extraction({ confidence: 0.88 }) as RawExtraction | null,
      modelA: "claude-sonnet-5-5",
      modelB: "claude-haiku-5-5" as string | null,
      promptHashA: H("prompt A"),
      promptHashB: H("prompt B") as string | null,
    },
    consensus: { status: "AGREE", diffs: [] as unknown[] },
    engagementId: ENGAGEMENT_ID as string | null,
    milestoneId: M1 as string | null,
    timingProposal: null as unknown,
    planSelection: null as unknown,
    agentRecommendation: null as unknown,
    submittedAt: "2026-10-05T10:05:00Z",
    ...over,
  };
}

export type RawIntent = ReturnType<typeof intent>;

/** Make intent single-extraction (b null), keeping the schema's SINGLE iff b === null rule. */
export function single(i: RawIntent): RawIntent {
  return { ...i, extraction: { ...i.extraction, b: null, modelB: null, promptHashB: null }, consensus: { status: "SINGLE", diffs: [] } };
}

export function context(over: Partial<KernelContext> = {}): KernelContext {
  const e = over.engagement === undefined ? engagement() : over.engagement;
  return {
    now: NOW,
    tenantId: TENANT,
    vaultAddress: VAULT,
    chainId: 31337,
    chain: { tokenAddress: OWNER, tokenDecimals: 6, vaultTokenDecimals: 6 },
    engagement: e,
    engagementOnChain:
      e === null ? null : { engagementId: e.engagementId, payee: e.payee, capBaseUnits: BigInt(e.capBaseUnits), start: e.start, end: e.end, termsHash: e.termsHash, active: true },
    milestone: e === null ? null : (e.milestones.find((m) => m.milestoneId === M1) ?? null),
    priorDecisions: [],
    released: { engagementTotal: 0n, tenantDay: 0n, tenantWeek: 0n, payeeDay: 0n, payeeCountDay: 0, tenantCountDay: 0, categoryMonth: {} },
    evidence: [],
    ownerApproval: null,
    screening: null,
    balances: { vaultAvailable: 10_000_000_000n, pendingReleases: 0n, obligations14d: 0n },
    payeeHistory: { priorPayments: 0, onTime: 0, disputes: 0 },
    doc: { hash: DOC_HASH, normalizedHash: keccak256Utf8(DOC_TEXT), normalizedText: untrusted(DOC_TEXT), zeroWidthCount: 0 },
    invoiceReceivedAt: RECEIVED,
    paymentTerms: e === null ? null : e.paymentTerms,
    escalations: { today: 0, todayByEngagement: {} },
    profile: "production",
    breaker: { halted: false, reason: null },
    payeeChangePending: false,
    reevaluation: null,
    planningAsOf: null,
    ...over,
  };
}

/** A context whose document text is `text` (hash kept consistent). */
export function withDoc(ctx: KernelContext, text: string): KernelContext {
  return { ...ctx, doc: { ...ctx.doc, normalizedText: untrusted(text), normalizedHash: keccak256Utf8(text) } };
}

export function summary(over: Partial<DecisionSummary> = {}): DecisionSummary {
  return {
    decisionId: "0c1d2e3f-4a5b-4c6d-8e7f-8091a2b3c4d5",
    intentId: H("some other intent"),
    verdict: "HOLD",
    docHash: H("another document"),
    engagementId: ENGAGEMENT_ID,
    milestoneId: M2,
    payee: PAYEE,
    normInvoiceNo: "INV0099",
    amountBaseUnits: 5_000_000n,
    releaseAmountBaseUnits: null,
    createdAt: "2026-09-01T00:00:00Z",
    ...over,
  };
}

export const PHASE_A_IDS: readonly CheckId[] = ["K-01", "K-02", "K-03", "K-04", "K-05", "K-06", "K-07", "K-08"];

/** The real K-01..K-08 stages with the real aggregation, without the WP-05 placeholders. */
export const PHASE_A: PipelineConfig = {
  pre: [],
  stages: KERNEL_PIPELINE.stages.filter((s) => !PENDING_CHECKS.includes(s.id)),
  required: PHASE_A_IDS,
};

export function phaseA(raw: unknown, ctx: KernelContext = context(), p: LoadedPolicy = policy()): Evaluation {
  return runPipeline(PHASE_A, raw, ctx, p);
}

export function check(e: Evaluation, id: CheckId) {
  const c = e.checks.find((x) => x.id === id);
  if (c === undefined) throw new Error(`no result for ${id}`);
  return c;
}

/** Assert one check's outcome (status/onFail/code). */
export function expectCheck(e: Evaluation, id: CheckId, onFail: "REJECT" | "ESCALATE" | "HOLD" | null, code: string | null): void {
  const c = check(e, id);
  expect({ id: c.id, status: c.status, onFail: c.onFail, code: c.code }).toEqual({ id, status: onFail === null ? "PASS" : "FAIL", onFail, code });
}

export function clone<T>(x: T): T {
  return structuredClone(x);
}
