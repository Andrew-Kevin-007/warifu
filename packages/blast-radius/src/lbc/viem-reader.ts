// The viem implementation of ChainReader (docs/16 §2.1). Reads only: eth_chainId, eth_getBlockByNumber, eth_call (vault
// getters, token.decimals/balanceOf) and eth_getCode, all pinned to one block number so a state is internally consistent.
// Not re-exported from the package root, so importing bounds in a browser bundle never pulls in viem.
//
// VERIFY(V-29): Arc RPC `finalized` / `safe` block tag support and finality depth. Until confirmed, "finalized" falls
//   back to (latest - DEFAULT_CONFIRMATIONS) when the node rejects the tag; the fallback is deliberate and documented.
// VERIFY(V-30): behaviour of the Arc public RPC for eth_call / eth_getCode at old blocks (archive depth) and the exact
//   error text for pruned state. Until confirmed, only the messages in PRUNED_STATE are classified as STATE_UNAVAILABLE
//   (verify then falls back to latest-with-digest-equality and says so); every other failure is an RPC_ERROR (UNVERIFIED).
import { symbolonVaultAbi } from "@symbolon/chain";
import type { Address, Hex32 } from "@symbolon/schemas";
import { erc20Abi, getAddress } from "viem";
import type { Abi, PublicClient } from "viem";
import { DEFAULT_CONFIRMATIONS } from "./texts";
import { ChainReadError, LbcError } from "./types";
import type { BlockHeader, BlockRef, ChainReader, EngagementState, Hex, VaultState } from "./types";

const PRUNED_STATE = /missing trie node|state (?:is )?(?:not|un)available|historical state|pruned|no state available|distance to target block exceeds|block (?:\S+ )?not found|header not found|state at block|requested data is not available/i;

/** A certificate over thousands of engagements is out of scope for a hackathon vault; refuse rather than loop unboundedly. */
export const MAX_ENGAGEMENTS = 2000;
const BATCH = 16;

function big(v: unknown, what: string): bigint {
  if (typeof v === "bigint") return v;
  if (typeof v === "number" && Number.isSafeInteger(v) && v >= 0) return BigInt(v);
  throw new ChainReadError("RPC_ERROR", `${what} was not an unsigned integer`);
}
function addr(v: unknown, what: string): Address {
  if (typeof v !== "string") throw new ChainReadError("RPC_ERROR", `${what} was not an address`);
  try {
    return getAddress(v) as Address;
  } catch (cause) {
    throw new ChainReadError("RPC_ERROR", `${what} was not an address`, { cause });
  }
}
function hex32(v: unknown, what: string): Hex32 {
  if (typeof v !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(v)) throw new ChainReadError("RPC_ERROR", `${what} was not a 32-byte value`);
  return v.toLowerCase() as Hex32;
}

export interface ViemReaderOptions {
  /** confirmations behind latest when the node has no `finalized` tag (default DEFAULT_CONFIRMATIONS) */
  readonly confirmations?: number;
}

export function viemChainReader(client: PublicClient, options: ViemReaderOptions = {}): ChainReader {
  const confirmations = BigInt(options.confirmations ?? DEFAULT_CONFIRMATIONS);

  async function headerOf(args: { blockNumber: bigint } | { blockTag: "latest" | "finalized" }): Promise<BlockHeader | null> {
    let b;
    try {
      b = await client.getBlock({ ...args, includeTransactions: false });
    } catch (e) {
      if (e instanceof Error && e.name === "BlockNotFoundError") return null;
      throw new ChainReadError("RPC_ERROR", "eth_getBlockByNumber failed", { cause: e });
    }
    if (b.number === null || b.hash === null) return null; // pending
    return { number: b.number, hash: hex32(b.hash, "block hash"), timestamp: big(b.timestamp, "block timestamp") };
  }

  const read = async (address: Address, abi: Abi, functionName: string, blockNumber: bigint, args?: readonly unknown[]): Promise<unknown> => {
    try {
      return await client.readContract({ address, abi, functionName, blockNumber, ...(args === undefined ? {} : { args }) } as never);
    } catch (e) {
      const msg = e instanceof Error ? `${e.message} ${(e as { details?: string }).details ?? ""}` : "";
      if (PRUNED_STATE.test(msg)) throw new ChainReadError("STATE_UNAVAILABLE", `no state for block ${blockNumber.toString()}`, { cause: e });
      throw new ChainReadError("RPC_ERROR", `eth_call ${functionName} failed`, { cause: e });
    }
  };

  return {
    async chainId() {
      try {
        return BigInt(await client.getChainId());
      } catch (cause) {
        throw new ChainReadError("RPC_ERROR", "eth_chainId failed", { cause });
      }
    },

    async header(ref: BlockRef) {
      if (typeof ref === "bigint") return headerOf({ blockNumber: ref });
      if (ref === "latest") return headerOf({ blockTag: "latest" });
      // "finalized": the node's tag if it has one, else latest minus confirmations (V-29).
      const tagged = await headerOf({ blockTag: "finalized" }).catch(() => null);
      if (tagged !== null) return tagged;
      const latest = await headerOf({ blockTag: "latest" });
      if (latest === null) return null;
      const n = latest.number > confirmations ? latest.number - confirmations : 0n;
      return headerOf({ blockNumber: n });
    },

    async vaultState(vault: Address, blockNumber: bigint): Promise<VaultState> {
      const abi = symbolonVaultAbi as unknown as Abi;
      const v = (fn: string, args?: readonly unknown[]) => read(vault, abi, fn, blockNumber, args);
      const [token, tokenDecimals, owner, kernelSigner, guardian, perTxCap, dailyCap, hourlyCap, humanThreshold, payeeChangeDelay, signerChangeDelay, ringSize, configHash, paused, count] = await Promise.all([
        v("token"), v("tokenDecimals"), v("owner"), v("kernelSigner"), v("guardian"), v("perTxCap"), v("dailyCap"), v("hourlyCap"), v("humanThreshold"),
        v("payeeChangeDelay"), v("signerChangeDelay"), v("RING_SIZE"), v("configHash"), v("paused"), v("engagementCount"),
      ]);
      const tokenAddress = addr(token, "token");
      const n = big(count, "engagementCount");
      if (n > BigInt(MAX_ENGAGEMENTS)) throw new LbcError("VALUE_OUT_OF_RANGE", `the vault has ${n.toString()} engagements; this tool certifies at most ${String(MAX_ENGAGEMENTS)}`);
      if (typeof paused !== "boolean") throw new ChainReadError("RPC_ERROR", "paused was not a boolean");

      const ids: Hex32[] = [];
      for (let i = 0n; i < n; i += BigInt(BATCH)) {
        const chunk = await Promise.all(Array.from({ length: Number(n - i < BigInt(BATCH) ? n - i : BigInt(BATCH)) }, (_, k) => v("engagementIdAt", [i + BigInt(k)])));
        ids.push(...chunk.map((x) => hex32(x, "engagementIdAt")));
      }
      const engagements: EngagementState[] = [];
      for (let i = 0; i < ids.length; i += BATCH) {
        const rows = await Promise.all(ids.slice(i, i + BATCH).map((id) => v("engagements", [id])));
        rows.forEach((row, k) => {
          const r = row as readonly unknown[] | Record<string, unknown>;
          const f = (idx: number, name: string): unknown => (Array.isArray(r) ? r[idx] : (r as Record<string, unknown>)[name]);
          engagements.push({
            id: ids[i + k]!,
            payee: addr(f(0, "payee"), "engagement payee"),
            cap: big(f(1, "cap"), "engagement cap"),
            released: big(f(2, "released"), "engagement released"),
            start: big(f(3, "start"), "engagement start"),
            end: big(f(4, "end"), "engagement end"),
            termsHash: hex32(f(5, "termsHash"), "engagement termsHash"),
            active: f(6, "active") === true,
          });
        });
      }

      const [tokenContractDecimals, balance] = await Promise.all([
        read(tokenAddress, erc20Abi as unknown as Abi, "decimals", blockNumber),
        read(tokenAddress, erc20Abi as unknown as Abi, "balanceOf", blockNumber, [vault]),
      ]);
      return {
        blockNumber,
        token: tokenAddress,
        tokenDecimals: Number(big(tokenDecimals, "tokenDecimals")),
        tokenContractDecimals: Number(big(tokenContractDecimals, "token.decimals()")),
        owner: addr(owner, "owner"),
        kernelSigner: addr(kernelSigner, "kernelSigner"),
        guardian: addr(guardian, "guardian"),
        perTxCap: big(perTxCap, "perTxCap"),
        dailyCap: big(dailyCap, "dailyCap"),
        hourlyCap: big(hourlyCap, "hourlyCap"),
        humanThreshold: big(humanThreshold, "humanThreshold"),
        payeeChangeDelay: big(payeeChangeDelay, "payeeChangeDelay"),
        signerChangeDelay: big(signerChangeDelay, "signerChangeDelay"),
        ringSize: big(ringSize, "RING_SIZE"),
        configHash: hex32(configHash, "configHash"),
        balance: big(balance, "balanceOf"),
        paused,
        engagements,
      };
    },

    async code(vault: Address, ref: bigint | "latest"): Promise<Hex> {
      try {
        const c = await client.getCode({ address: vault, ...(ref === "latest" ? { blockTag: "latest" as const } : { blockNumber: ref }) });
        return (c ?? "0x") as Hex;
      } catch (e) {
        const msg = e instanceof Error ? e.message : "";
        throw new ChainReadError(PRUNED_STATE.test(msg) ? "STATE_UNAVAILABLE" : "RPC_ERROR", "eth_getCode failed", { cause: e });
      }
    },
  };
}
