// K-16 CIRCUIT_BREAKER pre-check — HOLD — P0 (docs/04 K-16; WP-05). Runs before K-01 on the context alone.
// HALTED => HOLD BREAKER_HALTED on every evaluation (a more severe finding elsewhere still wins the verdict, and the
// verdict is never RELEASE). A malformed breaker state fails closed (HOLD KERNEL_ERROR). Trip/unfreeze logic: breaker.ts.
import type { CheckResult } from "@symbolon/schemas";
import type { KernelContext } from "../context";
import { fail, kernelError, pass } from "../verdict";

export function checkK16(ctx: KernelContext): CheckResult {
  const b = ctx.breaker;
  if (typeof b !== "object" || b === null || typeof b.halted !== "boolean") return kernelError("K-16", "breaker state is malformed");
  if (b.halted) return fail("K-16", "HOLD", "BREAKER_HALTED", "circuit breaker is HALTED; nothing is released until the owner unfreezes it");
  return pass("K-16", "circuit breaker OK");
}
