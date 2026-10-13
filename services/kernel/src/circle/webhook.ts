// Circle webhook receiver (WP-11; docs/05 s6, docs/06 B.2; RT-30, SEC-12).
//
// WHAT A WEBHOOK IS HERE: a doorbell. A verified notification may cause one indexer pass; it NEVER confirms a release or
// changes any money state (INV-8, K-15 trusts chain events). So the worst a forged or replayed webhook could ever do is
// cause one redundant, idempotent indexer pass, and these checks make even that hard:
//   1. size cap (route) and header presence; the key id must be one of the configured ids (fail closed when none is set);
//   2. ECDSA-SHA256 signature over the RAW body bytes with the public key Circle publishes for that id, VERIFY(V-12);
//   3. strict body shape; the notification timestamp (inside the signed body, so not forgeable) must be within the window
//      in BOTH directions, VERIFY(V-12): Circle may not sign a header timestamp, the body's is what is available;
//   4. idempotency on the signed notificationId (DB, survives restarts and several instances): a replay is a no-op.
// Failure answers are uniform and carry no detail about which check failed. Body contents are untrusted: only a validated
// id, a hex tx hash and a bounded state string are stored, never free text.
import { createHash, createPublicKey, verify } from "node:crypto";
import type { KeyObject } from "node:crypto";
import { z } from "zod";
import { ApiError } from "../errors";
import type { Db } from "../db/pool";
import { errorFields } from "../log";
import type { Logger } from "../log";
import type { Clock } from "../time";
import type { CircleApi } from "./client";

export const WEBHOOK_MAX_BYTES = 64 * 1024;
export const DEFAULT_WINDOW_MS = 5 * 60 * 1000;
const KEY_ID = /^[A-Za-z0-9_-]{8,64}$/;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

const BodySchema = z.looseObject({
  notificationId: z.string().min(1).max(128),
  notificationType: z.string().min(1).max(80).regex(/^[A-Za-z0-9._-]+$/),
  notification: z.looseObject({}).optional(),
  timestamp: z.iso.datetime({ offset: true }),
});
const TxFields = z.looseObject({
  id: z.string().max(64).regex(/^[A-Za-z0-9_-]+$/).optional(),
  state: z.string().max(40).regex(/^[A-Z_]+$/).optional(),
  txHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/).optional(),
});

export type WebhookOutcome = "PROCESSED" | "DUPLICATE" | "IGNORED";

export interface WebhookDeps {
  readonly db: Db;
  readonly api: Pick<CircleApi, "notificationPublicKey">;
  readonly clock: Clock;
  readonly logger: Logger;
  /** CIRCLE_WEBHOOK_PUBLIC_KEY_ID (comma separated for a rotation). Empty = the receiver refuses everything. */
  readonly allowedKeyIds: readonly string[];
  /** Runs one reconcile/indexer pass. It must not throw for "nothing to do"; a throw leaves the notification retryable. */
  readonly trigger: () => Promise<void>;
  readonly windowMs?: number;
}

export interface WebhookRequest {
  readonly rawBody: string;
  readonly signature: string | undefined;
  readonly keyId: string | undefined;
}

const unauthenticated = (): ApiError => new ApiError("UNAUTHENTICATED", "webhook rejected");

export function createCircleWebhookHandler(d: WebhookDeps): (r: WebhookRequest) => Promise<WebhookOutcome> {
  const windowMs = d.windowMs ?? DEFAULT_WINDOW_MS;
  const keys = new Map<string, KeyObject>();

  async function publicKey(keyId: string): Promise<KeyObject> {
    const hit = keys.get(keyId);
    if (hit !== undefined) return hit;
    const b64 = await d.api.notificationPublicKey(keyId);
    if (!BASE64.test(b64)) throw new Error("webhook public key is not base64");
    const k = createPublicKey({ key: Buffer.from(b64, "base64"), format: "der", type: "spki" });
    keys.set(keyId, k);
    return k;
  }

  return async (r) => {
    // 1. headers and key id
    if (r.signature === undefined || r.keyId === undefined || !KEY_ID.test(r.keyId) || !BASE64.test(r.signature) || r.signature.length > 512) throw unauthenticated();
    if (d.allowedKeyIds.length === 0 || !d.allowedKeyIds.includes(r.keyId)) throw unauthenticated();
    if (Buffer.byteLength(r.rawBody, "utf8") > WEBHOOK_MAX_BYTES) throw new ApiError("PAYLOAD_TOO_LARGE", "request body is too large");

    // 2. signature over the raw bytes
    let ok: boolean;
    try {
      const key = await publicKey(r.keyId);
      ok = verify("sha256", Buffer.from(r.rawBody, "utf8"), { key, dsaEncoding: "der" }, Buffer.from(r.signature, "base64"));
    } catch (e) {
      d.logger.warn("webhook.key_unavailable", { reasonCode: "KEY_UNAVAILABLE", ...errorFields(e) });
      throw new ApiError("UNAVAILABLE", "webhook verification is unavailable", {}, { "Retry-After": "30" }); // Circle redelivers; nothing was trusted
    }
    if (!ok) {
      d.logger.warn("webhook.rejected", { reasonCode: "BAD_SIGNATURE" });
      throw unauthenticated();
    }

    // 3. shape and freshness (only reachable with a valid signature, so the body is Circle's)
    let json: unknown;
    try {
      json = JSON.parse(r.rawBody);
    } catch {
      throw new ApiError("BAD_REQUEST", "malformed webhook body");
    }
    const body = BodySchema.safeParse(json);
    if (!body.success) throw new ApiError("BAD_REQUEST", "malformed webhook body");
    const eventMs = Date.parse(body.data.timestamp);
    if (Math.abs(d.clock() - eventMs) > windowMs) {
      d.logger.warn("webhook.rejected", { reasonCode: "OUTSIDE_WINDOW" });
      throw new ApiError("BAD_REQUEST", "webhook outside the accepted time window");
    }

    // 4. idempotency (the DB clock is not involved: the window above is the replay bound, the row is the exactly-once)
    const tx = TxFields.safeParse(body.data.notification ?? {});
    const fields = tx.success ? tx.data : {};
    const payloadSha = createHash("sha256").update(r.rawBody, "utf8").digest("hex");
    await d.db.query(
      `insert into circle_webhook_events (notification_id, notification_type, circle_tx_id, state, tx_hash, payload_sha256, event_at)
       values ($1, $2, $3, $4, $5, $6, $7) on conflict (notification_id) do nothing`,
      [body.data.notificationId, body.data.notificationType, fields.id ?? null, fields.state ?? null, fields.txHash?.toLowerCase() ?? null, payloadSha, new Date(eventMs).toISOString()],
    );
    const row = await d.db.query<{ triggered_at: string | null }>("select triggered_at from circle_webhook_events where notification_id = $1", [body.data.notificationId]);
    if (row.rows[0] === undefined) throw new Error("webhook row vanished");
    if (row.rows[0].triggered_at !== null) return "DUPLICATE";

    if (!body.data.notificationType.startsWith("transactions.")) {
      await d.db.query("update circle_webhook_events set triggered_at = now() where notification_id = $1 and triggered_at is null", [body.data.notificationId]);
      return "IGNORED";
    }
    // A throw here leaves triggered_at null: Circle's redelivery of the same notification runs it again. A concurrent duplicate
    // may run a second pass; indexTenant holds an advisory lock and is idempotent, so that is harmless.
    await d.trigger();
    await d.db.query("update circle_webhook_events set triggered_at = now() where notification_id = $1 and triggered_at is null", [body.data.notificationId]);
    d.logger.info("webhook.processed", { reasonCode: "TRIGGERED", ...(fields.txHash === undefined ? {} : { txHash: fields.txHash.toLowerCase() }) });
    return "PROCESSED";
  };
}
