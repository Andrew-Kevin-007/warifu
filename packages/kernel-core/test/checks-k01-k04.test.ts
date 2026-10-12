// K-01..K-04 unit tests. Each guard has a negative case; the positive control is the base world (world.test.ts)
// plus the "control" cases below that change only the guarded property back.
import { describe, expect, it } from "vitest";
import { inspectUntrusted } from "@symbolon/schemas";
import type { CheckResult, PaymentIntent } from "@symbolon/schemas";
import { maxIntentChars } from "../src/index";
import { checkK02 } from "../src/checks/k02-precision";
import { checkK03 } from "../src/checks/k03-doctype";
import type { Facts } from "../src/facts";
import {
  ATTACKER,
  DOC_HASH,
  DOC_TEXT,
  M1,
  M2,
  OTHER_TENANT,
  PAYEE,
  clone,
  context,
  expectCheck,

  intent,
  phaseA,
  policy,
  single,
  summary,
  withDoc,
} from "./helpers";
import type { RawExtraction, RawIntent } from "./helpers";

const detail = (c: CheckResult | undefined) => inspectUntrusted((c as CheckResult).detail);

/** Set extraction A (and B, to keep consensus AGREE) fields. */
function both(i: RawIntent, f: (x: RawExtraction) => void): RawIntent {
  const out = clone(i);
  f(out.extraction.a);
  if (out.extraction.b !== null) f(out.extraction.b);
  return out;
}

describe("K-01 STRICT_SCHEMA", () => {
  const rejectsAndStops = (raw: unknown, ctx = context(), p = policy()) => {
    const e = phaseA(raw, ctx, p);
    expectCheck(e, "K-01", "REJECT", "SCHEMA_INVALID");
    expect(e.checks.map((c) => c.id)).toEqual(["K-01"]); // nothing downstream runs
    expect(e.verdict).toBe("REJECT");
    expect(e.intentIdBound).toBe(false);
    return e;
  };

  it("rejects an unknown top-level key, and does not echo the key in the detail", () => {
    const e = rejectsAndStops({ ...intent(), "<script>alert(1)</script>": true });
    expect(detail(e.checks[0])).toContain("unrecognized_keys");
    expect(detail(e.checks[0])).not.toContain("<script>");
  });

  it.each<[string, (i: RawIntent) => unknown]>([
    ["unknown nested key", (i) => both(i, (x) => Object.assign(x, { injected: 1 }))],
    ["fractional amount string", (i) => both(i, (x) => (x.amount.parsedBaseUnits = "1000.5"))],
    ["31-digit amount", (i) => both(i, (x) => (x.amount.parsedBaseUnits = "1".repeat(31)))],
    ["lowercase (non-EIP-55) address", (i) => both(i, (x) => (x.payee.walletAddress = PAYEE.toLowerCase()))],
    ["non-ISO date", (i) => ({ ...i, submittedAt: "2026-10-05 10:05" })],
    ["free text over its bound", (i) => both(i, (x) => (x.invoiceNumber = "N".repeat(129)))],
    ["confidence out of range", (i) => both(i, (x) => (x.confidence = 1.5))],
    ["SINGLE consensus with two extractions", (i) => ({ ...i, consensus: { status: "SINGLE", diffs: [] } })],
    ["not an object", () => "pay 1000 to 0xabc"],
    ["null", () => null],
    ["array", () => [intent()]],
  ])("rejects %s", (_label, mutate) => {
    rejectsAndStops(mutate(intent()));
  });

  it("rejects an intent for another tenant or another document", () => {
    rejectsAndStops({ ...intent(), tenantId: OTHER_TENANT });
    rejectsAndStops({ ...intent(), docHash: `0x${"ab".repeat(32)}` });
  });

  describe("INV-23: binary-looking payloads in any intent field", () => {
    it.each<[string, (i: RawIntent) => RawIntent]>([
      ["NUL in the invoice number", (i) => both(i, (x) => (x.invoiceNumber = "INV\u00000042"))],
      ["C0 control in the payee name", (i) => both(i, (x) => (x.payee.legalName = "Acme\u001bDesign"))],
      ["data: URI in a line item", (i) => both(i, (x) => (x.lineItems = [{ description: "logo data:image/png;base64,iVBORw0KGgo=", amountPrinted: "1,000.00" }]))],
      ["replacement-character run", (i) => both(i, (x) => (x.anomalies = [{ code: "OTHER", quote: "���" }]))],
      ["512-char encoded run in a rationale", (i) => ({ ...i, timingProposal: { payAt: "2026-10-06T00:00:00Z", rationale: "Q".repeat(512) } })],
    ])("%s", (_label, mutate) => {
      const e = rejectsAndStops(mutate(intent()));
      expect(detail(e.checks[0])).toMatch(/binary-looking payload \((NUL|CONTROL|DATA_URI|REPLACEMENT_RUN|ENCODED_RUN)\)/);
    });

    it("control: a 511-char run in the same field is accepted", () => {
      const e = phaseA({ ...intent(), timingProposal: { payAt: "2026-10-06T00:00:00Z", rationale: "Q".repeat(511) } });
      expectCheck(e, "K-01", null, null);
    });
  });

  it("rejects an oversize intent (relative to limits.maxDocChars), with a just-under control", () => {
    const p = policy({ limits: { maxDocChars: 1000 } }); // limit = 4*1000 + 16384 = 20384 JCS chars
    expect(maxIntentChars(1000)).toBe(20_384);
    const withItems = (n: number) =>
      both(intent(), (x) => (x.lineItems = Array.from({ length: n }, () => ({ description: "d".repeat(450), amountPrinted: null }))));
    expectCheck(phaseA(withItems(15), context(), p), "K-01", null, null);
    rejectsAndStops(withItems(25), context(), p);
  });

  describe("the kernel-stored document text", () => {
    it("is bounded by limits.maxDocChars", () => {
      const p = policy({ limits: { maxDocChars: 100 } });
      expectCheck(phaseA(intent(), withDoc(context(), "x".repeat(100)), p), "K-01", null, null);
      rejectsAndStops(intent(), withDoc(context(), "x".repeat(101)), p);
    });

    it("is at most 4,096 UTF-8 bytes in the sandbox profile (production control passes)", () => {
      const text = "é".repeat(2049); // 4,098 bytes, 2,049 chars
      expectCheck(phaseA(intent(), withDoc(context(), text)), "K-01", null, null);
      rejectsAndStops(intent(), { ...withDoc(context(), text), profile: "sandbox" });
      expectCheck(phaseA(intent(), { ...withDoc(context(), "é".repeat(2048)), profile: "sandbox" }), "K-01", null, null);
    });

    it.each([
      ["NUL", `${DOC_TEXT}\u0000`],
      ["data URI", `${DOC_TEXT}data:application/pdf;base64,JVBERi0xLjQ=`],
      ["embedded encoded blob", `${DOC_TEXT}${"A".repeat(600)}`],
    ])("refuses binary-looking content: %s", (_label, text) => {
      rejectsAndStops(intent(), withDoc(context(), text));
    });

    it("refuses a stored text that is not a string", () => {
      const ctx = context();
      rejectsAndStops(intent(), { ...ctx, doc: { ...ctx.doc, normalizedText: 42 as unknown as typeof ctx.doc.normalizedText } });
    });

    it("a stored-text hash mismatch is HOLD KERNEL_ERROR and does NOT short-circuit", () => {
      const ctx = context();
      const e = phaseA(intent(), { ...ctx, doc: { ...ctx.doc, normalizedHash: `0x${"00".repeat(32)}` } });
      expectCheck(e, "K-01", "HOLD", "KERNEL_ERROR");
      expect(e.checks).toHaveLength(8);
      expect(e.verdict).toBe("HOLD");
    });
  });
});

describe("K-02 PRECISION_EXACT", () => {
  const setAmount = (printed: string, parsed: string | null, decimals: number | null = 6) =>
    both(intent(), (x) => {
      x.amount.printed = printed;
      x.amount.parsedBaseUnits = parsed;
      x.amount.decimals = decimals;
      x.lineItems = [];
    });

  it.each([
    ["6.0000001", "6000000", "REFUSE_ROUND"],
    ["1e3", "1000000000", "SCIENTIFIC"],
    ["١٠٠٠", "1000000000", "NON_ASCII_DIGITS"],
  ])("%j -> REJECT %s", (printed, parsed, code) => {
    expectCheck(phaseA(setAmount(printed, parsed)), "K-02", "REJECT", code);
  });

  it("an ambiguous total escalates; the extractor's value is then only used for K-08", () => {
    const e = phaseA(setAmount("1,000", "1000000000"));
    expectCheck(e, "K-02", "ESCALATE", "AMOUNT_AMBIGUOUS");
    expectCheck(e, "K-08", null, null);
    expect(e.verdict).toBe("ESCALATE");
  });

  it("parsedBaseUnits null => ESCALATE AMOUNT_AMBIGUOUS", () => {
    expectCheck(phaseA(setAmount("1,000.00", null)), "K-02", "ESCALATE", "AMOUNT_AMBIGUOUS");
  });

  it("extractor decimals that differ from the declared decimals => EXTRACTION_PARSE_MISMATCH (null decimals is fine)", () => {
    expectCheck(phaseA(setAmount("1,000.00", "1000000000", 18)), "K-02", "ESCALATE", "EXTRACTION_PARSE_MISMATCH");
    expectCheck(phaseA(setAmount("1,000.00", "1000000000", null)), "K-02", null, null);
  });

  it("kernel parse != parsedBaseUnits => EXTRACTION_PARSE_MISMATCH ('6.000000' read as '6.00' class)", () => {
    expectCheck(phaseA(setAmount("1,000.00", "100000000")), "K-02", "ESCALATE", "EXTRACTION_PARSE_MISMATCH");
  });

  describe("line items (step 6)", () => {
    const items = (...printed: Array<string | null>) =>
      both(intent(), (x) => (x.lineItems = printed.map((p, i) => ({ description: `item ${i}`, amountPrinted: p }))));

    it("sum != total => LINEITEM_SUM_MISMATCH; equal sum passes", () => {
      expectCheck(phaseA(items("400.00", "500.00")), "K-02", "ESCALATE", "LINEITEM_SUM_MISMATCH");
      expectCheck(phaseA(items("400.00", "600.00")), "K-02", null, null);
    });

    it("a line item that is not exact => LINEITEM_SUM_MISMATCH", () => {
      expectCheck(phaseA(items("approx 1000")), "K-02", "ESCALATE", "LINEITEM_SUM_MISMATCH");
    });

    it("line items use the total's decimal separator as the document convention", () => {
      expectCheck(phaseA(items("1,000")), "K-02", null, null); // total "1,000.00" fixes '.' as decimal
      const integerTotal = both(items("1,000"), (x) => (x.amount.printed = "1000"));
      expectCheck(phaseA(integerTotal), "K-02", "ESCALATE", "LINEITEM_SUM_MISMATCH"); // no convention to apply
    });

    it("is skipped unless every line item has a printed amount", () => {
      expectCheck(phaseA(items("1.00", null)), "K-02", null, null);
      expectCheck(phaseA(items()), "K-02", null, null);
    });
  });

  it("an unknown parse kind fails closed (ESCALATE)", () => {
    const facts = { totalParse: { kind: "MAYBE" }, claimedGross: 1n, declaredDecimals: 6 } as unknown as Facts;
    expect(checkK02(intent() as unknown as PaymentIntent, facts)).toMatchObject({ status: "FAIL", onFail: "ESCALATE", code: "AMOUNT_AMBIGUOUS" });
  });
});

describe("K-03 DOC_TYPE_SIGN", () => {
  const docTypes = (a: string, b: string | null) => {
    const i = b === null ? single(intent()) : clone(intent());
    i.extraction.a.docType = a;
    if (b !== null && i.extraction.b !== null) i.extraction.b.docType = b;
    return i;
  };

  it.each<[string, string | null, "REJECT" | "ESCALATE" | null, string | null]>([
    ["INVOICE", "INVOICE", null, null],
    ["INVOICE", null, null, null],
    ["CREDIT_NOTE", "CREDIT_NOTE", "ESCALATE", "CREDIT_NOTE"],
    ["STATEMENT", "STATEMENT", "REJECT", "NOT_PAYABLE"],
    ["OTHER", null, "REJECT", "NOT_PAYABLE"],
    ["INVOICE", "CREDIT_NOTE", "ESCALATE", "CREDIT_NOTE"],
    ["INVOICE", "OTHER", "REJECT", "NOT_PAYABLE"],
    ["CREDIT_NOTE", "STATEMENT", "REJECT", "NOT_PAYABLE"],
  ])("A=%s B=%s -> %s %s", (a, b, onFail, code) => {
    expectCheck(phaseA(docTypes(a, b)), "K-03", onFail, code);
  });

  it("a zero amount is not payable", () => {
    const zero = both(intent(), (x) => {
      x.amount.printed = "0.00";
      x.amount.parsedBaseUnits = "0";
      x.lineItems = [];
    });
    expectCheck(phaseA(zero), "K-03", "REJECT", "NOT_PAYABLE");
  });

  it("an unknown docType fails closed (REJECT)", () => {
    const i = clone(single(intent()));
    i.extraction.a.docType = "RECEIPT";
    expect(checkK03(i as unknown as PaymentIntent, { gross: 1n } as Facts)).toMatchObject({ onFail: "REJECT", code: "NOT_PAYABLE" });
  });
});

describe("K-04 IDEMPOTENCY_DEDUPE", () => {
  const base = phaseA(intent());
  const myId = base.intentId;

  it("an invoice number that normalizes past 128 characters is refused", () => {
    const e = phaseA(both(intent(), (x) => (x.invoiceNumber = "ﬃ".repeat(43))));
    expectCheck(e, "K-04", "REJECT", "SCHEMA_INVALID");
    expect(e.intentIdBound).toBe(false);
  });

  it("exact intentId seen => REPLAY returning the prior decision, short-circuit, no reasons", () => {
    const prior = summary({ intentId: myId, verdict: "RELEASE", milestoneId: M1, docHash: DOC_HASH });
    const e = phaseA(intent(), context({ priorDecisions: [prior] }));
    expect(e.verdict).toBe("REPLAY");
    expect(e.replayOf).toEqual(prior);
    expect(e.reasons).toEqual([]);
    expect(e.checks.map((c) => c.id)).toEqual(["K-01", "K-02", "K-03", "K-04"]);
    expect(e.checks[3]).toMatchObject({ status: "FAIL", onFail: null, code: null, refs: [prior.decisionId] });
  });

  it("REPLAY returns the latest decision of the chain, independent of input order", () => {
    const older = summary({ intentId: myId, decisionId: "11111111-1111-4111-8111-111111111111", createdAt: "2026-10-01T00:00:00Z" });
    const newer = summary({ intentId: myId, decisionId: "22222222-2222-4222-8222-222222222222", createdAt: "2026-10-02T00:00:00Z" });
    const tieHigh = summary({ intentId: myId, decisionId: "33333333-3333-4333-8333-333333333333", createdAt: "2026-10-02T00:00:00Z" });
    for (const order of [[older, newer, tieHigh], [tieHigh, newer, older], [newer, tieHigh, older]]) {
      expect(phaseA(intent(), context({ priorDecisions: order })).replayOf).toEqual(tieHigh);
    }
  });

  it("during a TOCTOU re-evaluation the intent's own chain never REPLAYs", () => {
    const prior = summary({ intentId: myId, verdict: "RELEASE", milestoneId: M1, docHash: DOC_HASH });
    const reevaluation = { decisionId: prior.decisionId, intentId: myId, payAt: "2026-10-05T12:00:00Z", releaseAmountBaseUnits: 1_000_000_000n };
    const e = phaseA(intent(), context({ priorDecisions: [prior], reevaluation }));
    expectCheck(e, "K-04", null, null);
    expect(e.verdict).toBe("RELEASE");
  });

  it("a re-evaluation for a different intentId is a context fault (HOLD KERNEL_ERROR)", () => {
    const reevaluation = { decisionId: summary().decisionId, intentId: summary().intentId, payAt: "2026-10-05T12:00:00Z", releaseAmountBaseUnits: 1n };
    expectCheck(phaseA(intent(), context({ reevaluation })), "K-04", "HOLD", "KERNEL_ERROR");
  });

  it("same milestone already RELEASE under another intent => REJECT MILESTONE_ALREADY_PAID (ATK-20)", () => {
    const paid = summary({ verdict: "RELEASE", milestoneId: M1, normInvoiceNo: "INV0041" });
    const e = phaseA(intent(), context({ priorDecisions: [paid] }));
    expectCheck(e, "K-04", "REJECT", "MILESTONE_ALREADY_PAID");
    expect(e.checks[3]?.refs).toEqual([paid.decisionId]);
    // same invoice number but a different amount is still another intent on that milestone
    expectCheck(phaseA(intent(), context({ priorDecisions: [summary({ verdict: "RELEASE", milestoneId: M1, normInvoiceNo: "INV0042" })] })), "K-04", "REJECT", "MILESTONE_ALREADY_PAID");
    // controls: a non-RELEASE decision on the milestone, or a RELEASE on another milestone
    expectCheck(phaseA(intent(), context({ priorDecisions: [summary({ verdict: "HOLD", milestoneId: M1 })] })), "K-04", null, null);
    expectCheck(phaseA(intent(), context({ priorDecisions: [summary({ verdict: "RELEASE", milestoneId: M2, amountBaseUnits: 7n })] })), "K-04", null, null);
  });

  it("same document under another intent => ESCALATE DUPLICATE_DOC", () => {
    expectCheck(phaseA(intent(), context({ priorDecisions: [summary({ docHash: DOC_HASH })] })), "K-04", "ESCALATE", "DUPLICATE_DOC");
  });

  describe("near-duplicate: same payee and same gross within 7 days", () => {
    const near = (over: Parameters<typeof summary>[0]) =>
      phaseA(intent(), context({ priorDecisions: [summary({ payee: PAYEE, amountBaseUnits: 1_000_000_000n, milestoneId: M2, ...over })] }));

    it("escalates inside the window (both directions), inclusive at exactly 7 days", () => {
      expectCheck(near({ createdAt: "2026-10-04T12:00:00Z" }), "K-04", "ESCALATE", "NEAR_DUPLICATE");
      expectCheck(near({ createdAt: "2026-09-28T12:00:00Z" }), "K-04", "ESCALATE", "NEAR_DUPLICATE"); // exactly 7 d
      expectCheck(near({ createdAt: "2026-10-12T12:00:00Z" }), "K-04", "ESCALATE", "NEAR_DUPLICATE"); // future, 7 d
      expectCheck(near({ createdAt: "2026-10-04T12:00:00Z", payee: PAYEE.toLowerCase() as typeof PAYEE }), "K-04", "ESCALATE", "NEAR_DUPLICATE");
    });

    it("controls: outside 7 d, another amount, another or no payee, or the same milestone and invoice number", () => {
      expectCheck(near({ createdAt: "2026-09-28T11:59:59Z" }), "K-04", null, null);
      expectCheck(near({ createdAt: "2026-10-04T12:00:00Z", amountBaseUnits: 999_999_999n }), "K-04", null, null);
      expectCheck(near({ createdAt: "2026-10-04T12:00:00Z", payee: ATTACKER }), "K-04", null, null);
      expectCheck(near({ createdAt: "2026-10-04T12:00:00Z", payee: null }), "K-04", null, null);
      expectCheck(near({ createdAt: "2026-10-04T12:00:00Z", milestoneId: M1, normInvoiceNo: "INV0042" }), "K-04", null, null);
    });
  });

  it("reports the most severe finding and lists all of them", () => {
    const e = phaseA(intent(), context({ priorDecisions: [summary({ verdict: "RELEASE", milestoneId: M1, docHash: DOC_HASH })] }));
    expectCheck(e, "K-04", "REJECT", "MILESTONE_ALREADY_PAID");
    expect(detail(e.checks[3])).toContain("DUPLICATE_DOC");
  });

  it("an unbound intent (no engagement) passes K-04 but can never release (K-05 rejects)", () => {
    const e = phaseA({ ...intent(), engagementId: null });
    expectCheck(e, "K-04", null, null);
    expect(detail(e.checks[3])).toContain("unbound");
    expectCheck(e, "K-05", "REJECT", "NO_ENGAGEMENT");
    expect(e.intentIdBound).toBe(false);
  });
});
