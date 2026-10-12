// Checks not implemented in this build (WP-05: K-09..K-14 and the K-16 breaker logic). Each one is REQUIRED,
// so it reports FAIL / HOLD / KERNEL_ERROR: a kernel that cannot evaluate a check never releases (docs/04 §1).
import type { CheckId, CheckResult } from "@symbolon/schemas";
import { kernelError } from "../verdict";

export const PENDING_CHECKS: readonly CheckId[] = Object.freeze(["K-16", "K-09", "K-10", "K-11", "K-12", "K-13", "K-14"] as const);

export function pendingCheck(id: CheckId): CheckResult {
  return kernelError(id, "check not implemented in this kernel build (WP-05); failing closed");
}
