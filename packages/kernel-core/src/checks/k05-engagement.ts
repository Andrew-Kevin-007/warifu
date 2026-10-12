// K-05 ENGAGEMENT_BINDING — REJECT — P0 (docs/04 K-05).
// The engagement referenced by the intent exists for this tenant, is ACTIVE, is signed by BOTH parties (a null
// ownerSig/payeeSig means not active: ORCH binding, docs/QUESTIONS WP-01 item 4), is registered on chain with the
// same termsHash (recomputed here from the loaded terms, so a DB row whose paymentTerms or milestones were edited
// is refused), cap and window; now is inside [start, end] (inclusive, as the vault); the milestone is a signed
// milestone of that engagement, is payable (PENDING | EVIDENCE_OK), and for sequential engagements every earlier
// milestone is PAID. Invoice-printed references are hints only and are not read here.
// Context faults (malformed engagement, ctx.milestone disagreeing with the signed entry) => HOLD KERNEL_ERROR.
import { EngagementSchema, computeTermsHash, epochSecondsFromIso, jcs } from "@symbolon/schemas";
import type { CheckResult, Engagement, Milestone, PaymentIntent } from "@symbolon/schemas";
import type { KernelContext } from "../context";
import type { Facts } from "../facts";
import { combine, fail, kernelError } from "../verdict";
import type { Issue } from "../verdict";

const inactive = (detail: string): Issue => ({ onFail: "REJECT", code: "ENGAGEMENT_INACTIVE", detail });

function registrationIssues(e: Engagement, ctx: KernelContext): Issue[] {
  const issues: Issue[] = [];
  if (e.status !== "ACTIVE") issues.push(inactive(`engagement status is ${e.status}`));
  if (e.ownerSig === null || e.payeeSig === null) issues.push(inactive("engagement is not signed by both owner and payee"));
  if (e.registeredTx === null) issues.push(inactive("engagement has no on-chain registration tx"));
  if (computeTermsHash(e) !== e.termsHash) issues.push(inactive("loaded terms do not hash to engagement.termsHash"));
  const chain = ctx.engagementOnChain;
  if (chain === null) {
    issues.push(inactive("no on-chain EngagementRegistered record for this engagement"));
  } else {
    if (chain.engagementId !== e.engagementId) issues.push(inactive("on-chain record is for another engagement"));
    if (!chain.active) issues.push(inactive("engagement is closed on chain"));
    if (chain.termsHash !== e.termsHash) issues.push(inactive("on-chain termsHash differs from the loaded terms"));
    if (chain.capBaseUnits !== BigInt(e.capBaseUnits)) issues.push(inactive("on-chain cap differs from the loaded terms"));
    if (chain.start !== e.start || chain.end !== e.end) issues.push(inactive("on-chain window differs from the loaded terms"));
  }
  return issues;
}

export function milestoneStatusIssue(m: Milestone): Issue | null {
  switch (m.status) {
    case "PENDING":
    case "EVIDENCE_OK":
      return null;
    case "PAID":
      return { onFail: "REJECT", code: "MILESTONE_ALREADY_PAID", detail: "milestone status is PAID" };
    case "DISPUTED":
    case "CANCELLED":
      return inactive(`milestone status is ${m.status}`);
    default: {
      const unknown: never = m.status;
      void unknown;
      return inactive("milestone status is unknown");
    }
  }
}

export function checkK05(intent: PaymentIntent, ctx: KernelContext, facts: Facts): CheckResult {
  const e = facts.engagement;
  if (intent.engagementId === null || e === null) {
    return fail("K-05", "REJECT", "NO_ENGAGEMENT", "no engagement of this tenant matches intent.engagementId");
  }
  if (!EngagementSchema.safeParse(e).success) return kernelError("K-05", "ctx.engagement does not satisfy EngagementSchema");

  const issues = registrationIssues(e, ctx);
  const now = epochSecondsFromIso(ctx.now);
  if (now < epochSecondsFromIso(e.start) || now > epochSecondsFromIso(e.end)) {
    issues.push({ onFail: "REJECT", code: "OUT_OF_WINDOW", detail: `now ${ctx.now} is outside [${e.start}, ${e.end}]` });
  }

  const m = facts.milestoneTerms;
  if (intent.milestoneId === null || m === null) {
    issues.push({ onFail: "REJECT", code: "UNKNOWN_MILESTONE", detail: "intent.milestoneId is not a milestone of this engagement" });
    return combine("K-05", issues, "");
  }
  if (ctx.milestone === null || jcs(ctx.milestone) !== jcs(m)) {
    issues.push({ onFail: "HOLD", code: "KERNEL_ERROR", detail: "ctx.milestone differs from the engagement's milestone entry" });
  }
  const status = milestoneStatusIssue(m);
  if (status !== null) issues.push(status);
  if (e.sequential) {
    const index = e.milestones.indexOf(m);
    const unpaid = e.milestones.slice(0, index).filter((x) => x.status !== "PAID");
    if (unpaid.length > 0) issues.push({ onFail: "REJECT", code: "MILESTONE_ORDER", detail: `${unpaid.length} earlier milestone(s) not PAID` });
  }
  return combine("K-05", issues, "engagement active, signed, registered on chain with matching terms; milestone payable");
}
