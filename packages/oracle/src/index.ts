// @symbolon/oracle (owner: ATTACK, WP-23): oracle-v1, the independent judge of what counts as a loss.
// Contract (docs/15 §2, docs/07 §3.3, docs/02 component table):
//   - decides whether a RELEASE was a LOSS from the scenario's ground truth and the instance state: predicates O1..O8;
//   - pure and deterministic, bigint only, no clock, no I/O;
//   - imports ONLY @symbolon/schemas. It must never import kernel-core, terms, policy, receipts, chain or the
//     extractor: it is the independent judge, and a defender that could import it could be tuned against it;
//   - consumers: packages/attack-suite (harness) and services/kernel/src/challenge/** (challenge service).
export const PACKAGE_NAME = "@symbolon/oracle" as const;

export { ORACLE_VERSION } from "./types";
export type {
  OracleInstance,
  OracleLimits,
  OracleRelease,
  OracleVerdict,
  PredicateFinding,
  PriorRelease,
  TermsBasis,
} from "./types";
export { amountDueOracle, insideDiscountWindow } from "./amount-due";
export { O1, O2, O3, O4, O5, O6, O7, O8, PREDICATES } from "./predicates";
export type { Predicate } from "./predicates";
export { applyRelease, judgeRelease, judgeSequence } from "./judge";
export type { SequenceStep } from "./judge";
