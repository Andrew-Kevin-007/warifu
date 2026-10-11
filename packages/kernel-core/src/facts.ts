// Facts derived once from (intent, ctx, policy) and shared by K-02..K-08: the kernel's own parse of the printed
// amount, the gross amount, the normalized invoice number, the engagement the intent is bound to, and the
// intentId (docs/04 K-04). Pure; any exception is caught by the pipeline and fails every dependent check closed.
import { deriveIntentId, epochSecondsFromIso, hashJcs, inspectUntrusted } from "@symbolon/schemas";
import type { Address, Engagement, Hex32, ISODateTime, Milestone, PaymentIntent } from "@symbolon/schemas";
import type { LoadedPolicy } from "@symbolon/policy";
import { amountDue } from "@symbolon/terms";
import type { AmountDue } from "@symbolon/terms";
import type { KernelContext } from "./context";
import { parseMoney } from "./money";
import type { MoneyParse } from "./money";
import { attempt, err, ok } from "./result";
import type { Result } from "./result";
import { normalizeInvoiceNumber } from "./text";

/** Sentinel used only when not even the context can be hashed (the decision can never be RELEASE then). */
export const UNKNOWN_INTENT_ID: Hex32 = `0x${"0".repeat(64)}`;

/** The release under evaluation at a TOCTOU re-evaluation (docs/04 §5). */
export interface ReleaseFacts {
  /** max(ctx.now, scheduled payAt): the earliest instant the payment can actually happen. */
  readonly payAt: ISODateTime;
  readonly scheduledAmount: bigint;
  /** amountDue(payAt) from the SIGNED terms and the kernel-recorded invoiceReceivedAt. */
  readonly expected: Result<AmountDue>;
}

export interface Facts {
  /** engagement.currencyDecimals when bound, else the policy's currency decimals. */
  readonly declaredDecimals: number;
  /** K-02: parseMoney of extraction A's printed amount. */
  readonly totalParse: MoneyParse;
  /** extraction A's parsedBaseUnits (the extractor's claim). */
  readonly claimedGross: bigint | null;
  /** GROSS invoiced amount: the kernel's exact parse when it has one, else the extractor's claim, else unknown. */
  readonly gross: bigint | null;
  /** null when the invoice number normalizes to more than 128 characters. */
  readonly normInvoiceNo: string | null;
  /** ctx.engagement, only if it is the engagement the intent references and belongs to this tenant. */
  readonly engagement: Engagement | null;
  /** The SIGNED milestone entry (engagement.milestones) for intent.milestoneId. */
  readonly milestoneTerms: Milestone | null;
  /** Payout address: always engagement.payee (docs/04 K-06). */
  readonly payout: Address | null;
  readonly intentId: Hex32;
  /** false => intentId is derived from the context only (no engagement, milestone, gross or invoice number). */
  readonly intentIdBound: boolean;
  readonly release: ReleaseFacts | null;
}

/** intentId for an intent that cannot be bound: keccak256(JCS({kind, tenantId, docHash})) from the context. */
export function unboundIntentId(ctx: KernelContext): Hex32 {
  const r = attempt(() => hashJcs({ kind: "symbolon/unbound-intent/1", tenantId: ctx.tenantId, docHash: ctx.doc.hash }), "INTERNAL", "unhashable");
  return r.ok ? r.value : UNKNOWN_INTENT_ID;
}

function boundEngagement(intent: PaymentIntent, ctx: KernelContext): Engagement | null {
  const e = ctx.engagement;
  if (e === null || intent.engagementId === null) return null;
  return e.engagementId === intent.engagementId && e.tenantId === ctx.tenantId ? e : null;
}

function releaseFacts(ctx: KernelContext, engagement: Engagement | null, gross: bigint | null): ReleaseFacts | null {
  const re = ctx.reevaluation;
  if (re === null || engagement === null || gross === null) return null;
  const payAt = epochSecondsFromIso(ctx.now) >= epochSecondsFromIso(re.payAt) ? ctx.now : re.payAt;
  const due = amountDue({ grossBaseUnits: gross, terms: engagement.paymentTerms, invoiceReceivedAt: ctx.invoiceReceivedAt, payAt });
  return {
    payAt,
    scheduledAmount: re.releaseAmountBaseUnits,
    expected: due.ok ? ok(due.value) : err("TERMS", `${due.error.code}: ${due.error.message}`),
  };
}

export function deriveFacts(intent: PaymentIntent, ctx: KernelContext, policy: LoadedPolicy): Facts {
  const a = intent.extraction.a;
  const engagement = boundEngagement(intent, ctx);
  const declaredDecimals = engagement === null ? policy.decimals : engagement.currencyDecimals;
  const totalParse = parseMoney(inspectUntrusted(a.amount.printed), inspectUntrusted(a.amount.currencyPrinted), declaredDecimals);
  const claimedGross = a.amount.parsedBaseUnits === null ? null : BigInt(a.amount.parsedBaseUnits);
  const gross = totalParse.kind === "EXACT" ? totalParse.baseUnits : claimedGross;
  const normInvoiceNo = normalizeInvoiceNumber(inspectUntrusted(a.invoiceNumber));
  const milestoneTerms =
    engagement === null || intent.milestoneId === null ? null : (engagement.milestones.find((m) => m.milestoneId === intent.milestoneId) ?? null);

  let intentId = unboundIntentId(ctx);
  let intentIdBound = false;
  if (engagement !== null && intent.milestoneId !== null && gross !== null && normInvoiceNo !== null) {
    const milestoneId = intent.milestoneId;
    const bound = attempt(
      () => deriveIntentId({ engagementId: engagement.engagementId, milestoneId, normInvoiceNo, amountBaseUnits: gross.toString(), payee: engagement.payee }),
      "INTERNAL",
      "intentId preimage out of range",
    );
    if (bound.ok) {
      intentId = bound.value;
      intentIdBound = true;
    }
  }

  return {
    declaredDecimals,
    totalParse,
    claimedGross,
    gross,
    normInvoiceNo,
    engagement,
    milestoneTerms,
    payout: engagement === null ? null : engagement.payee,
    intentId,
    intentIdBound,
    release: releaseFacts(ctx, engagement, gross),
  };
}
