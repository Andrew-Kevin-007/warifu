// Result shapes (docs/07 §2 "Result schema", extended where this build must be honest about what it did not run).
//   outcome   LOSS | BLOCKED | ESCALATED | HELD | NOOP | N/A  as in docs/07, plus NOT_RUN: the target could not
//             exercise the attack in this mode (reason recorded). NOT_RUN is never counted as blocked or as a loss.
//   scoring   oracle: loss decided by the oracle predicates on the releases the target made;
//             signal: the attack has no oracle-expressible loss (docs/QUESTIONS WP-22 item 2), so a documented
//                    second signal decides (a phantom ledger entry, a revert, ...), plus the oracle if money moved.
import type { CheckId, OraclePredicate } from "@symbolon/schemas";
import type { AttackId, TargetId } from "../types";
import type { Criterion } from "./target";

export const OUTCOMES = ["LOSS", "BLOCKED", "ESCALATED", "HELD", "NOOP", "N/A", "NOT_RUN"] as const;
export type Outcome = (typeof OUTCOMES)[number];

export type Expectation = "MATCH" | "MISMATCH" | "INCONCLUSIVE" | "N/A";

export interface ReleaseRecord {
  readonly amountBaseUnits: string;
  readonly payee: string;
  readonly time: string;
  readonly oracle: { readonly result: "LOSS" | "NO_LOSS"; readonly predicates: readonly OraclePredicate[] };
  /** Money that left the correct payee/amount rule (see report: 0 for a rule violation with correct payee and amount). */
  readonly lossBaseUnits: string;
}

export interface RunRecord {
  readonly label: string;
  readonly action: string;
  readonly checksFired: readonly CheckId[];
  readonly reasons: readonly string[];
  readonly heldByUnimplementedChecks: boolean;
  readonly expectation: Expectation;
  readonly expectationNote: string;
  readonly release: ReleaseRecord | null;
}

export interface StepRecord {
  readonly stepId: string;
  readonly kind: string;
  readonly status: "RAN" | "NOT_RUN";
  readonly reason: string;
  readonly runs: readonly RunRecord[];
  readonly signals: readonly string[];
  /** Stated criteria of a human-loop step (ATK-22 flood, ATK-23 render, ATK-24 explainer); empty for other steps. */
  readonly criteria: readonly Criterion[];
}

export type ControlResult =
  | { readonly status: "PASS"; readonly detail: string }
  | { readonly status: "OVERBLOCKED"; readonly detail: string }
  | { readonly status: "LOSS"; readonly detail: string }
  | { readonly status: "NOT_RUN"; readonly detail: string };

export interface AttackResult {
  readonly attackId: AttackId;
  readonly target: TargetId;
  readonly outcome: Outcome;
  readonly scoring: "oracle" | "signal";
  readonly lossBaseUnits: string;
  readonly checksFired: readonly CheckId[];
  readonly oracle: {
    readonly version: "oracle-v1";
    readonly predicates: readonly OraclePredicate[];
    readonly releases: number;
    readonly lossReleases: number;
  } | null;
  /** Every step ran (no NOT_RUN step). A result that is not complete is partial evidence only. */
  readonly complete: boolean;
  readonly trials: number;
  readonly expectations: { readonly match: number; readonly mismatch: number; readonly inconclusive: number };
  readonly steps: readonly StepRecord[];
  /** Human-loop criteria over all steps: how many were met (a failed one is also a signal and makes the outcome LOSS). */
  readonly criteria: { readonly passed: number; readonly failed: number };
  readonly control: ControlResult;
  /** Plain reasons: applicability reason for N/A, the NOT_RUN reasons, the signals. */
  readonly notes: readonly string[];
}

export interface HonestItemResult {
  readonly id: string;
  readonly group: string;
  readonly action: string;
  readonly released: boolean;
  readonly oracle: "NO_LOSS" | "LOSS" | null;
  readonly amountMatches: boolean | null;
  readonly heldByUnimplementedChecks: boolean;
}
