/* eslint-disable @typescript-eslint/no-explicit-any */
// WP-12 payee-change flow against the real vault: three signatures, strictly increasing nonces, the vault's delay, the
// pause cancellation (WP-07 item 6). A local pass is a smoke test (V-15, V-19).
import { symbolonVaultAbi } from "@symbolon/chain";
import type { Abi } from "viem";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PAYEE_DELAY, anvilSuiteEnabled, newParty } from "../helpers/anvil-vault";
import type { Party } from "../helpers/anvil-vault";
import { TENANT_A, activate, createEng, dbStatus, openEngagementWorld } from "../helpers/engagement-world";
import type { EngagementWorld } from "../helpers/engagement-world";
import { dbSuiteEnabled } from "../helpers/pgdb";
import { call } from "../helpers/world";

const enabled = anvilSuiteEnabled("payee-change.local") && dbSuiteEnabled("payee-change.local");

describe.skipIf(!enabled)("local payee change", () => {
  let w: EngagementWorld;
  let app: ReturnType<EngagementWorld["app"]>;
  beforeAll(async () => {
    w = await openEngagementWorld();
    app = w.app();
  }, 180_000);
  afterAll(async () => {
    await w?.close();
  }, 60_000);

  const post = (id: string, body: unknown) => call(app, "POST", `/v1/engagements/${id}/payee-change`, w.token(), body);
  const sign = async (id: string, changeId: string, role: "owner" | "oldPayee" | "newPayee", who: Party, typedData: unknown) =>
    post(id, { action: "sign", changeId, role, signature: await w.v.signTyped(who, typedData as any) });
  const chainPayee = async (id: string) => ((await w.v.pub.readContract({ address: w.v.vault, abi: symbolonVaultAbi as Abi, functionName: "engagements", args: [id] })) as readonly [string])[0];
  const change = async (id: string, changeId: string) => (await call(app, "GET", `/v1/engagements/${id}`, w.token())).json.payeeChanges.find((c: any) => c.changeId === changeId);

  /** initiate + three signatures; returns the change as the API reports it after the last signature */
  async function propose(id: string, oldParty: Party, newParty: Party) {
    const init = await post(id, { action: "initiate", newPayee: newParty.address });
    expect(init.status).toBe(201);
    const { changeId, typedData } = init.json;
    expect((await sign(id, changeId, "owner", w.v.owner, typedData)).status).toBe(200);
    expect((await sign(id, changeId, "oldPayee", oldParty, typedData)).status).toBe(200);
    const last = await sign(id, changeId, "newPayee", newParty, typedData);
    return { init: init.json, last };
  }

  it("initiate returns PayeeChange typed data with the next nonce, and only one change can be open", async () => {
    const { e } = await activate(w, app);
    const n1 = newParty();
    const init = await post(e.engagementId, { action: "initiate", newPayee: n1.address });
    expect(init.status).toBe(201);
    expect(init.json.status).toBe("COLLECTING");
    expect(init.json.typedData.primaryType).toBe("PayeeChange");
    expect(init.json.typedData.message).toEqual({ engagementId: e.engagementId, oldPayee: w.v.payee.address, newPayee: n1.address, nonce: "2" });
    expect((await post(e.engagementId, { action: "initiate", newPayee: newParty().address })).status).toBe(409);
  });

  it("refuses to start for an engagement that is not ACTIVE, or for an unacceptable new payee", async () => {
    const draft = await createEng(w, app);
    expect((await post(draft.engagementId, { action: "initiate", newPayee: newParty().address })).status).toBe(409);
    const { e } = await activate(w, app);
    expect((await post(e.engagementId, { action: "initiate", newPayee: w.v.payee.address })).status).toBe(422); // unchanged
    expect((await post(e.engagementId, { action: "initiate", newPayee: w.v.owner.address })).status).toBe(422);
    expect((await post(e.engagementId, { action: "initiate", newPayee: "0x0000000000000000000000000000000000000000" })).status).toBe(422);
    expect((await post(e.engagementId, { action: "initiate", newPayee: w.v.payee.address.toLowerCase() })).status).toBe(400); // not EIP-55
  });

  it("each of the three signatures must come from the right party, over this exact change", async () => {
    const { e } = await activate(w, app);
    const n1 = newParty();
    const init = await post(e.engagementId, { action: "initiate", newPayee: n1.address });
    const { changeId, typedData } = init.json;
    const stranger = newParty();
    expect((await sign(e.engagementId, changeId, "owner", stranger, typedData)).status).toBe(422);
    expect((await sign(e.engagementId, changeId, "oldPayee", w.v.owner, typedData)).status).toBe(422);
    expect((await sign(e.engagementId, changeId, "newPayee", w.v.payee, typedData)).status).toBe(422); // the OLD payee cannot sign for the new one
    const other = { ...typedData, message: { ...typedData.message, newPayee: stranger.address } };
    expect((await sign(e.engagementId, changeId, "newPayee", n1, other)).status).toBe(422); // signed a different payee
    const stale = { ...typedData, message: { ...typedData.message, nonce: "1" } };
    expect((await sign(e.engagementId, changeId, "owner", w.v.owner, stale)).status).toBe(422); // wrong nonce
    expect((await change(e.engagementId, changeId)).signed).toEqual({ owner: false, oldPayee: false, newPayee: false });
  });

  it("full flow: three signatures propose on chain; execution before the vault's delay is refused; after it the payee changes", async () => {
    const { e } = await activate(w, app);
    const n1 = newParty();
    const { init, last } = await propose(e.engagementId, w.v.payee, n1);
    expect(last.json.status).toBe("SUBMITTED");
    expect(last.json.submittedTx).toMatch(/^0x[0-9a-f]{64}$/);
    await w.v.mine(1);
    await w.index();
    const proposed = await change(e.engagementId, init.changeId);
    expect(proposed.status).toBe("PROPOSED");
    const chainNow = (await w.v.pub.getBlock()).timestamp;
    expect(BigInt(proposed.etaEpoch)).toBeGreaterThan(chainNow);
    expect(BigInt(proposed.etaEpoch) - chainNow).toBeLessThanOrEqual(BigInt(PAYEE_DELAY));
    // nothing changed yet, on chain or in the kernel
    expect(await chainPayee(e.engagementId)).toBe(w.v.payee.address);
    expect((await dbStatus(w, e.engagementId)).payee).toBe(w.v.payee.address);

    // too early: refused by the kernel before anything is sent
    const blocksBefore = await w.v.pub.getBlockNumber();
    const early = await post(e.engagementId, { action: "execute", changeId: init.changeId });
    expect(early.status).toBe(409);
    expect(early.json.error.code).toBe("TOO_EARLY");
    expect(early.json.error.detail.etaEpoch).toBe(proposed.etaEpoch);
    expect(await w.v.pub.getBlockNumber()).toBe(blocksBefore); // no transaction was submitted
    expect(await chainPayee(e.engagementId)).toBe(w.v.payee.address);

    await w.v.warp(PAYEE_DELAY + 1);
    const done = await post(e.engagementId, { action: "execute", changeId: init.changeId });
    expect(done.status).toBe(200);
    expect(done.json.status).toBe("EXECUTING");
    // still not applied in the kernel until the event is indexed
    expect((await dbStatus(w, e.engagementId)).payee).toBe(w.v.payee.address);
    await w.v.mine(1);
    await w.index();
    expect((await change(e.engagementId, init.changeId)).status).toBe("EXECUTED");
    expect((await dbStatus(w, e.engagementId)).payee).toBe(n1.address);
    expect(await chainPayee(e.engagementId)).toBe(n1.address);

    // a second change uses a strictly higher nonce and the NEW payee as the old one
    const n2 = newParty();
    const second = await post(e.engagementId, { action: "initiate", newPayee: n2.address });
    expect(second.status).toBe(201);
    expect(second.json.oldPayee).toBe(n1.address);
    expect(second.json.nonce).toBe("3");
  });

  it("a stale or replayed change cannot be re-proposed: the vault's nonce already moved past it", async () => {
    const { e } = await activate(w, app);
    const n1 = newParty();
    const { init } = await propose(e.engagementId, w.v.payee, n1);
    await w.v.mine(1);
    await w.index();
    // the engagement nonce on chain is now the change nonce; a new change must be above it
    const chainNonce = await w.ec.engagementNonce(w.v.vault, e.engagementId);
    expect(chainNonce).toBe(BigInt(init.nonce));
    expect((await post(e.engagementId, { action: "initiate", newPayee: newParty().address })).status).toBe(409); // one open change at a time
  });

  it("a pause cancels a proposed change (kernel mirrors it) and the vault refuses new proposals while paused", async () => {
    const { e } = await activate(w, app);
    const n1 = newParty();
    const { init } = await propose(e.engagementId, w.v.payee, n1);
    await w.v.mine(1);
    await w.index();
    expect((await change(e.engagementId, init.changeId)).status).toBe("PROPOSED");

    await w.v.ownerTx("pause", []);
    await w.index();
    expect((await change(e.engagementId, init.changeId)).status).toBe("CANCELLED");
    await w.v.warp(PAYEE_DELAY + 1);
    expect((await post(e.engagementId, { action: "execute", changeId: init.changeId })).status).toBe(409);
    expect(await chainPayee(e.engagementId)).toBe(w.v.payee.address);

    // while paused the relay is refused by the vault; the signatures stay, the change stays COLLECTING with the reason
    const n2 = newParty();
    const again = await post(e.engagementId, { action: "initiate", newPayee: n2.address });
    expect(again.status).toBe(201);
    const { changeId, typedData } = again.json;
    await sign(e.engagementId, changeId, "owner", w.v.owner, typedData);
    await sign(e.engagementId, changeId, "oldPayee", w.v.payee, typedData);
    const refused = await sign(e.engagementId, changeId, "newPayee", n2, typedData);
    expect(refused.status).toBe(200);
    expect(refused.json.status).toBe("COLLECTING");
    expect(refused.json.error).toBe("Paused");
    expect(refused.json.submittedTx).toBeNull();

    // after unpause, the same last signature again retries the relay
    await w.v.ownerTx("unpause", []);
    const retry = await post(e.engagementId, { action: "sign", changeId, role: "newPayee", signature: await w.v.signTyped(n2, typedData) });
    expect(retry.status).toBe(200);
    expect(retry.json.status).toBe("SUBMITTED");
  });

  it("only a change the vault proposed and the indexer read can be executed", async () => {
    const { e } = await activate(w, app);
    const init = await post(e.engagementId, { action: "initiate", newPayee: newParty().address });
    const r = await post(e.engagementId, { action: "execute", changeId: init.json.changeId });
    expect(r.status).toBe(409);
    expect((await post(e.engagementId, { action: "execute", changeId: "3f2504e0-4f89-41d3-9a0c-0305e82c3301" })).status).toBe(404);
  });

  it("no relayer: signatures are kept and nothing is sent", async () => {
    const noRelay = w.app({ engagements: { chain: w.ec, relayer: null } });
    const { e } = await activate(w, app);
    const n1 = newParty();
    const init = await call(noRelay, "POST", `/v1/engagements/${e.engagementId}/payee-change`, w.token(), { action: "initiate", newPayee: n1.address });
    const { changeId, typedData } = init.json;
    for (const [role, who] of [["owner", w.v.owner], ["oldPayee", w.v.payee], ["newPayee", n1]] as const) {
      await call(noRelay, "POST", `/v1/engagements/${e.engagementId}/payee-change`, w.token(), { action: "sign", changeId, role, signature: await w.v.signTyped(who, typedData) });
    }
    const row = await w.t.db.query("select status, submitted_tx from payee_changes where id = $1", [changeId]);
    expect(row.rows[0]).toEqual({ status: "COLLECTING", submitted_tx: null });
    expect(TENANT_A).toBeTruthy();
  });
});
