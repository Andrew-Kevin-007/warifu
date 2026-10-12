// Recorded in every Decision/Receipt (`kernelVersion`, docs/05 §2). Bump on any change to check semantics.
// 0.4.x = WP-04: K-01..K-08 implemented; K-09..K-14 and K-16 are fail-closed placeholders (HOLD KERNEL_ERROR)
// until WP-05, so this build can never return RELEASE from evaluate().
export const KERNEL_VERSION = "symbolon-kernel/0.4.0" as const;
