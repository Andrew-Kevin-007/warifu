// SEC-12 / RT-30: forged, replayed, stale and mis-keyed Circle webhooks, on a real Postgres. The signature scheme is
// ECDSA-SHA256 over the raw body with a key fetched by id (V-12, unverified against the live service); these tests prove
// OUR verification logic, with a key pair generated here.
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import type { KeyObject } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ApiError } from "../../src/errors";
import { createCircleWebhookHandler } from "../../src/circle/webhook";
import type { WebhookRequest } from "../../src/circle/webhook";
import { createLogger } from "../../src/log";
import { dbSuiteEnabled, openTestDb } from "../helpers/pgdb";
import type { TestDb } from "../helpers/pgdb";

const enabled = dbSuiteEnabled("circle-webhook.local");
const KEY_ID = "key-id-0001-aaaa";
const NOW = Date.UTC(2026, 9, 13, 12, 0, 0);

function keypair() {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  return { privateKey, b64: publicKey.export({ type: "spki", format: "der" }).toString("base64") };
}
const signBody = (k: KeyObject, body: string): string => sign("sha256", Buffer.from(body, "utf8"), { key: k, dsaEncoding: "der" }).toString("base64");
const iso = (ms: number): string => new Date(ms).toISOString();
const note = (id: string, over: Record<string, unknown> = {}, ts = NOW) =>
  JSON.stringify({
    subscriptionId: "sub-1",
    notificationId: id,
    notificationType: "transactions.outbound",
    notification: { id: "0d3c0b26-2b2e-4e0a-9d0e-111111111111", state: "CONFIRMED", txHash: `0x${"ab".repeat(32)}`, blockchain: "ARC-TESTNET", ...over },
    timestamp: iso(ts),
    version: 2,
  });

describe.skipIf(!enabled)("circle webhook receiver", () => {
  let t: TestDb;
  const kp = keypair();
  const other = keypair();
  let triggers = 0;
  let keyFetches = 0;
  let triggerFails = false;
  const clock = { now: NOW };
  const handler = () =>
    createCircleWebhookHandler({
      db: t.db,
      api: {
        notificationPublicKey: async (id) => {
          keyFetches++;
          if (id !== KEY_ID) throw new Error("unknown key");
          return kp.b64;
        },
      },
      clock: () => clock.now,
      logger: createLogger({ sink: { write: () => undefined } }),
      allowedKeyIds: [KEY_ID],
      trigger: async () => {
        triggers++;
        if (triggerFails) throw new Error("indexer down");
      },
    });
  const req = (rawBody: string, over: Partial<WebhookRequest> = {}): WebhookRequest => ({ rawBody, signature: signBody(kp.privateKey, rawBody), keyId: KEY_ID, ...over });
  const code = async (p: Promise<unknown>): Promise<string> => {
    try {
      await p;
      return "OK";
    } catch (e) {
      if (e instanceof ApiError) return e.code;
      throw e;
    }
  };
  const rows = async () => (await t.db.query<{ notification_id: string; triggered_at: string | null; tx_hash: string | null; payload_sha256: string }>("select * from circle_webhook_events order by received_at")).rows;

  beforeAll(() => {
    t = openTestDb("production");
  }, 120_000);
  afterAll(async () => {
    await t?.close();
  }, 60_000);

  it("accepts a correctly signed, fresh notification, triggers exactly one pass and records it", async () => {
    const body = note("n-accept-1");
    expect(await handler()(req(body))).toBe("PROCESSED");
    expect(triggers).toBe(1);
    const r = (await rows()).find((x) => x.notification_id === "n-accept-1");
    expect(r?.triggered_at).not.toBeNull();
    expect(r?.tx_hash).toBe(`0x${"ab".repeat(32)}`);
    expect(r?.payload_sha256).toBe(createHash("sha256").update(body).digest("hex"));
  });

  it("a replay of the same notification is a no-op (idempotent), even from a second handler instance", async () => {
    const body = note("n-replay-1");
    expect(await handler()(req(body))).toBe("PROCESSED");
    const before = triggers;
    expect(await handler()(req(body))).toBe("DUPLICATE");
    expect(await handler()(req(body))).toBe("DUPLICATE");
    expect(triggers).toBe(before);
    expect((await rows()).filter((x) => x.notification_id === "n-replay-1")).toHaveLength(1);
  });

  it("a forged signature is refused and leaves no trace: wrong key, tampered body, garbage, missing header", async () => {
    const before = { triggers, rows: (await rows()).length };
    const body = note("n-forged-1");
    const h = handler();
    expect(await code(h(req(body, { signature: signBody(other.privateKey, body) })))).toBe("UNAUTHENTICATED");
    expect(await code(h(req(body, { rawBody: body.replace("CONFIRMED", "COMPLETE") })))).toBe("UNAUTHENTICATED"); // body changed after signing
    expect(await code(h(req(body, { signature: "AAAA" })))).toBe("UNAUTHENTICATED");
    expect(await code(h(req(body, { signature: "not base64 !!" })))).toBe("UNAUTHENTICATED");
    expect(await code(h(req(body, { signature: undefined })))).toBe("UNAUTHENTICATED");
    expect(await code(h(req(body, { keyId: undefined })))).toBe("UNAUTHENTICATED");
    expect(triggers).toBe(before.triggers);
    expect((await rows()).length).toBe(before.rows);
  });

  it("a key id that is not configured is refused WITHOUT asking Circle for it (no outbound request on attacker input)", async () => {
    const f = keyFetches;
    const body = note("n-keyid-1");
    expect(await code(handler()(req(body, { keyId: "attacker-key-id-0001" })))).toBe("UNAUTHENTICATED");
    expect(await code(handler()(req(body, { keyId: "../../etc" })))).toBe("UNAUTHENTICATED");
    expect(keyFetches).toBe(f);
  });

  it("with no key id configured the receiver refuses everything (fail closed)", async () => {
    const h = createCircleWebhookHandler({ db: t.db, api: { notificationPublicKey: async () => kp.b64 }, clock: () => NOW, logger: createLogger({ sink: { write: () => undefined } }), allowedKeyIds: [], trigger: async () => undefined });
    expect(await code(h(req(note("n-nokey-1"))))).toBe("UNAUTHENTICATED");
  });

  it("a validly signed but stale or future-dated notification is refused (timestamp window, RT-30)", async () => {
    const before = triggers;
    const h = handler();
    expect(await code(h(req(note("n-stale-1", {}, NOW - 6 * 60_000))))).toBe("BAD_REQUEST");
    expect(await code(h(req(note("n-future-1", {}, NOW + 6 * 60_000))))).toBe("BAD_REQUEST");
    expect(await h(req(note("n-edge-1", {}, NOW - 4 * 60_000)))).toBe("PROCESSED"); // inside the window
    expect(triggers).toBe(before + 1);
    expect((await rows()).some((x) => x.notification_id === "n-stale-1")).toBe(false); // a stale one is not even remembered
  });

  it("a signed body of the wrong shape is a 400 and never triggers", async () => {
    const before = triggers;
    const h = handler();
    for (const bad of [
      "not json",
      JSON.stringify({ notificationType: "transactions.outbound", timestamp: iso(NOW) }),
      JSON.stringify({ notificationId: "x", notificationType: "transactions.outbound" }),
      JSON.stringify({ notificationId: "x", notificationType: "<b>", timestamp: iso(NOW) }),
      JSON.stringify({ notificationId: "y".repeat(200), notificationType: "transactions.outbound", timestamp: iso(NOW) }),
      JSON.stringify({ notificationId: "z", notificationType: "transactions.outbound", timestamp: "yesterday" }),
    ]) {
      expect(await code(h(req(bad)))).toBe("BAD_REQUEST");
    }
    expect(triggers).toBe(before);
  });

  it("hostile free text in the notification is never stored: a malformed tx hash or state is dropped, not echoed", async () => {
    const body = note("n-hostile-1", { txHash: "<script>alert(1)</script>", state: "<img onerror=x>", id: "'; drop table releases; --" });
    expect(await handler()(req(body))).toBe("PROCESSED");
    const r = (await rows()).find((x) => x.notification_id === "n-hostile-1") as Record<string, unknown>;
    expect(r["tx_hash"]).toBeNull();
    expect(r["state"]).toBeNull();
    expect(r["circle_tx_id"]).toBeNull();
  });

  it("a non-transaction notification is recorded but triggers nothing", async () => {
    const before = triggers;
    const body = JSON.stringify({ notificationId: "n-other-1", notificationType: "webhooks.test", notification: {}, timestamp: iso(NOW) });
    expect(await handler()(req(body))).toBe("IGNORED");
    expect(triggers).toBe(before);
  });

  it("if the trigger fails the notification stays retryable: Circle's redelivery runs it again, then it is a duplicate", async () => {
    const body = note("n-retry-1");
    triggerFails = true;
    await expect(handler()(req(body))).rejects.toThrow("indexer down");
    expect((await rows()).find((x) => x.notification_id === "n-retry-1")?.triggered_at).toBeNull();
    triggerFails = false;
    const before = triggers;
    expect(await handler()(req(body))).toBe("PROCESSED");
    expect(await handler()(req(body))).toBe("DUPLICATE");
    expect(triggers).toBe(before + 1);
  });

  it("an unreachable public-key endpoint is a retryable 503, not an accept", async () => {
    const h = createCircleWebhookHandler({ db: t.db, api: { notificationPublicKey: async () => Promise.reject(new Error("down")) }, clock: () => NOW, logger: createLogger({ sink: { write: () => undefined } }), allowedKeyIds: [KEY_ID], trigger: async () => undefined });
    expect(await code(h(req(note("n-down-1"))))).toBe("UNAVAILABLE");
  });

  it("a webhook never writes money state: no release, decision or engagement row is touched by any of the above", async () => {
    for (const table of ["releases", "decisions", "engagements"]) {
      const r = await t.db.query<{ n: string }>(`select count(*)::text as n from ${table}`);
      expect(r.rows[0]?.n).toBe("0");
    }
  });
});
