// @symbolon/oracle — scaffold placeholder (WP-23). The owning WP replaces this file.
// Contract (docs/15 §2, docs/07 §3, docs/02 component table):
//   - `oracle-v1` decides whether an attempt was a LOSS, from the scenario's ground truth and the observed outcome.
//   - Predicates O1..O8, each with a positive and a negative fixture. Pure, deterministic, bigint only.
//   - Imports ONLY @symbolon/schemas. It must never import kernel-core, terms, policy, receipts, chain or the extractor
//     (it is the independent judge: a defender that can import it can be tuned against it).
//   - Consumers: packages/attack-suite (harness) and services/kernel/src/challenge/** (challenge service).
export const PACKAGE_NAME = "@symbolon/oracle" as const;
export const ORACLE_VERSION = "oracle-v1" as const;
