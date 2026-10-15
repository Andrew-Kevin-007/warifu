// The ranked escalation digest (docs/04 K-12 v2, RT-14, ATK-22; WP-05, WP-36). Items held with ESCALATION_BUDGET_EXCEEDED
// are shown to the owner as ONE digest, never as separate approval prompts, and there is no bulk approve: each item still
// needs its own bound OwnerApproval (gates.ts). Rank (docs/04, RT-14 "ranked by risk"):
//   1. an item with a payee-redirect finding (a claimed address change, a wallet that is not the engagement payee, a
//      pending payee change) comes first: that is the one class of finding that points the money somewhere else, and an
//      attacker can cheaply pad the pile with items that fail MORE checks than the threat does;
//   2. then fewest passing checks first, then the largest amount (an unknown amount ranks as the largest), then the
//      newest payee (fewest prior payments), then decisionId (a deterministic tie-break). Pure.
import type { Hex32, ReasonCode, UUID } from "@symbolon/schemas";
import type { Evaluation } from "./evaluation";
import { issueCodes } from "./verdict";

/** Findings that redirect or may redirect the payout (docs/04 K-06). They are tier 1 of the digest rank. */
const PAYEE_REDIRECT: ReadonlySet<ReasonCode> = new Set<ReasonCode>(["ADDRESS_CHANGE_CLAIMED", "PAYEE_MISMATCH", "PAYEE_CHANGE_PENDING"]);

export interface DigestItem {
  readonly decisionId: UUID;
  readonly intentId: Hex32;
  readonly passingChecks: number;
  /** GROSS amount; null when unknown. */
  readonly amountBaseUnits: bigint | null;
  readonly payeePriorPayments: number;
  /** A FAILing check carries a payee-redirect finding (any of its issues, not only its worst, and after the budget gate too). */
  readonly payeeRedirect: boolean;
}

export interface RankedDigestItem extends DigestItem {
  /** 1 = show first. */
  readonly rank: number;
}

/** A digest entry for one evaluation; `payeePriorPayments` comes from the context it was evaluated in. */
export function digestItem(e: Evaluation, decisionId: UUID, payeePriorPayments: number): DigestItem {
  return {
    decisionId,
    intentId: e.intentId,
    passingChecks: e.checks.filter((c) => c.status === "PASS" && c.code === null).length,
    amountBaseUnits: e.amountBaseUnits === null ? null : BigInt(e.amountBaseUnits),
    payeePriorPayments,
    payeeRedirect: issueCodes(e.checks).some((code) => PAYEE_REDIRECT.has(code)),
  };
}

function compare(a: DigestItem, b: DigestItem): number {
  if (a.payeeRedirect !== b.payeeRedirect) return a.payeeRedirect ? -1 : 1;
  if (a.passingChecks !== b.passingChecks) return a.passingChecks - b.passingChecks;
  if (a.amountBaseUnits !== b.amountBaseUnits) {
    if (a.amountBaseUnits === null) return -1;
    if (b.amountBaseUnits === null) return 1;
    return a.amountBaseUnits > b.amountBaseUnits ? -1 : 1;
  }
  if (a.payeePriorPayments !== b.payeePriorPayments) return a.payeePriorPayments - b.payeePriorPayments;
  return a.decisionId < b.decisionId ? -1 : a.decisionId > b.decisionId ? 1 : 0;
}

/** Order the digest (see the module comment). Does not modify its input. */
export function rankEscalationDigest(items: readonly DigestItem[]): readonly RankedDigestItem[] {
  return [...items].sort(compare).map((item, i) => ({ ...item, rank: i + 1 }));
}
