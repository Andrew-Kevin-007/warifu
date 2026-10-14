// The target adapter (docs/07 §1-§2). A target receives one extraction run of one document, in a scenario
// instance, and answers what it would do. It never judges loss: the oracle does (docs/15 §2).
import type { ApprovalView, CheckId, Hex32, ReasonCode, UUID } from "@symbolon/schemas";
import type { OracleRelease } from "@symbolon/oracle";
import type { ApprovalRenderStep, AttackStep, ExplainerChecks, ExtractionRun, FaultStep, SubmitStep, TargetId } from "../types";
import type { SimState, StepView } from "./state";

export const ACTIONS = ["RELEASE", "HOLD", "ESCALATE", "REJECT", "REPLAY", "NOOP"] as const;
export type Action = (typeof ACTIONS)[number];

/**
 * An escalation-digest entry (docs/04 K-12 v2): what the ranking looks at. Structurally the kernel's DigestItem; kept
 * here so targets without a digest need not know the kernel.
 */
export interface TargetDigestItem {
  readonly decisionId: UUID;
  readonly intentId: Hex32;
  readonly passingChecks: number;
  readonly amountBaseUnits: bigint | null;
  readonly payeePriorPayments: number;
}

/** One stated criterion of a human-loop attack (ATK-22/23/24) and whether the target met it. */
export interface Criterion {
  readonly id: string;
  readonly passed: boolean;
  /** Plain statement of what was checked and found; never document text. */
  readonly detail: string;
}

export interface TargetDecision {
  readonly action: Action;
  /** Present iff action === "RELEASE". */
  readonly release: OracleRelease | null;
  /** Checks that FAILED (K-xx). Empty for targets without checks. */
  readonly checksFired: readonly CheckId[];
  readonly reasons: readonly ReasonCode[] | readonly string[];
  /** Plain-language trace for the report; never document text. */
  readonly note: string;
  /** True when the only thing standing between this decision and a release is a check the target does not implement yet. */
  readonly heldByUnimplementedChecks: boolean;
  /** The target's own human-facing explanation of this decision (Symbolon: the kernel's templated one); null if it has none. */
  readonly explanation?: string | null;
  /** The digest entry for this decision; null if the target has no escalation digest. */
  readonly digest?: TargetDigestItem | null;
}

export interface DecideInput {
  readonly state: SimState;
  readonly view: StepView;
  readonly step: SubmitStep;
  readonly run: ExtractionRun;
  readonly fixtureAttackId: string;
}

export interface FaultOutcome {
  /** "ran": the target models this fault. "not-run": it cannot be exercised in this mode (reason given). */
  readonly status: "ran" | "not-run";
  readonly reason: string;
  /** Statements about the target's ledger that became true because of the fault (second signal, docs/QUESTIONS WP-22 item 2). */
  readonly signals: readonly string[];
}

/**
 * The human in the loop (ATK-22/23/24, docs/07 §3.2): approval rendering, the escalation digest and the explainer.
 * Only a target that has an approval gate and an explainer implements it (Symbolon); for the others these attacks are N/A.
 */
export interface HumanLoop {
  /** ATK-23: one criterion per mutation of the rendered approval model, plus the raw-typed-data criterion. */
  approvalRender(step: ApprovalRenderStep): readonly Criterion[];
  /** ATK-23 control: an unmodified render of the same view must leave Sign enabled. */
  approvalControl(signedView: ApprovalView): Criterion;
  /** ATK-22: rank the digest; returns the rank (1 = first) of each decisionId. */
  rankDigest(items: readonly TargetDigestItem[]): ReadonlyMap<string, number>;
  /** ATK-22: is there any way to approve several items with one signature? */
  bulkApprove(): Criterion;
  /** ATK-24: criteria for one human-facing explanation against the phrases the document tried to plant. */
  explainer(explanation: string | null, checks: ExplainerChecks): readonly Criterion[];
}

export interface Target {
  readonly id: TargetId;
  readonly label: string;
  /** One honest sentence on what this target is, including "ours" / "SIMULATED" labels. */
  readonly provenance: string;
  decide(input: DecideInput): TargetDecision;
  /** Faults the target models; steps of other kinds are handled by the runner. */
  fault(step: FaultStep, state: SimState): FaultOutcome;
  /** Why a non-submit step kind cannot run on this target in this mode (null = it can run). */
  cannotRun(step: AttackStep): string | null;
  /** Checks of the target's own pipeline that are known to be unimplemented in this build (empty for others). */
  unimplementedChecks(): readonly CheckId[];
  /** Present only on a target with an approval gate and an explainer. */
  readonly humanLoop?: HumanLoop;
}
