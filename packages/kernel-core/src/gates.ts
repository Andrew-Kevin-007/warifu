// The two verdict gates that run after every check (docs/04 §1 and K-12; WP-05). Both work issue by issue on the
// CheckResults (verdict.ts issuesOf), so they can only make a finding non-blocking when a human signed for it, or
// turn an escalation into a hold; they never remove a HOLD or REJECT finding and never produce a RELEASE on their own.
//
// 1. Owner-approval gate (docs/04 §1: ESCALATE "needs a human ... no money moves until owner signs OwnerApproval").
//    A BOUND approval resolves ESCALATE findings: the service has verified the owner's EIP-712 signature and that its
//    receiptHash is the escalation receipt in this intent's supersedes chain; the kernel checks the binding it can
//    see: same intentId (bound), amount equal to THIS evaluation's release amount, deadline still in the future.
//    Resolved findings stay in the receipt as a PASS carrying their code. Never resolved: CREDIT_NOTE (never an
//    outbound payment), anything that is HOLD or REJECT. An approval for amount X never releases X+1 or another intent.
// 2. Escalation-budget gate (K-12 v2, RT-14). If the verdict would still be ESCALATE and today's escalations already
//    meet policy.escalation (maxPerDay, or maxPerEngagementPerDay for this engagement), every ESCALATE finding is
//    re-emitted as HOLD (same code) and K-12 records HOLD ESCALATION_BUDGET_EXCEEDED first: no prompt is raised, the
//    item goes into one ranked digest (digest.ts). REJECTs do not consume budget (the service counts ESCALATE only).
import { EIP712_MESSAGE_SCHEMAS, epochSecondsFromIso } from "@symbolon/schemas";
import type { CheckResult, Hex32 } from "@symbolon/schemas";
import type { LoadedPolicy } from "@symbolon/policy";
import type { KernelContext } from "./context";
import type { Facts } from "./facts";
import { aggregate, combine, fail, issuesOf, note } from "./verdict";
import type { Issue } from "./verdict";

export interface ApprovalStatus {
  readonly present: boolean;
  /** true only when the approval binds this intent, this release amount and an unexpired deadline. */
  readonly valid: boolean;
  /** Kernel-written reason when present but not valid. */
  readonly reason: string;
}

/** Does ctx.ownerApproval bind this evaluation? `releaseAmount` is what would be attested (null = unknown). */
export function approvalStatus(ctx: KernelContext, facts: Facts, releaseAmount: bigint | null): ApprovalStatus {
  const a = ctx.ownerApproval;
  if (a === null) return { present: false, valid: false, reason: "no owner approval" };
  const invalid = (reason: string): ApprovalStatus => ({ present: true, valid: false, reason });
  if (!EIP712_MESSAGE_SCHEMAS.OwnerApproval.safeParse(a).success) return invalid("owner approval is malformed");
  if (!facts.intentIdBound || a.intentId !== facts.intentId) return invalid("owner approval is for another intent");
  if (releaseAmount === null) return invalid("the release amount is not known, so no approval can bind it");
  if (a.amount !== releaseAmount.toString()) return invalid(`owner approval amount ${a.amount} differs from the release amount ${releaseAmount}`);
  if (BigInt(a.deadline) <= epochSecondsFromIso(ctx.now)) return invalid("owner approval deadline has passed");
  return { present: true, valid: true, reason: "owner approval binds intentId, amount and deadline" };
}

/** Is today's escalation budget already used up (for this engagement or the tenant)? Malformed counts => met. */
export function escalationBudgetMet(ctx: KernelContext, policy: LoadedPolicy, engagementId: Hex32 | null): boolean {
  const e = ctx.escalations;
  const counts: unknown[] = [e.today];
  const perEngagement = engagementId !== null && Object.hasOwn(e.todayByEngagement, engagementId) ? e.todayByEngagement[engagementId] : 0;
  counts.push(perEngagement);
  if (!counts.every((c) => typeof c === "number" && Number.isSafeInteger(c) && c >= 0)) return true;
  return e.today >= policy.policy.escalation.maxPerDay || (perEngagement as number) >= policy.policy.escalation.maxPerEngagementPerDay;
}

const approvable = (i: Issue): boolean => i.onFail === "ESCALATE" && i.code !== "CREDIT_NOTE";

function approvalGate(checks: readonly CheckResult[], approval: ApprovalStatus): CheckResult[] {
  if (!approval.valid) return [...checks];
  return checks.map((c) => {
    const issues = issuesOf(c);
    const resolved = issues.filter(approvable);
    if (resolved.length === 0) return c;
    const remaining = issues.filter((i) => !approvable(i));
    const what = resolved.map((i) => i.code).join(", ");
    if (remaining.length > 0) return combine(c.id, remaining, "");
    return note(c.id, (resolved[0] as Issue).code, `resolved by a bound owner approval: ${what}`, c.refs);
  });
}

function budgetGate(checks: readonly CheckResult[]): CheckResult[] {
  return checks.map((c) => {
    const issues = issuesOf(c);
    const held = issues.map((i): Issue => (i.onFail === "ESCALATE" ? { ...i, onFail: "HOLD", detail: `held, not escalated (escalation budget met): ${i.detail}` } : i));
    const budget: Issue = { onFail: "HOLD", code: "ESCALATION_BUDGET_EXCEEDED", detail: "today's escalation budget is used up; this item goes into the ranked digest instead of an approval prompt" };
    if (c.id === "K-12") return combine("K-12", [budget, ...held], "");
    return issues.some((i) => i.onFail === "ESCALATE") ? combine(c.id, held, "") : c;
  });
}

export interface GateInput {
  readonly approval: ApprovalStatus;
  readonly budgetMet: boolean;
}

/** Apply the approval gate, then (if the verdict is still ESCALATE and the budget is met) the budget gate. */
export function applyGates(checks: readonly CheckResult[], required: Parameters<typeof aggregate>[1], input: GateInput): CheckResult[] {
  const approved = approvalGate(checks, input.approval);
  if (!input.budgetMet || aggregate(approved, required).verdict !== "ESCALATE") return approved;
  const held = budgetGate(approved);
  return held.some((c) => c.id === "K-12") ? held : [...held, fail("K-12", "HOLD", "ESCALATION_BUDGET_EXCEEDED", "today's escalation budget is used up")];
}
