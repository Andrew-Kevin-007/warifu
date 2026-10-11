// Typed results for @symbolon/terms. The package never throws on bad input: every public function
// validates its arguments and returns a TermsResult, so a caller cannot silently use a value computed
// from garbage (fail closed, INV-4). kernel-core maps a TermsError to a HOLD/REJECT, never to RELEASE.

export type TermsErrorCode =
  /** An amount is not a bigint in [0, 2^256 - 1]. */
  | "INVALID_AMOUNT"
  /** Basis points are not an integer in the accepted range. */
  | "INVALID_BPS"
  /** A day count is not an integer in the accepted range (or netDays <= withinDays for APR). */
  | "INVALID_DAYS"
  /** A timestamp is not a canonical ISODateTime, or a derived instant leaves the representable range. */
  | "INVALID_TIME"
  /** Payment terms do not satisfy the frozen PaymentTermsSchema (packages/schemas). */
  | "INVALID_TERMS";

export interface TermsError {
  readonly code: TermsErrorCode;
  readonly message: string;
}

export type TermsResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: TermsError };

export function ok<T>(value: T): TermsResult<T> {
  return { ok: true, value };
}

export function err(code: TermsErrorCode, message: string): { readonly ok: false; readonly error: TermsError } {
  return { ok: false, error: { code, message } };
}
