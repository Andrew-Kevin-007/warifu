// Arc mempool fee floor (AGENTS.md section 3, V-20: docs.arc.io deploy page relayed by Kevin, 2026-10-10):
// transactions with maxFeePerGas below 20 gwei are not accepted. Gas is paid in native USDC (18 decimals).
// The floor is applied here so no caller can forget it; fee values are native-gas wei, never token amounts.
import { ChainError } from "./errors";

export const ARC_MIN_MAX_FEE_PER_GAS = 20_000_000_000n; // 20 gwei

/** Raise a requested maxFeePerGas to the floor (never lowers it). */
export function withFeeFloor(maxFeePerGas: bigint | undefined): bigint {
  if (maxFeePerGas === undefined) return ARC_MIN_MAX_FEE_PER_GAS;
  if (typeof maxFeePerGas !== "bigint" || maxFeePerGas < 0n) {
    throw new ChainError("FEE_BELOW_FLOOR", "maxFeePerGas must be a non-negative bigint");
  }
  return maxFeePerGas < ARC_MIN_MAX_FEE_PER_GAS ? ARC_MIN_MAX_FEE_PER_GAS : maxFeePerGas;
}

/** Throw if a transaction's maxFeePerGas is under the floor (use on transactions you did not build). */
export function assertFeeFloor(maxFeePerGas: bigint): void {
  if (typeof maxFeePerGas !== "bigint" || maxFeePerGas < ARC_MIN_MAX_FEE_PER_GAS) {
    throw new ChainError("FEE_BELOW_FLOOR", `maxFeePerGas ${String(maxFeePerGas)} < ${ARC_MIN_MAX_FEE_PER_GAS.toString()} (20 gwei floor, V-20)`);
  }
}
