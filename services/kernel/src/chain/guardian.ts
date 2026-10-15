// The guardian port (WP-15, K-16): the PAUSE-ONLY role of the vault (docs/06 A.2). The guardian key can call `pause()` and
// nothing else; it cannot unpause, withdraw or sign attestations, so a leaked guardian key can only stop payments. The
// implementation simulates first (a revert still costs gas on Arc, AGENTS.md section 3) and treats "already paused" as success.
import { symbolonVaultAbi, vaultRevertName, withFeeFloor } from "@symbolon/chain";
import type { Address, Hex32 } from "@symbolon/schemas";
import type { Account, PublicClient, WalletClient } from "viem";

export interface GuardianPauser {
  /** Pause the vault. Resolves with the tx hash, or null when it was already paused. Throws when the pause could not be sent. */
  pause(vault: Address): Promise<{ txHash: Hex32 | null }>;
}

export class PauseError extends Error {
  readonly revertName: string | null;
  constructor(message: string, revertName: string | null, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "PauseError";
    this.revertName = revertName;
  }
}

export interface ViemGuardianOptions {
  readonly publicClient: PublicClient;
  readonly walletClient: WalletClient;
  /** The guardian's local account (throwaway key on testnet). Never the kernel signer or the relayer. */
  readonly account: Account;
}

export function viemGuardianPauser(o: ViemGuardianOptions): GuardianPauser {
  return {
    async pause(vault) {
      try {
        if ((await o.publicClient.readContract({ address: vault, abi: symbolonVaultAbi, functionName: "paused" } as never)) === true) return { txHash: null };
        const { request } = await o.publicClient.simulateContract({ address: vault, abi: symbolonVaultAbi, functionName: "pause", args: [], account: o.account } as never);
        const hash = await o.walletClient.writeContract({ ...(request as object), maxFeePerGas: withFeeFloor(undefined) } as never);
        return { txHash: hash.toLowerCase() as Hex32 };
      } catch (cause) {
        const name = vaultRevertName(cause) ?? null;
        throw new PauseError(name === null ? "guardian pause failed" : `the vault refused pause: ${name}`, name, { cause });
      }
    },
  };
}
