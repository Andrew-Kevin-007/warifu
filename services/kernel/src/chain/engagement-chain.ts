// The chain edge of the engagement service (WP-12): the READS the sign flows and the indexer need, behind an interface so
// tests can drive a real anvil through the same code the service uses. Nothing here signs or sends (the relayer does).
// Everything is read from the trusted RPC the service is configured with; decoding is not authentication (QUESTIONS WP-06
// item 4), so the decimals used by the decoder come from assertTokenDecimals on the same node.
import { assertTokenDecimals, symbolonVaultAbi } from "@symbolon/chain";
import type { RawLog } from "@symbolon/chain";
import type { Address, Hex32 } from "@symbolon/schemas";
import { recoverAddress } from "viem";
import type { Hex, PublicClient } from "viem";

export interface BlockInfo {
  readonly number: bigint;
  readonly hash: Hex32;
  /** epoch seconds */
  readonly timestamp: bigint;
}

/** A log with the hash of the block it was read from (needed to detect a reorg later). */
export interface VaultLog extends RawLog {
  readonly blockHash: Hex32;
}

/** unknown = neither a receipt nor a pending transaction: the node does not have it (dropped, replaced or reorged out). */
export type TxStatus = "success" | "reverted" | "pending" | "unknown";

export interface EngagementChain {
  readonly chainId: number;
  latestBlock(): Promise<BlockInfo>;
  /** Canonical hash of block `n` right now; null when the node has no such block. */
  blockHash(n: bigint): Promise<Hex32 | null>;
  /** Logs emitted BY THE VAULT in [from, to]; every log carries its block hash. */
  logs(vault: Address, from: bigint, to: bigint): Promise<VaultLog[]>;
  /** token decimals verified three ways (vault immutable, token.decimals()). */
  verifiedDecimals(vault: Address): Promise<number>;
  /** The vault's EIP-712 domain separator (what its signature checks use). */
  domainSeparator(vault: Address): Promise<Hex32>;
  engagementNonce(vault: Address, engagementId: Hex32): Promise<bigint>;
  /** The vault's pending payee change for the engagement, or null when none exists. `live` is false once a pause cancelled it. */
  pendingPayee(vault: Address, engagementId: Hex32): Promise<{ newPayee: Address; eta: bigint; live: boolean } | null>;
  txStatus(txHash: Hex32): Promise<TxStatus>;
  /** Same rule as the vault's OZ SignatureChecker: a contract signer is asked (ERC-1271), an EOA signer must ecrecover. */
  isValidSignature(signer: Address, digest: Hex32, signature: Hex): Promise<boolean>;
}

const ZERO = "0x0000000000000000000000000000000000000000";
const ERC1271_MAGIC = "0x1626ba7e";
const erc1271Abi = [
  {
    type: "function",
    name: "isValidSignature",
    stateMutability: "view",
    inputs: [
      { name: "hash", type: "bytes32" },
      { name: "signature", type: "bytes" },
    ],
    outputs: [{ name: "magicValue", type: "bytes4" }],
  },
] as const;

export function viemEngagementChain(client: PublicClient, chainId: number): EngagementChain {
  const read = (address: Address, functionName: string, args?: readonly unknown[]): Promise<unknown> =>
    client.readContract({ address, abi: symbolonVaultAbi, functionName, ...(args === undefined ? {} : { args }) } as never) as Promise<unknown>;
  return {
    chainId,
    async latestBlock() {
      const b = await client.getBlock({ blockTag: "latest" });
      if (b.number === null || b.hash === null) throw new TypeError("node returned a pending block as latest");
      return { number: b.number, hash: b.hash as Hex32, timestamp: b.timestamp };
    },
    async blockHash(n) {
      try {
        const b = await client.getBlock({ blockNumber: n });
        return b.hash === null ? null : (b.hash as Hex32);
      } catch (e) {
        if (e instanceof Error && e.name === "BlockNotFoundError") return null;
        throw e;
      }
    },
    async logs(vault, from, to) {
      const logs = await client.getLogs({ address: vault, fromBlock: from, toBlock: to });
      return logs.map((l) => {
        if (l.blockHash === null) throw new TypeError("node returned a pending log for a closed range");
        return {
          address: l.address,
          topics: l.topics,
          data: l.data,
          blockNumber: l.blockNumber,
          transactionHash: l.transactionHash,
          logIndex: l.logIndex,
          removed: l.removed,
          blockHash: l.blockHash as Hex32,
        };
      });
    },
    async verifiedDecimals(vault) {
      return (await assertTokenDecimals(client, vault)).decimals;
    },
    async domainSeparator(vault) {
      const r = await read(vault, "domainSeparator");
      if (typeof r !== "string" || !/^0x[0-9a-f]{64}$/i.test(r)) throw new TypeError("vault returned a malformed domain separator");
      return r.toLowerCase() as Hex32;
    },
    async engagementNonce(vault, id) {
      const r = await read(vault, "engagementNonce", [id]);
      if (typeof r !== "bigint") throw new TypeError("vault returned a non-bigint nonce");
      return r;
    },
    async pendingPayee(vault, id) {
      const r = await read(vault, "pendingPayee", [id]);
      if (!Array.isArray(r) || r.length < 2) throw new TypeError("vault returned an unexpected pendingPayee shape");
      const [newPayee, eta] = r as [string, bigint];
      if (newPayee.toLowerCase() === ZERO) return null;
      const live = await read(vault, "payeeChangeLive", [id]);
      if (typeof live !== "boolean") throw new TypeError("vault returned a non-boolean");
      return { newPayee: newPayee as Address, eta: BigInt(eta), live };
    },
    async txStatus(txHash) {
      try {
        const r = await client.getTransactionReceipt({ hash: txHash });
        return r.status === "success" ? "success" : "reverted";
      } catch (e) {
        if (!(e instanceof Error && e.name === "TransactionReceiptNotFoundError")) throw e;
      }
      try {
        await client.getTransaction({ hash: txHash });
        return "pending";
      } catch (e) {
        if (e instanceof Error && e.name === "TransactionNotFoundError") return "unknown";
        throw e;
      }
    },
    async isValidSignature(signer, digest, signature) {
      const code = await client.getCode({ address: signer });
      if (code !== undefined && code !== "0x") {
        // VERIFY(V-23): ERC-1271 (Safe-style) owners/payees. Standard EVM; exercised against a mock Safe on anvil only.
        try {
          const magic = await client.readContract({ address: signer, abi: erc1271Abi, functionName: "isValidSignature", args: [digest, signature] });
          return magic === ERC1271_MAGIC;
        } catch {
          return false;
        }
      }
      try {
        return (await recoverAddress({ hash: digest, signature })).toLowerCase() === signer.toLowerCase();
      } catch {
        return false;
      }
    },
  };
}
