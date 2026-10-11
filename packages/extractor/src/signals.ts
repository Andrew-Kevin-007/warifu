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
  /** True when computing the signals itself failed: unknown risk, treated as a signal (ESCALATE). */
  readonly scanError: boolean;
}

/** The signals used when computing them failed: an explicit risk flag, never an empty "all clear". */
export function failClosedSignals(removedCount = 0): DocSignals {
  return { anomalies: [{ code: "OTHER", quote: untrusted("document signal computation failed") }], claimsAddressChange: false, removedCount, scanError: true };
}

/** Total function: any internal failure becomes `scanError` signals (typed), it never throws and never returns "clean". */
export function computeDocSignals(doc: PreparedDocument): DocSignals {
  try {
    const anomalies: Anomaly[] = [];
    let claimsAddressChange = false;
    if (doc.removedCount > 0) {
      const c = doc.counts;
      anomalies.push({
        code: "HIDDEN_CHARS",
        quote: untrusted(`removed ${doc.removedCount} characters (control ${c.control}, zero-width ${c.zeroWidth}, bidi ${c.bidi}, invalid ${c.invalid})`),
      });
    }
    for (const f of scanInjection(doc.normalized)) {
      anomalies.push({ code: f.code, quote: untrusted(inspectUntrusted(f.quote).slice(0, 500)) });
      if (f.code === "ADDRESS_CHANGE") claimsAddressChange = true;
    }
    return { anomalies, claimsAddressChange, removedCount: doc.removedCount, scanError: false };
  } catch {
    // Converted into a typed flag, not swallowed: an unscannable document is an unknown risk.
    return failClosedSignals(typeof doc?.removedCount === "number" ? doc.removedCount : 0);
  }
}

/** True when the signals alone justify routing a failed extraction to a human (ESCALATE) rather than a plain HOLD. */
export function hasRiskSignal(s: DocSignals | null): boolean {
  return s === null || s.scanError || s.anomalies.length > 0;
}
