// The Circle developer-controlled-wallet implementation of the WP-12 VaultRelayer port (docs/06 B.2).
//
// Same contract as the viem relayer: it submits ALREADY-SIGNED vault messages, changes nothing in them, and SIMULATES
// first (an Arc revert still burns gas). What differs is that Circle's API is asynchronous, so:
//
//  - IDEMPOTENCY: the Circle idempotency key is a UUID derived from (chain, wallet, vault, exact calldata, attempt).
//    The same message always maps to the same key, so a retry (or a second process) cannot submit it twice; the vault's
//    own replay guards (EngagementExists, used[intentId], nonces) are the second line. If Circle reports the keyed
//    transaction already dead (FAILED/CANCELLED/DENIED/STUCK), the next attempt number gets a fresh key, up to
//    MAX_ATTEMPTS (docs/02: after N=3 -> HOLD, alert), and a replay walks the same sequence to the same live transaction.
//  - CLAIM-THEN-SEND SPLIT IS NOT NEEDED (WP-12 item 3): the engagement service holds a DB transaction across relay()
//    and Postgres kills a session idle in transaction after 30 s. We do not hold it open for a slow Circle path: the wait
//    for a txHash is bounded by `pollDeadlineMs` (default 20 s, hard ceiling 25 s, enforced). On expiry we throw
//    RelayError("CIRCLE_PENDING"); the service records a retryable failure, and the next attempt re-sends the SAME keyed
//    request, which Circle answers with the SAME transaction, so nothing is duplicated and the txHash is picked up then.
//    A long-running release path (WP-14) should use the same keyed call and not hold a transaction at all.
//  - A txHash Circle reports is only a pointer: the indexer (chain events) alone decides what happened (INV-8, K-15).
import { symbolonVaultAbi, vaultRevertName } from "@symbolon/chain";
import type { Address, Hex32 } from "@symbolon/schemas";
import { encodeFunctionData } from "viem";
import type { Hex, PublicClient } from "viem";
import { RelayError } from "../chain/relayer";
import type { VaultRelayer } from "../chain/relayer";
import type { Secret } from "../secret";
import { CircleApiError, txPhase } from "./client";
import type { CircleApi } from "./client";
import { encryptEntitySecret, uuidFromMaterial } from "./entity-secret";

export const MAX_ATTEMPTS = 3;
export const MAX_POLL_DEADLINE_MS = 25_000;
const KEY_CACHE_MS = 60 * 60 * 1000;

export interface CircleRelayerOptions {
  readonly api: CircleApi;
  readonly publicClient: PublicClient;
  readonly chainId: number;
  /** Circle wallet id of the relayer EOA (RELAYER_WALLET_ID). */
  readonly walletId: string;
  /** Its address (RELAYER_WALLET_ADDRESS): used as `from` for the pre-send simulation. */
  readonly walletAddress: Address;
  readonly entitySecret: Secret;
  readonly pollDeadlineMs?: number;
  readonly pollIntervalMs?: number;
  /** Injectable for tests only. */
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
}

export function circleIdempotencyKey(chainId: number, walletId: string, vault: string, callData: string, attempt: number): string {
  return uuidFromMaterial(`symbolon/circle-relay/v1|${String(chainId)}|${walletId}|${vault.toLowerCase()}|${callData.toLowerCase()}|${String(attempt)}`);
}

export function circleVaultRelayer(o: CircleRelayerOptions): VaultRelayer {
  const deadlineMs = o.pollDeadlineMs ?? 20_000;
  if (!Number.isInteger(deadlineMs) || deadlineMs < 0 || deadlineMs > MAX_POLL_DEADLINE_MS) throw new RangeError(`pollDeadlineMs must be between 0 and ${String(MAX_POLL_DEADLINE_MS)}`);
  const intervalMs = o.pollIntervalMs ?? 1_000;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = o.now ?? (() => Date.now());
  let cachedKey: { pem: string; at: number } | null = null;

  async function ciphertext(): Promise<string> {
    if (cachedKey === null || now() - cachedKey.at > KEY_CACHE_MS) cachedKey = { pem: await o.api.entityPublicKey(), at: now() };
    return encryptEntitySecret(o.entitySecret, cachedKey.pem);
  }

  async function send(vault: Address, functionName: string, args: readonly unknown[]): Promise<{ txHash: Hex32 }> {
    let callData: Hex;
    try {
      // Simulate from the relayer address first: a message the vault would refuse is never sent.
      await o.publicClient.simulateContract({ address: vault, abi: symbolonVaultAbi, functionName, args, account: o.walletAddress } as never);
      callData = encodeFunctionData({ abi: symbolonVaultAbi, functionName, args } as never);
    } catch (cause) {
      const name = vaultRevertName(cause) ?? null;
      throw new RelayError(name === null ? `relay of ${functionName} failed` : `the vault refused ${functionName}: ${name}`, name, { cause });
    }
    const deadline = now() + deadlineMs;
    try {
      for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        const created = await o.api.createContractExecution({
          idempotencyKey: circleIdempotencyKey(o.chainId, o.walletId, vault, callData, attempt),
          walletId: o.walletId,
          contractAddress: vault,
          callData,
          refId: `symbolon:${functionName}`,
          entitySecretCiphertext: await ciphertext(),
        });
        let phase = txPhase(created.state);
        let hash: string | null = null;
        for (;;) {
          if (phase === "FAILED") break; // this keyed transaction is dead: try the next attempt number
          const tx = await o.api.getTransaction(created.id);
          phase = txPhase(tx.state);
          if (phase === "ON_CHAIN" && tx.txHash !== null) {
            hash = tx.txHash;
            break;
          }
          if (phase === "FAILED") break;
          if (now() >= deadline) throw new RelayError(`Circle has not reported a transaction hash for ${functionName} yet`, "CIRCLE_PENDING");
          await sleep(intervalMs);
        }
        if (hash !== null) return { txHash: hash.toLowerCase() as Hex32 };
      }
      throw new RelayError(`Circle failed ${functionName} ${String(MAX_ATTEMPTS)} times`, "CIRCLE_TX_FAILED");
    } catch (cause) {
      if (cause instanceof RelayError) throw cause;
      if (cause instanceof CircleApiError) throw new RelayError(`the Circle API failed during ${functionName} (HTTP ${String(cause.status)})`, "CIRCLE_API_ERROR", { cause });
      throw cause;
    }
  }

  return {
    registerEngagement: (i) => send(i.vault, "registerEngagement", [i.terms, i.ownerSig, i.payeeSig]),
    proposePayeeChange: (i) => send(i.vault, "proposePayeeChange", [i.change, i.ownerSig, i.oldSig, i.newSig]),
    executePayeeChange: (i) => send(i.vault, "executePayeeChange", [i.engagementId]),
  };
}
