// K-08 AMOUNT_CONFORMANCE — REJECT (over) / ESCALATE (under) — P0 (docs/04 K-08, INV-19).
// GROSS: exact equality with the SIGNED milestone amount unless partialAllowed; gross > milestone or
// released-including-pending + gross > engagement cap => REJECT OVERPAY; gross < milestone (not partial) =>
// ESCALATE UNDERPAY_PARTIAL. Per-milestone exactness defeats compensating errors (ATK-06).
// RELEASE AMOUNT (v2): the amount actually attested must equal amountDue(payAt) from @symbolon/terms, computed
// from the signed engagement paymentTerms and the kernel-recorded invoiceReceivedAt. Higher => REJECT OVERPAY,
// lower => ESCALATE UNDERPAY_PARTIAL. Invoice-stated terms are not an input here at all (ATK-21). In WP-04 the
// release amount under test is the scheduled one at a TOCTOU re-evaluation (ctx.reevaluation, at
// payAt = max(now, scheduled payAt)); on a first evaluation K-14 (WP-05) picks payAt and the kernel computes
// amountDue itself.
// Fail-closed additions: partialAllowed milestones also cap the cumulative released amount at the milestone
// amount; ctx.paymentTerms must equal the signed engagement terms; invoiceReceivedAt must not be after now.
import { epochSecondsFromIso, jcs } from "@symbolon/schemas";
import type { CheckResult } from "@symbolon/schemas";
import type { KernelContext } from "../context";
import type { Facts } from "../facts";
import { combine, fail, kernelError } from "../verdict";
import type { Issue } from "../verdict";

export function checkK08(ctx: KernelContext, facts: Facts): CheckResult {
  const e = facts.engagement;
  if (e === null) return fail("K-08", "REJECT", "NO_ENGAGEMENT", "no engagement to conform the amount to");
  const m = facts.milestoneTerms;
  if (m === null) return fail("K-08", "REJECT", "UNKNOWN_MILESTONE", "no signed milestone to conform the amount to");
  const gross = facts.gross;
  if (gross === null) return fail("K-08", "ESCALATE", "AMOUNT_AMBIGUOUS", "gross amount is not determinable");
  const released = ctx.released.engagementTotal;
  if (typeof released !== "bigint" || released < 0n) return kernelError("K-08", "released.engagementTotal is not a non-negative bigint");
  if (epochSecondsFromIso(ctx.invoiceReceivedAt) > epochSecondsFromIso(ctx.now)) return kernelError("K-08", "invoiceReceivedAt is after now");
  if (jcs(ctx.paymentTerms) !== jcs(e.paymentTerms)) return kernelError("K-08", "ctx.paymentTerms differ from the signed engagement paymentTerms");

  const issues: Issue[] = [];
  const milestoneAmount = BigInt(m.amountBaseUnits);
  const cap = BigInt(e.capBaseUnits);
  if (gross > milestoneAmount) {
    issues.push({ onFail: "REJECT", code: "OVERPAY", detail: `gross ${gross} > milestone amount ${milestoneAmount}` });
  }
  if (released + gross > cap) {
    issues.push({ onFail: "REJECT", code: "OVERPAY", detail: `released ${released} + gross ${gross} > engagement cap ${cap}` });
  }
  if (gross < milestoneAmount && !m.partialAllowed) {
    issues.push({ onFail: "ESCALATE", code: "UNDERPAY_PARTIAL", detail: `gross ${gross} < milestone amount ${milestoneAmount} and partial payment is not allowed` });
  }
  if (m.partialAllowed) {
    const prior = ctx.priorDecisions.filter(
      (p) => p.verdict === "RELEASE" && p.engagementId === e.engagementId && p.milestoneId === m.milestoneId && p.intentId !== facts.intentId,
    );
    // A prior release with an unknown amount counts as the whole milestone (fail closed).
    const priorSum = prior.reduce((s, p) => s + (p.amountBaseUnits ?? milestoneAmount), 0n);
    if (priorSum + gross > milestoneAmount) {
      issues.push({ onFail: "REJECT", code: "OVERPAY", detail: `prior partial releases ${priorSum} + gross ${gross} > milestone amount ${milestoneAmount}` });
    }
  }
  const r = facts.release;
  if (r !== null) {
    if (!r.expected.ok) {
      issues.push({ onFail: "HOLD", code: "KERNEL_ERROR", detail: `amountDue not computable: ${r.expected.error.message}` });
    } else if (r.scheduledAmount > r.expected.value.amountDue) {
      issues.push({ onFail: "REJECT", code: "OVERPAY", detail: `release amount ${r.scheduledAmount} > amountDue(${r.payAt}) ${r.expected.value.amountDue}` });
    } else if (r.scheduledAmount < r.expected.value.amountDue) {
      issues.push({ onFail: "ESCALATE", code: "UNDERPAY_PARTIAL", detail: `release amount ${r.scheduledAmount} < amountDue(${r.payAt}) ${r.expected.value.amountDue}` });
    }
  }
  return combine("K-08", issues, `gross equals the signed milestone amount${r === null ? "" : "; release amount equals amountDue(payAt)"}`);
}
