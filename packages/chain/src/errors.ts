// Typed errors for @symbolon/chain. Every guard in this package fails closed with one of these codes;
// callers switch on `code` (exhaustively) and treat any ChainError as HOLD/ESCALATE, never as a default.

export const CHAIN_ERROR_CODES = [
  "INVALID_DECIMALS", // decimals not an integer in [0, MAX_DECIMALS]
  "INVALID_AMOUNT", // not a bigint in [0, 2^256-1], or an amount string that is not canonical decimal
  "PRECISION_LOSS", // a conversion or parse would drop non-zero digits
  "UNDERFLOW", // subtraction below zero
  "OVERFLOW", // result above 2^256-1
  "DECIMALS_MISMATCH", // two amounts, or an amount and the chain, disagree on decimals (V-04)
  "UNKNOWN_CHAIN", // chain id or network name not in the verified list
  "CHAIN_ID_MISMATCH", // the RPC reports a different chain id than the config expects
  "BAD_CONFIG", // missing/invalid environment configuration
  "BAD_DEPLOYMENT", // deployments/*.json is malformed or internally inconsistent
  "FEE_BELOW_FLOOR", // maxFeePerGas under Arc's 20 gwei floor (V-20)
  "BAD_LOG", // a log is pending/removed/malformed, or comes from the wrong emitter
  "UNKNOWN_EVENT", // a log from the vault that is not in the vault ABI
  "BAD_REVERT_DATA", // revert data that is not one of the vault's custom errors
  "NOT_LOCAL_CHAIN", // anvil_* / evm_* helper aimed at a chain that is not the local one
  "RPC_ERROR", // the node answered with something unusable
] as const;
export type ChainErrorCode = (typeof CHAIN_ERROR_CODES)[number];

export class ChainError extends Error {
  readonly code: ChainErrorCode;

  constructor(code: ChainErrorCode, message: string, options?: { cause?: unknown }) {
    super(`${code}: ${message}`, options);
    this.name = "ChainError";
    this.code = code;
  }
}

export function isChainError(e: unknown, code?: ChainErrorCode): e is ChainError {
  return e instanceof ChainError && (code === undefined || e.code === code);
}
