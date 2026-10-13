// evaluate(intent, ctx, policy) -> Evaluation (docs/04): pure and deterministic; same input => deep-equal output.
// It never throws: anything unexpected yields HOLD with KERNEL_ERROR on every required check.
import type { LoadedPolicy } from "@symbolon/policy";
import { checkK02 } from "./checks/k02-precision";
import { checkK03 } from "./checks/k03-doctype";
import { checkK04 } from "./checks/k04-idempotency";
import { checkK05 } from "./checks/k05-engagement";
import { checkK06 } from "./checks/k06-payee";
import { checkK07 } from "./checks/k07-currency";
import { checkK08 } from "./checks/k08-amount";
import { checkK09 } from "./checks/k09-evidence";
import { checkK10 } from "./checks/k10-consensus";
import { checkK11 } from "./checks/k11-instruction";
import { checkK12 } from "./checks/k12-authority";
import { checkK13 } from "./checks/k13-screening";
import { checkK14 } from "./checks/k14-timing";
import { checkK16 } from "./checks/k16-breaker";
import type { KernelContext } from "./context";
import type { Evaluation } from "./evaluation";
import { unboundIntentId } from "./facts";
import { PATTERNS_VERSION } from "./patterns";
import { asResult, runPipeline } from "./pipeline";
import type { PipelineConfig } from "./pipeline";
import { EVALUATION_ORDER, aggregate, kernelError } from "./verdict";
import { KERNEL_VERSION } from "./version";

/** Every check of docs/04 §3 (K-15 is post-settlement, outside evaluate()). */
export const KERNEL_PIPELINE: PipelineConfig = Object.freeze({
  pre: [{ id: "K-16", run: (ctx: KernelContext) => checkK16(ctx) }],
  stages: [
    { id: "K-02", run: ({ intent, facts }) => asResult(checkK02(intent, facts)) },
    { id: "K-03", run: ({ intent, facts }) => asResult(checkK03(intent, facts)) },
    { id: "K-04", run: ({ intent, ctx, facts }) => checkK04(intent, ctx, facts) },
    { id: "K-05", run: ({ intent, ctx, facts }) => asResult(checkK05(intent, ctx, facts)) },
    { id: "K-06", run: ({ intent, ctx, facts }) => asResult(checkK06(intent, ctx, facts)) },
    { id: "K-07", run: ({ intent, ctx, policy, facts }) => asResult(checkK07(intent, ctx, policy, facts)) },
    { id: "K-08", run: ({ ctx, facts }) => asResult(checkK08(ctx, facts)) },
    { id: "K-09", run: ({ ctx, policy, facts, evidence }) => asResult(checkK09(ctx, policy, facts, evidence)) },
    { id: "K-10", run: ({ intent, policy }) => asResult(checkK10(intent, policy)) },
    { id: "K-11", run: ({ intent, ctx, facts }) => asResult(checkK11(intent, ctx, facts)) },
    { id: "K-12", run: ({ ctx, policy, facts, approval }) => asResult(checkK12(ctx, policy, facts, approval)) },
    { id: "K-13", run: ({ ctx, policy }) => asResult(checkK13(ctx, policy)) },
    { id: "K-14", run: ({ intent, ctx, policy, facts, schedule }) => asResult(checkK14(intent, ctx, policy, facts, schedule)) },
  ],
  required: EVALUATION_ORDER,
} satisfies PipelineConfig);

function safePolicyHash(policy: LoadedPolicy): Evaluation["policyHash"] {
  try {
    const h: unknown = policy.policyHash;
    return typeof h === "string" ? (h as Evaluation["policyHash"]) : null;
  } catch {
    return null;
  }
}

/** Last resort when even assembling the evaluation failed (e.g. a context that is not an object). */
function failedEvaluation(ctx: KernelContext, policy: LoadedPolicy): Evaluation {
  const checks = EVALUATION_ORDER.map((id) => kernelError(id, "kernel could not evaluate this intent; failing closed"));
  const agg = aggregate(checks, EVALUATION_ORDER);
  return {
    verdict: agg.verdict,
    checks,
    reasons: agg.reasons,
    intentId: unboundIntentId(ctx),
    intentIdBound: false,
    normInvoiceNo: null,
    docHash: null,
    engagementId: null,
    milestoneId: null,
    payee: null,
    amountBaseUnits: null,
    releaseAmountBaseUnits: null,
    payAt: null,
    timingSource: null,
    planId: null,
    plannerFallback: false,
    plans: [],
    planEvaluation: null,
    planEvaluationHash: null,
    timingFlags: [],
    invoiceReceivedAt: null,
    replayOf: null,
    approvableFindings: [],
    resolvedByApproval: [],
    humanExplanation: "On hold: the kernel could not evaluate a check (K-16 KERNEL_ERROR). Retry later; the kernel failed closed.",
    contextHash: null,
    policyHash: safePolicyHash(policy),
    kernelVersion: KERNEL_VERSION,
    patternsVersion: PATTERNS_VERSION,
  };
}

/**
 * Evaluate a raw (untrusted, unparsed) PaymentIntent against the kernel context and the loaded policy.
 * K-01 parses `rawIntent`; nothing else reads it.
 */
export function evaluate(rawIntent: unknown, ctx: KernelContext, policy: LoadedPolicy): Evaluation {
  try {
    return runPipeline(KERNEL_PIPELINE, rawIntent, ctx, policy);
  } catch {
    return failedEvaluation(ctx, policy);
  }
}
