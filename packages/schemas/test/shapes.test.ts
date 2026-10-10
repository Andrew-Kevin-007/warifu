import { describe, expect, it } from "vitest";
import {
  ApprovalViewSchema,
  ChallengeScenarioSchema,
  ChallengeStatsSchema,
  CheckResultSchema,
  DecisionSchema,
  DocumentSchema,
  EngagementSchema,
  EvidenceRequirementSchema,
  EvidenceSchema,
  ExtractedInvoiceSchema,
  FeasiblePlanSchema,
  LossBoundCertificateSchema,
  MAX_DOC_CHARS,
  PaymentIntentSchema,
  PaymentTermsSchema,
  PlanEvaluationSchema,
  PlanSelectionSchema,
  PolicySchema,
  ReceiptSchema,
  ReplayBundleSchema,
  computeBundleHash,
  computeCertHash,
  computeReceiptHash,
  computeTermsHash,
  computeTypedDataHash,
  deriveEntityId,
  hashJcs,
  paymentTermsHash,
  termsPreimage,
  toTypedDataJson,
  untrusted,
  verifyTermsHash,
  type ApprovalView,
  type Engagement,
} from "../src/index";
import {
  APPROVAL_VIEW,
  CERTIFICATE,
  CERTIFICATE_REVERIFIED,
  DOMAIN,
  ENGAGEMENT_EARLY_PAY,
  ENGAGEMENT_NET_ONLY,
  ESCALATION_DECISION,
  ESCALATION_RECEIPT,
  EXTRACTION_A,
  FEASIBLE_PLAN,
  MILESTONES,
  PAYMENT_INTENT,
  PLAN_EVALUATION,
  PLAN_SELECTION,
  POLICY,
  RELEASE_RECEIPT,
  REPLAY_BUNDLE_UNHASHED,
  SCENARIO,
  STATS_EMPTY,
  TENANT_ID,
  TERMS_EARLY_PAY,
  TERMS_NET_ONLY,
} from "./fixtures";

const ok = (schema: { safeParse: (v: unknown) => { success: boolean } }, v: unknown) => schema.safeParse(v).success;

describe("every fixture parses with its schema", () => {
  it.each([
    ["Engagement (earlyPay)", EngagementSchema, ENGAGEMENT_EARLY_PAY],
    ["Engagement (net only)", EngagementSchema, ENGAGEMENT_NET_ONLY],
    ["ExtractedInvoice", ExtractedInvoiceSchema, EXTRACTION_A],
    ["PaymentIntent", PaymentIntentSchema, PAYMENT_INTENT],
    ["FeasiblePlan", FeasiblePlanSchema, FEASIBLE_PLAN],
    ["PlanEvaluation", PlanEvaluationSchema, PLAN_EVALUATION],
    ["PlanSelection", PlanSelectionSchema, PLAN_SELECTION],
    ["Policy", PolicySchema, POLICY],
    ["Decision", DecisionSchema, ESCALATION_DECISION],
    ["Receipt (escalation)", ReceiptSchema, ESCALATION_RECEIPT],
    ["Receipt (release)", ReceiptSchema, RELEASE_RECEIPT],
    ["ApprovalView", ApprovalViewSchema, APPROVAL_VIEW],
    ["LossBoundCertificate", LossBoundCertificateSchema, CERTIFICATE],
    ["LossBoundCertificate (re-verified, with publisher)", LossBoundCertificateSchema, CERTIFICATE_REVERIFIED],
    ["ChallengeScenario", ChallengeScenarioSchema, SCENARIO],
    ["ChallengeStats", ChallengeStatsSchema, STATS_EMPTY],
    ["ReplayBundle", ReplayBundleSchema, REPLAY_BUNDLE_UNHASHED],
  ] as const)("%s", (_name, schema, value) => {
    const r = schema.safeParse(value);
    expect(r.error?.issues ?? []).toEqual([]);
  });

  it("schemas are strict: unknown keys are rejected everywhere", () => {
    expect(ok(EngagementSchema, { ...ENGAGEMENT_EARLY_PAY, extra: 1 })).toBe(false);
    expect(ok(ReceiptSchema, { ...ESCALATION_RECEIPT, inputs: { ...ESCALATION_RECEIPT.inputs, llmConfidence: 0.99 } })).toBe(false);
    expect(ok(PaymentTermsSchema, { ...TERMS_EARLY_PAY, earlyPay: { discountBps: 200, withinDays: 10, cap: "1" } })).toBe(false);
  });
});

describe("PaymentTerms (INV-19, docs/05 §2)", () => {
  it("bounds: discount 1..2000 bps, 0 < withinDays < netDays <= 365, integers only", () => {
    const early = (discountBps: number, withinDays: number, netDays = 30) => ({ ...TERMS_EARLY_PAY, netDays, earlyPay: { discountBps, withinDays } });
    expect(ok(PaymentTermsSchema, early(1, 1))).toBe(true);
    expect(ok(PaymentTermsSchema, early(2000, 29))).toBe(true);
    expect(ok(PaymentTermsSchema, early(0, 10))).toBe(false);
    expect(ok(PaymentTermsSchema, early(2001, 10))).toBe(false);
    expect(ok(PaymentTermsSchema, early(200, 30))).toBe(false);
    expect(ok(PaymentTermsSchema, early(200, 0))).toBe(false);
    expect(ok(PaymentTermsSchema, early(200.5, 10))).toBe(false);
    expect(ok(PaymentTermsSchema, { ...TERMS_NET_ONLY, netDays: 366 })).toBe(false);
    expect(ok(PaymentTermsSchema, { ...TERMS_NET_ONLY, payBeforeDueBufferHours: -1 })).toBe(false);
  });

  it("paymentTermsHash is null without terms and differs with/without earlyPay", () => {
    expect(paymentTermsHash(null)).toBeNull();
    expect(paymentTermsHash(TERMS_EARLY_PAY)).toBe(hashJcs(TERMS_EARLY_PAY));
    expect(paymentTermsHash(TERMS_EARLY_PAY)).not.toBe(paymentTermsHash(TERMS_NET_ONLY));
  });
});

describe("Engagement and termsHash (docs/05 §2)", () => {
  it("fixtures carry a correct termsHash, and earlyPay is inside the preimage", () => {
    expect(verifyTermsHash(ENGAGEMENT_EARLY_PAY)).toBe(true);
    expect(verifyTermsHash(ENGAGEMENT_NET_ONLY)).toBe(true);
    expect(ENGAGEMENT_EARLY_PAY.termsHash).not.toBe(ENGAGEMENT_NET_ONLY.termsHash);
    expect(termsPreimage(ENGAGEMENT_EARLY_PAY).paymentTerms).toEqual(TERMS_EARLY_PAY);
  });

  it("mutable state is outside the hash: status, signatures, registeredTx, milestone status", () => {
    const signed: Engagement = {
      ...ENGAGEMENT_EARLY_PAY,
      status: "ACTIVE",
      ownerSig: `0x${"11".repeat(65)}`,
      payeeSig: `0x${"22".repeat(65)}`,
      registeredTx: `0x${"33".repeat(32)}`,
      milestones: MILESTONES.map((m) => ({ ...m, status: "PAID" as const })),
    };
    expect(computeTermsHash(signed)).toBe(ENGAGEMENT_EARLY_PAY.termsHash);
    expect(verifyTermsHash(signed)).toBe(true);
  });

  it("every signed field is inside the hash", () => {
    const changed: Array<Partial<Engagement>> = [
      { payee: "0xD1220A0cf47c7B9Be7A2E6BA89F429762e7b9aDb" },
      { payeeLabel: "Acme Design Studio Ltd" },
      { capBaseUnits: "5000000001" },
      { end: "2027-01-01T00:00:00Z" },
      { sequential: false },
      { nonce: "2" },
      { paymentTerms: null },
      { milestones: [{ ...MILESTONES[0]!, evidenceSpec: [{ type: "OWNER_ACK" }] }, MILESTONES[1]!] },
      { milestones: [{ ...MILESTONES[0]!, amountBaseUnits: "1500000001" }, MILESTONES[1]!] },
    ];
    for (const patch of changed) {
      expect(computeTermsHash({ ...ENGAGEMENT_EARLY_PAY, ...patch }), JSON.stringify(patch)).not.toBe(ENGAGEMENT_EARLY_PAY.termsHash);
    }
  });

  it("rejects duplicate milestones, end < start, non-checksummed addresses and float amounts", () => {
    const dup = { ...ENGAGEMENT_EARLY_PAY, milestones: [MILESTONES[0]!, MILESTONES[0]!] };
    expect(ok(EngagementSchema, dup)).toBe(false);
    expect(ok(EngagementSchema, { ...ENGAGEMENT_EARLY_PAY, end: "2026-09-30T00:00:00Z" })).toBe(false);
    expect(ok(EngagementSchema, { ...ENGAGEMENT_EARLY_PAY, payee: ENGAGEMENT_EARLY_PAY.payee.toLowerCase() })).toBe(false);
    expect(ok(EngagementSchema, { ...ENGAGEMENT_EARLY_PAY, capBaseUnits: "5000.5" })).toBe(false);
    expect(ok(EngagementSchema, { ...ENGAGEMENT_EARLY_PAY, capBaseUnits: 5000000000 })).toBe(false);
  });

  it("evidence requirements: https only, no userinfo; CI repo is owner/name", () => {
    expect(ok(EvidenceRequirementSchema, { type: "URL_HEALTH", url: "http://a.example/", expectStatus: 200 })).toBe(false);
    expect(ok(EvidenceRequirementSchema, { type: "URL_HEALTH", url: "https://user:pw@a.example/", expectStatus: 200 })).toBe(false);
    expect(ok(EvidenceRequirementSchema, { type: "CI_PASS", repo: "acme", ref: "main" })).toBe(false);
    expect(ok(EvidenceRequirementSchema, { type: "SCREENSHOT" })).toBe(false);
  });

  it("deriveEntityId takes exactly one of slug | uuid", () => {
    expect(deriveEntityId({ tenantId: TENANT_ID, slug: "a" })).toBe(hashJcs({ slug: "a", tenantId: TENANT_ID }));
    expect(() => deriveEntityId({ tenantId: TENANT_ID, slug: "a", uuid: TENANT_ID } as unknown as { tenantId: string; slug: string })).toThrow();
    expect(() => deriveEntityId({ tenantId: "not-a-uuid", slug: "a" })).toThrow();
  });
});

describe("extraction, intent and evidence", () => {
  it("ExtractedInvoice: confidence in [0,1]; lone surrogates rejected", () => {
    expect(ok(ExtractedInvoiceSchema, { ...EXTRACTION_A, confidence: 1.5 })).toBe(false);
    expect(ok(ExtractedInvoiceSchema, { ...EXTRACTION_A, invoiceNumber: `INV${String.fromCharCode(0xd800)}` })).toBe(false);
  });

  it("PaymentIntent: SINGLE iff no second extraction, and b/modelB/promptHashB move together", () => {
    const single = { ...PAYMENT_INTENT, extraction: { ...PAYMENT_INTENT.extraction, b: null, modelB: null, promptHashB: null } };
    expect(ok(PaymentIntentSchema, single)).toBe(false); // consensus still says AGREE
    expect(ok(PaymentIntentSchema, { ...single, consensus: { status: "SINGLE", diffs: [] } })).toBe(true);
    expect(ok(PaymentIntentSchema, { ...PAYMENT_INTENT, extraction: { ...PAYMENT_INTENT.extraction, modelB: null } })).toBe(false);
    expect(ok(PaymentIntentSchema, { ...PAYMENT_INTENT, consensus: { status: "DISAGREE", diffs: [] } })).toBe(false);
  });

  it("PlanSelection: deviating from the evaluator needs a reason", () => {
    expect(ok(PlanSelectionSchema, { ...PLAN_SELECTION, deviatesFromEvaluator: true })).toBe(false);
    expect(ok(PlanSelectionSchema, { ...PLAN_SELECTION, deviatesFromEvaluator: true, deviationReason: untrusted("x") })).toBe(true);
  });

  it("Evidence: only kernel-collected evidence parses", () => {
    const ev = {
      evidenceId: "6ba7b810-9dad-41d1-80b4-00c04fd430c8",
      milestoneId: MILESTONES[0]!.milestoneId,
      type: "OWNER_ACK",
      collectedBy: "kernel",
      collectedAt: "2026-10-05T10:15:00Z",
      source: "fixture:owner-ack-1",
      payload: { ack: true },
      payloadHash: hashJcs({ ack: true }),
      result: "PASS",
      details: "ok",
    };
    expect(ok(EvidenceSchema, ev)).toBe(true);
    expect(ok(EvidenceSchema, { ...ev, collectedBy: "agent" })).toBe(false);
  });

  it("Document: normalized text is capped at MAX_DOC_CHARS (INV-23 keeps blobs opaque)", () => {
    const doc = {
      documentId: "0f8fad5b-d9cb-469f-a165-70867728950e",
      tenantId: TENANT_ID,
      rawHash: hashJcs("raw"),
      blobSha256: null,
      mime: "application/pdf",
      storageKey: null,
      normalizedText: "x".repeat(MAX_DOC_CHARS),
      normalizedHash: hashJcs("n"),
      zeroWidthCount: 0,
      receivedAt: "2026-10-05T10:15:00Z",
      createdAt: "2026-10-05T10:15:00Z",
    };
    expect(ok(DocumentSchema, doc)).toBe(true);
    expect(ok(DocumentSchema, { ...doc, normalizedText: "x".repeat(MAX_DOC_CHARS + 1) })).toBe(false);
  });
});

describe("decision and receipt", () => {
  it("CheckResult name must match its id", () => {
    const c = ESCALATION_DECISION.checks[1]!;
    expect(ok(CheckResultSchema, c)).toBe(true);
    expect(ok(CheckResultSchema, { ...c, name: "STRICT_SCHEMA" })).toBe(false);
  });

  it("Receipt.decision has no humanExplanation (only its hash)", () => {
    expect(ok(ReceiptSchema, { ...ESCALATION_RECEIPT, decision: ESCALATION_DECISION })).toBe(false);
  });

  it("receiptHash changes with any field and not with key order", () => {
    const h = computeReceiptHash(ESCALATION_RECEIPT);
    expect(computeReceiptHash({ ...ESCALATION_RECEIPT, inputs: { ...ESCALATION_RECEIPT.inputs, profile: "sandbox" } })).not.toBe(h);
    const reverseKeys = (v: unknown): unknown =>
      Array.isArray(v)
        ? v.map(reverseKeys)
        : v !== null && typeof v === "object"
          ? Object.fromEntries(Object.entries(v).reverse().map(([k, x]) => [k, reverseKeys(x)]))
          : v;
    const reordered = reverseKeys(ESCALATION_RECEIPT) as typeof ESCALATION_RECEIPT;
    expect(JSON.stringify(reordered)).not.toBe(JSON.stringify(ESCALATION_RECEIPT));
    expect(computeReceiptHash(reordered)).toBe(h);
    expect(computeReceiptHash(RELEASE_RECEIPT)).not.toBe(h);
  });

  it("Policy amounts are decimal strings, never numbers", () => {
    expect(ok(PolicySchema, { ...POLICY, caps: { ...POLICY.caps, dailyCap: 5000 } })).toBe(false);
    expect(ok(PolicySchema, { ...POLICY, caps: { ...POLICY.caps, dailyCap: "5e3" } })).toBe(false);
  });
});

describe("ApprovalView (INV-20): an inconsistent view does not parse", () => {
  const view = APPROVAL_VIEW;
  const withMessage = (patch: Partial<ApprovalView["typedData"]["message"]>): ApprovalView => {
    const typedData = toTypedDataJson("OwnerApproval", DOMAIN, { ...view.typedData.message, ...patch });
    return { ...view, typedData, typedDataHash: computeTypedDataHash(typedData) };
  };

  it("the signed amount must equal releaseBaseUnits", () => {
    expect(ok(ApprovalViewSchema, withMessage({ amount: "1500000000" }))).toBe(false);
  });

  it("the signed intent, receipt and deadline must equal the view's", () => {
    expect(ok(ApprovalViewSchema, withMessage({ intentId: `0x${"00".repeat(32)}` }))).toBe(false);
    expect(ok(ApprovalViewSchema, withMessage({ receiptHash: `0x${"00".repeat(32)}` }))).toBe(false);
    expect(ok(ApprovalViewSchema, withMessage({ deadline: "1" }))).toBe(false);
  });

  it("display strings must come from formatBaseUnits", () => {
    expect(ok(ApprovalViewSchema, { ...view, display: { ...view.display, release: "1,470" } })).toBe(false);
    expect(ok(ApprovalViewSchema, { ...view, display: { ...view.display, gross: "1,470.00" } })).toBe(false);
  });

  it("typedDataHash must be keccak256(JCS(typedData))", () => {
    expect(ok(ApprovalViewSchema, { ...view, typedDataHash: `0x${"00".repeat(32)}` })).toBe(false);
  });

  it("typed data cannot redefine the struct or the domain", () => {
    const reordered = { ...view.typedData, types: { ...view.typedData.types, OwnerApproval: [...view.typedData.types.OwnerApproval].reverse() } };
    expect(ok(ApprovalViewSchema, { ...view, typedData: reordered, typedDataHash: computeTypedDataHash(reordered as typeof view.typedData) })).toBe(false);
    const otherName = { ...view.typedData, domain: { ...view.typedData.domain, name: "NotSymbolon" } };
    expect(ok(ApprovalViewSchema, { ...view, typedData: otherName })).toBe(false);
    const extraType = { ...view.typedData, types: { ...view.typedData.types, Evil: [{ name: "x", type: "uint256" }] } };
    expect(ok(ApprovalViewSchema, { ...view, typedData: extraType })).toBe(false);
  });
});

describe("certificate, challenge and replay bundle", () => {
  it("certHash ignores validity and publisher, and covers the bounds", () => {
    expect(computeCertHash(CERTIFICATE)).toBe(CERTIFICATE.certHash);
    expect(computeCertHash(CERTIFICATE_REVERIFIED)).toBe(CERTIFICATE.certHash);
    expect(computeCertHash({ ...CERTIFICATE, bounds: { ...CERTIFICATE.bounds, T2: { loss: "1", liveness: "censorable" } } })).not.toBe(CERTIFICATE.certHash);
  });

  it("LBC rejects unknown schema ids and money as numbers", () => {
    expect(ok(LossBoundCertificateSchema, { ...CERTIFICATE, schema: "lbc/2" })).toBe(false);
    expect(ok(LossBoundCertificateSchema, { ...CERTIFICATE, inputs: { ...CERTIFICATE.inputs, balanceBaseUnits: 10000000000 } })).toBe(false);
  });

  it("ChallengeStats: upper95LossRate is null until there is a human attempt", () => {
    expect(ok(ChallengeStatsSchema, { ...STATS_EMPTY, upper95LossRate: 0.03 })).toBe(true);
    expect(ok(ChallengeStatsSchema, { ...STATS_EMPTY, lossEvents: { ...STATS_EMPTY.lossEvents, byPredicate: { O1: 0 } } })).toBe(false);
  });

  it("bundleHash covers everything except itself", () => {
    const h = computeBundleHash(REPLAY_BUNDLE_UNHASHED);
    expect(computeBundleHash({ ...REPLAY_BUNDLE_UNHASHED, bundleHash: h })).toBe(h);
    expect(computeBundleHash({ ...REPLAY_BUNDLE_UNHASHED, txs: [h] })).not.toBe(h);
  });
});
