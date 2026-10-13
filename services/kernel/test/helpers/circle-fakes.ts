// A scripted stand-in for Circle's HTTP API at the CircleApi interface (the network edge: the only thing mocked). It models
// what matters to the relayer: idempotency keys de-duplicate (a repeated key returns the SAME transaction), the entity
// secret ciphertext is real RSA-OAEP that the fake DECRYPTS and checks (so a wrong or reused-secret bug fails), and a
// transaction reports a scripted sequence of states. Nothing here is a claim about the real Circle service (V-11/V-12/V-26).
import { constants, generateKeyPairSync, privateDecrypt, randomUUID } from "node:crypto";
import type { KeyObject } from "node:crypto";
import type { CircleApi, CircleTx, ContractExecutionInput } from "../../src/circle/client";

export interface FakeTx {
  id: string;
  readonly input: ContractExecutionInput;
  /** States returned by successive getTransaction calls; the last one repeats. */
  script: Array<{ state: string; txHash?: string | null }>;
  polls: number;
}

export interface FakeCircleOptions {
  readonly entitySecretHex: string;
  /** Decide a NEW transaction's scripted states. Default: SENT with a hash derived by `hashFor`. */
  readonly plan?: (input: ContractExecutionInput, n: number) => FakeTx["script"] | Promise<FakeTx["script"]>;
  readonly initialState?: (n: number) => string;
}

export interface FakeCircle extends CircleApi {
  readonly txs: Map<string, FakeTx>;
  readonly byKey: Map<string, FakeTx>;
  readonly executeCalls: ContractExecutionInput[];
  readonly ciphertextsSeen: string[];
  readonly privateKey: KeyObject;
  readonly walletSets: unknown[];
  webhookKeys: Map<string, string>;
}

export function fakeCircle(o: FakeCircleOptions): FakeCircle {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pem = publicKey.export({ type: "spki", format: "pem" }).toString();
  const txs = new Map<string, FakeTx>();
  const byKey = new Map<string, FakeTx>();
  const executeCalls: ContractExecutionInput[] = [];
  const ciphertextsSeen: string[] = [];
  const walletSets: unknown[] = [];
  const webhookKeys = new Map<string, string>();

  function checkCiphertext(c: string): void {
    if (ciphertextsSeen.includes(c)) throw new Error("entity secret ciphertext reused");
    ciphertextsSeen.push(c);
    const plain = privateDecrypt({ key: privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }, Buffer.from(c, "base64")).toString("hex");
    if (plain !== o.entitySecretHex) throw new Error("entity secret ciphertext does not decrypt to the entity secret");
  }

  const api: FakeCircle = {
    txs,
    byKey,
    executeCalls,
    ciphertextsSeen,
    privateKey,
    walletSets,
    webhookKeys,
    async entityPublicKey() {
      return pem;
    },
    async createContractExecution(i) {
      executeCalls.push(i);
      checkCiphertext(i.entitySecretCiphertext);
      const existing = byKey.get(i.idempotencyKey);
      if (existing !== undefined) return { id: existing.id, state: existing.script[0]?.state ?? "INITIATED" };
      const n = byKey.size;
      const script = o.plan === undefined ? [{ state: "SENT", txHash: `0x${(n + 1).toString(16).padStart(64, "0")}` }] : await o.plan(i, n);
      const tx: FakeTx = { id: randomUUID(), input: i, script, polls: 0 };
      txs.set(tx.id, tx);
      byKey.set(i.idempotencyKey, tx);
      return { id: tx.id, state: o.initialState?.(n) ?? "INITIATED" };
    },
    async getTransaction(id): Promise<CircleTx> {
      const tx = txs.get(id);
      if (tx === undefined) throw new Error("unknown tx");
      const step = tx.script[Math.min(tx.polls, tx.script.length - 1)];
      tx.polls++;
      if (step === undefined) throw new Error("empty script");
      return { id, state: step.state, txHash: step.txHash ?? null, errorReason: null };
    },
    async notificationPublicKey(keyId) {
      const k = webhookKeys.get(keyId);
      if (k === undefined) throw new Error("unknown webhook key");
      return k;
    },
    async createWalletSet(i) {
      checkCiphertext(i.entitySecretCiphertext);
      walletSets.push(i);
      return { id: "ws-0000-aaaa" };
    },
    async createWallets(i) {
      checkCiphertext(i.entitySecretCiphertext);
      return [{ id: "wallet-0001", address: "0x00000000000000000000000000000000000000aa", blockchain: i.blockchain }];
    },
  };
  return api;
}
