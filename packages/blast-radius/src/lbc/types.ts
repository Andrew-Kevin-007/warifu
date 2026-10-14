// Types shared by the Loss Bound Certificate build and verify paths (docs/16 §2.1, §5). Pure types and one error class:
// no I/O here. The chain is reached only through the `ChainReader` interface below, so build and verify run unchanged
// against viem (viem-reader.ts), a mock (tests) or a recorded replay bundle (docs/15 §7).
import type { Address, Hex32 } from "@symbolon/schemas";

export type Hex = `0x${string}`;

export interface BlockHeader {
  readonly number: bigint;
  readonly hash: Hex32;
  /** seconds since the epoch, as in the block header (the vault's `block.timestamp`) */
  readonly timestamp: bigint;
}

/** `finalized` falls back to "latest minus confirmations" inside the reader when the node has no such tag (V-29). */
export type BlockRef = bigint | "latest" | "finalized";

/** One `engagements(id)` read, plus its id. `released` is NOT part of the digest (docs/16 §3). */
export interface EngagementState {
  readonly id: Hex32;
  readonly payee: Address;
  readonly cap: bigint;
  readonly released: bigint;
  readonly start: bigint;
  readonly end: bigint;
  readonly termsHash: Hex32;
  readonly active: boolean;
}

/** Everything the certificate needs from the vault at ONE block (docs/16 §2.1 table). */
export interface VaultState {
  readonly blockNumber: bigint;
  readonly token: Address;
  /** the vault's own immutable `tokenDecimals` (V-04) */
  readonly tokenDecimals: number;
  /** `token.decimals()` read from the token itself; must equal `tokenDecimals` or the build refuses. */
  readonly tokenContractDecimals: number;
  readonly owner: Address;
  readonly kernelSigner: Address;
  readonly guardian: Address;
  readonly perTxCap: bigint;
  readonly dailyCap: bigint;
  readonly hourlyCap: bigint;
  readonly humanThreshold: bigint;
  readonly payeeChangeDelay: bigint;
  readonly signerChangeDelay: bigint;
  /** the vault's `RING_SIZE` constant (64) */
  readonly ringSize: bigint;
  /** the vault's own `configHash()` view */
  readonly configHash: Hex32;
  /** token.balanceOf(vault) in base units */
  readonly balance: bigint;
  readonly paused: boolean;
  /** in registration order (`engagementIdAt(0..count-1)`) */
  readonly engagements: readonly EngagementState[];
}

export type ChainReadErrorCode =
  /** The node answered but has no state for that block (non-archive node). Build/verify may fall back, loudly. */
  | "STATE_UNAVAILABLE"
  /** Anything else: transport error, malformed answer, decoding failure. Never recovered from. */
  | "RPC_ERROR";

export class ChainReadError extends Error {
  readonly code: ChainReadErrorCode;
  constructor(code: ChainReadErrorCode, message: string, options?: { cause?: unknown }) {
    super(`${code}: ${message}`, options);
    this.name = "ChainReadError";
    this.code = code;
  }
}

/** The only door to the chain. Implementations throw ChainReadError (or any Error: callers treat it as RPC_ERROR). */
export interface ChainReader {
  chainId(): Promise<bigint>;
  /** null when the node does not know the block. */
  header(ref: BlockRef): Promise<BlockHeader | null>;
  /** All reads pinned to `blockNumber`. */
  vaultState(vault: Address, blockNumber: bigint): Promise<VaultState>;
  /** Deployed runtime code of `vault`; "0x" when there is none. */
  code(vault: Address, ref: bigint | "latest"): Promise<Hex>;
}

export type LbcErrorCode =
  | "INVALID_STATE" // the chain answered something no vault can answer (zero P or D, released > cap, decimals mismatch...)
  | "CONFIG_HASH_INCONSISTENT" // the vault's getters do not hash to its own configHash()
  | "BLOCK_UNAVAILABLE"
  | "REORG_DURING_BUILD"
  | "INVALID_OPTION"
  | "VALIDATION_INVALID" // validation results file malformed, unattributed or contradicting the bound
  | "TERMS_INVALID"
  | "POLICY_INVALID"
  | "ARTIFACT_INVALID"
  | "VALUE_OUT_OF_RANGE";

/** A build refuses (throws) rather than produce a certificate it cannot stand behind. */
export class LbcError extends Error {
  readonly code: LbcErrorCode;
  constructor(code: LbcErrorCode, message: string, options?: { cause?: unknown }) {
    super(`${code}: ${message}`, options);
    this.name = "LbcError";
    this.code = code;
  }
}
