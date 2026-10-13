// The ranked escalation digest (docs/04 K-12 v2, RT-14, ATK-22; WP-05). Items held with ESCALATION_BUDGET_EXCEEDED are
// shown to the owner as ONE digest, never as separate approval prompts, and there is no bulk approve: each item still
// needs its own bound OwnerApproval (gates.ts). Rank (docs/04): fewest passing checks first, then the largest amount
// (an unknown amount ranks as the largest), then the newest payee (fewest prior payments), then decisionId (a
// deterministic tie-break). Pure.
import type { Hex32, UUID } from "@symbolon/schemas";
import type { Evaluation } from "./evaluation";

export interface DigestItem {
  readonly decisionId: UUID;
  readonly intentId: Hex32;
  readonly passingChecks: number;
  /** GROSS amount; null when unknown. */
  readonly amountBaseUnits: bigint | null;
  readonly payeePriorPayments: number;
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
  };
}

function compare(a: DigestItem, b: DigestItem): number {
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
