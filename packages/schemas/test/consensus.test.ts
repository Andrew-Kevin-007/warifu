import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { CONSENSUS_FIELDS, ConsensusResultSchema, consensus, inspectUntrusted, untrusted, type ExtractedInvoice } from "../src/index";
import { EXTRACTION_A, EXTRACTION_B, NEW_PAYEE } from "./fixtures";

const diffFields = (a: ExtractedInvoice, b: ExtractedInvoice | null) => consensus(a, b).diffs.map((d) => d.field);

describe("consensus(A, B) (docs/03 §4, K-10)", () => {
  it("compares exactly the fields docs/03 §4 lists", () => {
    // payee wallet, amount.printed, parsedBaseUnits, invoiceNumber, docType, references, statedTerms (netDays, earlyPay)
    expect([...CONSENSUS_FIELDS]).toEqual([
      "payee.walletAddress",
      "amount.printed",
      "amount.parsedBaseUnits",
      "invoiceNumber",
      "docType",
      "references.engagementId",
      "references.milestoneId",
      "references.poNumber",
      "statedTerms.netDays",
      "statedTerms.earlyPay",
    ]);
  });

  it("SINGLE when there is no second extraction", () => {
    expect(consensus(EXTRACTION_A, null)).toEqual({ status: "SINGLE", diffs: [] });
  });

  it("AGREE when only informational fields differ (confidence, line items, anomalies)", () => {
    const b: ExtractedInvoice = {
      ...EXTRACTION_B,
      lineItems: [],
      anomalies: [{ code: "OTHER", quote: untrusted("x") }],
      payee: { ...EXTRACTION_B.payee, legalName: untrusted("ACME") },
    };
    expect(consensus(EXTRACTION_A, b)).toEqual({ status: "AGREE", diffs: [] });
  });

  it("DISAGREE on a payee wallet change, with a field-level diff in JCS form", () => {
    const b: ExtractedInvoice = { ...EXTRACTION_B, payee: { ...EXTRACTION_B.payee, walletAddress: NEW_PAYEE } };
    const r = consensus(EXTRACTION_A, b);
    expect(r.status).toBe("DISAGREE");
    expect(r.diffs).toHaveLength(1);
    const [d] = r.diffs;
    expect(d?.field).toBe("payee.walletAddress");
    expect(inspectUntrusted(d!.a)).toBe(JSON.stringify(EXTRACTION_A.payee.walletAddress));
    expect(inspectUntrusted(d!.b)).toBe(JSON.stringify(NEW_PAYEE));
  });

  it("distinguishes null from the string \"null\"", () => {
    const b: ExtractedInvoice = { ...EXTRACTION_B, references: { ...EXTRACTION_B.references, milestoneId: untrusted("null") } };
    const [d] = consensus(EXTRACTION_A, b).diffs;
    expect(d?.field).toBe("references.milestoneId");
    expect(inspectUntrusted(d!.a)).toBe("null");
    expect(inspectUntrusted(d!.b)).toBe('"null"');
  });

  it("compares statedTerms.earlyPay structurally (key order does not matter, values do)", () => {
    const reordered: ExtractedInvoice = {
      ...EXTRACTION_B,
      statedTerms: { ...EXTRACTION_B.statedTerms, earlyPay: { withinDays: 10, discountBps: 200 } },
    };
    expect(consensus(EXTRACTION_A, reordered).status).toBe("AGREE");
    const changed: ExtractedInvoice = { ...EXTRACTION_B, statedTerms: { ...EXTRACTION_B.statedTerms, earlyPay: { discountBps: 300, withinDays: 10 } } };
    expect(diffFields(EXTRACTION_A, changed)).toEqual(["statedTerms.earlyPay"]);
  });

  it("is exact: no trimming, case folding or number parsing", () => {
    const spaced: ExtractedInvoice = { ...EXTRACTION_B, amount: { ...EXTRACTION_B.amount, printed: untrusted("1,500.00 ") } };
    const lower: ExtractedInvoice = { ...EXTRACTION_B, invoiceNumber: untrusted("inv-2026-0042") };
    expect(diffFields(EXTRACTION_A, spaced)).toEqual(["amount.printed"]);
    expect(diffFields(EXTRACTION_A, lower)).toEqual(["invoiceNumber"]);
  });

  it("reports every differing field, in CONSENSUS_FIELDS order", () => {
    const b: ExtractedInvoice = {
      ...EXTRACTION_B,
      docType: "CREDIT_NOTE",
      statedTerms: { ...EXTRACTION_B.statedTerms, netDays: 60 },
      amount: { ...EXTRACTION_B.amount, parsedBaseUnits: "15000000000" },
      payee: { ...EXTRACTION_B.payee, walletAddress: null },
    };
    expect(diffFields(EXTRACTION_A, b)).toEqual(["payee.walletAddress", "amount.parsedBaseUnits", "docType", "statedTerms.netDays"]);
  });

  it("is symmetric and its result always satisfies ConsensusResultSchema (property)", () => {
    const variant = fc.record({
      wallet: fc.constantFrom(EXTRACTION_A.payee.walletAddress, NEW_PAYEE, null),
      printed: fc.constantFrom("1,500.00", "1.500,00", "15,000.00"),
      parsed: fc.constantFrom("1500000000", "15000000000", null),
      netDays: fc.constantFrom(30, 45, null),
      po: fc.constantFrom("PO-778", "null", null),
    });
    const build = (v: { wallet: ExtractedInvoice["payee"]["walletAddress"]; printed: string; parsed: string | null; netDays: number | null; po: string | null }): ExtractedInvoice => ({
      ...EXTRACTION_A,
      payee: { ...EXTRACTION_A.payee, walletAddress: v.wallet },
      amount: { ...EXTRACTION_A.amount, printed: untrusted(v.printed), parsedBaseUnits: v.parsed },
      statedTerms: { ...EXTRACTION_A.statedTerms, netDays: v.netDays },
      references: { ...EXTRACTION_A.references, poNumber: v.po === null ? null : untrusted(v.po) },
    });
    fc.assert(
      fc.property(variant, variant, (va, vb) => {
        const a = build(va);
        const b = build(vb);
        const ab = consensus(a, b);
        const ba = consensus(b, a);
        expect(ConsensusResultSchema.safeParse(ab).success).toBe(true);
        expect(ab.status).toBe(ba.status);
        expect(ab.diffs.map((d) => [d.field, inspectUntrusted(d.a), inspectUntrusted(d.b)])).toEqual(
          ba.diffs.map((d) => [d.field, inspectUntrusted(d.b), inspectUntrusted(d.a)]),
        );
        expect(consensus(a, a).status).toBe("AGREE");
      }),
      { numRuns: 300 },
    );
  });
});
