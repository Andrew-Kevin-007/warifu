// Post-hoc validation and reconciliation of ONE model's extraction (docs/03 §3 "validated post-hoc").
//
// Two kinds of outcome, both fail-safe:
//   * REJECT the whole output (SCHEMA_INVALID, FIELD_NOT_IN_DOCUMENT): a value the document does not print
//     (an address copied from read_context, an invented invoice number, an amount that is not a substring)
//     means the model hallucinated or was steered; no intent is created from it.
//   * REDUCE: values that cannot be verified deterministically are nulled or flagged, and anomalies are only ever
//     ADDED (hidden characters, injection phrases, address-change language, terms claims). Nothing is filled in
//     from the deterministic parsers: the model's `parsedBaseUnits` survives only if parseAmountPrinted
//     reproduces it exactly. This is what keeps "confidently wrong" at zero (docs/03 §8).
// The kernel re-derives every fact it relies on; this layer is defence in depth.
import { ExtractedInvoiceSchema, inspectUntrusted, jcs, untrusted, type ExtractedInvoice, type Untrusted } from "@symbolon/schemas";
import { DEFAULT_USDC_ALIASES, isAcceptedCurrency, parseAmountPrinted } from "./parse/amount";
import { scanInjection } from "./parse/injection";
import { parseStatedTerms } from "./parse/terms";
import type { PreparedDocument } from "./prepare";

export interface ValidationOptions {
  /** Token decimals for the document's currency (from chain/engagement context; V-04). */
  readonly decimals: number;
  readonly usdcAliases?: readonly string[];
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
  | { readonly ok: true; readonly extraction: ExtractedInvoice; readonly corrections: readonly Correction[] }
  | { readonly ok: false; readonly failure: ValidationFailure };

type Anomaly = ExtractedInvoice["anomalies"][number];

const MAX_ANOMALIES = 50;

function has(text: string, needle: string, ci = false): boolean {
  return ci ? text.toLowerCase().includes(needle.toLowerCase()) : text.includes(needle);
}

export function validateExtraction(rawOutput: unknown, doc: PreparedDocument, options: ValidationOptions): ValidationResult {
  const parsed = ExtractedInvoiceSchema.safeParse(rawOutput);
  if (!parsed.success) {
    return { ok: false, failure: { code: "SCHEMA_INVALID", paths: parsed.error.issues.slice(0, 10).map((i) => i.path.join(".")) } };
  }
  const x = parsed.data;
  const text = inspectUntrusted(doc.normalized);
  const printed = inspectUntrusted(x.amount.printed);

  // --- 1. verbatim-substring rules (REJECT) -----------------------------------------------------------------
  const notIn = (field: string): ValidationResult => ({ ok: false, failure: { code: "FIELD_NOT_IN_DOCUMENT", field } });
  if (printed.length === 0 || !has(text, printed)) return notIn("amount.printed");
  const currency = inspectUntrusted(x.amount.currencyPrinted);
  if (currency.length > 0 && !has(text, currency, true)) return notIn("amount.currencyPrinted");
  const invNo = inspectUntrusted(x.invoiceNumber);
  if (invNo.length > 0 && !has(text, invNo)) return notIn("invoiceNumber");
  if (x.payee.walletAddress !== null && !has(text, x.payee.walletAddress, true)) return notIn("payee.walletAddress");
  for (const k of ["engagementId", "milestoneId", "poNumber"] as const) {
    const v = x.references[k];
    if (v !== null && !has(text, inspectUntrusted(v))) return notIn(`references.${k}`);
  }
  if (x.statedTerms.raw !== null && !has(text, inspectUntrusted(x.statedTerms.raw))) return notIn("statedTerms.raw");

  const corrections: Correction[] = [];
  const anomalies: Anomaly[] = [...x.anomalies];
  const hasAnomaly = (code: Anomaly["code"]) => anomalies.some((a) => a.code === code);
  const addAnomaly = (code: Anomaly["code"], quote: string) => {
    if (anomalies.length < MAX_ANOMALIES) anomalies.push({ code, quote: untrusted(quote.slice(0, 500)) });
  };

  // --- 2. amount: keep parsedBaseUnits only if the deterministic parser reproduces it ---------------------------
  const det = parseAmountPrinted(printed, options.decimals);
  let { parsedBaseUnits, decimals, decimalSeparatorGuess } = x.amount;
  if (parsedBaseUnits !== null) {
    const currencyOk = isAcceptedCurrency(currency, options.usdcAliases ?? DEFAULT_USDC_ALIASES) || (currency.length === 0 && /^\s*\$/.test(printed));
    if (det.kind !== "ok" || det.baseUnits.toString() !== parsedBaseUnits) {
      corrections.push({ field: "amount.parsedBaseUnits", reason: det.kind === "ambiguous" ? "PARSED_BASE_UNITS_AMBIGUOUS" : "PARSED_BASE_UNITS_NOT_REPRODUCED" });
      parsedBaseUnits = null;
      decimals = null;
      if (!hasAnomaly("AMOUNT_AMBIGUOUS")) addAnomaly("AMOUNT_AMBIGUOUS", printed);
    } else if (!currencyOk || decimals !== options.decimals) {
      corrections.push({ field: "amount.parsedBaseUnits", reason: "PARSED_BASE_UNITS_CURRENCY_OR_DECIMALS" });
      parsedBaseUnits = null;
      decimals = null;
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

  // --- 3. stated terms: cross-check with the deterministic reader (flag, never adopt) -------------------------
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
    if (statedTerms.earlyPay !== null || dt.earlyPay !== null) {
      if (!hasAnomaly("TERMS_CLAIM")) addAnomaly("TERMS_CLAIM", dt.raw ?? "");
    }
  } else if (statedTerms.netDays !== null || statedTerms.earlyPay !== null) {
    // The model reports terms the reader cannot confirm: keep them but mark them unverified.
    corrections.push({ field: "statedTerms", reason: "STATED_TERMS_UNVERIFIABLE" });
    statedTerms = { ...statedTerms, ambiguous: true };
    if (statedTerms.earlyPay !== null && !hasAnomaly("TERMS_CLAIM")) addAnomaly("TERMS_CLAIM", inspectUntrusted(statedTerms.raw ?? untrusted("")));
  }

  // --- 4. anomalies are only ever added ---------------------------------------------------------------------------
  const before = anomalies.length;
  if (doc.removedCount > 0) {
    const c = doc.counts;
    addAnomaly("HIDDEN_CHARS", `removed ${doc.removedCount} characters (control ${c.control}, zero-width ${c.zeroWidth}, bidi ${c.bidi}, invalid ${c.invalid})`);
  }
  if (invNo.length === 0 && !hasAnomaly("MISSING_FIELD")) addAnomaly("MISSING_FIELD", "invoiceNumber");
  let claimsAddressChange = x.payee.claimsAddressChange;
  for (const f of scanInjection(doc.normalized)) {
    if (!anomalies.some((a) => a.code === f.code && inspectUntrusted(a.quote) === inspectUntrusted(f.quote))) addAnomaly(f.code, inspectUntrusted(f.quote));
    if (f.code === "ADDRESS_CHANGE" && !claimsAddressChange) {
      claimsAddressChange = true;
      corrections.push({ field: "payee.claimsAddressChange", reason: "ADDRESS_CHANGE_FLAG_RAISED" });
    }
  }
  if (anomalies.length > before) corrections.push({ field: "anomalies", reason: "ANOMALIES_ADDED" });

  const extraction: ExtractedInvoice = {
    ...x,
    payee: { ...x.payee, claimsAddressChange },
    amount: { ...x.amount, parsedBaseUnits, decimals, decimalSeparatorGuess },
    statedTerms,
    anomalies,
  };
  // Re-validate what we are about to hand on (guards against a bug in the reconciliation above).
  const again = ExtractedInvoiceSchema.safeParse(extraction);
  if (!again.success) return { ok: false, failure: { code: "SCHEMA_INVALID", paths: again.error.issues.slice(0, 10).map((i) => i.path.join(".")) } };
  return { ok: true, extraction: again.data, corrections };
}

export type { Untrusted };
