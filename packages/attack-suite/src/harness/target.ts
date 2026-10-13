// The target adapter (docs/07 §1-§2). A target receives one extraction run of one document, in a scenario
// instance, and answers what it would do. It never judges loss: the oracle does (docs/15 §2).
import type { CheckId, ReasonCode } from "@symbolon/schemas";
import type { OracleRelease } from "@symbolon/oracle";
import type { AttackStep, ExtractionRun, FaultStep, SubmitStep, TargetId } from "../types";
import type { SimState, StepView } from "./state";

export const ACTIONS = ["RELEASE", "HOLD", "ESCALATE", "REJECT", "REPLAY", "NOOP"] as const;
export type Action = (typeof ACTIONS)[number];

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
}
