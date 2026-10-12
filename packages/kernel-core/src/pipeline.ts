// The evaluation pipeline (docs/04 §3): pre-checks (K-16) -> K-01 -> derived facts -> K-02..K-14 -> aggregate.
// Every check runs even after an earlier failure (all reasons reach the receipt), except the two short-circuits:
// K-01 SCHEMA_INVALID (nothing downstream is meaningful) and K-04 REPLAY (returns the prior decision).
// Fail closed: a check that throws becomes FAIL / HOLD / KERNEL_ERROR (docs/04 §1); if the facts cannot be
// derived, every later check is KERNEL_ERROR. Not re-exported from index.ts: production code calls evaluate(),
// which always runs the full required set; tests use runPipeline to exercise the guard and subsets of checks.
import type { CheckId, CheckResult, PaymentIntent } from "@symbolon/schemas";
import type { LoadedPolicy } from "@symbolon/policy";
import { checkK01 } from "./checks/k01-schema";
import type { K01Outcome } from "./checks/k01-schema";
import { contextHash } from "./context";
import type { DecisionSummary, KernelContext } from "./context";
import type { Evaluation } from "./evaluation";
import { deriveFacts, unboundIntentId } from "./facts";
import type { Facts } from "./facts";
import { attempt } from "./result";
import { aggregate, kernelError } from "./verdict";
import { KERNEL_VERSION } from "./version";

export interface StageInput {
  readonly intent: PaymentIntent;
  readonly ctx: KernelContext;
  readonly policy: LoadedPolicy;
  readonly facts: Facts;
}

export type StageOutcome =
  | { readonly kind: "result"; readonly result: CheckResult }
  | { readonly kind: "replay"; readonly result: CheckResult; readonly replayOf: DecisionSummary };

export interface Stage {
  readonly id: CheckId;
  readonly run: (input: StageInput) => StageOutcome;
}

/** Runs before K-01, on the context alone (K-16 breaker pre-check). */
export interface PreStage {
  readonly id: CheckId;
  readonly run: (ctx: KernelContext, policy: LoadedPolicy) => CheckResult;
}

export interface PipelineConfig {
  readonly pre: readonly PreStage[];
  readonly stages: readonly Stage[];
  /** Checks that must all be present (exactly once) for a RELEASE. */
  readonly required: readonly CheckId[];
}

export const asResult = (result: CheckResult): StageOutcome => ({ kind: "result", result });

const THREW = "check raised an internal error; failing closed";

function runPre(stage: PreStage, ctx: KernelContext, policy: LoadedPolicy): CheckResult {
  try {
    return stage.run(ctx, policy);
  } catch {
    return kernelError(stage.id, THREW);
  }
}

function runK01(raw: unknown, ctx: KernelContext, policy: LoadedPolicy): K01Outcome {
  try {
    return checkK01(raw, ctx, policy);
  } catch {
    return { result: kernelError("K-01", THREW), intent: null };
  }
}

function runStage(stage: Stage, input: StageInput): StageOutcome {
  try {
    return stage.run(input);
  } catch {
    return asResult(kernelError(stage.id, THREW));
  }
}

interface Derived {
  readonly intent: PaymentIntent | null;
  readonly facts: Facts | null;
  readonly replayOf: DecisionSummary | null;
}

function finish(config: PipelineConfig, checks: readonly CheckResult[], ctx: KernelContext, policy: LoadedPolicy, d: Derived): Evaluation {
  const agg = d.replayOf === null ? aggregate(checks, config.required) : { verdict: "REPLAY" as const, reasons: [] };
  const hash = contextHash(ctx);
  const f = d.facts;
  const release = f === null ? null : f.release;
  return {
    verdict: agg.verdict,
    checks,
    reasons: agg.reasons,
    intentId: f === null ? unboundIntentId(ctx) : f.intentId,
    intentIdBound: f !== null && f.intentIdBound,
    normInvoiceNo: f === null ? null : f.normInvoiceNo,
    docHash: ctx.doc.hash,
    engagementId: d.intent === null ? null : d.intent.engagementId,
    milestoneId: d.intent === null ? null : d.intent.milestoneId,
    payee: f === null ? null : f.payout,
    amountBaseUnits: f === null || f.gross === null ? null : f.gross.toString(),
    releaseAmountBaseUnits: release === null || !release.expected.ok ? null : release.expected.value.amountDue.toString(),
    payAt: release === null ? null : release.payAt,
    invoiceReceivedAt: ctx.invoiceReceivedAt,
    replayOf: d.replayOf,
    contextHash: hash.ok ? hash.value : null,
    policyHash: policy.policyHash,
    kernelVersion: KERNEL_VERSION,
  };
}

export function runPipeline(config: PipelineConfig, raw: unknown, ctx: KernelContext, policy: LoadedPolicy): Evaluation {
  const checks: CheckResult[] = config.pre.map((p) => runPre(p, ctx, policy));
  const k01 = runK01(raw, ctx, policy);
  checks.push(k01.result);
  const intent = k01.intent;
  if (intent === null) return finish(config, checks, ctx, policy, { intent: null, facts: null, replayOf: null });

  const derived = attempt(() => deriveFacts(intent, ctx, policy), "INTERNAL", "facts not derivable");
  if (!derived.ok) {
    for (const s of config.stages) checks.push(kernelError(s.id, "facts could not be derived from the intent and context; failing closed"));
    return finish(config, checks, ctx, policy, { intent, facts: null, replayOf: null });
  }
  const facts = derived.value;
  for (const s of config.stages) {
    const out = runStage(s, { intent, ctx, policy, facts });
    checks.push(out.result);
    if (out.kind === "replay") return finish(config, checks, ctx, policy, { intent, facts, replayOf: out.replayOf });
  }
  return finish(config, checks, ctx, policy, { intent, facts, replayOf: null });
}
