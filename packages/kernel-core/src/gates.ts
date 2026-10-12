// The two verdict gates that run after every check (docs/04 §1 and K-12; WP-05). Both work issue by issue on the
// CheckResults (verdict.ts issuesOf), so they can only make a finding non-blocking when a human signed for THAT finding,
// or turn an escalation into a hold; they never remove a HOLD or REJECT finding and never produce a RELEASE on their own.
//
// 1. Owner-approval gate (docs/04 §1: ESCALATE "needs a human ... no money moves until owner signs OwnerApproval").
//    The approval resolves only what the owner saw. It is BOUND when: ctx.approvedEscalation exists (the escalated
//    decision the service found in this intent's supersedes chain) and its receiptHash equals OwnerApproval.receiptHash;
//    the approval is for this intentId (bound); its amount equals THIS evaluation's release amount; its deadline is
//    still in the future. A bound approval resolves exactly the ESCALATE findings whose (checkId, code) appear in
//    approvedEscalation.findings; any other ESCALATE (a new anomaly, a payee-change claim, a different check after a
//    TOCTOU re-evaluation) stays ESCALATE and needs a new approval. A missing or mismatched receiptHash resolves nothing.
//    Never resolvable, even if listed (NEVER_APPROVABLE): CREDIT_NOTE (never an outbound payment, docs/04 K-03) and
//    ADDRESS_CHANGE_CLAIMED (an address change happens only through the on-chain PayeeChange path with three signatures
//    and the delay, docs/04 K-06). HOLD and REJECT findings are never resolved. Resolved findings stay in the receipt
//    as a PASS carrying their code. An approval for amount X never releases X+1 or another intent.
// 2. Escalation-budget gate (K-12 v2, RT-14). If the verdict would still be ESCALATE and today's escalations already
//    meet policy.escalation (maxPerDay, or maxPerEngagementPerDay for this engagement), every ESCALATE finding is
//    re-emitted as HOLD (same code) and K-12 records HOLD ESCALATION_BUDGET_EXCEEDED first: no prompt is raised, the
//    item goes into one ranked digest (digest.ts). REJECTs do not consume budget (the service counts ESCALATE only).
import { CHECK_IDS, EIP712_MESSAGE_SCHEMAS, REASON_CODES, epochSecondsFromIso } from "@symbolon/schemas";
import type { CheckId, CheckResult, Hex32, ReasonCode } from "@symbolon/schemas";
import type { LoadedPolicy } from "@symbolon/policy";
import type { FindingRef, KernelContext } from "./context";
import type { Facts } from "./facts";
import { aggregate, combine, fail, issuesOf, note } from "./verdict";
import type { Issue } from "./verdict";

/** Findings an owner approval can never resolve (docs/04 K-03, K-06). */
export const NEVER_APPROVABLE: ReadonlySet<ReasonCode> = new Set<ReasonCode>(["CREDIT_NOTE", "ADDRESS_CHANGE_CLAIMED"]);

export interface ApprovalStatus {
  readonly present: boolean;
  /** true only when the approval binds this intent, the approved escalation receipt, this release amount and an unexpired deadline. */
  readonly valid: boolean;
  /** Kernel-written reason when present but not valid. */
  readonly reason: string;
  /** "K-nn:CODE" keys of the findings a valid approval resolves; empty when not valid. */
  readonly approved: ReadonlySet<string>;
}

export const findingKey = (checkId: CheckId, code: ReasonCode): string => `${checkId}:${code}`;

const HEX32 = /^0x[0-9a-f]{64}$/;

function approvedKeys(ctx: KernelContext): ReadonlySet<string> | null {
  const e = ctx.approvedEscalation;
  if (e === null || typeof e !== "object" || typeof e.receiptHash !== "string" || !HEX32.test(e.receiptHash) || !Array.isArray(e.findings)) return null;
  const keys = new Set<string>();
  for (const f of e.findings as readonly FindingRef[]) {
    if (typeof f !== "object" || f === null || !(CHECK_IDS as readonly string[]).includes(f.checkId) || !(REASON_CODES as readonly string[]).includes(f.code)) return null;
    keys.add(findingKey(f.checkId, f.code));
  }
  return keys;
}

/** Does ctx.ownerApproval bind this evaluation? `releaseAmount` is what would be attested (null = unknown). */
export function approvalStatus(ctx: KernelContext, facts: Facts, releaseAmount: bigint | null): ApprovalStatus {
  const none: ReadonlySet<string> = new Set();
  const a = ctx.ownerApproval;
  if (a === null) return { present: false, valid: false, reason: "no owner approval", approved: none };
  const invalid = (reason: string): ApprovalStatus => ({ present: true, valid: false, reason, approved: none });
  if (!EIP712_MESSAGE_SCHEMAS.OwnerApproval.safeParse(a).success) return invalid("owner approval is malformed");
  const keys = approvedKeys(ctx);
  if (keys === null) return invalid("no well-formed approved escalation record for this approval");
  if (a.receiptHash !== (ctx.approvedEscalation as NonNullable<KernelContext["approvedEscalation"]>).receiptHash) return invalid("owner approval is for another escalation receipt");
  if (!facts.intentIdBound || a.intentId !== facts.intentId) return invalid("owner approval is for another intent");
  if (releaseAmount === null) return invalid("the release amount is not known, so no approval can bind it");
  if (a.amount !== releaseAmount.toString()) return invalid(`owner approval amount ${a.amount} differs from the release amount ${releaseAmount}`);
  if (BigInt(a.deadline) <= epochSecondsFromIso(ctx.now)) return invalid("owner approval deadline has passed");
  return { present: true, valid: true, reason: "owner approval binds the escalation receipt, intentId, amount and deadline", approved: keys };
}

/** The ESCALATE findings of these checks that an owner approval could resolve (listed for the ApprovalView). */
export function approvableFindings(checks: readonly CheckResult[]): FindingRef[] {
  const out: FindingRef[] = [];
  const seen = new Set<string>();
  for (const c of checks) {
    for (const i of issuesOf(c)) {
      const key = findingKey(c.id, i.code);
      if (i.onFail !== "ESCALATE" || NEVER_APPROVABLE.has(i.code) || seen.has(key)) continue;
      seen.add(key);
      out.push({ checkId: c.id, code: i.code });
    }
  }
  return out;
}

/** Is today's escalation budget already used up (for this engagement or the tenant)? Malformed counts => met. */
export function escalationBudgetMet(ctx: KernelContext, policy: LoadedPolicy, engagementId: Hex32 | null): boolean {
  const e = ctx.escalations;
  const perEngagement = engagementId !== null && Object.hasOwn(e.todayByEngagement, engagementId) ? e.todayByEngagement[engagementId] : 0;
  if (![e.today, perEngagement].every((c) => typeof c === "number" && Number.isSafeInteger(c) && c >= 0)) return true;
  return e.today >= policy.policy.escalation.maxPerDay || (perEngagement as number) >= policy.policy.escalation.maxPerEngagementPerDay;
}

function approvalGate(checks: readonly CheckResult[], approval: ApprovalStatus): CheckResult[] {
  if (!approval.valid) return [...checks];
  return checks.map((c) => {
    const issues = issuesOf(c);
    const resolves = (i: Issue): boolean => i.onFail === "ESCALATE" && !NEVER_APPROVABLE.has(i.code) && approval.approved.has(findingKey(c.id, i.code));
    const resolved = issues.filter(resolves);
    if (resolved.length === 0) return c;
    const remaining = issues.filter((i) => !resolves(i));
    if (remaining.length > 0) return combine(c.id, remaining, "");
    return note(c.id, (resolved[0] as Issue).code, `resolved by a bound owner approval: ${resolved.map((i) => i.code).join(", ")}`, c.refs);
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
export function applyGates(checks: readonly CheckResult[], required: readonly CheckId[], input: GateInput): CheckResult[] {
  const approved = approvalGate(checks, input.approval);
  if (!input.budgetMet || aggregate(approved, required).verdict !== "ESCALATE") return approved;
  const held = budgetGate(approved);
  return held.some((c) => c.id === "K-12") ? held : [...held, fail("K-12", "HOLD", "ESCALATION_BUDGET_EXCEEDED", "today's escalation budget is used up")];
}
