// The kernel-side gates the planner eval composes with the planner (WP-35). These are an EVAL-SIDE MIRROR of two
// real checks, kept here because packages/extractor may import only schemas and terms (INV-8; kernel-core is not
// imported by LLM code, and the reverse is forbidden):
//   * K-14 terms binding: invoice-stated terms are COMPARED with the signed (effective) terms, never adopted
//     (packages/kernel-core/src/checks/k14-timing.ts termsIssues; INV-19);
//   * K-04 duplicate: a re-sent invoice for an already-paid milestone is REJECTed (replay/duplicate class).
// The real kernel is exercised end to end by the attack suite; this mirror only lets the planner eval say what the
// kernel would have done with a trap. If k14-timing.ts changes, update this file (the planner tests pin each rule).
import type { EffectiveTerms } from "@symbolon/terms";
import type { StatedTermsStatus } from "../../src/planner";
import type { StatedTerms } from "./scenarios";

/** Compare the invoice's stated terms with the effective terms, as K-14 does. Priority: NOT_SIGNED, DIFFERS, AMBIGUOUS. */
export function statedTermsStatus(stated: StatedTerms, terms: EffectiveTerms): StatedTermsStatus {
  const early = stated.earlyPay;
  if (early !== null && terms.earlyPay === null) return "NOT_SIGNED";
  let differs = false;
  if (early !== null && terms.earlyPay !== null && (early.discountBps !== terms.earlyPay.discountBps || early.withinDays !== terms.earlyPay.withinDays)) differs = true;
  if (stated.netDays !== null && stated.netDays !== terms.netDays) differs = true;
  if (differs) return "DIFFERS";
  // An ambiguous statement always has raw text behind it, so "states nothing" requires ambiguous=false.
  if (stated.ambiguous) return "AMBIGUOUS";
  return stated.netDays === null && early === null ? "NONE" : "MATCH";
}

export type KernelGate = "OPEN" | "ESCALATE" | "REJECT";

export function kernelGate(status: StatedTermsStatus, duplicateOfPaid: boolean): KernelGate {
  if (duplicateOfPaid) return "REJECT";
  return status === "NOT_SIGNED" || status === "DIFFERS" || status === "AMBIGUOUS" ? "ESCALATE" : "OPEN";
}
