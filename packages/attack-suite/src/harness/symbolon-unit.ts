// The `symbolon` target in UNIT mode (docs/07 §2): the real kernel pipeline (`evaluate` from kernel-core) driven
// in process with a KernelContext assembled from the fixture's scenario instance. No service, no database, no
// chain, no model.
//
// What this target is and is not (reported verbatim in results/attack-matrix.md):
//   - It runs whatever checks the merged kernel-core implements. With WP-05 merged K-01..K-14 and K-16 are real and an
//     intent can reach RELEASE; the oracle judges those releases. The plumbing that detects a fail-closed placeholder
//     (`heldByUnimplementedChecks`) stays, so a future regression to a placeholder is reported, never read as a defence.
//   - The context is built the way the service builds it: rolling 24 h / 7 d totals and counts that include
//     decided-but-unsettled releases, the escalation counts of the day (total and per engagement), the payee's payment
//     history, and sandbox evidence in the shape K-09's sandbox contract requires (payload.requirement).
//   - Engagements are the fixtures' templates, "activated" with PLACEHOLDER signatures and a placeholder
//     registration tx (K-05 checks they are present, not that they verify). They are SIMULATED, not signed.
//   - Extraction reads are the fixtures' REFERENCE reads, not model outputs.
//   - Faults (reconciler, K-15) and contract calls (ATK-17) are not part of the pure kernel; those steps are reported
//     NOT_RUN with the reason. The human-loop attacks (ATK-22 digest, ATK-23 approval rendering, ATK-24 explainer) run
//     in symbolon-human.ts against kernel-core and packages/receipts.
import { digestItem, evaluate, issueCodes, summarizeEvaluation } from "@symbolon/kernel-core";
import type { DecisionSummary, Evaluation, KernelContext } from "@symbolon/kernel-core";
import { applyPolicyOverrides, normalizePolicy } from "@symbolon/policy";
import type { LoadedPolicy } from "@symbolon/policy";
import { consensus, epochSecondsFromIso, hashJcs, inspectUntrusted, keccak256Utf8, normalizeUntrusted, untrusted } from "@symbolon/schemas";
import type { CheckId, Engagement, Evidence, ISODateTime } from "@symbolon/schemas";
import { hex32FromLabel, uuidFromLabel } from "../ids";
import { CHAIN_ID, POLICY_OVERRIDES, TENANT_ID, VAULT, evidenceFixturesFor, milestoneId, OWNER } from "../world";
import { symbolonHumanLoop } from "./symbolon-human";
import type { DecideInput, FaultOutcome, Target, TargetDecision } from "./target";
import type { SimState } from "./state";
import type { AttackStep, FaultStep } from "../types";

export const SYMBOLON_UNIT_PROVENANCE =
  "symbolon (unit mode): the real kernel-core evaluate() pipeline in process; engagements are fixture templates with PLACEHOLDER signatures (SIMULATED); extraction reads are REFERENCE reads; no model, chain or service.";

const PLACEHOLDER_SIG = `0x${"11".repeat(65)}` as const;
const NOT_IMPLEMENTED_PREFIX = "check not implemented";

let policyCache: LoadedPolicy | null = null;
/** Effective sandbox policy: the docs/04 §7 shape with the scenario overrides applied (docs/15 §2). */
export function sandboxPolicy(): LoadedPolicy {
  policyCache ??= applyPolicyOverrides(
    normalizePolicy({
      version: 1,
      tenant: "challenge-sandbox",
      currency: { code: "USDC", decimals: 6, treatUsdAsUsdc: true },
      caps: { perTxHardCap: "2000", dailyCap: "5000", weeklyCap: "10000", humanApprovalAbove: "1500" },
      categories: { design: "150.000000", dev: "300.000000", tools: "100.000000" },
    }),
    POLICY_OVERRIDES,
  );
  return policyCache;
}

function activatedEngagement(state: SimState): Engagement {
  const t = state.world.template.engagement;
  return {
    ...t,
    status: "ACTIVE",
    ownerSig: PLACEHOLDER_SIG,
    payeeSig: PLACEHOLDER_SIG,
    registeredTx: hex32FromLabel(`registered/${state.world.scenarioId}`),
    milestones: t.milestones.map((m) => ({ ...m, status: state.milestoneStatus.get(m.slug) ?? m.status })),
  };
}

/**
 * Sandbox evidence exactly as K-09's sandbox contract wants it (kernel-core/src/evidence.ts header): source
 * `fixture:<id>`, `collectedBy` 'kernel', and `payload.requirement` JCS-equal to the signed spec entry the fixture
 * satisfies; the fixture's `result` is authoritative. Fixtures not yet available (`availableAt` after now) are absent.
 */
function evidenceFor(state: SimState, now: ISODateTime): Evidence[] {
  return evidenceFixturesFor(state.world, state.evidencePlan)
    .filter((f) => f.availableAt === null || f.availableAt <= now)
    .map((f) => {
      const fixturePayload: unknown = f.payload;
      const body = typeof fixturePayload === "object" && fixturePayload !== null && !Array.isArray(fixturePayload) ? (fixturePayload as Record<string, unknown>) : { value: fixturePayload };
      const payload = { ...body, requirement: f.requirement };
      return {
        evidenceId: uuidFromLabel(`evidence/${f.fixtureId}`),
        milestoneId: f.milestoneId,
        type: f.requirement.type,
        collectedBy: "kernel" as const,
        collectedAt: now,
        source: `fixture:${f.fixtureId}`,
        payload,
        payloadHash: hashJcs(payload),
        result: f.result,
        details: untrusted(f.details),
      };
    });
}

const DAY = 86_400n;
const WEEK = 7n * DAY;

// Totals as the service computes them (services/kernel/src/db/repo.ts loadReleasedTotals): a RELEASE decision is dated by
// its payAt with NO upper bound, so "a payment scheduled for tomorrow still counts today" (docs/04 s2 race guard). An
// earlier version of this file also required payAt <= now, which let a split attack (ATK-14 adaptive) sail under the
// velocity limit because every slice is scheduled in the future; oracle O5 caught it (docs/QUESTIONS WP-36).
function releasedTotals(state: SimState, now: ISODateTime): KernelContext["released"] {
  const at = epochSecondsFromIso(now);
  const inWindow = (time: string, window: bigint): boolean => epochSecondsFromIso(time) > at - window;
  const rs = state.releases;
  const category: Record<string, bigint> = Object.fromEntries(state.categoryBaseline);
  for (const r of rs) {
    const m = state.world.template.milestones.find((x) => x.milestoneId === r.milestoneId);
    if (m !== undefined && r.time.slice(0, 7) >= now.slice(0, 7)) category[m.category] = (category[m.category] ?? 0n) + r.amount;
  }
  const payeeDay = rs.filter((r) => r.payee.toLowerCase() === state.world.payee.toLowerCase() && inWindow(r.time, DAY));
  return {
    engagementTotal: rs.reduce((s, r) => s + r.amount, 0n),
    tenantDay: rs.filter((r) => inWindow(r.time, DAY)).reduce((s, r) => s + r.amount, 0n),
    tenantCountDay: rs.filter((r) => inWindow(r.time, DAY)).length,
    tenantWeek: rs.filter((r) => inWindow(r.time, WEEK)).reduce((s, r) => s + r.amount, 0n),
    payeeDay: payeeDay.reduce((s, r) => s + r.amount, 0n),
    payeeCountDay: payeeDay.length,
    categoryMonth: category,
  };
}

/**
 * What the service knows about the payee: how many payments it has already made (releases in this instance, the
 * fixture's `priorReleases` included). `onTime` and `disputes` are not modelled by any fixture and no check reads
 * them; they stay 0 rather than being invented.
 */
function payeeHistory(state: SimState): KernelContext["payeeHistory"] {
  const payee = state.world.payee.toLowerCase();
  return { priorPayments: state.releases.filter((r) => r.payee.toLowerCase() === payee).length, onTime: 0, disputes: 0 };
}

const ESCALATIONS_KEY = "escalationsByEngagement";

/** Escalations raised today per engagement (the service counts ESCALATE decisions only, docs/04 K-12 v2). */
function escalationsByEngagement(state: SimState): Readonly<Record<string, number>> {
  return (state.memory[ESCALATIONS_KEY] ?? {}) as Record<string, number>;
}

function countEscalation(state: SimState, engagementId: string | null): void {
  state.escalationsToday += 1;
  if (engagementId === null) return;
  const by = { ...escalationsByEngagement(state) };
  by[engagementId] = (by[engagementId] ?? 0) + 1;
  state.memory[ESCALATIONS_KEY] = by;
}

function priorDecisions(state: SimState, engagement: Engagement): DecisionSummary[] {
  const own = (state.memory["decisions"] ?? []) as DecisionSummary[];
  const fromPatches: DecisionSummary[] = state.releases
    .filter((r) => r.stepId === "prior" && r.milestoneId !== null)
    .map((r, i) => ({
      decisionId: uuidFromLabel(`prior/${i}/${r.invoiceNumber ?? ""}`),
      intentId: hex32FromLabel(`prior-intent/${i}/${r.invoiceNumber ?? ""}`),
      verdict: "RELEASE" as const,
      docHash: hex32FromLabel(`prior-doc/${i}/${r.invoiceNumber ?? ""}`),
      engagementId: engagement.engagementId,
      milestoneId: r.milestoneId,
      payee: r.payee,
      normInvoiceNo: r.invoiceNumber === null ? null : r.invoiceNumber.toUpperCase().replace(/[^A-Z0-9]/g, ""),
      amountBaseUnits: r.amount,
      releaseAmountBaseUnits: r.amount,
      createdAt: r.time,
    }));
  return [...fromPatches, ...own];
}

export function buildContext(input: DecideInput): KernelContext {
  const { state, view, step } = input;
  const now = view.now;
  const engagement = view.noEngagement ? null : activatedEngagement(state);
  const norm = normalizeUntrusted(step.doc.text);
  const text = inspectUntrusted(norm.normalized);
  return {
    now,
    tenantId: TENANT_ID,
    vaultAddress: VAULT,
    chainId: CHAIN_ID,
    chain: { tokenAddress: OWNER, tokenDecimals: 6, vaultTokenDecimals: 6 },
    engagement,
    engagementOnChain:
      engagement === null
        ? null
        : { engagementId: engagement.engagementId, payee: engagement.payee, capBaseUnits: BigInt(engagement.capBaseUnits), start: engagement.start, end: engagement.end, termsHash: engagement.termsHash, active: true },
    milestone: engagement === null || step.milestoneSlug === null ? null : (engagement.milestones.find((m) => m.slug === step.milestoneSlug) ?? null),
    priorDecisions: engagement === null ? (state.memory["decisions"] ?? []) as DecisionSummary[] : priorDecisions(state, engagement),
    released: releasedTotals(state, now),
    evidence: evidenceFor(state, now),
    ownerApproval: null,
    approvedEscalation: null,
    planningAsOf: null,
    screening: state.screening === null ? null : { status: state.screening, checkedAt: now, provider: "fixture" },
    balances: { vaultAvailable: 1_000_000_000_000n, pendingReleases: 0n, obligations14d: 0n },
    payeeHistory: payeeHistory(state),
    doc: { hash: keccak256Utf8(inspectUntrusted(step.doc.text)), normalizedHash: keccak256Utf8(text), normalizedText: norm.normalized, zeroWidthCount: norm.removedCount },
    invoiceReceivedAt: step.doc.receivedAt,
    paymentTerms: engagement === null ? null : engagement.paymentTerms,
    escalations: { today: state.escalationsToday, todayByEngagement: escalationsByEngagement(state) },
    profile: "sandbox",
    breaker: state.breakerHalted ? { halted: true, reason: "FIXTURE" } : { halted: false, reason: null },
    payeeChangePending: state.payeeChangePending,
    reevaluation: null,
  };
}

export function buildIntent(input: DecideInput, ctx: KernelContext): unknown {
  const { state, step, run, view } = input;
  const docHash = ctx.doc.hash;
  return {
    schemaVersion: 1,
    tenantId: TENANT_ID,
    documentId: uuidFromLabel(`document/${step.stepId}`),
    docHash,
    extraction: {
      a: run.a,
      b: run.b,
      modelA: "reference-read-a",
      modelB: run.b === null ? null : "reference-read-b",
      promptHashA: hex32FromLabel("reference-read/prompt-a"),
      promptHashB: run.b === null ? null : hex32FromLabel("reference-read/prompt-b"),
    },
    consensus: consensus(run.a, run.b),
    engagementId: view.noEngagement ? null : state.world.template.engagement.engagementId,
    milestoneId: view.noEngagement || step.milestoneSlug === null ? null : milestoneId(state.world, step.milestoneSlug),
    timingProposal: null,
    planSelection: null,
    agentRecommendation: run.agentRecommendation,
    submittedAt: view.now,
  };
}

/** Which of the evaluation's FAILs are fail-closed placeholders (the kernel build does not implement the check). */
export function pendingFailures(e: Evaluation): CheckId[] {
  return e.checks.filter((c) => c.status === "FAIL" && c.code === "KERNEL_ERROR" && String(c.detail).startsWith(NOT_IMPLEMENTED_PREFIX)).map((c) => c.id);
}

/** Map an Evaluation to the target-neutral decision (exported so the mapping itself can be tested). */
export function toDecision(e: Evaluation, ctx: KernelContext): TargetDecision {
  const failed = e.checks.filter((c) => c.status === "FAIL");
  const pending = pendingFailures(e);
  const onlyPending = e.verdict === "HOLD" && failed.length > 0 && failed.every((c) => pending.includes(c.id));
  const base = {
    checksFired: failed.map((c) => c.id),
    reasons: e.reasons,
    issues: issueCodes(e.checks),
    heldByUnimplementedChecks: onlyPending,
  };
  if (e.verdict !== "RELEASE") {
    return { action: e.verdict, release: null, note: `kernel verdict ${e.verdict}${onlyPending ? " (only because checks " + pending.join(", ") + " are not implemented)" : ""}`, ...base };
  }
  if (e.payee === null || e.milestoneId === null || e.releaseAmountBaseUnits === null || e.payAt === null) {
    // A RELEASE without its release fields would be a kernel bug; do not paper over it.
    throw new RangeError("kernel returned RELEASE without payee, milestone, release amount or payAt");
  }
  return {
    action: "RELEASE",
    release: {
      milestoneId: e.milestoneId,
      payee: e.payee,
      amount: BigInt(e.releaseAmountBaseUnits),
      time: e.payAt,
      invoiceReceivedAt: ctx.invoiceReceivedAt,
      termsBasis: "signed",
      clockAnchor: e.invoiceReceivedAt,
      ownerApproved: ctx.ownerApproval !== null,
    },
    note: "kernel verdict RELEASE",
    ...base,
  };
}

/** What the kernel saw and decided for one run: the inputs a receipt is built from (the challenge service signs it). Read-only. */
export interface UnitObservation {
  readonly evaluation: Evaluation;
  readonly ctx: KernelContext;
  readonly rawIntent: unknown;
  readonly label: string;
  readonly stepId: string;
}

export function makeSymbolonUnitTarget(onEvaluation?: (o: UnitObservation) => void): Target & { observedUnimplemented(): readonly CheckId[] } {
  const seenPending = new Set<CheckId>();
  return {
    id: "symbolon",
    label: "Symbolon (unit mode: real kernel-core pipeline)",
    provenance: SYMBOLON_UNIT_PROVENANCE,

    decide(input: DecideInput): TargetDecision {
      const ctx = buildContext(input);
      const rawIntent = buildIntent(input, ctx);
      const e = evaluate(rawIntent, ctx, sandboxPolicy());
      onEvaluation?.({ evaluation: e, ctx, rawIntent, label: input.run.label, stepId: input.step.stepId });
      for (const id of pendingFailures(e)) seenPending.add(id);
      const base = toDecision(e, ctx);
      // Remember the decision for K-04 in later steps of the same instance (a REPLAY is not a new decision).
      const decisionId = uuidFromLabel(`decision/${input.step.stepId}/${input.run.label}`);
      const summary = summarizeEvaluation(e, { decisionId, createdAt: input.view.now });
      if (summary.ok) {
        const list = (input.state.memory["decisions"] ?? []) as DecisionSummary[];
        input.state.memory["decisions"] = [...list, summary.value];
      }
      // The service counts ESCALATE decisions towards the day's escalation budget (RT-14); HOLD and REJECT do not consume it.
      if (e.verdict === "ESCALATE") countEscalation(input.state, e.engagementId);
      return { ...base, explanation: e.humanExplanation, digest: digestItem(e, decisionId, ctx.payeeHistory.priorPayments) };
    },

    fault(step: FaultStep): FaultOutcome {
      return {
        status: "not-run",
        reason: `fault "${step.fault}" is exercised by the reconciler and the service (K-15, e2e-local), which unit mode does not include`,
        signals: [],
      };
    },

    cannotRun(step: AttackStep): string | null {
      switch (step.kind) {
        case "submit":
        case "fault":
        case "flood": // each flood item is a submit step; the digest criteria are reported NOT_RUN by the runner
          return null;
        case "vault-call":
          return "contract-level test: needs the SymbolonVault on arc-anvil (e2e-local, docs/07 §6); unit mode has no chain";
        case "approval-render":
          return null; // renderModel / checkWysiwys from packages/receipts, run in symbolon-human.ts
        default: {
          const never: never = step;
          throw new RangeError(`unknown step ${JSON.stringify(never)}`);
        }
      }
    },

    humanLoop: symbolonHumanLoop,
    unimplementedChecks: () => [...seenPending].sort(),
    observedUnimplemented: () => [...seenPending].sort(),
  };
}

