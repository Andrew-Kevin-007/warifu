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

export const TESTNET_BLOCKCHAIN = "ARC-TESTNET";
/** Kept for callers that list what testnet accepts. */
export const SUPPORTED_BLOCKCHAINS: readonly string[] = [TESTNET_BLOCKCHAIN];
// VERIFY(V-03): Circle's identifier for Arc mainnet is operator-supplied (CIRCLE_BLOCKCHAIN, from Circle's supported-
// blockchains page), never defaulted. It must look like an Arc identifier and must not be a testnet one; Circle itself
// rejects an identifier it does not know, so a wrong value fails closed at wallet creation.
const MAINNET_BLOCKCHAIN_SHAPE = /^ARC(-[A-Z0-9]{2,20})?$/;

/** testnet/local accept only ARC-TESTNET; mainnet needs an explicit Arc identifier that is not a testnet one. */
export function checkCircleBlockchain(blockchain: string, network: "mainnet" | "testnet" | "local"): string {
  if (network !== "mainnet") {
    if (blockchain !== TESTNET_BLOCKCHAIN) throw new RangeError(`unsupported CIRCLE_BLOCKCHAIN for ${network} (only ${TESTNET_BLOCKCHAIN})`);
    return blockchain;
  }
  if (!MAINNET_BLOCKCHAIN_SHAPE.test(blockchain) || /TEST/.test(blockchain)) throw new RangeError("unsupported CIRCLE_BLOCKCHAIN for mainnet (an Arc mainnet identifier, never a testnet one)");
  return blockchain;
}

export interface GenerateWalletInput {
  readonly api: CircleApi;
  readonly entitySecret: Secret;
  readonly profile: WalletProfile;
  readonly blockchain: string;
  /** Network the wallet is for; default testnet. Mainnet needs an explicit Arc mainnet identifier (checkCircleBlockchain). */
  readonly network?: "mainnet" | "testnet" | "local";
  /** Creation is idempotent under this id: re-running the script with the same id returns the same wallet set/wallet. */
  readonly runId?: string;
}

export async function generateRelayerWallet(i: GenerateWalletInput): Promise<GeneratedWallet> {
  checkCircleBlockchain(i.blockchain, i.network ?? "testnet");
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
