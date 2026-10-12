// The relayer port (WP-12): submits ALREADY-SIGNED vault messages (docs/06 A.2: "relayer: submit already-signed messages
// (pays gas); change any message: no"). The Circle developer-controlled-wallet implementation is WP-11; this file defines
// the interface the engagement service depends on plus a viem implementation used for local/anvil and for a throwaway
// testnet relayer key. Every call is SIMULATED first: on Arc a revert still consumes gas (AGENTS.md section 3), so a
// message the vault would refuse is never sent.
import { symbolonVaultAbi, vaultRevertName, withFeeFloor } from "@symbolon/chain";
import type { Address, Hex32 } from "@symbolon/schemas";
import type { Account, Hex, PublicClient, WalletClient } from "viem";

/** uint fields are bigint here (this is the ABI edge, not the JSON edge). */
export interface EngagementTermsArgs {
  readonly engagementId: Hex32;
  readonly owner: Address;
  readonly payee: Address;
  readonly cap: bigint;
  readonly start: bigint;
  readonly end: bigint;
  readonly termsHash: Hex32;
  readonly nonce: bigint;
}

export interface PayeeChangeArgs {
  readonly engagementId: Hex32;
  readonly oldPayee: Address;
  readonly newPayee: Address;
  readonly nonce: bigint;
}

export class RelayError extends Error {
  /** The vault custom error the simulation hit (OwnerMismatch, BadPayeeSig, TooEarly, ...), when there is one. */
  readonly revertName: string | null;
  constructor(message: string, revertName: string | null, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "RelayError";
    this.revertName = revertName;
  }
}

export interface VaultRelayer {
  registerEngagement(i: { vault: Address; terms: EngagementTermsArgs; ownerSig: Hex; payeeSig: Hex }): Promise<{ txHash: Hex32 }>;
  proposePayeeChange(i: { vault: Address; change: PayeeChangeArgs; ownerSig: Hex; oldSig: Hex; newSig: Hex }): Promise<{ txHash: Hex32 }>;
  executePayeeChange(i: { vault: Address; engagementId: Hex32 }): Promise<{ txHash: Hex32 }>;
}

export interface ViemRelayerOptions {
  readonly publicClient: PublicClient;
  readonly walletClient: WalletClient;
  /** A local account (throwaway key) or, on anvil only, an unlocked JSON-RPC address. */
  readonly account: Account | Address;
}

export function viemVaultRelayer(o: ViemRelayerOptions): VaultRelayer {
  async function send(vault: Address, functionName: string, args: readonly unknown[]): Promise<{ txHash: Hex32 }> {
    try {
      const { request } = await o.publicClient.simulateContract({ address: vault, abi: symbolonVaultAbi, functionName, args, account: o.account } as never);
      const hash = await o.walletClient.writeContract({ ...(request as object), maxFeePerGas: withFeeFloor(undefined) } as never);
      return { txHash: hash.toLowerCase() as Hex32 };
    } catch (cause) {
      const name = vaultRevertName(cause) ?? null;
      throw new RelayError(name === null ? `relay of ${functionName} failed` : `the vault refused ${functionName}: ${name}`, name, { cause });
    }
  }
  return {
    registerEngagement: (i) => send(i.vault, "registerEngagement", [i.terms, i.ownerSig, i.payeeSig]),
    proposePayeeChange: (i) => send(i.vault, "proposePayeeChange", [i.change, i.ownerSig, i.oldSig, i.newSig]),
    executePayeeChange: (i) => send(i.vault, "executePayeeChange", [i.engagementId]),
  };
}
