// A tiny, independent reference for amountDue (docs/04 K-08, INV-19). It exists so that fixture expectations
// do not depend on the code under test (packages/terms is owned by KERNEL-CORE). It is deliberately the
// simplest possible reading of the spec:
//   amountDue = gross - floor(gross * discountBps / 10000)   if payAt <= receivedAt + withinDays * 86400
//             = gross                                         otherwise (or when the signed terms have no early-pay)
// The window is measured from the KERNEL-recorded receipt, never from a date printed on the invoice.
import { epochSecondsFromIso, type ISODateTime, type PaymentTerms } from "@symbolon/schemas";
import { DAY } from "./time";

export function referenceDiscountValue(gross: bigint, terms: PaymentTerms | null): bigint {
  if (terms === null || terms.earlyPay === null) return 0n;
  return (gross * BigInt(terms.earlyPay.discountBps)) / 10_000n;
}

export function insideDiscountWindow(terms: PaymentTerms | null, receivedAt: ISODateTime, payAt: ISODateTime): boolean {
  if (terms === null || terms.earlyPay === null) return false;
  return epochSecondsFromIso(payAt) <= epochSecondsFromIso(receivedAt) + BigInt(terms.earlyPay.withinDays) * DAY;
}

export function referenceAmountDue(gross: bigint, terms: PaymentTerms | null, receivedAt: ISODateTime, payAt: ISODateTime): bigint {
  return insideDiscountWindow(terms, receivedAt, payAt) ? gross - referenceDiscountValue(gross, terms) : gross;
}
