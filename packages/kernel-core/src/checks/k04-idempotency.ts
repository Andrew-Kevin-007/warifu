// K-04 IDEMPOTENCY_DEDUPE — REPLAY / REJECT / ESCALATE — P0 (docs/04 K-04).
// intentId = keccak256(JCS({engagementId, milestoneId, normInvoiceNo, amountBaseUnits(GROSS), payee})) (facts.ts).
//   exact intentId seen                                  => REPLAY, returning the prior decision (short-circuit)
//   same (engagementId, milestoneId) already RELEASE      => REJECT MILESTONE_ALREADY_PAID (a partialAllowed milestone: only
//                                                            once its releases cover the whole amount; see milestoneSettled)
//   same doc.hash under another intent                    => ESCALATE DUPLICATE_DOC
//   same payee + same gross within 7 days, other intent   => ESCALATE NEAR_DUPLICATE
// Fail-closed readings (docs/QUESTIONS.md "WP-04"): MILESTONE_ALREADY_PAID fires for ANY other intent on that
// milestone, not only "a different invoice no." (a same-number re-invoice with a changed amount is a different
// intent too); DUPLICATE_DOC fires for any other intent on the same document. During a TOCTOU re-evaluation
// (ctx.reevaluation) the intent's own decisions are its supersedes chain, so they never trigger REPLAY.
import { epochSecondsFromIso } from "@symbolon/schemas";
import type { CheckResult, Milestone, PaymentIntent } from "@symbolon/schemas";
import type { DecisionSummary, KernelContext } from "../context";
import type { Facts } from "../facts";
import { combine, fail, kernelError, replayResult } from "../verdict";
import type { Issue } from "../verdict";

export const NEAR_DUPLICATE_WINDOW_SECONDS = 7n * 86_400n;

export type K04Outcome =
  | { readonly kind: "result"; readonly result: CheckResult }
  | { readonly kind: "replay"; readonly result: CheckResult; readonly replayOf: DecisionSummary };

const result = (r: CheckResult): K04Outcome => ({ kind: "result", result: r });

/** The latest decision by (createdAt, decisionId); independent of the order of priorDecisions. */
function latest(decisions: readonly DecisionSummary[]): DecisionSummary {
  return decisions.reduce((best, d) =>
    d.createdAt > best.createdAt || (d.createdAt === best.createdAt && d.decisionId > best.decisionId) ? d : best,
  );
}

const ids = (ds: readonly DecisionSummary[]) => ds.map((d) => d.decisionId);

/**
 * Do the releases already scheduled on this milestone settle it? A milestone that does not allow partial payment is settled
 * by ANY release (docs/04 K-04). A partialAllowed milestone (read from the SIGNED terms) is settled only once the releases
 * cover its whole amount, so a legitimate later instalment is not rejected here; whether this instalment still fits is K-08's
 * cumulative OVERPAY check. A release with an unknown amount counts as the whole milestone (fail closed, as in K-08), and
 * unknown milestone terms are treated as not partial.
 */
function milestoneSettled(released: readonly DecisionSummary[], terms: Milestone | null): boolean {
  if (terms === null || !terms.partialAllowed) return true;
  const whole = BigInt(terms.amountBaseUnits);
  return released.reduce((sum, p) => sum + (p.amountBaseUnits ?? whole), 0n) >= whole;
}

export function checkK04(intent: PaymentIntent, ctx: KernelContext, facts: Facts): K04Outcome {
  if (facts.normInvoiceNo === null) {
    return result(fail("K-04", "REJECT", "SCHEMA_INVALID", "invoice number normalizes to more than 128 characters"));
  }
  const re = ctx.reevaluation;
  if (re !== null && re.intentId !== facts.intentId) {
    return result(kernelError("K-04", "reevaluation.intentId differs from the intentId of the intent being re-evaluated"));
  }
  const same = ctx.priorDecisions.filter((p) => p.intentId === facts.intentId);
  if (re === null && same.length > 0) {
    const prior = latest(same);
    return { kind: "replay", result: replayResult("K-04", `exact intentId seen: replay of decision ${prior.decisionId}`, [prior.decisionId]), replayOf: prior };
  }

  const others = ctx.priorDecisions.filter((p) => p.intentId !== facts.intentId);
  const issues: Issue[] = [];
  if (intent.engagementId !== null && intent.milestoneId !== null) {
    const paid = others.filter((p) => p.verdict === "RELEASE" && p.engagementId === intent.engagementId && p.milestoneId === intent.milestoneId);
    if (paid.length > 0 && milestoneSettled(paid, facts.milestoneTerms)) {
      issues.push({ onFail: "REJECT", code: "MILESTONE_ALREADY_PAID", detail: "milestone already released or pending under another intent", refs: ids(paid) });
    }
  }
  const sameDoc = others.filter((p) => p.docHash === ctx.doc.hash);
  if (sameDoc.length > 0) {
    issues.push({ onFail: "ESCALATE", code: "DUPLICATE_DOC", detail: "the same document was already decided under another intent", refs: ids(sameDoc) });
  }
  const payout = facts.payout;
  const gross = facts.gross;
  if (payout !== null && gross !== null) {
    const now = epochSecondsFromIso(ctx.now);
    const near = others.filter((p) => {
      if (p.payee === null || p.payee.toLowerCase() !== payout.toLowerCase() || p.amountBaseUnits !== gross) return false;
      const age = now - epochSecondsFromIso(p.createdAt);
      const within = (age < 0n ? -age : age) <= NEAR_DUPLICATE_WINDOW_SECONDS;
      return within && (p.milestoneId !== intent.milestoneId || p.normInvoiceNo !== facts.normInvoiceNo);
    });
    if (near.length > 0) {
      issues.push({ onFail: "ESCALATE", code: "NEAR_DUPLICATE", detail: "same payee and amount within 7 days under another intent", refs: ids(near) });
    }
  }
  return result(combine("K-04", issues, facts.intentIdBound ? "no replay or duplicate" : "no replay or duplicate (intentId unbound: see K-02/K-05/K-08)"));
}
