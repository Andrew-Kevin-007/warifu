// Wallet generation helpers (WP-11; lifted in spirit from arc-escrow's generate-wallet.mjs, re-written against CircleApi).
// Creates a wallet SET and one EOA developer-controlled wallet on the configured blockchain. The sandbox profile MUST use
// its own wallet set and its own Circle API key (INV-16): the profile is part of the wallet-set name, and the result is
// printed, never written to an env file here. Entity-secret REGISTRATION (the one-time step that gives Circle the public
// side and produces the recovery file) is an operator step in Circle's console/SDK, VERIFY(V-26); it is not automated.
import { randomUUID } from "node:crypto";
import type { Secret } from "../secret";
import type { CircleApi } from "./client";
import { encryptEntitySecret, uuidFromMaterial } from "./entity-secret";

export type WalletProfile = "production" | "sandbox";

export interface GeneratedWallet {
  readonly profile: WalletProfile;
  readonly walletSetId: string;
  readonly walletId: string;
  /** Lowercase 0x address: this is RELAYER_WALLET_ADDRESS; fund it with testnet USDC for gas (>= $2, docs/06 B.2). */
  readonly address: string;
  readonly blockchain: string;
}

export const SUPPORTED_BLOCKCHAINS: readonly string[] = ["ARC-TESTNET"]; // mainnet identifier is V-03: refused until verified

export interface GenerateWalletInput {
  readonly api: CircleApi;
  readonly entitySecret: Secret;
  readonly profile: WalletProfile;
  readonly blockchain: string;
  /** Creation is idempotent under this id: re-running the script with the same id returns the same wallet set/wallet. */
  readonly runId?: string;
}

export async function generateRelayerWallet(i: GenerateWalletInput): Promise<GeneratedWallet> {
  if (!SUPPORTED_BLOCKCHAINS.includes(i.blockchain)) throw new RangeError("unsupported CIRCLE_BLOCKCHAIN (mainnet is blocked until V-03)");
  const runId = i.runId ?? randomUUID();
  const publicKey = await i.api.entityPublicKey();
  const set = await i.api.createWalletSet({
    idempotencyKey: uuidFromMaterial(`symbolon/wallet-set/v1|${i.profile}|${runId}`),
    name: `symbolon-${i.profile}-relayer`,
    entitySecretCiphertext: encryptEntitySecret(i.entitySecret, publicKey), // a fresh ciphertext per request
  });
  const wallets = await i.api.createWallets({
    idempotencyKey: uuidFromMaterial(`symbolon/wallet/v1|${i.profile}|${runId}`),
    walletSetId: set.id,
    blockchain: i.blockchain,
    count: 1,
    entitySecretCiphertext: encryptEntitySecret(i.entitySecret, publicKey),
  });
  const w = wallets[0];
  if (w === undefined || w.blockchain !== i.blockchain) throw new Error("Circle returned no wallet on the requested blockchain");
  return { profile: i.profile, walletSetId: set.id, walletId: w.id, address: w.address, blockchain: w.blockchain };
}
