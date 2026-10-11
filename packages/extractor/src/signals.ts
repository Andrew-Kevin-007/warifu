// Document-level risk signals, computed from the normalized text BEFORE any model runs, independent of what any
// model says and of whether later validation passes (finding "fail-open / signal suppression"). They travel with
// every result, success or failure, so an injected or hidden-character document can never fail "quietly": a failed
// extraction that carries signals is routed to ESCALATE, not silently dropped.
import type { ExtractedInvoice } from "@symbolon/schemas";
import { inspectUntrusted, untrusted } from "@symbolon/schemas";
import { scanInjection } from "./parse/injection";
import type { PreparedDocument } from "./prepare";

export type Anomaly = ExtractedInvoice["anomalies"][number];

export interface DocSignals {
  readonly anomalies: readonly Anomaly[];
  readonly claimsAddressChange: boolean;
  readonly removedCount: number;
  /** True when the scanner itself failed: unknown risk, treated as a signal (ESCALATE). */
  readonly scanError: boolean;
}

export function computeDocSignals(doc: PreparedDocument): DocSignals {
  const anomalies: Anomaly[] = [];
  let claimsAddressChange = false;
  let scanError = false;

  if (doc.removedCount > 0) {
    const c = doc.counts;
    anomalies.push({
      code: "HIDDEN_CHARS",
      quote: untrusted(`removed ${doc.removedCount} characters (control ${c.control}, zero-width ${c.zeroWidth}, bidi ${c.bidi}, invalid ${c.invalid})`),
    });
  }
  try {
    for (const f of scanInjection(doc.normalized)) {
      anomalies.push({ code: f.code, quote: untrusted(inspectUntrusted(f.quote).slice(0, 500)) });
      if (f.code === "ADDRESS_CHANGE") claimsAddressChange = true;
    }
  } catch {
    // Converted into a typed flag, not swallowed: an unscannable document is an unknown risk.
    scanError = true;
    anomalies.push({ code: "OTHER", quote: untrusted("injection scan failed") });
  }
  return { anomalies, claimsAddressChange, removedCount: doc.removedCount, scanError };
}

/** True when the signals alone justify routing a failed extraction to a human (ESCALATE) rather than a plain HOLD. */
export function hasRiskSignal(s: DocSignals | null): boolean {
  return s === null || s.scanError || s.anomalies.length > 0;
}
