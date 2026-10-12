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
import { pendingCheck } from "./checks/pending";
import type { KernelContext } from "./context";
import type { Evaluation } from "./evaluation";
import { unboundIntentId } from "./facts";
import { asResult, runPipeline } from "./pipeline";
import type { PipelineConfig, Stage } from "./pipeline";
import { EVALUATION_ORDER, aggregate, kernelError } from "./verdict";
import { KERNEL_VERSION } from "./version";

const pending = (id: Stage["id"]): Stage => ({ id, run: () => asResult(pendingCheck(id)) });

/** K-01..K-08 implemented (WP-04); K-16 and K-09..K-14 fail closed until WP-05. */
export const KERNEL_PIPELINE: PipelineConfig = Object.freeze({
  pre: [{ id: "K-16", run: () => pendingCheck("K-16") }],
  stages: [
    { id: "K-02", run: ({ intent, facts }) => asResult(checkK02(intent, facts)) },
    { id: "K-03", run: ({ intent, facts }) => asResult(checkK03(intent, facts)) },
    { id: "K-04", run: ({ intent, ctx, facts }) => checkK04(intent, ctx, facts) },
    { id: "K-05", run: ({ intent, ctx, facts }) => asResult(checkK05(intent, ctx, facts)) },
    { id: "K-06", run: ({ intent, ctx, facts }) => asResult(checkK06(intent, ctx, facts)) },
    { id: "K-07", run: ({ intent, ctx, policy, facts }) => asResult(checkK07(intent, ctx, policy, facts)) },
    { id: "K-08", run: ({ ctx, facts }) => asResult(checkK08(ctx, facts)) },
    pending("K-09"),
    pending("K-10"),
    pending("K-11"),
    pending("K-12"),
    pending("K-13"),
    pending("K-14"),
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
    invoiceReceivedAt: null,
    replayOf: null,
    contextHash: null,
    policyHash: safePolicyHash(policy),
    kernelVersion: KERNEL_VERSION,
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
