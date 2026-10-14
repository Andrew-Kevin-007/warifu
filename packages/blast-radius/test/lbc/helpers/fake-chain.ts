// An in-memory ChainReader for fast tests of build/verify (the real-chain tests are in anvil.lbc.test.ts). It is a
// deterministic fake of the network EDGE only: states are plain data, the certificate code under test is real.
import type { Address, Hex32 } from "@symbolon/schemas";
import { keccak256, getAddress, stringToBytes } from "viem";
import { computeConfigHash } from "../../../src/lbc/digest";
import { ChainReadError } from "../../../src/lbc/types";
import type { BlockHeader, BlockRef, ChainReader, EngagementState, Hex, VaultState } from "../../../src/lbc/types";

export const USDC = 1_000_000n;
export const VAULT = getAddress("0xdbF03B407c01E7cD3CBea99509d93f8DDDC8C6FB") as Address;
export const TOKEN = getAddress("0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed") as Address;
export const OWNER = getAddress("0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359") as Address;
export const SIGNER = getAddress("0x52908400098527886E0F7030069857D2E4169EE7") as Address;
export const SIGNER2 = getAddress("0x8626f6940E2eb28930eFb4CeF49B2d1F2C9C1199") as Address;
export const GUARDIAN = getAddress("0xD1220A0cf47c7B9Be7A2E6BA89F429762e7b9aDb") as Address;
export const PAYEE = getAddress("0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed") as Address;

export const h32 = (label: string): Hex32 => keccak256(stringToBytes(label)) as Hex32;
export const T0 = 1_760_000_000n;

export function engagement(label: string, over: Partial<EngagementState> = {}): EngagementState {
  return { id: h32(`eng:${label}`), payee: PAYEE, cap: 100n * USDC, released: 0n, start: T0 - 1000n, end: T0 + 1_000_000n, termsHash: h32(`terms:${label}`), active: true, ...over };
}

/** A consistent vault state (configHash recomputed from the getters). */
export function makeState(over: Partial<Omit<VaultState, "configHash">> & { blockNumber?: bigint } = {}): VaultState {
  const base: Omit<VaultState, "configHash"> = {
    blockNumber: 100n,
    token: TOKEN,
    tokenDecimals: 6,
    tokenContractDecimals: 6,
    owner: OWNER,
    kernelSigner: SIGNER,
    guardian: GUARDIAN,
    perTxCap: 100n * USDC,
    dailyCap: 200n * USDC,
    hourlyCap: 0n,
    humanThreshold: 50n * USDC,
    payeeChangeDelay: 172_800n,
    signerChangeDelay: 86_400n,
    ringSize: 64n,
    balance: 200n * USDC,
    paused: false,
    engagements: [],
    ...over,
  };
  return { ...base, configHash: computeConfigHash(base) };
}

/** The spec's worked example (docs/16 §3): B=200, P=100, D=200, H=50, hc=0, three counted engagements with remaining 150. */
export function exampleState(over: Partial<Omit<VaultState, "configHash">> = {}): VaultState {
  return makeState({
    engagements: [
      engagement("a", { cap: 100n * USDC, released: 20n * USDC }),
      engagement("b", { cap: 50n * USDC }),
      engagement("c", { cap: 30n * USDC, released: 10n * USDC }),
      engagement("closed", { cap: 999n * USDC, active: false }),
      engagement("ended", { cap: 500n * USDC, end: T0 - 10n }),
    ],
    ...over,
  });
}

export function headerAt(n: bigint, salt = "", timestamp: bigint = T0 + (n - 100n) * 2n): BlockHeader {
  return { number: n, hash: h32(`block:${n.toString()}:${salt}`), timestamp };
}

export type Fault = "chainId" | "header" | "vaultState" | "code" | null;

/** Chain with a block history; each block holds the vault state as of that block. */
export class FakeChain implements ChainReader {
  chain = 31337n;
  readonly blocks = new Map<bigint, { header: BlockHeader; state: VaultState; code: Hex }>();
  latestNumber = 0n;
  /** block numbers whose state a non-archive node would not have */
  pruned = new Set<bigint>();
  fault: Fault = null;
  code0: Hex = "0x6001600055";
  calls = { vaultState: 0 };

  push(n: bigint, state: VaultState, header: BlockHeader = headerAt(n), code: Hex = this.code0): this {
    this.blocks.set(n, { header, state: { ...state, blockNumber: n }, code });
    if (n > this.latestNumber) this.latestNumber = n;
    return this;
  }
  /** The state of the latest block, for building the next one. */
  get head(): VaultState {
    return this.blocks.get(this.latestNumber)!.state;
  }
  next(over: Partial<Omit<VaultState, "configHash">>, timestampDelta = 2n): this {
    const n = this.latestNumber + 1n;
    const prev = this.blocks.get(this.latestNumber)!;
    const { configHash: _c, ...rest } = prev.state;
    const state = makeState({ ...rest, ...over });
    return this.push(n, state, headerAt(n, "", prev.header.timestamp + timestampDelta));
  }

  async chainId(): Promise<bigint> {
    if (this.fault === "chainId") throw new ChainReadError("RPC_ERROR", "boom");
    return this.chain;
  }
  async header(ref: BlockRef): Promise<BlockHeader | null> {
    if (this.fault === "header") throw new ChainReadError("RPC_ERROR", "boom");
    const n = ref === "latest" || ref === "finalized" ? this.latestNumber : ref;
    return this.blocks.get(n)?.header ?? null;
  }
  async vaultState(_vault: Address, n: bigint): Promise<VaultState> {
    this.calls.vaultState++;
    if (this.fault === "vaultState") throw new ChainReadError("RPC_ERROR", "boom");
    if (this.pruned.has(n)) throw new ChainReadError("STATE_UNAVAILABLE", "pruned");
    const b = this.blocks.get(n);
    if (b === undefined) throw new ChainReadError("RPC_ERROR", "unknown block");
    return b.state;
  }
  async code(_vault: Address, ref: bigint | "latest"): Promise<Hex> {
    if (this.fault === "code") throw new ChainReadError("RPC_ERROR", "boom");
    const n = ref === "latest" ? this.latestNumber : ref;
    return this.blocks.get(n)?.code ?? "0x";
  }
}

export function chainWith(state: VaultState): FakeChain {
  return new FakeChain().push(100n, state);
}
