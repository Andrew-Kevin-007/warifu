// The token-ledger READ edge of the reconciler (WP-15, K-15 balance identity): what the settlement token says about the vault.
// Reads only; nothing here signs or sends. Behind an interface so tests can drive a real anvil or a scripted ledger.
//
// VERIFY(V-60): on Arc the ERC-20 USDC interface is backed by the native balance and "USDC system events" are emitted by a
// system emitter (AGENTS.md section 3). Whether `Transfer` logs filtered by the token address and `balanceOf(vault)` at a
// historical block are both complete and available on Arc's RPC is not verified here (docs/VERIFY_LOG.md V-60). Both are
// ordinary ERC-20 reads; if either is missing the reconciler cannot check the identity and says so (it never invents a number).
import type { Address } from "@symbolon/schemas";
import { parseAbiItem } from "viem";
import type { PublicClient } from "viem";

export interface LedgerChain {
  /** token.balanceOf(account) as of block `at` (a historical read; the reconciler passes its consistent safe block). */
  balanceAt(token: Address, account: Address, at: bigint): Promise<bigint>;
  /** Σ Transfer(to = account) over [from, to] inclusive. */
  inflow(token: Address, account: Address, from: bigint, to: bigint): Promise<bigint>;
  /** Head of the node. */
  latestBlock(): Promise<bigint>;
}

const TRANSFER = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");
const balanceOfAbi = [{ type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "account", type: "address" }], outputs: [{ type: "uint256" }] }] as const;

export function viemLedgerChain(client: PublicClient): LedgerChain {
  return {
    async latestBlock() {
      return client.getBlockNumber();
    },
    async balanceAt(token, account, at) {
      const r = await client.readContract({ address: token, abi: balanceOfAbi, functionName: "balanceOf", args: [account], blockNumber: at });
      if (typeof r !== "bigint") throw new TypeError("token returned a non-bigint balance");
      return r;
    },
    async inflow(token, account, from, to) {
      if (to < from) return 0n;
      const logs = await client.getLogs({ address: token, event: TRANSFER, args: { to: account }, fromBlock: from, toBlock: to });
      let sum = 0n;
      for (const l of logs) {
        if (l.removed === true || l.args.value === undefined) throw new TypeError("node returned an unusable Transfer log");
        sum += l.args.value;
      }
      return sum;
    },
  };
}
