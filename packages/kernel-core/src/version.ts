// Recorded in every Decision/Receipt (`kernelVersion`, docs/05 §2). Bump on any change to check semantics.
// 0.4.x = WP-04: K-01..K-08 (K-09..K-14, K-16 were fail-closed placeholders).
// 0.5.x = WP-05: every check K-01..K-14 and the K-16 pre-check, owner-approval and escalation-budget gates, templated
// explanation, feasible plans and the TOCTOU re-evaluation.
export const KERNEL_VERSION = "symbolon-kernel/0.5.0" as const;
