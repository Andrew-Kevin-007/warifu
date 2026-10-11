// Shared fixtures for pipeline tests. Addresses are the public EIP-55 test vectors (no real funds/keys).
import type { LlmRequest, LlmResponse, LlmToolCall } from "../src/llm/types";

export const PAYEE = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed";
export const ATTACKER = "0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359";

export const INVOICE_TEXT = `INVOICE
Invoice No. INV-1001
Date: 2026-10-01   Due: 2026-10-31
From: Acme Design Ltd
Pay to wallet: ${PAYEE}
Milestone: M-2 (landing page)
Total due: 1,000.00 USDC
Terms: 2/10 net 30
Thank you for your business.`;

type Json = Record<string, unknown>;

/** A wire-format ExtractedInvoice (plain JSON) matching INVOICE_TEXT; override pieces per test. */
export function goodExtraction(over: Json = {}): Json {
  return {
    docType: "INVOICE",
    invoiceNumber: "INV-1001",
    issueDate: "2026-10-01",
    dueDate: "2026-10-31",
    payee: { legalName: "Acme Design Ltd", walletAddress: PAYEE, claimsAddressChange: false },
    amount: { printed: "1,000.00", currencyPrinted: "USDC", decimalSeparatorGuess: ".", parsedBaseUnits: "1000000000", decimals: 6 },
    references: { engagementId: null, milestoneId: "M-2", poNumber: null },
    statedTerms: { raw: "2/10 net 30", netDays: 30, earlyPay: { discountBps: 200, withinDays: 10 }, ambiguous: false },
    lineItems: [{ description: "landing page", amountPrinted: null }],
    anomalies: [{ code: "TERMS_CLAIM", quote: "2/10 net 30" }],
    confidence: 0.9,
    ...over,
  };
}

export function submit(input: unknown, id = "call-1"): LlmResponse {
  return { toolCalls: [{ id, name: "submit_extraction", input }], text: null, usage: { tokensIn: 500, tokensOut: 200 } };
}

export function calls(...cs: LlmToolCall[]): LlmResponse {
  return { toolCalls: cs, text: null, usage: { tokensIn: 400, tokensOut: 50 } };
}

export const isA = (r: LlmRequest) => r.role === "extractor_a";
export const userText = (r: LlmRequest) => (r.messages[0]?.role === "user" ? r.messages[0].text : "");
