// Payment-terms math (docs/03 §5.2, docs/04 K-08/K-14, INV-19). Pure: no clock, randomness or I/O;
// every instant is an argument. Money is bigint base units (INV-10); day counts and basis points are
// small integers validated before they become bigint.
//
//   discount applies iff payAt <= invoiceReceivedAt + withinDays * 86400   (UTC seconds, inclusive)
//   discountValue    = floor(gross * discountBps / 10000)                  (rounds in the payee's favour)
//   amountDue(payAt) = gross - discountValue  inside the window | gross  outside
//   impliedAprBps    = floor(discountBps * 365 * 10000 / ((10000 - discountBps) * (netDays - withinDays)))
//
// The terms passed in are ALWAYS the signed engagement terms (`PaymentTerms`, inside termsHash). Invoice-
// stated terms have no parameter here on purpose: they are compared by the kernel (K-14), never adopted.
import { MAX_UINT256, PaymentTermsSchema, epochSecondsFromIso, isIsoDateTime, isoFromEpochSeconds } from "@symbolon/schemas";
import type { ISODateTime, PaymentTerms } from "@symbolon/schemas";
import { err, ok } from "./result";
import type { TermsResult } from "./result";

export const BPS_DENOMINATOR = 10_000n;
export const SECONDS_PER_DAY = 86_400n;
export const DAYS_PER_YEAR = 365n;
/** Largest day count accepted by the generic helpers (statedTerms allow up to 3650; signed terms up to 365). */
export const MAX_DAYS = 3650;
/** 9999-12-31T23:59:59Z: the last instant an ISODateTime can spell. */
const MAX_EPOCH_SECONDS = 253402300799n;

function checkAmount(value: bigint, what: string): TermsResult<bigint> {
  if (typeof value !== "bigint" || value < 0n || value > MAX_UINT256) {
    return err("INVALID_AMOUNT", `${what} must be a bigint in [0, 2^256 - 1]`);
  }
  return ok(value);
}

function checkBps(bps: number, max: number): TermsResult<bigint> {
  if (!Number.isSafeInteger(bps) || bps < 0 || bps > max) {
    return err("INVALID_BPS", `discountBps must be an integer in [0, ${max}]`);
  }
  return ok(BigInt(bps));
}

function checkDays(days: number, what: string): TermsResult<bigint> {
  if (!Number.isSafeInteger(days) || days < 0 || days > MAX_DAYS) {
    return err("INVALID_DAYS", `${what} must be an integer in [0, ${MAX_DAYS}]`);
  }
  return ok(BigInt(days));
}

function toEpoch(iso: ISODateTime, what: string): TermsResult<bigint> {
  if (typeof iso !== "string" || !isIsoDateTime(iso)) {
    return err("INVALID_TIME", `${what} must be a canonical ISODateTime (YYYY-MM-DDTHH:MM:SSZ)`);
  }
  return ok(epochSecondsFromIso(iso));
}

/** floor(gross * discountBps / 10000). `discountBps` in [0, 10000]. */
export function discountValue(gross: bigint, discountBps: number): TermsResult<bigint> {
  const g = checkAmount(gross, "gross");
  if (!g.ok) return g;
  const b = checkBps(discountBps, 10_000);
  if (!b.ok) return b;
  // Both operands are non-negative, so bigint division (truncation) is floor.
  return ok((g.value * b.value) / BPS_DENOMINATOR);
}

/** `iso + days` whole days, as a canonical ISODateTime. */
export function addDays(iso: ISODateTime, days: number): TermsResult<ISODateTime> {
  const t = toEpoch(iso, "instant");
  if (!t.ok) return t;
  const d = checkDays(days, "days");
  if (!d.ok) return d;
  const end = t.value + d.value * SECONDS_PER_DAY;
  if (end > MAX_EPOCH_SECONDS) return err("INVALID_TIME", "derived instant is after 9999-12-31T23:59:59Z");
  return ok(isoFromEpochSeconds(end));
}

/** dueDate = invoiceReceivedAt + netDays (signed terms; docs/04 K-14). */
export function dueDate(invoiceReceivedAt: ISODateTime, netDays: number): TermsResult<ISODateTime> {
  return addDays(invoiceReceivedAt, netDays);
}

/** End of the early-pay window: invoiceReceivedAt + withinDays (inclusive bound). */
export function discountWindowEnd(invoiceReceivedAt: ISODateTime, withinDays: number): TermsResult<ISODateTime> {
  return addDays(invoiceReceivedAt, withinDays);
}

/** payAt <= invoiceReceivedAt + withinDays * 86400 (seconds, inclusive at the boundary). */
export function isWithinDiscountWindow(payAt: ISODateTime, invoiceReceivedAt: ISODateTime, withinDays: number): TermsResult<boolean> {
  const p = toEpoch(payAt, "payAt");
  if (!p.ok) return p;
  const end = discountWindowEnd(invoiceReceivedAt, withinDays);
  if (!end.ok) return end;
  return ok(p.value <= epochSecondsFromIso(end.value));
}

export interface AmountDueInput {
  /** The GROSS invoiced amount in base units (what K-08 matches against the milestone). */
  readonly grossBaseUnits: bigint;
  /** Signed engagement terms; null means policy defaults: no discount (docs/04 K-14). */
  readonly terms: PaymentTerms | null;
  /** Kernel-recorded receipt time of the invoice; the discount clock starts here (INV-19). */
  readonly invoiceReceivedAt: ISODateTime;
  /** The instant the payment is made. */
  readonly payAt: ISODateTime;
}

export interface AmountDue {
  readonly amountDue: bigint;
  /** 0n when no discount applies. */
  readonly discountValue: bigint;
  readonly discountApplied: boolean;
  /** End of the early-pay window, or null when the signed terms have no early-pay discount. */
  readonly windowEnd: ISODateTime | null;
}

/** amountDue(payAt) from the signed terms (docs/03 §5.2). Always 0 <= amountDue <= gross. */
export function amountDue(input: AmountDueInput): TermsResult<AmountDue> {
  const g = checkAmount(input.grossBaseUnits, "grossBaseUnits");
  if (!g.ok) return g;
  const received = toEpoch(input.invoiceReceivedAt, "invoiceReceivedAt");
  if (!received.ok) return received;
  const pay = toEpoch(input.payAt, "payAt");
  if (!pay.ok) return pay;
  const none: AmountDue = { amountDue: g.value, discountValue: 0n, discountApplied: false, windowEnd: null };
  if (input.terms === null) return ok(none);
  const parsed = PaymentTermsSchema.safeParse(input.terms);
  if (!parsed.success) return err("INVALID_TERMS", "payment terms do not satisfy PaymentTermsSchema");
  const early = parsed.data.earlyPay;
  if (early === null) return ok(none);
  const windowEnd = discountWindowEnd(input.invoiceReceivedAt, early.withinDays);
  if (!windowEnd.ok) return windowEnd;
  if (pay.value > epochSecondsFromIso(windowEnd.value)) {
    return ok({ ...none, windowEnd: windowEnd.value });
  }
  const discount = discountValue(g.value, early.discountBps);
  if (!discount.ok) return discount;
  return ok({ amountDue: g.value - discount.value, discountValue: discount.value, discountApplied: true, windowEnd: windowEnd.value });
}

export interface ImpliedAprInput {
  readonly discountBps: number;
  readonly netDays: number;
  readonly withinDays: number;
}

/**
 * Simple-interest annualised rate of taking the discount, in bps (docs/03 §5.2):
 * floor(discountBps * 365 * 10000 / ((10000 - discountBps) * (netDays - withinDays))).
 * Requires 0 <= discountBps < 10000 and 0 <= withinDays < netDays <= MAX_DAYS.
 */
export function impliedAprBps(input: ImpliedAprInput): TermsResult<bigint> {
  const b = checkBps(input.discountBps, 9_999);
  if (!b.ok) return b;
  const net = checkDays(input.netDays, "netDays");
  if (!net.ok) return net;
  const within = checkDays(input.withinDays, "withinDays");
  if (!within.ok) return within;
  if (net.value <= within.value) return err("INVALID_DAYS", "netDays must be greater than withinDays");
  const numerator = b.value * DAYS_PER_YEAR * BPS_DENOMINATOR;
  const denominator = (BPS_DENOMINATOR - b.value) * (net.value - within.value);
  return ok(numerator / denominator);
}

/** impliedAprBps of signed terms; null when the terms (or their absence) carry no early-pay discount. */
export function termsImpliedAprBps(terms: PaymentTerms | null): TermsResult<bigint | null> {
  if (terms === null) return ok(null);
  const parsed = PaymentTermsSchema.safeParse(terms);
  if (!parsed.success) return err("INVALID_TERMS", "payment terms do not satisfy PaymentTermsSchema");
  const early = parsed.data.earlyPay;
  if (early === null) return ok(null);
  return impliedAprBps({ discountBps: early.discountBps, netDays: parsed.data.netDays, withinDays: early.withinDays });
}
