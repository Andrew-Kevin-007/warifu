// K-12 AUTHORITY_ENVELOPE — REJECT (hard caps) / ESCALATE (human gate) — P0 (docs/04 K-12; WP-05).
// Amount tested: the GROSS invoiced amount (>= any discounted release amount: conservative, and the same number for
// every plan). Totals include decided-but-unsettled releases and are rolling windows (context.ts ReleasedTotals).
//   gross > perTxHardCap                                     => REJECT CAP_PER_TX
//   tenantDay + gross > dailyCap / tenantWeek + gross > weekly => REJECT CAP_DAILY / CAP_WEEKLY
//   payee count, tenant count or payee amount over velocity   => REJECT VELOCITY (defeats ATK-14 splitting)
//   category month + gross > budget, or no budget for it      => ESCALATE CATEGORY_BUDGET
//   gross > humanApprovalAbove                                 => ESCALATE HUMAN_REQUIRED
//   first payment to this payee: gross > firstPaymentMax       => ESCALATE FIRST_PAYMENT_LARGE;
//                                and newPayee.alwaysHuman      => ESCALATE HUMAN_REQUIRED
// Every ESCALATE here is resolved only by a BOUND owner approval (gates.ts); the escalation budget (RT-14) is applied
// by the budget gate after every check has run, because only then is the would-be verdict known. The hourly cap is not
// checked here (no reason code; the vault enforces it, docs/QUESTIONS.md "WP-05").
import type { CheckResult } from "@symbolon/schemas";
import { categoryBudget } from "@symbolon/policy";
import type { LoadedPolicy } from "@symbolon/policy";
import type { KernelContext } from "../context";
import type { Facts } from "../facts";
import type { ApprovalStatus } from "../gates";
import { combine, fail, kernelError } from "../verdict";
import type { Issue } from "../verdict";

const isAmount = (v: unknown): v is bigint => typeof v === "bigint" && v >= 0n;
const isCount = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;

export function checkK12(ctx: KernelContext, policy: LoadedPolicy, facts: Facts, approval: ApprovalStatus): CheckResult {
  const gross = facts.gross;
  if (gross === null) return fail("K-12", "ESCALATE", "AMOUNT_AMBIGUOUS", "the authority envelope cannot be evaluated without a determinable amount");
  const r = ctx.released;
  const h = ctx.payeeHistory;
  const category = facts.milestoneTerms === null ? null : facts.milestoneTerms.category;
  const spentRaw = category !== null && Object.hasOwn(r.categoryMonth, category) ? r.categoryMonth[category] : 0n;
  if (![r.tenantDay, r.tenantWeek, r.payeeDay, spentRaw].every(isAmount) || ![r.payeeCountDay, r.tenantCountDay, h.priorPayments].every(isCount)) {
    return kernelError("K-12", "released totals or payee history are malformed");
  }
  const spent = spentRaw as bigint;
  const a = policy.amounts;
  const v = policy.policy.velocity;
  const issues: Issue[] = [];
  if (gross > a.perTxHardCap) issues.push({ onFail: "REJECT", code: "CAP_PER_TX", detail: `gross ${gross} > perTxHardCap ${a.perTxHardCap}` });
  if (r.tenantDay + gross > a.dailyCap) issues.push({ onFail: "REJECT", code: "CAP_DAILY", detail: `rolling 24 h ${r.tenantDay} + ${gross} > dailyCap ${a.dailyCap}` });
  if (r.tenantWeek + gross > a.weeklyCap) issues.push({ onFail: "REJECT", code: "CAP_WEEKLY", detail: `rolling 7 d ${r.tenantWeek} + ${gross} > weeklyCap ${a.weeklyCap}` });
  if (r.payeeCountDay + 1 > v.maxReleasesPerPayeePerDay) issues.push({ onFail: "REJECT", code: "VELOCITY", detail: `payee releases in 24 h would be ${r.payeeCountDay + 1} > ${v.maxReleasesPerPayeePerDay}` });
  if (r.tenantCountDay + 1 > v.maxReleasesPerDay) issues.push({ onFail: "REJECT", code: "VELOCITY", detail: `tenant releases in 24 h would be ${r.tenantCountDay + 1} > ${v.maxReleasesPerDay}` });
  if (r.payeeDay + gross > a.maxAmountPerPayeePerDay) issues.push({ onFail: "REJECT", code: "VELOCITY", detail: `payee 24 h ${r.payeeDay} + ${gross} > ${a.maxAmountPerPayeePerDay}` });
  if (category !== null) {
    const budget = categoryBudget(policy, category);
    if (budget === undefined) issues.push({ onFail: "ESCALATE", code: "CATEGORY_BUDGET", detail: `no monthly budget for category ${category}` });
    else if (spent + gross > budget) issues.push({ onFail: "ESCALATE", code: "CATEGORY_BUDGET", detail: `category ${category} month ${spent} + ${gross} > ${budget}` });
  }
  const approvalNote = approval.present ? ` (${approval.reason})` : "";
  if (gross > a.humanApprovalAbove) issues.push({ onFail: "ESCALATE", code: "HUMAN_REQUIRED", detail: `gross ${gross} > humanApprovalAbove ${a.humanApprovalAbove}${approvalNote}` });
  if (h.priorPayments === 0) {
    if (gross > a.firstPaymentMax) issues.push({ onFail: "ESCALATE", code: "FIRST_PAYMENT_LARGE", detail: `first payment to this payee: ${gross} > ${a.firstPaymentMax}${approvalNote}` });
    if (policy.policy.newPayee.alwaysHuman) issues.push({ onFail: "ESCALATE", code: "HUMAN_REQUIRED", detail: `first payment to this payee always needs the owner${approvalNote}` });
  }
  return combine("K-12", issues, "within caps, velocity, category budget and the human gate");
}
