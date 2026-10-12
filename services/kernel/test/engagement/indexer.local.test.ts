/* eslint-disable @typescript-eslint/no-explicit-any */
// WP-12 indexer under fault: reorgs, undecodable and look-alike logs, a range that races a reorg, concurrent passes,
// dropped and reverted submissions. Real anvil + real vault + real Postgres; only the chain edge is wrapped to inject faults.
// A local pass is a smoke test (V-15, V-19).
import { symbolonVaultAbi } from "@symbolon/chain";
import { revertTo, snapshot } from "@symbolon/chain/anvil";
import type { Abi } from "viem";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { EngagementChain } from "../../src/chain/engagement-chain";
import { recordChainEvent } from "../../src/engagement/repo";
import { indexTenant } from "../../src/engagement/indexer";
import { anvilSuiteEnabled } from "../helpers/anvil-vault";
import { TENANT_A, createEng, dbStatus, openEngagementWorld, signAs } from "../helpers/engagement-world";
import type { EngagementWorld } from "../helpers/engagement-world";
import { dbSuiteEnabled } from "../helpers/pgdb";
import { call } from "../helpers/world";

const enabled = anvilSuiteEnabled("indexer.local") && dbSuiteEnabled("indexer.local");

describe.skipIf(!enabled)("local indexer under fault", () => {
  let w: EngagementWorld;
  let app: ReturnType<EngagementWorld["app"]>;
  beforeAll(async () => {
    w = await openEngagementWorld();
    app = w.app();
  }, 180_000);
  afterAll(async () => {
    await w?.close();
  }, 60_000);

  const run = (chain: EngagementChain, o: Record<string, unknown> = {}) => indexTenant({ db: w.t.db, chain, logger: w.logger }, TENANT_A, { confirmations: 0n, ...o });
  const findings = async (kind: string) => (await w.t.db.query<{ detail: any; severity: string }>("select detail, severity from reconciliations where tenant_id = $1 and kind = $2", [TENANT_A, kind])).rows;
  const cursor = async () => BigInt((await w.t.db.query<{ n: string }>("select next_block::text as n from chain_cursors where tenant_id = $1", [TENANT_A])).rows[0]?.n ?? "-1");

  /** create + owner sign; the payee signature (which triggers the relay) is left to the caller */
  async function almostSigned() {
    const e = await createEng(w, app);
    await signAs(w, app, e, "owner");
    return e;
  }

  it("a reorg that removes the registration block: the engagement stops being ACTIVE, the event is REORGED, a HIGH finding is raised", async () => {
    const e = await almostSigned();
    const snap = await snapshot(w.v.dev);
    const r = await signAs(w, app, e, "payee");
    await w.v.mine(1);
    await w.index();
    expect((await dbStatus(w, e.engagementId)).status).toBe("ACTIVE");
    const regTx = r.json.submittedTx as string;

    await revertTo(w.v.dev, snap); // the registration tx and its blocks are gone
    await w.v.mine(3);
    const res = await w.index();
    expect(res.reorged).toBeGreaterThan(0);

    const s = await dbStatus(w, e.engagementId);
    expect(s.status).toBe("REGISTERING");
    expect(s.registered_tx).toBeNull();
    const ev = await w.t.db.query("select status, reorged_at from chain_events where tx_hash = $1", [regTx]);
    expect(ev.rows[0]?.status).toBe("REORGED");
    expect(ev.rows[0]?.reorged_at).not.toBeNull();
    expect((await findings("CHAIN_REORG")).length).toBeGreaterThan(0);
    // the chain agrees: it does not hold the engagement any more
    const onChain = (await w.v.pub.readContract({ address: w.v.vault, abi: symbolonVaultAbi as Abi, functionName: "engagements", args: [e.engagementId] })) as readonly unknown[];
    expect(onChain[6]).toBe(false);

    // a later pass does not resurrect it
    await w.v.mine(2);
    await w.index();
    expect((await dbStatus(w, e.engagementId)).status).toBe("REGISTERING");
  });

  it("after the reorg dropped the submitted tx, signing again re-sends it and the engagement activates from the NEW block", async () => {
    const e = await almostSigned();
    const snap = await snapshot(w.v.dev);
    await signAs(w, app, e, "payee");
    await w.v.mine(1);
    await w.index();
    expect((await dbStatus(w, e.engagementId)).status).toBe("ACTIVE");
    await revertTo(w.v.dev, snap);
    await w.v.mine(2);
    await w.index(TENANT_A, { droppedAfterSeconds: 0 }); // unwinds the activation; the vanished tx is cleared for a retry
    const mid = await dbStatus(w, e.engagementId);
    expect(mid.status).toBe("REGISTERING");
    expect(mid.submitted_tx).toBeNull();
    expect(mid.registration_error).toBe("TX_DROPPED");

    const again = await signAs(w, app, e, "payee"); // same signature: a retry of the relay
    expect(again.status).toBe(200);
    expect(again.json.submittedTx).toMatch(/^0x[0-9a-f]{64}$/);
    await w.v.mine(1);
    await w.index();
    const end = await dbStatus(w, e.engagementId);
    expect(end.status).toBe("ACTIVE");
    expect(end.registered_tx).toBe(again.json.submittedTx);
    const rows = await w.t.db.query("select count(*)::int as n from chain_events where event = 'EngagementRegistered' and data ->> 'engagementId' = $1 and status = 'CONFIRMED'", [e.engagementId]);
    expect(rows.rows[0]?.n).toBe(1);
  });

  it("a log that does not decode (look-alike address, extra data) STALLS the indexer: nothing activates, a HIGH finding is raised, the cursor stays", async () => {
    const e = await almostSigned();
    await signAs(w, app, e, "payee");
    await w.v.mine(1);
    const before = await cursor();
    const lookAlike: EngagementChain = {
      ...w.ec,
      logs: async (vault, from, to) => (await w.ec.logs(vault, from, to)).map((l) => ({ ...l, address: w.v.token })),
    };
    const res = await run(lookAlike);
    expect(res.outcome).toBe("STALLED");
    expect((await dbStatus(w, e.engagementId)).status).toBe("REGISTERING");
    expect(await cursor()).toBe(before);
    expect((await findings("UNDECODABLE_VAULT_LOG")).some((f) => f.severity === "HIGH")).toBe(true);

    const padded: EngagementChain = { ...w.ec, logs: async (vault, from, to) => (await w.ec.logs(vault, from, to)).map((l) => ({ ...l, data: `${l.data}00` as `0x${string}` })) };
    expect((await run(padded)).outcome).toBe("STALLED");
    expect((await dbStatus(w, e.engagementId)).status).toBe("REGISTERING");

    // the honest node unblocks it
    await w.index();
    expect((await dbStatus(w, e.engagementId)).status).toBe("ACTIVE");
  });

  it("a log range whose block is no longer canonical aborts the pass (RACED): nothing is written", async () => {
    const e = await almostSigned();
    await signAs(w, app, e, "payee");
    await w.v.mine(1);
    const before = await cursor();
    let armed = false; // the reorg happens between fetching the logs and re-checking their block
    const racing: EngagementChain = {
      ...w.ec,
      logs: async (vault, from, to) => {
        const logs = await w.ec.logs(vault, from, to);
        armed = true;
        return logs;
      },
      blockHash: async (n) => (armed ? `0x${"99".repeat(32)}` : w.ec.blockHash(n)),
    };
    const res = await run(racing);
    expect(res.outcome).toBe("RACED");
    expect(await cursor()).toBe(before);
    expect((await dbStatus(w, e.engagementId)).status).toBe("REGISTERING");
    await w.index();
    expect((await dbStatus(w, e.engagementId)).status).toBe("ACTIVE");
  });

  it("concurrent passes leave exactly one row per log and one activation", async () => {
    const e = await almostSigned();
    await signAs(w, app, e, "payee");
    await w.v.mine(1);
    const results = await Promise.all([w.index(), w.index(), w.index()]);
    expect(results.every((r) => ["OK", "LOCKED", "NOTHING"].includes(r.outcome))).toBe(true);
    expect((await dbStatus(w, e.engagementId)).status).toBe("ACTIVE");
    const dup = await w.t.db.query("select tx_hash, log_index, count(*) from chain_events group by 1, 2 having count(*) > 1");
    expect(dup.rows).toEqual([]);
  });

  it("a registration tx that reverted on chain is cleared so signing again retries it (never ACTIVE in between)", async () => {
    const e = await createEng(w, app);
    // submit a tx that is guaranteed to revert: registerEngagement with garbage signatures and a fixed gas limit (no simulation)
    const msg = e.typedData.message;
    const terms = { engagementId: msg.engagementId, owner: msg.owner, payee: msg.payee, cap: BigInt(msg.cap), start: BigInt(msg.start), end: BigInt(msg.end), termsHash: msg.termsHash, nonce: BigInt(msg.nonce) };
    const badTx = await w.v.wallet.writeContract({ address: w.v.vault, abi: symbolonVaultAbi as Abi, functionName: "registerEngagement", args: [terms, "0x00", "0x00"], account: w.v.relayerAccount, chain: w.v.wallet.chain, gas: 400_000n });
    expect((await w.v.pub.waitForTransactionReceipt({ hash: badTx })).status).toBe("reverted");
    const stub = w.app({ engagements: { chain: w.ec, relayer: { ...w.relayer, registerEngagement: async () => ({ txHash: badTx.toLowerCase() as `0x${string}` }) } } });
    await signAs(w, stub, e, "owner");
    const r = await signAs(w, stub, e, "payee");
    expect(r.json.submittedTx).toBe(badTx.toLowerCase());
    await w.index();
    const s = await dbStatus(w, e.engagementId);
    expect(s.status).toBe("REGISTERING");
    expect(s.submitted_tx).toBeNull();
    expect(s.registration_error).toBe("TX_REVERTED");
    const retry = await signAs(w, app, e, "payee");
    expect(retry.json.submittedTx).not.toBe(badTx.toLowerCase());
    await w.v.mine(1);
    await w.index();
    expect((await dbStatus(w, e.engagementId)).status).toBe("ACTIVE");
  });

  it("the vault refusing a relay (simulation reverts) is recorded with the vault's reason and nothing is sent", async () => {
    const e = await createEng(w, app);
    await signAs(w, app, e, "owner");
    // provoke a refusal: register the id directly first, then let the kernel try the same id
    const ownerSig = await w.v.signTyped(w.v.owner, e.typedData);
    const payeeSig = await w.v.signTyped(w.v.payee, e.typedData);
    const m = e.typedData.message;
    const terms = { engagementId: m.engagementId, owner: m.owner, payee: m.payee, cap: BigInt(m.cap), start: BigInt(m.start), end: BigInt(m.end), termsHash: m.termsHash, nonce: BigInt(m.nonce) };
    const hash = await w.v.wallet.writeContract({ address: w.v.vault, abi: symbolonVaultAbi as Abi, functionName: "registerEngagement", args: [terms, ownerSig, payeeSig], account: w.v.relayerAccount, chain: w.v.wallet.chain });
    await w.v.pub.waitForTransactionReceipt({ hash });
    const r = await signAs(w, app, e, "payee");
    expect(r.json.submittedTx).toBeNull();
    expect(r.json.registrationError).toBe("EngagementExists");
    await w.index(); // the id is on chain with identical terms and both signatures are stored => the indexer activates it
    expect((await dbStatus(w, e.engagementId)).status).toBe("ACTIVE");
  });

  it("recordChainEvent: same log twice is SAME; the same tx in another block revives the row (CHANGED); another tenant's key is an error", async () => {
    const ev = { tenantId: TENANT_A, event: "ConfigChanged", txHash: `0x${"ab".repeat(32)}`, logIndex: 7, blockNumber: 5n, blockHash: `0x${"01".repeat(32)}`, data: { configHash: "0x01" } };
    expect(await recordChainEvent(w.t.db, ev)).toBe("NEW");
    expect(await recordChainEvent(w.t.db, ev)).toBe("SAME");
    expect(await recordChainEvent(w.t.db, { ...ev, blockNumber: 6n, blockHash: `0x${"02".repeat(32)}` })).toBe("CHANGED");
    const row = await w.t.db.query("select block_number::text as n, block_hash, status from chain_events where tx_hash = $1 and log_index = 7", [ev.txHash]);
    expect(row.rows).toEqual([{ n: "6", block_hash: `0x${"02".repeat(32)}`, status: "CONFIRMED" }]);
    await expect(recordChainEvent(w.t.db, { ...ev, tenantId: "5b2e1d63-8c4f-4e3b-8d22-1b2c3d4e5f62" })).rejects.toThrow(/another tenant/);
  });

  it("indexing a tenant bound to a different chain id is refused", async () => {
    const other: EngagementChain = { ...w.ec, chainId: 1 };
    await expect(run(other)).rejects.toThrow(/chain/);
    expect(call).toBeTypeOf("function");
  });
});
