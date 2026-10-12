// K-14 LIQUIDITY_AND_TIMING (+ TERMS BINDING) — HOLD / ESCALATE — P0 (docs/04 K-14, INV-19; RT-15; WP-05).
// Terms come ONLY from the signed engagement (facts.engagement.paymentTerms, inside termsHash); null => policy
// defaults (timing.defaultNetDays, no discount). Invoice-stated terms (both extractions) are compared, never adopted:
//   stated early-pay discount, signed terms have none        => ESCALATE TERMS_NOT_SIGNED
//   stated netDays or early-pay differ (either direction)     => ESCALATE TERMS_MISMATCH
//   ambiguous terms, unless the invoice states no terms at all => ESCALATE TERMS_MISMATCH
// The invoice's printed due date is never read. First evaluation: the schedule (src/schedule.ts) must have a safe
// payable plan, else HOLD (EVIDENCE_MISSING when the evidence precondition is not met, LIQUIDITY otherwise); the
// scheduled amount must keep the reserve floor (vaultAvailable - pendingReleases >= amountDue + reserve floor).
// Timing flags (PLAN_OUT_OF_ENVELOPE, TIMING_CLAMPED, LATE) are recorded as a PASS code, never a hold.
// TOCTOU re-evaluation (docs/04 §5): payAt = max(now, scheduled payAt); if the scheduled payAt was inside the
// discount window, the window has closed by now and the scheduled amount is no longer amountDue => ESCALATE
// DISCOUNT_WINDOW_CLOSED (owner decides; never a silent switch). Liquidity is re-checked at amountDue(payAt).
import { epochSecondsFromIso, jcs } from "@symbolon/schemas";
import type { CheckResult, ExtractedInvoice, PaymentIntent } from "@symbolon/schemas";
import type { LoadedPolicy } from "@symbolon/policy";
import { effectiveTerms } from "@symbolon/terms";
import type { EffectiveTerms } from "@symbolon/terms";
import type { KernelContext } from "../context";
import type { Facts } from "../facts";
import type { Result } from "../result";
import type { Schedule } from "../schedule";
import { combine, fail, kernelError, note } from "../verdict";
import type { Issue } from "../verdict";

/** Terms-binding findings for one extraction's statedTerms against the effective (signed or default) terms. */
export function termsIssues(stated: ExtractedInvoice["statedTerms"], terms: EffectiveTerms, which: string): Issue[] {
  const issues: Issue[] = [];
  const signed = terms.signed ? "signed" : "default (no signed terms)";
  const early = stated.earlyPay;
  if (early !== null) {
    if (terms.earlyPay === null) {
      issues.push({ onFail: "ESCALATE", code: "TERMS_NOT_SIGNED", detail: `extraction ${which}: the invoice states an early-pay discount that the ${signed} terms do not contain` });
    } else if (early.discountBps !== terms.earlyPay.discountBps || early.withinDays !== terms.earlyPay.withinDays) {
      issues.push({ onFail: "ESCALATE", code: "TERMS_MISMATCH", detail: `extraction ${which}: stated early-pay terms differ from the ${signed} terms` });
    }
  }
  if (stated.netDays !== null && stated.netDays !== terms.netDays) {
    issues.push({ onFail: "ESCALATE", code: "TERMS_MISMATCH", detail: `extraction ${which}: stated net days differ from the ${signed} terms` });
  }
  const statesNothing = stated.raw === null && stated.netDays === null && early === null;
  if (stated.ambiguous && !statesNothing) {
    issues.push({ onFail: "ESCALATE", code: "TERMS_MISMATCH", detail: `extraction ${which}: the invoice's terms are ambiguous` });
  }
  return issues;
}

function liquidityIssue(ctx: KernelContext, policy: LoadedPolicy, amount: bigint): Issue | null {
  const headroom = ctx.balances.vaultAvailable - ctx.balances.pendingReleases;
  if (headroom >= amount + policy.amounts.reserveFloor) return null;
  return { onFail: "HOLD", code: "LIQUIDITY", detail: `vaultAvailable - pendingReleases ${headroom} < amountDue ${amount} + reserve floor ${policy.amounts.reserveFloor}` };
}

export function checkK14(intent: PaymentIntent, ctx: KernelContext, policy: LoadedPolicy, facts: Facts, schedule: Result<Schedule>): CheckResult {
  const e = facts.engagement;
  if (e === null) return fail("K-14", "REJECT", "NO_ENGAGEMENT", "no engagement whose terms could schedule a payment");
  if (facts.milestoneTerms === null) return fail("K-14", "REJECT", "UNKNOWN_MILESTONE", "no signed milestone to schedule");
  const gross = facts.gross;
  if (gross === null) return fail("K-14", "ESCALATE", "AMOUNT_AMBIGUOUS", "gross amount is not determinable; nothing can be scheduled");
  if (jcs(ctx.paymentTerms) !== jcs(e.paymentTerms)) return kernelError("K-14", "ctx.paymentTerms differ from the signed engagement paymentTerms (INV-19)");
  const terms = effectiveTerms(e.paymentTerms, policy.policy.timing);
  if (!terms.ok) return kernelError("K-14", `effective terms: ${terms.error.code}`);

  const issues: Issue[] = [];
  const extractions = intent.extraction.b === null ? [intent.extraction.a] : [intent.extraction.a, intent.extraction.b];
  extractions.forEach((x, i) => issues.push(...termsIssues(x.statedTerms, terms.value, i === 0 ? "A" : "B")));

  const r = facts.release;
  if (r !== null) {
    if (!r.expected.ok) {
      issues.push({ onFail: "HOLD", code: "KERNEL_ERROR", detail: "amountDue at payAt is not computable from the signed terms" });
      return combine("K-14", issues, "");
    }
    const due = r.expected.value;
    const scheduledInWindow = due.windowEnd !== null && epochSecondsFromIso(r.scheduledPayAt) <= epochSecondsFromIso(due.windowEnd);
    if (scheduledInWindow && !due.discountApplied && r.scheduledAmount !== due.amountDue) {
      issues.push({ onFail: "ESCALATE", code: "DISCOUNT_WINDOW_CLOSED", detail: `the discount window closed at ${due.windowEnd}; the scheduled ${r.scheduledAmount} is no longer amountDue(${r.payAt}) ${due.amountDue}` });
    }
    const liquidity = liquidityIssue(ctx, policy, due.amountDue);
    if (liquidity !== null) issues.push(liquidity);
    return combine("K-14", issues, `re-evaluated at ${r.payAt}: amountDue ${due.amountDue}, liquidity ok`, [`payAt:${r.payAt}`]);
  }

  if (!schedule.ok) {
    issues.push({ onFail: "HOLD", code: "KERNEL_ERROR", detail: `no schedule: ${schedule.error.message}` });
    return combine("K-14", issues, "");
  }
  const s = schedule.value;
  const chosen = s.chosen;
  if (chosen === null) {
    issues.push(
      s.planSet.window === null
        ? { onFail: "HOLD", code: "EVIDENCE_MISSING", detail: "no payment time: the evidence precondition is not satisfied" }
        : { onFail: "HOLD", code: "LIQUIDITY", detail: "no feasible plan keeps the reserve floor" },
    );
    return combine("K-14", issues, "");
  }
  const liquidity = liquidityIssue(ctx, policy, BigInt(chosen.amountDue));
  if (liquidity !== null) issues.push(liquidity);
  const refs = [`plan:${chosen.planId}`, `payAt:${chosen.payAt}`];
  const detail = `${s.detail}; payAt ${chosen.payAt}, amountDue ${chosen.amountDue}, timingSource ${s.timingSource}${s.plannerFallback ? ", plannerFallback" : ""}${s.flags.length > 0 ? `; flags ${s.flags.join(", ")}` : ""}`;
  const result = combine("K-14", issues, detail, refs);
  const flag = s.flags[0];
  return result.status === "PASS" && flag !== undefined ? note("K-14", flag, detail, refs) : result;
}
