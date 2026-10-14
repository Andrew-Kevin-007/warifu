/* eslint-disable @typescript-eslint/no-explicit-any */
// The Circle relayer and webhook route against a REAL vault on anvil and a REAL Postgres. Only Circle's HTTP edge is a fake
// (circle-fakes.ts): its "execute" hook broadcasts the exact calldata it was given from anvil's unlocked account, which is
// what a developer-controlled wallet would do. A local pass is a smoke test (V-15, V-19), not evidence about Circle.
import { generateKeyPairSync, sign } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createCircleWebhookHandler } from "../../src/circle/webhook";
import { circleVaultRelayer } from "../../src/circle/relayer";
import { indexAll } from "../../src/engagement/indexer";
import { Secret } from "../../src/secret";
import { anvilSuiteEnabled } from "../helpers/anvil-vault";
import { fakeCircle } from "../helpers/circle-fakes";
import { createEng, dbStatus, openEngagementWorld, signAs } from "../helpers/engagement-world";
import type { EngagementWorld } from "../helpers/engagement-world";
import { dbSuiteEnabled } from "../helpers/pgdb";
import { call } from "../helpers/world";

const enabled = anvilSuiteEnabled("circle.local") && dbSuiteEnabled("circle.local");
const SECRET_HEX = "cd".repeat(32);
const KEY_ID = "key-id-e2e-0001";

describe.skipIf(!enabled)("circle relayer + webhook on a real vault", () => {
  let w: EngagementWorld;
  const ec = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  let broadcast = true; // false: Circle reports a hash for a transaction that never reaches the chain
  let circle: ReturnType<typeof fakeCircle>;
  let triggerCalls = 0;
  beforeAll(async () => {
    w = await openEngagementWorld();
    circle = fakeCircle({
      entitySecretHex: SECRET_HEX,
      plan: async (input) => {
        if (!broadcast) return [{ state: "SENT", txHash: `0x${"9".repeat(64)}` }];
        const hash = await w.v.wallet.sendTransaction({ account: w.v.relayerAccount, to: input.contractAddress as `0x${string}`, data: input.callData as `0x${string}`, chain: null } as never);
        return [{ state: "SENT", txHash: hash }];
      },
    });
    circle.webhookKeys.set(KEY_ID, ec.publicKey.export({ type: "spki", format: "der" }).toString("base64"));
  }, 180_000);
  afterAll(async () => {
    await w?.close();
  }, 60_000);

  const relayer = () => circleVaultRelayer({ api: circle, publicClient: w.v.pub, chainId: 31337, walletId: "relayer-wallet-1", walletAddress: w.v.relayerAccount, entitySecret: new Secret(SECRET_HEX), pollDeadlineMs: 2_000, pollIntervalMs: 10 });
  const webhook = () =>
    createCircleWebhookHandler({
      db: w.t.db,
      api: circle,
      clock: () => Date.now(),
      logger: w.logger,
      allowedKeyIds: [KEY_ID],
      trigger: async () => {
        triggerCalls++;
        await indexAll({ db: w.t.db, chain: w.ec, logger: w.logger }, { confirmations: 0n });
      },
    });
  const app = () => w.app({ engagements: { chain: w.ec, relayer: relayer() }, circleWebhook: webhook() });
  const note = (id: string) => JSON.stringify({ notificationId: id, notificationType: "transactions.outbound", notification: { id: "0d3c0b26-2b2e-4e0a-9d0e-111111111111", state: "COMPLETE" }, timestamp: new Date().toISOString() });
  const post = (a: ReturnType<typeof app>, body: string, headers: Record<string, string> = {}, path = "/v1/webhooks/circle") =>
    call(a, "POST", path, null, body, { "x-circle-key-id": KEY_ID, "x-circle-signature": sign("sha256", Buffer.from(body), { key: ec.privateKey, dsaEncoding: "der" }).toString("base64"), ...headers });

  it("registers an engagement through the Circle relayer; a duplicate sign submits nothing twice; only the indexer makes it ACTIVE", async () => {
    broadcast = true;
    const a = app();
    const e = await createEng(w, a);
    await signAs(w, a, e, "owner");
    const r = await signAs(w, a, e, "payee");
    expect(r.status).toBe(200);
    const mid = await dbStatus(w, e.engagementId);
    expect(mid.status).toBe("REGISTERING"); // submitted is not registered
    expect(mid.submitted_tx).toMatch(/^0x[0-9a-f]{64}$/);
    expect(circle.byKey.size).toBeGreaterThanOrEqual(1);
    const txsBefore = circle.txs.size;
    await signAs(w, a, e, "payee"); // the same signature again: no-op
    expect(circle.txs.size).toBe(txsBefore);
    await w.v.mine(1);
    await w.index();
    const done = await dbStatus(w, e.engagementId);
    expect(done.status).toBe("ACTIVE");
    expect(done.registered_tx).toBe(mid.submitted_tx);
  });

  it("a verified webhook triggers an indexer pass, and that pass (chain events), not the webhook, activates the engagement", async () => {
    broadcast = true;
    const a = app();
    // Register WITHOUT indexing: the transaction is on chain, the kernel has not read it yet.
    const e = await createEng(w, a);
    await signAs(w, a, e, "owner");
    await signAs(w, a, e, "payee");
    await w.v.mine(1);
    expect((await dbStatus(w, e.engagementId)).status).toBe("REGISTERING");
    const before = triggerCalls;
    const res = await post(a, note("e2e-trigger-1"));
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ status: "processed" });
    expect(triggerCalls).toBe(before + 1);
    expect((await dbStatus(w, e.engagementId)).status).toBe("ACTIVE");
    // the very same notification again changes nothing and does not index again
    const again = await post(a, note("e2e-trigger-1"), {}, "/webhooks/circle");
    expect(again.json).toEqual({ status: "duplicate" });
    expect(triggerCalls).toBe(before + 1);
  });

  it("a webhook that CLAIMS completion for a transaction that never reached the chain activates nothing", async () => {
    broadcast = false;
    const a = app();
    const e = await createEng(w, a);
    await signAs(w, a, e, "owner");
    await signAs(w, a, e, "payee");
    const sub = await dbStatus(w, e.engagementId);
    expect(sub.submitted_tx).toBe(`0x${"9".repeat(64)}`);
    const res = await post(a, note("e2e-liar-1"));
    expect(res.status).toBe(200);
    const after = await dbStatus(w, e.engagementId);
    expect(after.status).toBe("REGISTERING"); // the chain says no event: not active
    expect(after.registered_tx).toBeNull();
    broadcast = true;
  });

  it("the route refuses forged, tampered, mis-keyed and oversized webhooks, and needs no service token", async () => {
    const a = app();
    const body = note("e2e-forged-1");
    const other = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const forged = sign("sha256", Buffer.from(body), { key: other.privateKey, dsaEncoding: "der" }).toString("base64");
    const before = triggerCalls;
    expect((await post(a, body, { "x-circle-signature": forged })).status).toBe(401);
    expect((await post(a, body.replace("COMPLETE", "FAILED"))).status).toBe(200); // a DIFFERENT body, signed correctly by post(): fine
    expect((await call(a, "POST", "/v1/webhooks/circle", null, body, { "x-circle-key-id": KEY_ID })).status).toBe(401); // no signature header
    expect((await post(a, body, { "x-circle-key-id": "not-the-configured-key" })).status).toBe(401);
    const huge = JSON.stringify({ notificationId: "big", notificationType: "transactions.outbound", timestamp: new Date().toISOString(), pad: "x".repeat(70_000) });
    expect((await post(a, huge)).status).toBe(413);
    expect(triggerCalls).toBe(before + 1); // only the one correctly signed (different) body triggered
    // a tampered body with the ORIGINAL signature
    const goodSig = sign("sha256", Buffer.from(body), { key: ec.privateKey, dsaEncoding: "der" }).toString("base64");
    expect((await call(a, "POST", "/v1/webhooks/circle", null, body.replace("COMPLETE", "SENT"), { "x-circle-key-id": KEY_ID, "x-circle-signature": goodSig })).status).toBe(401);
  });

  it("without a configured Circle edge the route answers 501 and does nothing", async () => {
    const bare = w.app({ circleWebhook: undefined as never });
    const res = await call(bare, "POST", "/v1/webhooks/circle", null, note("e2e-none-1"), { "x-circle-key-id": KEY_ID, "x-circle-signature": "AAAA" });
    expect(res.status).toBe(501);
  });

  it("the Circle relayer refuses what the vault would refuse and sends nothing (a re-registration)", async () => {
    broadcast = true;
    const a = app();
    const e = await createEng(w, a);
    await signAs(w, a, e, "owner");
    await signAs(w, a, e, "payee");
    await w.v.mine(1);
    await w.index();
    const sent = circle.txs.size;
    const meta: any = (await w.t.db.query("select owner_sig, payee_sig from engagements where engagement_id = $1", [e.engagementId])).rows[0];
    const m = e.typedData.message;
    await expect(
      relayer().registerEngagement({
        vault: w.v.vault,
        terms: { engagementId: m.engagementId, owner: m.owner, payee: m.payee, cap: BigInt(m.cap), start: BigInt(m.start), end: BigInt(m.end), termsHash: m.termsHash, nonce: BigInt(m.nonce) },
        ownerSig: meta.owner_sig,
        payeeSig: meta.payee_sig,
      }),
    ).rejects.toMatchObject({ revertName: "EngagementExists" });
    expect(circle.txs.size).toBe(sent); // no Circle call, no gas burned
  });
});
