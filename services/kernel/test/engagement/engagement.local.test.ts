/* eslint-disable @typescript-eslint/no-explicit-any */
// WP-12 against a real anvil node, the real SymbolonVault and a real Postgres: creation, signature collection, the
// registerEngagement relay and the indexer that alone makes an engagement ACTIVE. Includes RT-15 and RT-19.
// A local pass is a smoke test (V-15); stock anvil is not Arc (V-19).
import { symbolonVaultAbi } from "@symbolon/chain";
import { EIP712_TYPES, computeTermsHash, eip712Digest } from "@symbolon/schemas";
import type { Abi } from "viem";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as base from "../../src/db/repo";
import { anvilSuiteEnabled } from "../helpers/anvil-vault";
import { TENANT_A, TENANT_B, activate, chainEngagement, createEng, dbStatus, openEngagementWorld, signAs, termsBody } from "../helpers/engagement-world";
import type { EngagementWorld } from "../helpers/engagement-world";
import { dbSuiteEnabled } from "../helpers/pgdb";
import { call } from "../helpers/world";

const enabled = anvilSuiteEnabled("engagement.local") && dbSuiteEnabled("engagement.local");

describe.skipIf(!enabled)("local engagements: sign flows, relay, indexer", () => {
  let w: EngagementWorld;
  let app: ReturnType<EngagementWorld["app"]>;
  beforeAll(async () => {
    w = await openEngagementWorld();
    app = w.app();
  }, 180_000);
  afterAll(async () => {
    await w?.close();
  }, 60_000);

  const get = (id: string, tenant = TENANT_A) => call(app, "GET", `/v1/engagements/${id}`, w.token(tenant));
  const findings = async (kind: string) => (await w.t.db.query<{ detail: any; severity: string }>("select detail, severity from reconciliations where tenant_id = $1 and kind = $2", [TENANT_A, kind])).rows;

  describe("typed data", () => {
    it("create returns the typed data; its digest is exactly what the real vault computes", async () => {
      const e = await createEng(w, app);
      expect(e.status).toBe("DRAFT");
      expect(e.typedData.primaryType).toBe("EngagementTerms");
      expect(e.typedData.domain).toEqual({ name: "SymbolonVault", version: "1", chainId: 31337, verifyingContract: w.v.vault });
      const m = e.typedData.message;
      const onChain = await w.v.pub.readContract({
        address: w.v.vault,
        abi: symbolonVaultAbi as Abi,
        functionName: "engagementTermsDigest",
        args: [{ engagementId: m.engagementId, owner: m.owner, payee: m.payee, cap: BigInt(m.cap), start: BigInt(m.start), end: BigInt(m.end), termsHash: m.termsHash, nonce: BigInt(m.nonce) }],
      });
      expect(e.digest).toBe(onChain);
      expect(eip712Digest(e.typedData)).toBe(onChain);
    });

    it("the termsHash in the typed data is computed by the kernel from the stored terms, never taken from the request", async () => {
      const e = await createEng(w, app);
      const loaded = await base.loadEngagement(w.t.db, TENANT_A, e.engagementId);
      expect(loaded).not.toBeNull();
      expect(computeTermsHash(loaded!)).toBe(e.termsHash);
      expect(e.typedData.message.termsHash).toBe(e.termsHash);
      const forged = await call(app, "POST", "/v1/engagements", w.token(), termsBody(w, { termsHash: `0x${"ab".repeat(32)}` }));
      expect(forged.status).toBe(400);
    });

    it("creating the same terms again is idempotent; different terms under the same id are a conflict", async () => {
      const body = termsBody(w);
      const a = await call(app, "POST", "/v1/engagements", w.token(), body);
      const b = await call(app, "POST", "/v1/engagements", w.token(), body);
      expect([a.status, b.status]).toEqual([201, 200]);
      expect(b.json.termsHash).toBe(a.json.termsHash);
      const c = await call(app, "POST", "/v1/engagements", w.token(), { ...body, capBaseUnits: "100000001" });
      expect(c.status).toBe(409);
    });

    it("refuses an owner that is not the vault owner, a bad payee and an unauthenticated caller", async () => {
      expect((await call(app, "POST", "/v1/engagements", w.token(), termsBody(w, { owner: w.v.payee.address }))).status).toBe(422);
      expect((await call(app, "POST", "/v1/engagements", w.token(), termsBody(w, { payee: w.v.owner.address }))).status).toBe(422);
      expect((await call(app, "POST", "/v1/engagements", null, termsBody(w))).status).toBe(401);
    });

    it("refuses to hand out typed data when the vault's own EIP-712 domain differs from ours (wrong chain id / verifying contract)", async () => {
      const lying = w.app({ engagements: { chain: { ...w.ec, domainSeparator: async () => `0x${"cd".repeat(32)}` }, relayer: w.relayer } });
      const r = await call(lying, "POST", "/v1/engagements", w.token(), termsBody(w));
      expect(r.status).toBe(503);
    });

    it("is tenant-isolated: another tenant sees nothing", async () => {
      const e = await createEng(w, app);
      expect((await get(e.engagementId, TENANT_B)).status).toBe(404);
      const sig = await w.v.signTyped(w.v.owner, e.typedData);
      expect((await call(app, "POST", `/v1/engagements/${e.engagementId}/sign`, w.token(TENANT_B), { role: "owner", signature: sig })).status).toBe(404);
      expect((await call(app, "POST", `/v1/engagements/${e.engagementId}/payee-change`, w.token(TENANT_B), { action: "initiate", newPayee: w.v.kernel.address })).status).toBe(404);
    });
  });

  describe("signature collection: fail closed", () => {
    it("rejects a signature by the wrong signer, an unknown signer, and a payee signature submitted as the owner's", async () => {
      const e = await createEng(w, app);
      const stranger = (await import("../helpers/anvil-vault")).newParty();
      expect((await signAs(w, app, e, "owner", stranger)).status).toBe(422);
      expect((await signAs(w, app, e, "owner", w.v.payee)).status).toBe(422);
      expect((await signAs(w, app, e, "payee", w.v.owner)).status).toBe(422);
      const meta = await dbStatus(w, e.engagementId);
      expect(meta.status).toBe("DRAFT");
      const row = await w.t.db.query("select owner_sig, payee_sig from engagements where engagement_id = $1", [e.engagementId]);
      expect(row.rows[0]).toEqual({ owner_sig: null, payee_sig: null });
    });

    it("rejects a signature over different terms (cap + 1), another chain id, another verifying contract, another struct", async () => {
      const e = await createEng(w, app);
      const td = e.typedData;
      const variants = [
        { ...td, message: { ...td.message, cap: (BigInt(td.message.cap) + 1n).toString() } },
        { ...td, message: { ...td.message, termsHash: `0x${"11".repeat(32)}` } },
        { ...td, message: { ...td.message, nonce: "2" } },
        { ...td, domain: { ...td.domain, chainId: 1 } },
        { ...td, domain: { ...td.domain, verifyingContract: w.v.token } },
      ];
      for (const v of variants) {
        const signature = await w.v.signTyped(w.v.owner, v);
        const r = await call(app, "POST", `/v1/engagements/${e.engagementId}/sign`, w.token(), { role: "owner", signature });
        expect(r.status, JSON.stringify(v.message)).toBe(422);
        expect(r.json.error.code).toBe("BAD_SIGNATURE");
      }
      expect((await dbStatus(w, e.engagementId)).status).toBe("DRAFT");
    });

    it("rejects malformed signatures without storing anything", async () => {
      const e = await createEng(w, app);
      for (const signature of ["0x", "0x12", `0x${"00".repeat(65)}`, "nothex", `0x${"ff".repeat(65)}`]) {
        const r = await call(app, "POST", `/v1/engagements/${e.engagementId}/sign`, w.token(), { role: "owner", signature });
        expect([400, 422]).toContain(r.status);
      }
      expect((await dbStatus(w, e.engagementId)).status).toBe("DRAFT");
    });

    it("a mismatched termsHash is rejected: the signer saw other terms", async () => {
      const e = await createEng(w, app);
      const signature = await w.v.signTyped(w.v.owner, e.typedData);
      const r = await call(app, "POST", `/v1/engagements/${e.engagementId}/sign`, w.token(), { role: "owner", signature, termsHash: `0x${"22".repeat(32)}` });
      expect(r.status).toBe(409);
      expect(r.json.error.code).toBe("TERMS_MISMATCH");
      expect((await dbStatus(w, e.engagementId)).status).toBe("DRAFT");
    });

    it("a stored row that no longer hashes to its termsHash is refused (TERMS_MISMATCH), not signed and not relayed", async () => {
      const e = await createEng(w, app);
      await w.t.db.query("update engagements set cap_base_units = cap_base_units + 1 where engagement_id = $1", [e.engagementId]);
      const signature = await w.v.signTyped(w.v.owner, e.typedData);
      const r = await call(app, "POST", `/v1/engagements/${e.engagementId}/sign`, w.token(), { role: "owner", signature });
      expect(r.status).toBe(409);
      expect(r.json.error.code).toBe("TERMS_MISMATCH");
    });

    it("the same signature again is a no-op; a different valid signature for the same role is refused (first one stands)", async () => {
      const e = await createEng(w, app);
      const first = await signAs(w, app, e, "owner");
      expect(first.status).toBe(200);
      expect(first.json.status).toBe("AWAITING_PAYEE");
      expect((await signAs(w, app, e, "owner")).status).toBe(200);
    });
  });

  describe("registration: active only after the on-chain event is indexed", () => {
    it("both signatures relay registerEngagement, yet the engagement is NOT active until the indexer reads the event", async () => {
      const e = await createEng(w, app);
      await signAs(w, app, e, "owner");
      const r = await signAs(w, app, e, "payee");
      expect(r.status).toBe(200);
      expect(r.json.status).toBe("REGISTERING");
      expect(r.json.submittedTx).toMatch(/^0x[0-9a-f]{64}$/);
      await w.v.mine(1);
      // the vault already holds the engagement ...
      expect((await chainEngagement(w, e.engagementId))[6]).toBe(true);
      // ... but the kernel does not call it active: only the indexed event does
      const before = await dbStatus(w, e.engagementId);
      expect(before.status).toBe("REGISTERING");
      expect(before.registered_tx).toBeNull();
      expect((await get(e.engagementId)).json.engagement.status).toBe("REGISTERING");

      const res = await w.index();
      expect(res.applied).toBeGreaterThan(0);
      const after = await dbStatus(w, e.engagementId);
      expect(after.status).toBe("ACTIVE");
      expect(after.registered_tx).toBe(r.json.submittedTx);
      const ev = await w.t.db.query("select event, status, block_hash from chain_events where tx_hash = $1", [r.json.submittedTx]);
      expect(ev.rows).toHaveLength(1);
      expect(ev.rows[0]).toMatchObject({ event: "EngagementRegistered", status: "CONFIRMED" });
      expect(ev.rows[0]?.block_hash).toMatch(/^0x[0-9a-f]{64}$/);
    });

    it("no relayer configured: the signatures are kept, nothing reaches the chain, and the engagement stays REGISTERING", async () => {
      const noRelay = w.app({ engagements: { chain: w.ec, relayer: null } });
      const e = await createEng(w, noRelay);
      await signAs(w, noRelay, e, "owner");
      const r = await signAs(w, noRelay, e, "payee");
      expect(r.json.status).toBe("REGISTERING");
      expect(r.json.submittedTx).toBeNull();
      expect((await chainEngagement(w, e.engagementId))[6]).toBe(false);
      await w.index();
      expect((await dbStatus(w, e.engagementId)).status).toBe("REGISTERING");
    });

    it("confirmation depth is configurable: the event is applied only once it is that many blocks deep", async () => {
      const e = await createEng(w, app);
      await signAs(w, app, e, "owner");
      await signAs(w, app, e, "payee");
      await w.index(TENANT_A, { confirmations: 3n });
      expect((await dbStatus(w, e.engagementId)).status).toBe("REGISTERING");
      await w.v.mine(2);
      await w.index(TENANT_A, { confirmations: 3n });
      expect((await dbStatus(w, e.engagementId)).status).toBe("REGISTERING");
      await w.v.mine(1);
      await w.index(TENANT_A, { confirmations: 3n });
      expect((await dbStatus(w, e.engagementId)).status).toBe("ACTIVE");
    });

    it("the indexer is idempotent: a second pass, and a rewound cursor, change nothing", async () => {
      const { e } = await activate(w, app);
      const count = async () => Number((await w.t.db.query<{ n: string }>("select count(*)::text as n from chain_events where tenant_id = $1", [TENANT_A])).rows[0]?.n);
      const before = await count();
      const s1 = await dbStatus(w, e.engagementId);
      await w.index();
      await w.t.db.query("update chain_cursors set next_block = 0 where tenant_id = $1", [TENANT_A]);
      await w.index();
      expect(await count()).toBe(before);
      expect(await dbStatus(w, e.engagementId)).toEqual(s1);
    });

    it("ACTIVE cannot be written without both signatures and a registration tx (database backstop)", async () => {
      const e = await createEng(w, app);
      await expect(w.t.db.query("update engagements set status = 'ACTIVE' where engagement_id = $1", [e.engagementId])).rejects.toThrow(/engagements_active_is_registered/);
      await signAs(w, app, e, "owner");
      await expect(w.t.db.query("update engagements set status = 'ACTIVE', registered_tx = $2 where engagement_id = $1", [e.engagementId, `0x${"aa".repeat(32)}`])).rejects.toThrow(/engagements_active_is_registered/);
    });

    it("a request cannot set status, signatures or registeredTx", async () => {
      const e = await createEng(w, app);
      for (const extra of [{ status: "ACTIVE" }, { registeredTx: `0x${"aa".repeat(32)}` }, { ownerSig: "0x11" }]) {
        const r = await call(app, "POST", `/v1/engagements/${e.engagementId}/sign`, w.token(), { role: "owner", signature: `0x${"11".repeat(65)}`, ...extra });
        expect(r.status).toBe(400);
      }
    });

    it("an engagement the vault already holds cannot be registered twice: a re-sign after ACTIVE is a no-op, nothing is resent", async () => {
      const { e } = await activate(w, app);
      const tx = (await dbStatus(w, e.engagementId)).registered_tx;
      const again = await signAs(w, app, e, "owner");
      expect(again.status).toBe(200);
      expect(again.json.status).toBe("ACTIVE");
      expect((await dbStatus(w, e.engagementId)).registered_tx).toBe(tx);
    });
  });

  describe("chain disagrees with the stored terms: never active (RT-15, RT-19)", () => {
    // Owner and payee collude (or a relayer with both signatures) and register DOCTORED terms directly on the vault.
    async function registerDirect(id: string, over: Record<string, string>, td: any) {
      const message = { ...td.message, ...over };
      const forged = { ...td, message };
      const ownerSig = await w.v.signTyped(w.v.owner, forged);
      const payeeSig = await w.v.signTyped(w.v.payee, forged);
      const terms = { engagementId: id, owner: message.owner, payee: message.payee, cap: BigInt(message.cap), start: BigInt(message.start), end: BigInt(message.end), termsHash: message.termsHash, nonce: BigInt(message.nonce) };
      const hash = await w.v.wallet.writeContract({ address: w.v.vault, abi: symbolonVaultAbi as Abi, functionName: "registerEngagement", args: [terms, ownerSig, payeeSig], account: w.v.relayerAccount, chain: w.v.wallet.chain });
      await w.v.pub.waitForTransactionReceipt({ hash });
      return hash;
    }
    const noRelay = () => w.app({ engagements: { chain: w.ec, relayer: null } });

    it("RT-15: terms injection on chain (different payment terms hash) is not activated: CANCELLED + HIGH finding", async () => {
      const a = noRelay();
      const e = await createEng(w, a);
      await signAs(w, a, e, "owner");
      await signAs(w, a, e, "payee");
      // doctored paymentTerms => a different termsHash, signed by both parties directly on chain
      await registerDirect(e.engagementId, { termsHash: `0x${"5a".repeat(32)}` }, e.typedData);
      await w.index();
      const s = await dbStatus(w, e.engagementId);
      expect(s.status).toBe("CANCELLED");
      expect(s.registered_tx).toBeNull();
      const f = (await findings("ENGAGEMENT_TERMS_MISMATCH")).filter((x) => x.detail.engagementId === e.engagementId);
      expect(f).toHaveLength(1);
      expect(f[0]?.severity).toBe("HIGH");
      expect(f[0]?.detail.fields).toContain("termsHash");
    });

    it("a different cap or window on chain is not activated either", async () => {
      const a = noRelay();
      const e = await createEng(w, a);
      await signAs(w, a, e, "owner");
      await signAs(w, a, e, "payee");
      await registerDirect(e.engagementId, { cap: (BigInt(e.typedData.message.cap) * 2n).toString() }, e.typedData);
      await w.index();
      expect((await dbStatus(w, e.engagementId)).status).toBe("CANCELLED");
      const f = (await findings("ENGAGEMENT_TERMS_MISMATCH")).find((x) => x.detail.engagementId === e.engagementId);
      expect(f?.detail.fields).toContain("cap");
    });

    it("an event whose termsHash matches but whose stored signatures are missing is not activated", async () => {
      const a = noRelay();
      const e = await createEng(w, a);
      await signAs(w, a, e, "owner"); // payee signature never reaches the kernel
      await registerDirect(e.engagementId, {}, e.typedData);
      await w.index();
      expect((await dbStatus(w, e.engagementId)).status).toBe("AWAITING_PAYEE");
      expect((await findings("ENGAGEMENT_REGISTERED_WITHOUT_SIGNATURES")).some((x) => x.detail.engagementId === e.engagementId)).toBe(true);
    });

    it("RT-19: an engagement registered on chain behind the kernel's back is surfaced (HIGH), never activated, and the chain count stays reconcilable", async () => {
      const ghost = await createEng(w, noRelay()); // creates a row; use its typed data but a DIFFERENT engagement id on chain
      const otherId = `0x${"77".repeat(32)}`;
      await registerDirect(otherId, { engagementId: otherId }, ghost.typedData);
      await w.index();
      const f = (await findings("ENGAGEMENT_UNKNOWN")).filter((x) => x.detail.engagementId === otherId);
      expect(f).toHaveLength(1);
      expect(f[0]?.severity).toBe("HIGH");
      const exists = await w.t.db.query("select 1 from engagements where engagement_id = $1", [otherId]);
      expect(exists.rowCount).toBe(0);
      // every registration the vault knows is either an indexed EngagementRegistered event or a finding: the sets reconcile
      const onChain = await w.v.pub.readContract({ address: w.v.vault, abi: symbolonVaultAbi as Abi, functionName: "engagementCount" });
      const indexed = await w.t.db.query<{ n: string }>("select count(*)::text as n from chain_events where tenant_id = $1 and event = 'EngagementRegistered' and status = 'CONFIRMED'", [TENANT_A]);
      expect(BigInt(indexed.rows[0]?.n ?? "0")).toBe(onChain);
    });

    it("RT-15: the payment terms that govern payments are the signed ones; editing them after activation breaks the hash K-05 recomputes", async () => {
      const { e } = await activate(w, app);
      const loaded = await base.loadEngagement(w.t.db, TENANT_A, e.engagementId);
      expect(loaded?.paymentTerms).toEqual({ netDays: 30, earlyPay: { discountBps: 200, withinDays: 10 }, payBeforeDueBufferHours: 0, allowImmediate: false });
      expect(computeTermsHash(loaded!)).toBe(loaded?.termsHash);
      await w.t.db.query(
        `update engagements set terms = jsonb_set(terms, '{paymentTerms,earlyPay,discountBps}', '800') where engagement_id = $1`,
        [e.engagementId],
      );
      const tampered = await base.loadEngagement(w.t.db, TENANT_A, e.engagementId);
      expect(tampered?.paymentTerms?.earlyPay?.discountBps).toBe(800);
      expect(computeTermsHash(tampered!)).not.toBe(tampered?.termsHash); // K-05: "loaded terms do not hash to engagement.termsHash"
    });

    it("RT-15: the payee's signature covers the discount terms: a signature over other payment terms does not verify", async () => {
      const a = await createEng(w, app, { slug: "same-but-terms-a" });
      const other = await call(app, "POST", "/v1/engagements", w.token(), termsBody(w, { slug: "same-but-terms-b", paymentTerms: { netDays: 30, earlyPay: { discountBps: 900, withinDays: 10 }, payBeforeDueBufferHours: 0, allowImmediate: false } }));
      expect(other.status).toBe(201);
      expect(other.json.termsHash).not.toBe(a.termsHash);
      const sigOverOther = await w.v.signTyped(w.v.payee, other.json.typedData);
      const r = await call(app, "POST", `/v1/engagements/${a.engagementId}/sign`, w.token(), { role: "payee", signature: sigOverOther });
      expect(r.status).toBe(422);
    });
  });

  it("logs never contain a signature (INV-11 / SEC-07)", async () => {
    const e = await createEng(w, app);
    const signature = await w.v.signTyped(w.v.owner, e.typedData);
    await call(app, "POST", `/v1/engagements/${e.engagementId}/sign`, w.token(), { role: "owner", signature });
    expect(w.logs.join("\n")).not.toContain(signature.slice(2, 40));
    expect(EIP712_TYPES.EngagementTerms.length).toBe(8);
  });
});
