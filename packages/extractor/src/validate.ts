// Post-hoc validation and reconciliation of ONE model's extraction (docs/03 section 3, "validated post-hoc").
//
// Two kinds of outcome, both fail-safe:
//   * REJECT the whole output (SCHEMA_INVALID, FIELD_NOT_IN_DOCUMENT): a value the document does not print as a
//     WHOLE TOKEN (an address copied from read_context, an invoice number that is only a prefix of the printed
//     one, an amount that is a fragment of a larger number) means the model hallucinated or was steered. No intent
//     is created from it, but the document-level signals still travel with the failure.
//   * REDUCE: values that cannot be verified deterministically are nulled or flagged, and anomalies are only ever
//     ADDED. Nothing is filled in from the deterministic parsers: the model's `parsedBaseUnits` survives only if
//     parseAmountPrinted reproduces it exactly AND amount + currency + decimals check out together.
// Every check below is anchored: whole-token occurrence (token.ts) or exact equality; no bare `includes()`.
// The kernel re-derives every fact it relies on; this layer is defence in depth.
import { ExtractedInvoiceSchema, inspectUntrusted, jcs, untrusted, type ExtractedInvoice } from "@symbolon/schemas";
import { DEFAULT_PARSE_ELIGIBLE, isParseEligible } from "./currency";
import { parseAmountPrinted } from "./parse/amount";
import { parseStatedTerms } from "./parse/terms";
import type { PreparedDocument } from "./prepare";
import { computeDocSignals, type Anomaly, type DocSignals } from "./signals";
import { currenciesNextTo, occursAsCurrency, occursAsToken } from "./token";

export interface ValidationOptions {
  /** Token decimals for the document's currency (from chain/engagement context; V-04). */
  readonly decimals: number;
  /** Exact printed spellings for which base units may be emitted (default ["USDC"]); subset of the known list. */
  readonly parseEligibleCurrencies?: readonly string[];
}

export type ValidationFailure =
  | { readonly code: "SCHEMA_INVALID"; readonly paths: readonly string[] }
  | { readonly code: "FIELD_NOT_IN_DOCUMENT"; readonly field: string };

export interface Correction {
  readonly field: string;
  readonly reason:
    | "PARSED_BASE_UNITS_NOT_REPRODUCED"
    | "PARSED_BASE_UNITS_AMBIGUOUS"
    | "PARSED_BASE_UNITS_CURRENCY_OR_DECIMALS"
    | "SEPARATOR_GUESS_CORRECTED"
    | "STATED_TERMS_DISAGREE_WITH_READER"
    | "STATED_TERMS_UNVERIFIABLE"
    | "ADDRESS_CHANGE_FLAG_RAISED"
    | "ANOMALIES_ADDED";
}

export type ValidationResult =
  | { readonly ok: true; readonly extraction: ExtractedInvoice; readonly corrections: readonly Correction[]; readonly signals: DocSignals }
  | { readonly ok: false; readonly failure: ValidationFailure; readonly signals: DocSignals };

const MAX_ANOMALIES = 50;

export function validateExtraction(rawOutput: unknown, doc: PreparedDocument, options: ValidationOptions, signals: DocSignals = computeDocSignals(doc)): ValidationResult {
  const fail = (failure: ValidationFailure): ValidationResult => ({ ok: false, failure, signals });
  const parsed = ExtractedInvoiceSchema.safeParse(rawOutput);
  if (!parsed.success) return fail({ code: "SCHEMA_INVALID", paths: parsed.error.issues.slice(0, 10).map((i) => i.path.join(".")) });
  const x = parsed.data;
  const text = inspectUntrusted(doc.normalized);
  const printed = inspectUntrusted(x.amount.printed);
  const currency = inspectUntrusted(x.amount.currencyPrinted);
  const invNo = inspectUntrusted(x.invoiceNumber);
  const notIn = (field: string) => fail({ code: "FIELD_NOT_IN_DOCUMENT", field });

  // --- 1. whole-token occurrence rules (REJECT) -------------------------------------------------------------------
  if (!occursAsToken(text, printed)) return notIn("amount.printed");
  // The currency must be printed in the document exactly as given (case-sensitive, whole token: "USD" is not
  // found inside "USDC"). Whether it may produce base units is decided below by the closed parse-eligible list.
  if (currency.length > 0 && !occursAsCurrency(text, currency)) return notIn("amount.currencyPrinted");
  if (invNo.length > 0 && !occursAsToken(text, invNo)) return notIn("invoiceNumber");
  if (x.payee.walletAddress !== null && !occursAsToken(text, x.payee.walletAddress, true)) return notIn("payee.walletAddress");
  for (const k of ["engagementId", "milestoneId", "poNumber"] as const) {
    const v = x.references[k];
    if (v !== null && !occursAsToken(text, inspectUntrusted(v))) return notIn(`references.${k}`);
  }
  if (x.statedTerms.raw !== null && !occursAsToken(text, inspectUntrusted(x.statedTerms.raw))) return notIn("statedTerms.raw");

  const corrections: Correction[] = [];
  const modelAnomalies: Anomaly[] = [...x.anomalies];
  const extra: Anomaly[] = [];
  const hasAnomaly = (code: Anomaly["code"]) => [...modelAnomalies, ...signals.anomalies, ...extra].some((a) => a.code === code);
  const addAnomaly = (code: Anomaly["code"], quote: string) => extra.push({ code, quote: untrusted(quote.slice(0, 500)) });

  // --- 2. amount + currency + decimals, validated TOGETHER ---------------------------------------------------------
  const det = parseAmountPrinted(printed, options.decimals);
  let { parsedBaseUnits, decimals, decimalSeparatorGuess } = x.amount;
  if (parsedBaseUnits !== null) {
    let reason: Correction["reason"] | null = null;
    if (det.kind !== "ok" || det.baseUnits.toString() !== parsedBaseUnits) {
      reason = det.kind === "ambiguous" ? "PARSED_BASE_UNITS_AMBIGUOUS" : "PARSED_BASE_UNITS_NOT_REPRODUCED";
    } else {
      // The currency the amount is printed with: inside the printed string, or immediately next to it in the document.
      const printedCcy = det.currency;
      const neighbours = currenciesNextTo(text, printed);
      const currencyConsistent =
        isParseEligible(currency, options.parseEligibleCurrencies ?? DEFAULT_PARSE_ELIGIBLE) &&
        (printedCcy === null ? neighbours.has(currency) : printedCcy === currency) &&
        // no OTHER known currency is printed next to the same amount
        [...neighbours].every((n) => n === currency);
      if (!currencyConsistent || decimals !== options.decimals) reason = "PARSED_BASE_UNITS_CURRENCY_OR_DECIMALS";
    }
    if (reason !== null) {
      corrections.push({ field: "amount.parsedBaseUnits", reason });
      parsedBaseUnits = null;
      decimals = null;
      if (reason === "PARSED_BASE_UNITS_CURRENCY_OR_DECIMALS") addAnomaly("OTHER", `currency or decimals not verifiable: ${JSON.stringify(currency.slice(0, 32))}`);
      else if (!hasAnomaly("AMOUNT_AMBIGUOUS")) addAnomaly("AMOUNT_AMBIGUOUS", printed);
    }
  }
  if (det.kind === "ambiguous") {
    if (decimalSeparatorGuess !== "ambiguous") corrections.push({ field: "amount.decimalSeparatorGuess", reason: "SEPARATOR_GUESS_CORRECTED" });
    decimalSeparatorGuess = "ambiguous";
    if (!hasAnomaly("AMOUNT_AMBIGUOUS")) addAnomaly("AMOUNT_AMBIGUOUS", printed);
  } else if (det.kind === "ok" && decimalSeparatorGuess !== det.decimalSeparator) {
    corrections.push({ field: "amount.decimalSeparatorGuess", reason: "SEPARATOR_GUESS_CORRECTED" });
    decimalSeparatorGuess = det.decimalSeparator;
  }

  // --- 3. stated terms: cross-check with the deterministic reader (flag, never adopt) -------------------------------
  let statedTerms = x.statedTerms;
  const dt = parseStatedTerms(text);
  const sameEarly = (a: typeof statedTerms.earlyPay, b: typeof dt.earlyPay) => jcs(a) === jcs(b);
  if (dt.found) {
    const agree = statedTerms.netDays === dt.netDays && sameEarly(statedTerms.earlyPay, dt.earlyPay);
    if (!agree) {
      corrections.push({ field: "statedTerms", reason: "STATED_TERMS_DISAGREE_WITH_READER" });
      statedTerms = { raw: statedTerms.raw ?? (dt.raw === null ? null : untrusted(dt.raw)), netDays: dt.netDays, earlyPay: dt.earlyPay, ambiguous: true };
    } else {
      statedTerms = { ...statedTerms, raw: statedTerms.raw ?? (dt.raw === null ? null : untrusted(dt.raw)), ambiguous: statedTerms.ambiguous || dt.ambiguous };
    }
    if ((statedTerms.earlyPay !== null || dt.earlyPay !== null) && !hasAnomaly("TERMS_CLAIM")) addAnomaly("TERMS_CLAIM", dt.raw ?? "");
  } else if (statedTerms.netDays !== null || statedTerms.earlyPay !== null) {
    // The model reports terms the reader cannot confirm: keep them but mark them unverified.
    corrections.push({ field: "statedTerms", reason: "STATED_TERMS_UNVERIFIABLE" });
    statedTerms = { ...statedTerms, ambiguous: true };
    if (statedTerms.earlyPay !== null && !hasAnomaly("TERMS_CLAIM")) addAnomaly("TERMS_CLAIM", inspectUntrusted(statedTerms.raw ?? untrusted("")));
  }

  // --- 4. anomalies are only ever added; document signals come FIRST so the cap can never push them out ------------
  if (invNo.length === 0 && !hasAnomaly("MISSING_FIELD")) addAnomaly("MISSING_FIELD", "invoiceNumber");
  let claimsAddressChange = x.payee.claimsAddressChange;
  if (signals.claimsAddressChange && !claimsAddressChange) {
    claimsAddressChange = true;
    corrections.push({ field: "payee.claimsAddressChange", reason: "ADDRESS_CHANGE_FLAG_RAISED" });
  }
  const seen = new Set<string>();
  const anomalies: Anomaly[] = [];
  for (const a of [...signals.anomalies, ...extra, ...modelAnomalies]) {
    const key = `${a.code}|${inspectUntrusted(a.quote)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    anomalies.push(a);
  }
  anomalies.splice(MAX_ANOMALIES);
  if (anomalies.length > x.anomalies.length) corrections.push({ field: "anomalies", reason: "ANOMALIES_ADDED" });

  const extraction: ExtractedInvoice = {
    ...x,
    payee: { ...x.payee, claimsAddressChange },
    amount: { ...x.amount, parsedBaseUnits, decimals, decimalSeparatorGuess },
    statedTerms,
    anomalies,
  };
  // Re-validate what we are about to hand on (guards against a bug in the reconciliation above).
  const again = ExtractedInvoiceSchema.safeParse(extraction);
  if (!again.success) return fail({ code: "SCHEMA_INVALID", paths: again.error.issues.slice(0, 10).map((i) => i.path.join(".")) });
  return { ok: true, extraction: again.data, corrections, signals };
}
