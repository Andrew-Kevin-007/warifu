// Deterministic sample objects shared by the vector builder (scripts/build-vectors.ts) and the unit tests.
// Hand-written FIXTURE data: the amounts, plans and certificate numbers are illustrative inputs for
// canonicalization/hash/digest vectors. They are not computed by packages/terms or bounds.ts and are
// not claims about anything (AGENTS.md §0.7, §0.9). Addresses are the EIP-55 spec examples; there are no keys.
import {
  computeCertHash,
  computeReceiptHash,
  computeTermsHash,
  computeTypedDataHash,
  derivePlanId,
  deriveEntityId,
  deriveIntentId,
  deriveMilestoneId,
  epochSecondsFromIso,
  formatBaseUnits,
  hashJcs,
  keccak256Utf8,
  paymentTermsHash,
  sanitizeLlmText,
  sha256Utf8,
  symbolonDomain,
  toTypedDataJson,
  untrusted,
  type Address,
  type ApprovalView,
  type ChallengeScenario,
  type ChallengeStats,
  type Decision,
  type Engagement,
  type ExtractedInvoice,
  type FeasiblePlan,
  type LossBoundCertificate,
  type Milestone,
  type PaymentIntent,
  type PaymentTerms,
  type PlanEvaluation,
  type PlanSelection,
  type Policy,
  type Receipt,
  type ReceiptDecision,
  type ReplayBundle,
  type SignedReceipt,
} from "../src/index";

// --- identities (EIP-55 spec examples; nobody holds these keys for us) -------------------------------
export const TENANT_ID = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
export const OWNER: Address = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed";
export const PAYEE: Address = "0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359";
export const VAULT: Address = "0xdbF03B407c01E7cD3CBea99509d93f8DDDC8C6FB";
export const NEW_PAYEE: Address = "0xD1220A0cf47c7B9Be7A2E6BA89F429762e7b9aDb";
export const TOKEN: Address = "0x52908400098527886E0F7030069857D2E4169EE7";
export const KERNEL_SIGNER: Address = "0x8617E340B3D01FA5F11F306F4090FD50E238070D";
/** anvil's chain id: the vectors are about encoding, not about a particular network. */
export const CHAIN_ID = 31337;
export const DOMAIN = symbolonDomain(CHAIN_ID, VAULT);

// --- engagement ------------------------------------------------------------------------------------
export const ENGAGEMENT_ID = deriveEntityId({ tenantId: TENANT_ID, slug: "acme-site-redesign" });
export const MILESTONE_ID = deriveMilestoneId({ tenantId: TENANT_ID, uuid: "3f2504e0-4f89-41d3-9a0c-0305e82c3301" });
export const MILESTONE2_ID = deriveMilestoneId({ tenantId: TENANT_ID, uuid: "16fd2706-8baf-433b-82eb-8c7fada847da" });

export const TERMS_EARLY_PAY: PaymentTerms = {
  netDays: 30,
  earlyPay: { discountBps: 200, withinDays: 10 },
  payBeforeDueBufferHours: 24,
  allowImmediate: false,
};
export const TERMS_NET_ONLY: PaymentTerms = { netDays: 30, earlyPay: null, payBeforeDueBufferHours: 24, allowImmediate: false };

export const MILESTONES: Milestone[] = [
  {
    milestoneId: MILESTONE_ID,
    slug: "design",
    description: "Homepage and pricing page design, 3 review rounds",
    amountBaseUnits: "1500000000",
    partialAllowed: false,
    immediate: false,
    dueDate: "2026-11-01T00:00:00Z",
    category: "design",
    evidenceSpec: [{ type: "OWNER_ACK" }, { type: "ARTIFACT_HASH", sha256: sha256Utf8("design-v3.fig") }],
    status: "PENDING",
  },
  {
    milestoneId: MILESTONE2_ID,
    slug: "build",
    description: "Next.js build — deploy to staging (ünïcödé, 中文, 😀)",
    amountBaseUnits: "3500000000",
    partialAllowed: true,
    immediate: false,
    dueDate: null,
    category: "engineering",
    evidenceSpec: [
      { type: "CI_PASS", repo: "acme/site", ref: "main", workflow: "ci.yml" },
      { type: "URL_HEALTH", url: "https://staging.acme.example/health", expectStatus: 200 },
    ],
    status: "PENDING",
  },
];

function engagementWith(paymentTerms: PaymentTerms | null): Engagement {
  const base = {
    engagementId: ENGAGEMENT_ID,
    tenantId: TENANT_ID,
    owner: OWNER,
    payee: PAYEE,
    payeeLabel: "Acme Design Studio",
    currency: "USDC" as const,
    currencyDecimals: 6,
    capBaseUnits: "5000000000",
    start: "2026-10-01T00:00:00Z",
    end: "2026-12-31T23:59:59Z",
    sequential: true,
    milestones: MILESTONES,
    paymentTerms,
    nonce: "1",
  };
  return {
    ...base,
    termsHash: computeTermsHash(base),
    ownerSig: null,
    payeeSig: null,
    status: "DRAFT",
    registeredTx: null,
  };
}

export const ENGAGEMENT_EARLY_PAY = engagementWith(TERMS_EARLY_PAY);
export const ENGAGEMENT_NET_ONLY = engagementWith(TERMS_NET_ONLY);

// --- document, extraction, intent ----------------------------------------------------------------
export const RECEIVED_AT = "2026-10-05T10:15:00Z";
export const NORMALIZED_TEXT = "INVOICE INV-2026-0042\nAcme Design Studio Ltd\nTotal: 1,500.00 USDC\nTerms: 2/10 net 30";
export const DOC_HASH = keccak256Utf8(`%PDF-fixture\n${NORMALIZED_TEXT}`);

export const EXTRACTION_A: ExtractedInvoice = {
  docType: "INVOICE",
  invoiceNumber: untrusted("INV-2026-0042"),
  issueDate: "2026-10-05",
  dueDate: "2026-11-04",
  payee: { legalName: untrusted("Acme Design Studio Ltd"), walletAddress: PAYEE, claimsAddressChange: false },
  amount: {
    printed: untrusted("1,500.00"),
    currencyPrinted: untrusted("USDC"),
    decimalSeparatorGuess: ".",
    parsedBaseUnits: "1500000000",
    decimals: 6,
  },
  references: { engagementId: untrusted(ENGAGEMENT_ID), milestoneId: null, poNumber: untrusted("PO-778") },
  statedTerms: { raw: untrusted("2/10 net 30"), netDays: 30, earlyPay: { discountBps: 200, withinDays: 10 }, ambiguous: false },
  lineItems: [{ description: untrusted("Design, 3 rounds"), amountPrinted: untrusted("1,500.00") }],
  anomalies: [],
  confidence: 0.92,
};
/** Same facts, different (informational) confidence: consensus must say AGREE. */
export const EXTRACTION_B: ExtractedInvoice = { ...EXTRACTION_A, confidence: 0.88 };

export const PROMPT_HASH_A = keccak256Utf8("prompt:extract:v1:a");
export const PROMPT_HASH_B = keccak256Utf8("prompt:extract:v1:b");

export const INTENT_ID = deriveIntentId({
  engagementId: ENGAGEMENT_ID,
  milestoneId: MILESTONE_ID,
  normInvoiceNo: "INV20260042",
  amountBaseUnits: "1500000000",
  payee: PAYEE,
});

export const PAY_AT = "2026-10-12T09:00:00Z";
export const FEASIBLE_PLAN: FeasiblePlan = {
  planId: derivePlanId({ intentId: INTENT_ID, mode: "TAKE_DISCOUNT", payAt: PAY_AT }),
  mode: "TAKE_DISCOUNT",
  payAt: PAY_AT,
  amountDue: "1470000000",
  discountValue: "30000000",
  impliedAprBps: 3724,
  liquidityAfter: "8530000000",
  reserveFloorOk: true,
  windowEnd: "2026-10-15T10:15:00Z",
};
export const PLAN_EVALUATION: PlanEvaluation = {
  plans: [{ planId: FEASIBLE_PLAN.planId, netBenefitBase: "27000000", regretBase: "0" }],
  topPlanId: FEASIBLE_PLAN.planId,
  costOfCapitalBps: 800,
};
export const PLAN_SELECTION: PlanSelection = {
  planId: FEASIBLE_PLAN.planId,
  rationale: untrusted("Discount window open; reserve floor holds."),
  factorsConsidered: ["discount_window", "liquidity"],
  riskFlags: [],
  deviatesFromEvaluator: false,
  deviationReason: null,
};

export const PAYMENT_INTENT: PaymentIntent = {
  schemaVersion: 1,
  tenantId: TENANT_ID,
  documentId: "0f8fad5b-d9cb-469f-a165-70867728950e",
  docHash: DOC_HASH,
  extraction: {
    a: EXTRACTION_A,
    b: EXTRACTION_B,
    modelA: "fixture-model-a",
    modelB: "fixture-model-b",
    promptHashA: PROMPT_HASH_A,
    promptHashB: PROMPT_HASH_B,
  },
  consensus: { status: "AGREE", diffs: [] },
  engagementId: ENGAGEMENT_ID,
  milestoneId: MILESTONE_ID,
  timingProposal: null,
  planSelection: PLAN_SELECTION,
  agentRecommendation: { verdict: "RELEASE", reasons: [untrusted("Evidence complete; discount window open")] },
  submittedAt: "2026-10-05T10:15:05Z",
};

// --- policy ------------------------------------------------------------------------------------------
export const POLICY: Policy = {
  version: 1,
  tenant: "acme",
  currency: { code: "USDC", decimals: 6, treatUsdAsUsdc: true },
  caps: { perTxHardCap: "2000.000000", dailyCap: "5000.000000", weeklyCap: "15000.000000", humanApprovalAbove: "1000.000000" },
  velocity: { maxReleasesPerDay: 10, maxReleasesPerPayeePerDay: 3, maxAmountPerPayeePerDay: "4000.000000" },
  newPayee: { firstPaymentMax: "500.000000", alwaysHuman: true },
  categories: { design: "3000.000000", engineering: "8000.000000" },
  reserve: { floor: "1000.000000", lookaheadDays: 14 },
  timing: { disputeWindowHours: 24, payBeforeDueBufferHours: 24, allowImmediate: false, defaultNetDays: 30, windowSafetyMarginMinutes: 30 },
  treasury: { costOfCapitalBps: 800 },
  escalation: { maxPerDay: 5, maxPerEngagementPerDay: 2 },
  limits: { maxDocChars: 20000 },
  evidence: { freshnessHours: 72, allowOwnerOverride: true, urlAllowlist: ["https://staging.acme.example"] },
  extraction: { allowSingle: false },
  screening: { required: false, staleAfterHours: 24 },
  reconciliation: { ackWindowHours: 0.17 },
};
export const POLICY_HASH = hashJcs(POLICY);

// --- decision and receipts ------------------------------------------------------------------------
export const HUMAN_EXPLANATION = "Held for owner approval: 1,500.00 USDC is above the 1,000.00 USDC approval threshold.";

export const ESCALATION_DECISION: Decision = {
  decisionId: "9b2e4c1a-6d3f-4a8b-9c7e-1f2a3b4c5d6e",
  tenantId: TENANT_ID,
  intentId: INTENT_ID,
  verdict: "ESCALATE",
  checks: [
    { id: "K-01", name: "STRICT_SCHEMA", status: "PASS", onFail: null, code: null, detail: untrusted("ok"), refs: [] },
    {
      id: "K-12",
      name: "AUTHORITY_ENVELOPE",
      status: "FAIL",
      onFail: "ESCALATE",
      code: "HUMAN_REQUIRED",
      detail: untrusted("amount 1,500.00 > humanApprovalAbove 1,000.00"),
      refs: ["policy:caps.humanApprovalAbove"],
    },
  ],
  reasons: ["HUMAN_REQUIRED"],
  engagementId: ENGAGEMENT_ID,
  milestoneId: MILESTONE_ID,
  payee: PAYEE,
  amountBaseUnits: "1500000000",
  payAt: PAY_AT,
  timingSource: "AGENT",
  releaseAmountBaseUnits: "1470000000",
  planId: FEASIBLE_PLAN.planId,
  plannerFallback: false,
  invoiceReceivedAt: RECEIVED_AT,
  policyHash: POLICY_HASH,
  kernelVersion: "0.1.0",
  patternsVersion: "patterns-1",
  contextHash: keccak256Utf8("context:fixture"),
  agentRecommendation: PAYMENT_INTENT.agentRecommendation,
  humanExplanation: HUMAN_EXPLANATION,
  supersedes: null,
  createdAt: "2026-10-05T10:15:07Z",
};

export function receiptDecisionOf(d: Decision): ReceiptDecision {
  const { humanExplanation: _humanExplanation, ...rest } = d;
  return rest;
}

export const ESCALATION_RECEIPT: Receipt = {
  receiptVersion: 1,
  decision: receiptDecisionOf(ESCALATION_DECISION),
  // keccak256 of the explanation's UTF-8 bytes (docs/QUESTIONS.md, WP-01 "text hashes").
  humanExplanationHash: keccak256Utf8(HUMAN_EXPLANATION),
  inputs: {
    docHash: DOC_HASH,
    extractionHashA: hashJcs(EXTRACTION_A),
    extractionHashB: hashJcs(EXTRACTION_B),
    promptHashA: PROMPT_HASH_A,
    promptHashB: PROMPT_HASH_B,
    modelA: "fixture-model-a",
    modelB: "fixture-model-b",
    evidence: [{ evidenceId: "6ba7b810-9dad-41d1-80b4-00c04fd430c8", payloadHash: keccak256Utf8("evidence:owner-ack"), result: "PASS" }],
    engagementTermsHash: ENGAGEMENT_EARLY_PAY.termsHash,
    normalizedDocHash: keccak256Utf8(NORMALIZED_TEXT),
    paymentTermsHash: paymentTermsHash(TERMS_EARLY_PAY),
    planEvaluationHash: hashJcs(PLAN_EVALUATION),
    profile: "production",
  },
  issuedAt: "2026-10-05T10:15:07Z",
};
export const ESCALATION_RECEIPT_HASH = computeReceiptHash(ESCALATION_RECEIPT);

/** The final RELEASE receipt (after the owner approved), superseding the escalation decision. */
export const RELEASE_DECISION: Decision = {
  ...ESCALATION_DECISION,
  decisionId: "1b4e28ba-2fa1-41d2-883f-0016d3cca427",
  verdict: "RELEASE",
  checks: [
    { id: "K-01", name: "STRICT_SCHEMA", status: "PASS", onFail: null, code: null, detail: untrusted("ok"), refs: [] },
    { id: "K-12", name: "AUTHORITY_ENVELOPE", status: "PASS", onFail: null, code: null, detail: untrusted("owner approval verified"), refs: [] },
  ],
  reasons: [],
  humanExplanation: null,
  supersedes: ESCALATION_DECISION.decisionId,
  createdAt: "2026-10-12T09:00:03Z",
};
export const RELEASE_RECEIPT: Receipt = {
  ...ESCALATION_RECEIPT,
  decision: receiptDecisionOf(RELEASE_DECISION),
  humanExplanationHash: null,
  issuedAt: "2026-10-12T09:00:03Z",
};
export const RELEASE_RECEIPT_HASH = computeReceiptHash(RELEASE_RECEIPT);

// --- approval view (INV-20) ------------------------------------------------------------------------
export const APPROVAL_EXPIRES_AT = "2026-10-06T10:15:07Z";
const approvalTypedData = toTypedDataJson("OwnerApproval", DOMAIN, {
  intentId: INTENT_ID,
  receiptHash: ESCALATION_RECEIPT_HASH,
  amount: "1470000000",
  deadline: epochSecondsFromIso(APPROVAL_EXPIRES_AT).toString(),
});

export const APPROVAL_VIEW: ApprovalView = {
  intentId: INTENT_ID,
  receiptHash: ESCALATION_RECEIPT_HASH,
  engagementId: ENGAGEMENT_ID,
  milestoneId: MILESTONE_ID,
  payee: { address: PAYEE, label: "Acme Design Studio" },
  decimals: 6,
  grossBaseUnits: "1500000000",
  releaseBaseUnits: "1470000000",
  display: { gross: formatBaseUnits("1500000000", 6), release: formatBaseUnits("1470000000", 6) },
  diffVsEngagement: [{ field: "payee.legalName", expected: "Acme Design Studio", actual: untrusted("Acme Design Studio Ltd") }],
  reasons: ["HUMAN_REQUIRED"],
  planSummary: { planId: FEASIBLE_PLAN.planId, mode: "TAKE_DISCOUNT", payAt: PAY_AT, discountValue: "30000000" },
  expiresAt: APPROVAL_EXPIRES_AT,
  typedData: approvalTypedData,
  typedDataHash: computeTypedDataHash(approvalTypedData),
  advisory: { text: sanitizeLlmText("Vendor delivered on time twice before. Taking the 2% discount looks reasonable.") },
};

// --- Loss Bound Certificate (fixture numbers; NOT computed by bounds.ts) --------------------------
const HORIZONS: LossBoundCertificate["bounds"]["T3_ownerExposed"] = [
  { label: "1h", seconds: 3600, value: "2000000000", binding: ["daily"] },
  { label: "24h", seconds: 86400, value: "5000000000", binding: ["daily", "engagements"] },
];

const certificateBase: LossBoundCertificate = {
  schema: "lbc/1",
  algorithm: { id: "symbolon-bounds", version: "1.0.0", gitSha: "0b02ff9", detectionLatencySeconds: 300 },
  subject: { vault: VAULT, chainId: CHAIN_ID, token: TOKEN, tokenDecimals: 6 },
  asOf: { blockNumber: 1234567, blockHash: keccak256Utf8("block:fixture"), timestamp: 1791158400 },
  inputs: {
    configHash: keccak256Utf8("config:fixture"),
    engagementsDigest: keccak256Utf8("engagements:fixture"),
    policyHash: POLICY_HASH,
    balanceBaseUnits: "10000000000",
    limits: { perTxCap: "2000000000", dailyCap: "5000000000", hourlyCap: "0", humanThreshold: "1000000000", ringSize: 64 },
    sumRemainingBaseUnits: "5000000000",
    activeEngagements: 1,
  },
  bounds: {
    T1: { unauthorizedLoss: "0", assumes: ["A-EVID", "A-OWNER-KEY"], weakEvidenceExposure: "NOT_COMPUTED" },
    T2: { loss: "0", liveness: "censorable" },
    T3c: {
      perReleaseUnapproved: "1000000000",
      perDay: "5000000000",
      horizons: HORIZONS,
      timeToEmpty: { days: 2, limitedBy: "daily" },
      alarmed: { seconds: 300, value: "2000000000", assumes: ["A-MON"] },
    },
    T3_ownerExposed: HORIZONS,
  },
  assumptions: [
    { id: "A-EVID", text: "Fixture assumption text (evidence sources are honest)." },
    { id: "A-MON", text: "Fixture assumption text (monitoring alarms within the stated latency)." },
    { id: "A-OWNER-KEY", text: "Fixture assumption text (owner key not compromised)." },
  ],
  exclusions: [{ id: "X-FIXTURE", text: "Fixture exclusion text." }],
  notes: ["Fixture certificate for canonicalization vectors; numbers are not computed by bounds.ts."],
  validation: null,
  validity: { status: "UNVERIFIED", reasons: ["CODE_NOT_VALIDATED"], checkedAt: 1791158460, freshnessSeconds: 3600 },
  certHash: "0x0000000000000000000000000000000000000000000000000000000000000000",
};
export const CERTIFICATE: LossBoundCertificate = { ...certificateBase, certHash: computeCertHash(certificateBase) };
/** Same certificate, different verification result and a publisher signature: certHash must not change. */
export const CERTIFICATE_REVERIFIED: LossBoundCertificate = {
  ...CERTIFICATE,
  validity: { status: "STALE", reasons: ["CONFIG_CHANGED", "FRESHNESS_EXCEEDED"], checkedAt: 1791245000, freshnessSeconds: 3600 },
  publisher: { address: KERNEL_SIGNER, sig: `0x${"ab".repeat(65)}` },
};

// --- challenge / replay -----------------------------------------------------------------------------
export const SCENARIO: ChallengeScenario = {
  scenarioId: "S-A",
  title: "Fixture scenario",
  engagement: ENGAGEMENT_EARLY_PAY,
  milestones: MILESTONES,
  paymentTerms: TERMS_EARLY_PAY,
  policy: { caps: { perTxHardCap: "25.000000", dailyCap: "60.000000" } },
  clock: { mode: "fixed", start: "2026-10-05T10:00:00Z" },
  evidenceFixtures: [
    {
      fixtureId: "owner-ack-1",
      milestoneId: MILESTONE_ID,
      requirement: { type: "OWNER_ACK" },
      result: "PASS",
      payload: { ack: true },
      details: "fixture owner ack",
      availableAt: null,
    },
  ],
  groundTruth: {
    legitPayee: PAYEE,
    legitAmountByMilestone: { [MILESTONE_ID]: "1500000000" },
    allowedWindow: { start: "2026-10-05T10:15:00Z", end: "2026-11-04T10:15:00Z" },
  },
  oracleVersion: "oracle-v1",
};

export const STATS_EMPTY: ChallengeStats = {
  asOf: "2026-10-05T12:00:00Z",
  source: "recorded",
  attempts: { human: 0, distinctHuman: 0, house: 0, oneClick: 0 },
  outcomes: { RELEASE: 0, HOLD: 0, ESCALATE: 0, REJECT: 0, REPLAY: 0 },
  lossEvents: { total: 0, byPredicate: { O1: 0, O2: 0, O3: 0, O4: 0, O5: 0, O6: 0, O7: 0, O8: 0 } },
  benign: { n: 0, falseRejects: 0 },
  topReasonCodes: [],
  uniqueAttackers: 0,
  certifiedBoundBaseUnits: "5000000000",
  observedMaxLossBaseUnits: "0",
  upper95LossRate: null,
};

export const SIGNED_RELEASE_RECEIPT: SignedReceipt = {
  receipt: RELEASE_RECEIPT,
  receiptHash: RELEASE_RECEIPT_HASH,
  // Fixture bytes, not a real signature (WP-02 owns signing).
  signature: `0x${"cd".repeat(65)}`,
  signer: KERNEL_SIGNER,
};

const bundleBase: ReplayBundle = {
  version: 1,
  builtAt: "2026-10-05T12:00:00Z",
  gitSha: "0b02ff9",
  harnessVersions: { "attack-suite": "0.0.0" },
  attackMatrix: {},
  holdout: { seedHash: keccak256Utf8("holdout:fixture"), n: 0, losses: 0, upper95: 0 },
  scenarios: [SCENARIO],
  attempts: [],
  receipts: [SIGNED_RELEASE_RECEIPT],
  decisions: [RELEASE_DECISION],
  extractionOutputs: [],
  certificate: CERTIFICATE,
  txs: [],
  plannerReport: {},
  bundleHash: "0x0000000000000000000000000000000000000000000000000000000000000000",
};
export { bundleBase as REPLAY_BUNDLE_UNHASHED };
