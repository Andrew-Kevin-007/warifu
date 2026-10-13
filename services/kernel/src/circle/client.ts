// Thin typed Circle Web3 Services client (WP-11). The network edge is the ONLY thing mocked in tests: pass `fetchImpl`.
// No Circle SDK is a dependency of this repo and no network install is possible in this lane, so this is a small fetch
// client behind the CircleApi interface; swapping in the official SDK later means implementing the same interface.
//
// Every endpoint path, header and response shape below is written from memory of Circle's public docs and is UNVERIFIED:
// VERIFY(V-11) contract-execution request shape, VERIFY(V-12) notification key endpoint, VERIFY(V-26) the rest. See
// docs/VERIFY_LOG.md. Response bodies are untrusted: parsed with zod, never echoed (error messages are fixed strings plus a
// bounded code), and the API key is never part of any thrown value.
import { z } from "zod";
import type { Secret } from "../secret";

export type CircleTxState = "INITIATED" | "QUEUED" | "SENT" | "CONFIRMED" | "COMPLETE" | "FAILED" | "CANCELLED" | "DENIED" | "STUCK" | "CLEARED";
const STATES: readonly string[] = ["INITIATED", "QUEUED", "SENT", "CONFIRMED", "COMPLETE", "FAILED", "CANCELLED", "DENIED", "STUCK", "CLEARED"];

export type TxPhase = "PENDING" | "ON_CHAIN" | "FAILED";
/** PENDING: not broadcast yet. ON_CHAIN: broadcast (a txHash exists or soon will). FAILED: Circle will not send it. Unknown = FAILED (fail closed). */
export function txPhase(state: string): TxPhase {
  switch (state) {
    case "INITIATED":
    case "QUEUED":
      return "PENDING";
    case "SENT":
    case "CONFIRMED":
    case "COMPLETE":
      return "ON_CHAIN";
    default:
      return "FAILED"; // FAILED, CANCELLED, DENIED, STUCK, CLEARED and anything new
  }
}

export interface CircleTx {
  readonly id: string;
  readonly state: string;
  /** Lowercase 0x + 64 hex, or null when Circle has not reported one (or reported something malformed). */
  readonly txHash: string | null;
  readonly errorReason: string | null;
}

export class CircleApiError extends Error {
  readonly status: number;
  /** Circle's numeric error code when the body had one, else null. Never the message text (untrusted). */
  readonly code: number | null;
  constructor(message: string, status: number, code: number | null, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "CircleApiError";
    this.status = status;
    this.code = code;
  }
}

export interface ContractExecutionInput {
  /** A UUID. Circle de-duplicates on it (docs/06 B.2); derived deterministically by the relayer. */
  readonly idempotencyKey: string;
  readonly walletId: string;
  readonly contractAddress: string;
  /** Pre-encoded calldata (viem encodeFunctionData), VERIFY(V-11) whether the API accepts it. */
  readonly callData: string;
  readonly refId: string;
  /** Fresh RSA-OAEP ciphertext of the entity secret: Circle rejects a reused one. */
  readonly entitySecretCiphertext: string;
}

export interface CircleApi {
  /** PEM public key used to encrypt the entity secret. */
  entityPublicKey(): Promise<string>;
  createContractExecution(i: ContractExecutionInput): Promise<{ readonly id: string; readonly state: string }>;
  getTransaction(id: string): Promise<CircleTx>;
  /** Base64 DER (SPKI) public key for a webhook key id. */
  notificationPublicKey(keyId: string): Promise<string>;
  createWalletSet(i: { idempotencyKey: string; name: string; entitySecretCiphertext: string }): Promise<{ readonly id: string }>;
  createWallets(i: {
    idempotencyKey: string;
    walletSetId: string;
    blockchain: string;
    count: number;
    entitySecretCiphertext: string;
  }): Promise<ReadonlyArray<{ readonly id: string; readonly address: string; readonly blockchain: string }>>;
}

export interface CircleHttpOptions {
  readonly apiKey: Secret;
  readonly baseUrl?: string;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
}

export const CIRCLE_BASE_URL = "https://api.circle.com";
const TX_HASH = /^0x[0-9a-fA-F]{64}$/;
const SHORT_ID = z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/);

const EnvelopeError = z.looseObject({ code: z.number().int().optional() });

const ExecutionResponse = z.looseObject({ data: z.looseObject({ id: SHORT_ID, state: z.string().max(40) }) });
const TransactionResponse = z.looseObject({
  data: z.looseObject({
    transaction: z.looseObject({
      id: SHORT_ID,
      state: z.string().max(40),
      txHash: z.string().max(100).nullish(),
      errorReason: z.string().max(100).nullish(),
    }),
  }),
});
const EntityKeyResponse = z.looseObject({ data: z.looseObject({ publicKey: z.string().min(100).max(4096) }) });
const NotificationKeyResponse = z.looseObject({ data: z.looseObject({ publicKey: z.string().min(40).max(2048) }) });
const WalletSetResponse = z.looseObject({ data: z.looseObject({ walletSet: z.looseObject({ id: SHORT_ID }) }) });
const WalletsResponse = z.looseObject({
  data: z.looseObject({
    wallets: z.array(z.looseObject({ id: SHORT_ID, address: z.string().regex(/^0x[0-9a-fA-F]{40}$/), blockchain: z.string().max(40) })).min(1).max(10),
  }),
});

export function createCircleHttpApi(o: CircleHttpOptions): CircleApi {
  const base = o.baseUrl ?? CIRCLE_BASE_URL;
  const url = new URL(base);
  if (url.protocol !== "https:" || url.hostname !== "api.circle.com") throw new RangeError("the Circle API base URL must be https://api.circle.com"); // never send the key elsewhere
  const doFetch = o.fetchImpl ?? fetch;
  const timeoutMs = o.timeoutMs ?? 10_000;

  async function call<T>(method: "GET" | "POST", path: string, body: unknown, schema: z.ZodType<T>): Promise<T> {
    let res: Response;
    try {
      res = await doFetch(`${url.origin}${path}`, {
        method,
        headers: { Authorization: `Bearer ${o.apiKey.reveal()}`, Accept: "application/json", ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(timeoutMs),
        redirect: "error", // a redirect would carry the Authorization header somewhere else
      });
    } catch (cause) {
      throw new CircleApiError("the Circle API did not answer", 0, null, { cause: cause instanceof Error ? new Error(cause.name) : undefined });
    }
    let text: string;
    try {
      text = await res.text();
    } catch {
      throw new CircleApiError("the Circle API response could not be read", res.status, null);
    }
    let json: unknown;
    try {
      json = text === "" ? {} : (JSON.parse(text.slice(0, 1_000_000)) as unknown);
    } catch {
      json = null;
    }
    if (!res.ok) {
      const e = EnvelopeError.safeParse(json);
      throw new CircleApiError(`the Circle API refused the request (HTTP ${String(res.status)})`, res.status, e.success ? (e.data.code ?? null) : null);
    }
    const parsed = schema.safeParse(json);
    if (!parsed.success) throw new CircleApiError("the Circle API answered with an unexpected shape", res.status, null);
    return parsed.data;
  }

  return {
    async entityPublicKey() {
      // VERIFY(V-26): GET /v1/w3s/config/entity/publicKey -> { data: { publicKey: PEM } }
      return (await call("GET", "/v1/w3s/config/entity/publicKey", undefined, EntityKeyResponse)).data.publicKey;
    },
    async createContractExecution(i) {
      // VERIFY(V-11): POST /v1/w3s/developer/transactions/contractExecution. Pre-encoded `callData` may or may not be accepted
      // for a struct argument; the fallback is abiFunctionSignature + abiParameters (tuple encoding). Fee: VERIFY(V-27).
      const r = await call(
        "POST",
        "/v1/w3s/developer/transactions/contractExecution",
        {
          idempotencyKey: i.idempotencyKey,
          walletId: i.walletId,
          contractAddress: i.contractAddress,
          callData: i.callData,
          feeLevel: "HIGH",
          refId: i.refId,
          entitySecretCiphertext: i.entitySecretCiphertext,
        },
        ExecutionResponse,
      );
      return { id: r.data.id, state: r.data.state };
    },
    async getTransaction(id) {
      if (!SHORT_ID.safeParse(id).success) throw new CircleApiError("malformed Circle transaction id", 0, null);
      const t = (await call("GET", `/v1/w3s/transactions/${encodeURIComponent(id)}`, undefined, TransactionResponse)).data.transaction;
      return { id: t.id, state: t.state, txHash: typeof t.txHash === "string" && TX_HASH.test(t.txHash) ? t.txHash.toLowerCase() : null, errorReason: t.errorReason ?? null };
    },
    async notificationPublicKey(keyId) {
      if (!/^[A-Za-z0-9_-]{8,64}$/.test(keyId)) throw new CircleApiError("malformed webhook key id", 0, null);
      // VERIFY(V-12): GET /v2/notifications/publicKey/{id} -> { data: { id, algorithm, publicKey: base64 DER } }
      return (await call("GET", `/v2/notifications/publicKey/${encodeURIComponent(keyId)}`, undefined, NotificationKeyResponse)).data.publicKey;
    },
    async createWalletSet(i) {
      // VERIFY(V-26): POST /v1/w3s/developer/walletSets
      const r = await call("POST", "/v1/w3s/developer/walletSets", { idempotencyKey: i.idempotencyKey, name: i.name, entitySecretCiphertext: i.entitySecretCiphertext }, WalletSetResponse);
      return { id: r.data.walletSet.id };
    },
    async createWallets(i) {
      // VERIFY(V-26): POST /v1/w3s/developer/wallets (accountType EOA: the relayer holds native USDC gas, docs/06 B.2)
      const r = await call(
        "POST",
        "/v1/w3s/developer/wallets",
        { idempotencyKey: i.idempotencyKey, accountType: "EOA", blockchains: [i.blockchain], count: i.count, walletSetId: i.walletSetId, entitySecretCiphertext: i.entitySecretCiphertext },
        WalletsResponse,
      );
      return r.data.wallets.map((w) => ({ id: w.id, address: w.address.toLowerCase(), blockchain: w.blockchain }));
    },
  };
}

export function isKnownState(s: string): s is CircleTxState {
  return STATES.includes(s);
}
