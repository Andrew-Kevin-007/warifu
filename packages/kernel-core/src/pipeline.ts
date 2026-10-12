// The evaluation pipeline (docs/04 §3): pre-checks (K-16) -> K-01 -> derived inputs -> K-02..K-14 -> verdict gates ->
// aggregate. Every check runs even after an earlier failure (all reasons reach the receipt), except the two
// short-circuits: K-01 SCHEMA_INVALID (nothing downstream is meaningful) and K-04 REPLAY (returns the prior decision).
// Fail closed: a check that throws becomes FAIL / HOLD / KERNEL_ERROR (docs/04 §1); if the facts cannot be derived,
// every later check is KERNEL_ERROR; derived inputs (evidence, schedule, approval) that fail become typed errors the
// checks report as KERNEL_ERROR; a gate that throws turns K-12 into KERNEL_ERROR. Not re-exported from index.ts:
// production code calls evaluate(), which always runs the full required set; tests use runPipeline.
import type { CheckId, CheckResult, PaymentIntent, ReasonCode } from "@symbolon/schemas";
import type { LoadedPolicy } from "@symbolon/policy";
import { checkK01 } from "./checks/k01-schema";
import type { K01Outcome } from "./checks/k01-schema";
import { contextHash } from "./context";
import type { DecisionSummary, FindingRef, KernelContext } from "./context";
import { assessEvidence } from "./evidence";
import type { EvidenceAssessment } from "./evidence";
import type { Evaluation } from "./evaluation";
import { explain } from "./explain/index";
import { deriveFacts, unboundIntentId } from "./facts";
import type { Facts } from "./facts";
import { applyGates, approvableFindings, approvalStatus, escalationBudgetMet, findingKey } from "./gates";
import type { ApprovalStatus } from "./gates";
import { PATTERNS_VERSION } from "./patterns";
import { attempt, err } from "./result";
import type { Result } from "./result";
import { deriveSchedule } from "./schedule";
import type { Schedule } from "./schedule";
import { aggregate, kernelError } from "./verdict";
import { KERNEL_VERSION } from "./version";

export interface StageInput {
  readonly intent: PaymentIntent;
  readonly ctx: KernelContext;
  readonly policy: LoadedPolicy;
  readonly facts: Facts;
  /** K-09's assessment of the signed evidence spec (K-14 needs when it was satisfied). */
  readonly evidence: Result<EvidenceAssessment>;
  /** First evaluation: the feasible plans and the scheduled plan. At a TOCTOU re-evaluation: an error (no re-planning). */
  readonly schedule: Result<Schedule>;
  /** Whether ctx.ownerApproval binds this evaluation (gates.ts). */
  readonly approval: ApprovalStatus;
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

/** Derived inputs shared by several checks, each computed once and never throwing. */
interface DerivedInputs {
  readonly evidence: Result<EvidenceAssessment>;
  readonly schedule: Result<Schedule>;
  readonly approval: ApprovalStatus;
  readonly budgetMet: boolean;
}

function deriveInputs(intent: PaymentIntent, ctx: KernelContext, policy: LoadedPolicy, facts: Facts): DerivedInputs {
  const e = facts.engagement;
  const m = facts.milestoneTerms;
  const evidence: Result<EvidenceAssessment> =
    e === null || m === null ? err("CONTEXT_INVALID", "no signed milestone to assess") : attempt(() => assessEvidence(m, e.owner, ctx, policy), "INTERNAL", "evidence could not be assessed");
  let schedule: Result<Schedule> = err("CONTEXT_INVALID", "a TOCTOU re-evaluation keeps the scheduled payAt");
  if (ctx.reevaluation === null) {
    const s = attempt(() => deriveSchedule(intent, ctx, policy, facts, evidence), "INTERNAL", "the schedule could not be derived from the context");
    schedule = s.ok ? s.value : s;
  }
  const releaseAmount = releaseAmountOf(ctx, facts, schedule);
  const approval = attempt(() => approvalStatus(ctx, facts, releaseAmount), "INTERNAL", "approval");
  const budget = attempt(() => escalationBudgetMet(ctx, policy, intent.engagementId), "INTERNAL", "budget");
  return {
    evidence,
    schedule,
    approval: approval.ok ? approval.value : { present: true, valid: false, reason: "owner approval could not be checked", approved: new Set() },
    budgetMet: budget.ok ? budget.value : true,
  };
}

/** The amount that would be attested: at a re-evaluation amountDue(payAt), else the scheduled plan's amountDue. */
function releaseAmountOf(ctx: KernelContext, facts: Facts, schedule: Result<Schedule>): bigint | null {
  if (ctx.reevaluation !== null) return facts.release !== null && facts.release.expected.ok ? facts.release.expected.value.amountDue : null;
  return schedule.ok && schedule.value.chosen !== null ? BigInt(schedule.value.chosen.amountDue) : null;
}

interface Derived {
  readonly intent: PaymentIntent | null;
  readonly facts: Facts | null;
  readonly inputs: DerivedInputs | null;
  readonly replayOf: DecisionSummary | null;
}

function gate(checks: readonly CheckResult[], config: PipelineConfig, inputs: DerivedInputs): CheckResult[] {
  try {
    return applyGates(checks, config.required, { approval: inputs.approval, budgetMet: inputs.budgetMet });
  } catch {
    return checks.map((c) => (c.id === "K-12" ? kernelError("K-12", "verdict gates failed; failing closed") : c));
  }
}

function finish(config: PipelineConfig, raw: readonly CheckResult[], ctx: KernelContext, policy: LoadedPolicy, d: Derived): Evaluation {
  const inputs = d.inputs;
  const gated = d.replayOf === null && inputs !== null ? gate(raw, config, inputs) : [...raw];
  const agg = d.replayOf === null ? aggregate(gated, config.required) : { verdict: "REPLAY" as const, reasons: [] as ReasonCode[] };
  const hash = contextHash(ctx);
  const f = d.facts;
  const release = f === null ? null : f.release;
  const schedule = inputs !== null && inputs.schedule.ok ? inputs.schedule.value : null;
  const chosen = schedule === null ? null : schedule.chosen;
  const approvable: FindingRef[] = d.replayOf === null && inputs !== null ? approvableFindings(raw) : [];
  const resolved = inputs !== null && inputs.approval.valid ? approvable.filter((x) => inputs.approval.approved.has(findingKey(x.checkId, x.code))) : [];
  let releaseAmount: string | null = null;
  let payAt: string | null = null;
  if (release !== null) {
    releaseAmount = release.expected.ok ? release.expected.value.amountDue.toString() : null;
    payAt = release.payAt;
  } else if (chosen !== null) {
    releaseAmount = chosen.amountDue;
    payAt = chosen.payAt;
  }
  const evaluation: Omit<Evaluation, "humanExplanation"> = {
    verdict: agg.verdict,
    checks: gated,
    reasons: agg.reasons,
    intentId: f === null ? unboundIntentId(ctx) : f.intentId,
    intentIdBound: f !== null && f.intentIdBound,
    normInvoiceNo: f === null ? null : f.normInvoiceNo,
    docHash: ctx.doc.hash,
    engagementId: d.intent === null ? null : d.intent.engagementId,
    milestoneId: d.intent === null ? null : d.intent.milestoneId,
    payee: f === null ? null : f.payout,
    amountBaseUnits: f === null || f.gross === null ? null : f.gross.toString(),
    releaseAmountBaseUnits: releaseAmount,
    payAt,
    timingSource: schedule === null ? null : schedule.timingSource,
    planId: schedule === null ? null : schedule.planId,
    plannerFallback: schedule !== null && schedule.plannerFallback,
    plans: schedule === null ? [] : schedule.planSet.plans,
    planEvaluation: schedule === null ? null : schedule.evaluation,
    planEvaluationHash: schedule === null ? null : schedule.evaluationHash,
    timingFlags: schedule === null || chosen === null ? [] : schedule.flags,
    invoiceReceivedAt: ctx.invoiceReceivedAt,
    replayOf: d.replayOf,
    approvableFindings: approvable,
    resolvedByApproval: resolved,
    contextHash: hash.ok ? hash.value : null,
    policyHash: policy.policyHash,
    kernelVersion: KERNEL_VERSION,
    patternsVersion: PATTERNS_VERSION,
  };
  return { ...evaluation, humanExplanation: explanationFor(evaluation, f) };
}

const FALLBACK_EXPLANATION = "On hold: the kernel could not render an explanation (KERNEL_ERROR). Retry later; the kernel failed closed.";

function explanationFor(e: Omit<Evaluation, "humanExplanation">, f: Facts | null): string {
  const r = attempt(
    () =>
      explain({
        verdict: e.verdict,
        checks: e.checks,
        amountBaseUnits: e.amountBaseUnits,
        releaseAmountBaseUnits: e.releaseAmountBaseUnits,
        decimals: f === null ? 6 : f.declaredDecimals,
        payee: e.payee,
        milestoneId: e.milestoneId,
        milestoneSlug: f === null || f.milestoneTerms === null ? null : f.milestoneTerms.slug,
        payAt: e.payAt,
        timingFlags: e.timingFlags,
        resolvedByApproval: e.resolvedByApproval,
      }),
    "INTERNAL",
    "explanation",
  );
  return r.ok ? r.value : FALLBACK_EXPLANATION;
}

export function runPipeline(config: PipelineConfig, raw: unknown, ctx: KernelContext, policy: LoadedPolicy): Evaluation {
  const checks: CheckResult[] = config.pre.map((p) => runPre(p, ctx, policy));
  const k01 = runK01(raw, ctx, policy);
  checks.push(k01.result);
  const intent = k01.intent;
  if (intent === null) return finish(config, checks, ctx, policy, { intent: null, facts: null, inputs: null, replayOf: null });

  const derived = attempt(() => deriveFacts(intent, ctx, policy), "INTERNAL", "facts not derivable");
  if (!derived.ok) {
    for (const s of config.stages) checks.push(kernelError(s.id, "facts could not be derived from the intent and context; failing closed"));
    return finish(config, checks, ctx, policy, { intent, facts: null, inputs: null, replayOf: null });
  }
  const facts = derived.value;
  const inputs = deriveInputs(intent, ctx, policy, facts);
  for (const s of config.stages) {
    const out = runStage(s, { intent, ctx, policy, facts, evidence: inputs.evidence, schedule: inputs.schedule, approval: inputs.approval });
    checks.push(out.result);
    if (out.kind === "replay") return finish(config, checks, ctx, policy, { intent, facts, inputs, replayOf: out.replayOf });
  }
  return finish(config, checks, ctx, policy, { intent, facts, inputs, replayOf: null });
}
