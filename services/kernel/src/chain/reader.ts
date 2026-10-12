// Chain reads for the context assembler (docs/04 s2). Everything here is a READ through @symbolon/chain's public exports
// (viem readContract with the vault ABI); nothing signs or sends. Amounts are bigint base units at the decimals the
// vault itself reports (V-04): `assertTokenDecimals` verifies vault.tokenDecimals() == token.decimals() on every
// snapshot, so a balance can never be read at the wrong scale. Any RPC failure throws; the caller fails closed.
import { assertTokenDecimals, getBalanceBaseUnits, symbolonVaultAbi } from "@symbolon/chain";
import type { Address, Hex32 } from "@symbolon/schemas";
import type { PublicClient } from "viem";

export interface VaultSnapshot {
  readonly token: Address;
  /** token.decimals(), equal to vaultTokenDecimals (asserted). */
  readonly tokenDecimals: number;
  readonly vaultTokenDecimals: number;
  readonly balance: bigint;
  readonly perTxCap: bigint;
  readonly dailyCap: bigint;
  readonly hourlyCap: bigint;
  readonly humanThreshold: bigint;
  readonly paused: boolean;
}

export interface OnChainEngagement {
  readonly payee: Address;
  readonly cap: bigint;
  readonly released: bigint;
  /** epoch seconds */
  readonly start: bigint;
  readonly end: bigint;
  readonly termsHash: Hex32;
  readonly active: boolean;
}

export interface ChainReader {
  readonly chainId: number;
  snapshot(vault: Address): Promise<VaultSnapshot>;
  /** null when the vault has no engagement with this id (payee is the zero address). */
  engagement(vault: Address, engagementId: Hex32): Promise<OnChainEngagement | null>;
  payeeChangeLive(vault: Address, engagementId: Hex32): Promise<boolean>;
  /** Resolves when the node answers; rejects otherwise (readiness probe). */
  ping(): Promise<void>;
}

const ZERO = "0x0000000000000000000000000000000000000000";

export function viemChainReader(client: PublicClient, chainId: number): ChainReader {
  const read = <F extends string>(address: Address, functionName: F, args?: readonly unknown[]): Promise<unknown> =>
    client.readContract({ address, abi: symbolonVaultAbi, functionName, ...(args === undefined ? {} : { args }) } as never) as Promise<unknown>;
  return {
    chainId,
    async snapshot(vault) {
      const verified = await assertTokenDecimals(client, vault);
      const [perTxCap, dailyCap, hourlyCap, humanThreshold, paused, balance] = await Promise.all([
        read(vault, "perTxCap"),
        read(vault, "dailyCap"),
        read(vault, "hourlyCap"),
        read(vault, "humanThreshold"),
        read(vault, "paused"),
        getBalanceBaseUnits(client, verified.token, vault, verified.decimals),
      ]);
      for (const v of [perTxCap, dailyCap, hourlyCap, humanThreshold]) if (typeof v !== "bigint") throw new TypeError("vault returned a non-bigint limit");
      if (typeof paused !== "boolean") throw new TypeError("vault returned a non-boolean paused flag");
      return {
        token: verified.token,
        tokenDecimals: verified.decimals,
        vaultTokenDecimals: verified.decimals,
        balance: balance.units,
        perTxCap: perTxCap as bigint,
        dailyCap: dailyCap as bigint,
        hourlyCap: hourlyCap as bigint,
        humanThreshold: humanThreshold as bigint,
        paused,
      };
    },
    async engagement(vault, engagementId) {
      const r = await read(vault, "engagements", [engagementId]);
      if (!Array.isArray(r) || r.length < 7) throw new TypeError("vault returned an unexpected engagement shape");
      const [payee, cap, released, start, end, termsHash, active] = r as [string, bigint, bigint, bigint, bigint, string, boolean];
      if (payee.toLowerCase() === ZERO) return null;
      return { payee: payee as Address, cap, released, start: BigInt(start), end: BigInt(end), termsHash: termsHash as Hex32, active };
    },
    async payeeChangeLive(vault, engagementId) {
      const r = await read(vault, "payeeChangeLive", [engagementId]);
      if (typeof r !== "boolean") throw new TypeError("vault returned a non-boolean");
      return r;
    },
    async ping() {
      await client.getChainId();
    },
  };
}
