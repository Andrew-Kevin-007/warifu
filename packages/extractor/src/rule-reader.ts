// The keyless reader: a deterministic, rule-based invoice reader with NO model and NO network (docs/03 "zero paid calls by default").
// It produces the same structure a model run does (an `ExtractedInvoice`), from the normalized text, so the kernel treats it exactly like any
// other advisory reading: it re-derives everything and trusts nothing (INV-8). It is deliberately conservative: when it cannot read a field
// unambiguously it leaves it null and raises an anomaly, which the kernel turns into a HOLD or an escalation, never a release. Every string
// copied out of the document is Untrusted (INV-15), and `amount.printed` is an exact substring of the normalized text.
//
// What it is NOT: a language model. It reads the common invoice shapes (labelled total, wallet line, invoice number, dates, stated terms) and
// the document-level risk signals (hidden characters, instruction phrases, address-change language) that the same package computes for the
// model path. Anything unusual is simply read less, which fails closed.
import { AddressSchema, inspectUntrusted, keccak256Utf8, untrusted } from "@symbolon/schemas";
import type { Address, ExtractedInvoice } from "@symbolon/schemas";
import { currencyAlternation } from "./currency";
import { parseAmountPrinted } from "./parse/amount";
import { parseStatedTerms } from "./parse/terms";
import { prepareDocument } from "./prepare";
import { computeDocSignals } from "./signals";

export const RULE_READER_ID = "rule-reader/1" as const;

export type RuleReadResult =
  | { readonly ok: true; readonly value: ExtractedInvoice; readonly readerId: typeof RULE_READER_ID }
  | { readonly ok: false; readonly code: "DOC_EMPTY" | "DOC_TOO_LARGE" | "NO_AMOUNT_FOUND"; readonly disposition: "ESCALATE" | "HOLD" };

const CUR = currencyAlternation();
// number with optional grouping, optional currency before or after. The whole match is the `printed` string (exact substring).
const AMOUNT_RE = new RegExp(`(?:(?:${CUR})[ \\u00a0]?)?\\d(?:[\\d.,\\u00a0\\u2009']*\\d)?(?:[ \\u00a0]?(?:${CUR}))?`, "g");
const TOTAL_LINE_RE = /(total\s*due|amount\s*due|balance\s*due|grand\s*total|total\s*amount|total|amount|payable|subtotal and total due)/i;
const WALLET_RE = /0x[0-9a-fA-F]{40}/g;
const ISO_DATE_RE = /\b(\d{4}-\d{2}-\d{2})\b/g;

/** EIP-55 checksum of a 0x address (keccak over the lowercase hex), or null if the input is not a valid 20-byte hex string. */
export function toChecksumAddress(raw: string): Address | null {
  if (!/^0x[0-9a-fA-F]{40}$/.test(raw)) return null;
  const lower = raw.slice(2).toLowerCase();
  const hash = keccak256Utf8(lower).slice(2);
  let out = "0x";
  for (let i = 0; i < lower.length; i++) out += Number.parseInt(hash[i] ?? "0", 16) >= 8 ? (lower[i] ?? "").toUpperCase() : (lower[i] ?? "");
  const parsed = AddressSchema.safeParse(out);
  return parsed.success ? parsed.data : null;
}

/** The address as the document printed it: an all-lowercase or all-uppercase print is checksummed; a mixed-case print must already be correct. */
function readAddress(candidate: string): Address | null {
  const hex = candidate.slice(2);
  const mixed = hex !== hex.toLowerCase() && hex !== hex.toUpperCase();
  if (mixed) {
    const p = AddressSchema.safeParse(candidate);
    return p.success ? p.data : null; // a wrong mixed-case checksum is a corrupted address: refuse it
  }
  return toChecksumAddress(candidate);
}

function pickAmount(text: string): string | null {
  const lines = text.split("\n");
  const totals = lines.filter((l) => TOTAL_LINE_RE.test(l) && /\d/.test(l));
  // the LAST labelled total line wins (a "subtotal" precedes the total); fall back to the last amount-looking token anywhere
  for (const pool of [totals.reverse(), lines.filter((l) => /\d/.test(l)).reverse()]) {
    for (const line of pool) {
      const hits = [...line.matchAll(AMOUNT_RE)].map((m) => m[0].trim()).filter((s) => s.length > 0 && /\d/.test(s));
      // skip dates, wallet fragments and plain small integers that are clearly not money (a bare 4-digit year, a "2/10" term)
      const money = hits.filter((h) => !/^\d{4}-\d{2}-\d{2}$/.test(h) && !/^0x/i.test(h));
      const withCurrency = money.find((h) => new RegExp(`(${CUR})`).test(h));
      const choice = withCurrency ?? money[money.length - 1];
      if (choice !== undefined && text.includes(choice)) return choice;
    }
  }
  return null;
}

function labelled(text: string, labels: RegExp, valueRe: RegExp): string | null {
  for (const line of text.split("\n")) {
    if (!labels.test(line)) continue;
    const m = valueRe.exec(line.slice((labels.exec(line)?.index ?? 0)));
    if (m?.[1] !== undefined) return m[1];
  }
  return null;
}

function firstDate(text: string, labelRe: RegExp): string | null {
  for (const line of text.split("\n")) {
    if (!labelRe.test(line)) continue;
    const m = [...line.matchAll(ISO_DATE_RE)][0];
    if (m?.[1] !== undefined) return m[1];
  }
  return null;
}

export function ruleRead(rawText: string): RuleReadResult {
  const prepared = prepareDocument(rawText);
  if (!prepared.ok) return { ok: false, code: prepared.error.code === "DOC_TOO_LARGE" ? "DOC_TOO_LARGE" : "DOC_EMPTY", disposition: "HOLD" };
  const doc = prepared.value;
  const text = inspectUntrusted(doc.normalized);
  const signals = computeDocSignals(doc);

  const printed = pickAmount(text);
  if (printed === null) return { ok: false, code: "NO_AMOUNT_FOUND", disposition: signals.anomalies.length > 0 || signals.scanError ? "ESCALATE" : "HOLD" };
  const parsed = parseAmountPrinted(printed, 6);
  const anomalies = [...signals.anomalies];
  if (parsed.kind !== "ok") anomalies.push({ code: "AMOUNT_AMBIGUOUS", quote: untrusted(printed.slice(0, 500)) });

  const wallets = [...text.matchAll(WALLET_RE)].map((m) => m[0]);
  const walletAddress = wallets.length === 0 ? null : readAddress(wallets[0] as string);
  if (wallets.length > 1 && new Set(wallets.map((w) => w.toLowerCase())).size > 1) anomalies.push({ code: "OTHER", quote: untrusted("more than one wallet address is printed") });
  if (wallets.length > 0 && walletAddress === null) anomalies.push({ code: "OTHER", quote: untrusted("a printed wallet address is not a valid checksummed address") });

  const terms = parseStatedTerms(text);
  if (terms.found) anomalies.push({ code: "TERMS_CLAIM", quote: untrusted((terms.raw ?? "").slice(0, 500)) });

  const lower = text.toLowerCase();
  const docType: ExtractedInvoice["docType"] = /credit\s*(note|memo)|refund due/.test(lower) ? "CREDIT_NOTE" : /\bstatement\b/.test(lower) && !/\binvoice\b/.test(lower) ? "STATEMENT" : /\binvoice\b|\bbill\b|\btotal due\b|amount due/.test(lower) ? "INVOICE" : "OTHER";

  const invoiceNumber = labelled(text, /(invoice|inv)\b/i, /(?:invoice|inv)\s*(?:no\.?|number|#)?\s*[:#]?\s*([A-Za-z0-9][A-Za-z0-9_/-]{1,40})/i) ?? "";
  const poNumber = labelled(text, /\bpo\b|purchase order/i, /(?:po|purchase order)\s*(?:no\.?|number|#)?\s*[:#]?\s*([A-Za-z0-9][A-Za-z0-9_/-]{1,40})/i);
  const legalName = labelled(text, /^(from|vendor|payee|supplier|bill(?:ed)? from)\b/i, /^(?:from|vendor|payee|supplier|bill(?:ed)? from)\s*[:-]\s*(.{1,120})$/i);

  const value: ExtractedInvoice = {
    docType,
    invoiceNumber: untrusted(invoiceNumber),
    issueDate: firstDate(text, /(issue|invoice)\s*date|date of issue|^date\b/i) as ExtractedInvoice["issueDate"],
    dueDate: firstDate(text, /due(\s*date)?/i) as ExtractedInvoice["dueDate"],
    payee: { legalName: legalName === null ? null : untrusted(legalName.trim()), walletAddress, claimsAddressChange: signals.claimsAddressChange },
    amount: {
      printed: untrusted(printed),
      currencyPrinted: untrusted(parsed.kind === "invalid" ? "" : (parsed.currency ?? "")),
      decimalSeparatorGuess: parsed.kind === "ok" ? parsed.decimalSeparator : parsed.kind === "ambiguous" ? "ambiguous" : "ambiguous",
      parsedBaseUnits: parsed.kind === "ok" ? parsed.baseUnits.toString() : null,
      decimals: parsed.kind === "ok" ? 6 : null,
    },
    references: { engagementId: null, milestoneId: null, poNumber: poNumber === null ? null : untrusted(poNumber) },
    statedTerms: { raw: terms.raw === null ? null : untrusted(terms.raw), netDays: terms.netDays, earlyPay: terms.earlyPay, ambiguous: terms.ambiguous },
    lineItems: [],
    anomalies,
    confidence: 0.5, // informational only; never used for release (INV-8)
  };
  return { ok: true, value, readerId: RULE_READER_ID };
}
