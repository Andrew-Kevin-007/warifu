// The oracle's OWN amountDue (docs/04 K-08 semantics, INV-19). It is deliberately a second, independent
// implementation: the judge must not share code with packages/terms, which the kernel under test uses.
//   discount applies iff payAt <= invoiceReceivedAt + withinDays * 86400 s (inclusive)
//   discountValue = floor(gross * discountBps / 10000)
//   amountDue     = gross - discountValue inside the window, gross outside (or without signed early-pay terms)
// No kernel-recorded receipt time (null) means no discount clock: gross.
import { epochSecondsFromIso } from "@symbolon/schemas";
import type { ISODateTime, PaymentTerms } from "@symbolon/schemas";

const SECONDS_PER_DAY = 86_400n;
const BPS = 10_000n;

export function insideDiscountWindow(terms: PaymentTerms | null, receivedAt: ISODateTime | null, payAt: ISODateTime): boolean {
  if (terms === null || terms.earlyPay === null || receivedAt === null) return false;
  return epochSecondsFromIso(payAt) <= epochSecondsFromIso(receivedAt) + BigInt(terms.earlyPay.withinDays) * SECONDS_PER_DAY;
}

export function amountDueOracle(gross: bigint, terms: PaymentTerms | null, receivedAt: ISODateTime | null, payAt: ISODateTime): bigint {
  if (!insideDiscountWindow(terms, receivedAt, payAt) || terms === null || terms.earlyPay === null) return gross;
  return gross - (gross * BigInt(terms.earlyPay.discountBps)) / BPS;
}
