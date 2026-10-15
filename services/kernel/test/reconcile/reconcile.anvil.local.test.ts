/* eslint-disable @typescript-eslint/no-explicit-any */
// WP-15 acceptance over a REAL anvil + the real SymbolonVault + real Postgres: K-15 reconciliation findings (missing tx, extra
// event, balance drift), K-16 breaker trip, the GUARDIAN key pausing the vault, and the owner-signed unfreeze.
// Findings come from chain state only (indexed events, token balance and Transfer logs at one block); nothing here is driven
// by a webhook body. A local pass is a smoke test (V-15, V-19); Arc's token-event behaviour is VERIFY(V-60).
import { randomBytes } from "node:crypto";
import { symbolonVaultAbi } from "@symbolon/chain";
import { isoFromEpochSeconds, keccak256Utf8 } from "@symbolon/schemas";
import type { Hex32 } from "@symbolon/schemas";
import type { Abi } from "viem";
import { afterEach, describe, expect, it } from "vitest";
import * as base from "../../src/db/repo";
import { ZERO_APPROVAL_REF } from "../../src/chain/relayer";
import type { VaultRelayer } from "../../src/chain/relayer";
import { signAttestation } from "../../src/release/attestation";
import { tickTenant } from "../../src/release/scheduler";
import { reconcileTenant } from "../../src/reconcile/service";
import * as rrepo from "../../src/reconcile/repo";
import { breakerUnfreezeDigest, unfreeze } from "../../src/reconcile/unfreeze";
import { USDC } from "../helpers/anvil-vault";
import { anvilSuiteEnabled, openChainReleaseWorld } from "../helpers/chain-release-world";
import type { ChainReleaseWorld } from "../helpers/chain-release-world";
import { dbSuiteEnabled } from "../helpers/pgdb";
import { call } from "../helpers/world";

const enabled = anvilSuiteEnabled("reconcile.anvil.local") && dbSuiteEnabled("reconcile.anvil.local");

describe.skipIf(!enabled)("local: reconciler, breaker, guardian pause, unfreeze on a real vault (WP-15)", () => {
  const open: ChainReleaseWorld[] = [];
  afterEach(async () => {
    while (open.length > 0) await open.pop()?.close();
  });
  const world = async (): Promise<ChainReleaseWorld> => {
    const w = await openChainReleaseWorld();
    open.push(w);
    return w;
  };

  const pass = async (w: ChainReleaseWorld, over: Parameters<ChainReleaseWorld["reconcilerDeps"]>[0] = {}) =>
    reconcileTenant(w.reconcilerDeps(over), w.tenantId, w.ew.v.vault);
  const paused = async (w: ChainReleaseWorld): Promise<boolean> => (await w.ew.v.pub.readContract({ address: w.ew.v.vault, abi: symbolonVaultAbi as Abi, functionName: "paused" })) as boolean;
  const findings = async (w: ChainReleaseWorld) => (await w.ew.t.db.query<{ kind: string; severity: string; resolved: boolean }>("select kind, severity, resolved from reconciliations where tenant_id = $1 order by created_at, id", [w.tenantId])).rows;

  /** Submit, evidence, schedule, pay: returns the intent id of a CONFIRMED release. */
  async function pay(w: ChainReleaseWorld): Promise<Hex32> {
    const sub = await w.submit();
    expect(sub.status, JSON.stringify(sub.json)).toBe(201);
    await w.ack();
    const { recheckHolds } = await import("../../src/release/scheduler");
    await recheckHolds(w.releaseDeps(), w.tenantId, { milestoneId: w.milestoneId });
    const head = await base.getLatestStoredDecisionForIntent(w.ew.t.db, w.tenantId, sub.json.intentId);
    expect(head?.decision.verdict).toBe("RELEASE");
    await w.advanceTo(BigInt(Math.floor(Date.parse(head!.decision.payAt as string) / 1000)) + 1n);
    expect(await tickTenant(w.releaseDeps(), w.tenantId)).toMatchObject({ sent: 1 });
    await w.index();
    return sub.json.intentId as Hex32;
  }

  it("a healthy vault: a confirmed release, balance identity holds, no findings, no trip, no pause", async () => {
    const w = await world();
    await pay(w);
    const r = await pass(w);
    expect(r).toMatchObject({ findings: [], tripped: false, paused: false });
    expect(r.skipped).toEqual([]);
    expect(await findings(w)).toEqual([]);
    expect(await paused(w)).toBe(false);
    // Running again is idempotent.
    expect(await pass(w)).toMatchObject({ findings: [], tripped: false });
  }, 240_000);

  it("missing tx: a SUBMITTED release the chain never shows -> MEDIUM after 120 s, HIGH after 10 min, breaker trips, guardian pauses", async () => {
    const w = await world();
    const sub = await w.submit();
    await w.ack();
    const { recheckHolds } = await import("../../src/release/scheduler");
    await recheckHolds(w.releaseDeps(), w.tenantId, { milestoneId: w.milestoneId });
    const head = await base.getLatestStoredDecisionForIntent(w.ew.t.db, w.tenantId, sub.json.intentId);
    await w.advanceTo(BigInt(Math.floor(Date.parse(head!.decision.payAt as string) / 1000)) + 1n);
    // A relayer that claims success but never sends anything (a dropped or fabricated transaction).
    const phantom: VaultRelayer = { ...w.ew.relayer, release: async () => ({ txHash: `0x${randomBytes(32).toString("hex")}` as Hex32 }) };
    expect(await tickTenant(w.releaseDeps({ relayer: phantom, txStatus: async () => "pending" }), w.tenantId)).toMatchObject({ sent: 1 });
    await w.index();
    expect(await w.balanceOf(w.ew.v.payee.address)).toBe(0n);

    expect(await pass(w)).toMatchObject({ findings: [], tripped: false }); // too young to be a finding
    await w.advanceTo(w.now() + 121n);
    const mid = await pass(w);
    expect(mid.findings).toEqual([{ kind: "RELEASE_UNCONFIRMED", severity: "MEDIUM" }]);
    expect(mid.tripped).toBe(false);
    expect(await paused(w)).toBe(false);

    await w.advanceTo(w.now() + 600n);
    const high = await pass(w);
    expect(high.findings).toEqual([{ kind: "RELEASE_UNCONFIRMED", severity: "HIGH" }]);
    expect(high.tripped).toBe(true);
    expect(high.paused).toBe(true);
    expect(await paused(w)).toBe(true); // the guardian key paused the real vault
    const br = await rrepo.loadBreakerRow(w.ew.t.db, w.tenantId);
    expect(br).toMatchObject({ halted: true, reason: "RECONCILIATION:RELEASE_UNCONFIRMED" });
    expect(br.pauseTx).toMatch(/^0x[0-9a-f]{64}$/);
    // Nothing is sent while halted: a new invoice is HOLD BREAKER_HALTED.
    const again = await w.submit();
    expect(again.json.decision.verdict).not.toBe("RELEASE");
    expect(again.json.decision.reasons).toContain("BREAKER_HALTED");
    // Passes while halted do not trip twice.
    expect(await pass(w)).toMatchObject({ tripped: false, findings: [] });
  }, 240_000);

  it("extra event: a Released the kernel never decided (signer misuse) -> UNKNOWN_RELEASE HIGH, breaker trips, vault paused", async () => {
    const w = await world();
    const v = w.ew.v;
    const intentId = `0x${randomBytes(32).toString("hex")}` as Hex32;
    const chainNow = (await v.pub.getBlock()).timestamp;
    const att = await signAttestation(
      {
        chainId: 31337,
        vault: v.vault,
        intentId,
        engagementId: w.engagementId,
        milestoneId: w.milestoneId,
        payee: v.payee.address,
        amount: "1000000",
        receiptHash: `0x${randomBytes(32).toString("hex")}` as Hex32,
        deadline: isoFromEpochSeconds(chainNow + 600n),
      },
      w.signer,
    );
    await w.ew.relayer.release({
      vault: v.vault,
      attestation: { intentId, engagementId: w.engagementId, milestoneId: w.milestoneId, payee: v.payee.address, amount: 1_000_000n, receiptHash: att.message.receiptHash as Hex32, deadline: chainNow + 600n },
      kernelSig: att.signature,
      ref: ZERO_APPROVAL_REF,
      ownerApprovalSig: "0x",
    });
    expect(await w.balanceOf(v.payee.address)).toBe(1_000_000n);
    await w.index(); // the indexer records the UNKNOWN_RELEASE finding itself ...
    expect((await findings(w)).map((f) => f.kind)).toContain("UNKNOWN_RELEASE");
    expect(await paused(w)).toBe(false); // ... but only the reconciler pass trips and pauses
    const r = await pass(w);
    expect(r.tripped).toBe(true);
    expect(await paused(w)).toBe(true);
    expect((await rrepo.loadBreakerRow(w.ew.t.db, w.tenantId)).reason).toBe("RECONCILIATION:UNKNOWN_RELEASE");
  }, 240_000);

  it("balance drift: tokens leave the vault with no Released/Withdrawn event -> BALANCE_DRIFT HIGH, breaker trips, vault paused", async () => {
    const w = await world();
    const v = w.ew.v;
    await pay(w);
    expect(await pass(w)).toMatchObject({ findings: [], tripped: false });
    // Something moves 3 USDC out of the vault by a path the vault's own events do not explain (anvil impersonation).
    await v.dev.impersonateAccount({ address: v.vault });
    await v.dev.setBalance({ address: v.vault, value: 10n ** 20n });
    const transferAbi = [{ type: "function", name: "transfer", stateMutability: "nonpayable", inputs: [{ name: "to", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ type: "bool" }] }] as const;
    const tx = await v.wallet.writeContract({ address: v.token, abi: transferAbi, functionName: "transfer", args: [v.owner.address, 3n * USDC], account: v.vault, chain: null } as never);
    await v.pub.waitForTransactionReceipt({ hash: tx });
    await v.dev.stopImpersonatingAccount({ address: v.vault });
    await w.index(); // advance the applied head past the transfer
    const r = await pass(w);
    expect(r.findings).toEqual([{ kind: "BALANCE_DRIFT", severity: "HIGH" }]);
    expect(r.tripped).toBe(true);
    expect(await paused(w)).toBe(true);
    const f = (await w.ew.t.db.query<{ detail: any }>("select detail from reconciliations where tenant_id = $1 and kind = 'BALANCE_DRIFT'", [w.tenantId])).rows[0]!.detail;
    expect(BigInt(f.expectedBaseUnits) - BigInt(f.actualBaseUnits)).toBe(3n * USDC);
  }, 240_000);

  it("no guardian configured: the kernel still halts, the vault is not paused, and the gap is recorded", async () => {
    const w = await world();
    const sub = await w.submit();
    await w.ack();
    void sub;
    // An unexplained release again (cheapest HIGH): reuse the extra-event shape through a direct finding.
    await rrepo.insertFinding(w.ew.t.db, w.tenantId, "UNKNOWN_RELEASE", "HIGH", "test:1", { intentId: "0x" + "ab".repeat(32) });
    const r = await pass(w, { guardian: null });
    expect(r.tripped).toBe(true);
    expect(r.paused).toBe(false);
    expect(await paused(w)).toBe(false);
    const br = await rrepo.loadBreakerRow(w.ew.t.db, w.tenantId);
    expect(br).toMatchObject({ halted: true, pauseError: "NO_GUARDIAN_CONFIGURED" });
    // The kernel's own gate holds even though the vault is live: evaluations return HOLD BREAKER_HALTED.
    const again = await w.submit();
    expect(again.json.decision.reasons).toContain("BREAKER_HALTED");
    // A later pass with a guardian pauses it (retry).
    expect(await pass(w)).toMatchObject({ tripped: false, paused: true });
    expect(await paused(w)).toBe(true);
  }, 240_000);

  describe("owner-signed unfreeze", () => {
    async function halted(w: ChainReleaseWorld) {
      await rrepo.insertFinding(w.ew.t.db, w.tenantId, "UNKNOWN_RELEASE", "HIGH", `test:${randomBytes(4).toString("hex")}`, { intentId: "0x" + "cd".repeat(32) });
      expect((await pass(w)).tripped).toBe(true);
      return (await rrepo.loadBreakerRow(w.ew.t.db, w.tenantId)).since as bigint;
    }
    async function sign(w: ChainReleaseWorld, signer: "owner" | "payee", reason: string, since: bigint, ttl = 300n) {
      const deadline = w.now() + ttl;
      const digest = breakerUnfreezeDigest({ chainId: 31337, vault: w.ew.v.vault, reasonHash: keccak256Utf8(reason), haltedSince: since, deadline });
      const party = signer === "owner" ? w.ew.v.owner : w.ew.v.payee;
      const signature = await party.account.sign({ hash: digest });
      return { reason, haltedSince: since.toString(), deadline: deadline.toString(), signature };
    }
    const deps = (w: ChainReleaseWorld) => ({ db: w.ew.t.db, chain: w.chain, engagementChain: w.ew.ec, clock: w.nowMs, logger: w.ew.logger });

    it("refuses anyone but the owner, a stale halt, an expired request and an empty reason; clears nothing", async () => {
      const w = await world();
      const since = await halted(w);
      const stillHalted = async () => (await rrepo.loadBreakerRow(w.ew.t.db, w.tenantId)).halted;
      await expect(unfreeze(deps(w), w.tenantId, await sign(w, "payee", "looked at it", since))).rejects.toMatchObject({ code: "BAD_SIGNATURE" });
      await expect(unfreeze(deps(w), w.tenantId, await sign(w, "owner", "looked at it", since - 1n))).rejects.toMatchObject({ code: "CONFLICT" });
      await expect(unfreeze(deps(w), w.tenantId, await sign(w, "owner", "looked at it", since, -5n))).rejects.toMatchObject({ code: "CONFLICT" });
      await expect(unfreeze(deps(w), w.tenantId, await sign(w, "owner", "looked at it", since, 3600n))).rejects.toMatchObject({ code: "BAD_REQUEST" });
      await expect(unfreeze(deps(w), w.tenantId, { ...(await sign(w, "owner", "", since)) })).rejects.toMatchObject({ code: "BAD_REQUEST" });
      // The signature is bound to the reason text: signed for one reason, submitted with another.
      const s = await sign(w, "owner", "reason one", since);
      await expect(unfreeze(deps(w), w.tenantId, { ...s, reason: "reason two" })).rejects.toMatchObject({ code: "BAD_SIGNATURE" });
      expect(await stillHalted()).toBe(true);
    }, 240_000);

    it("the owner's signed unfreeze clears the kernel breaker (the vault stays paused until the owner unpauses); a NEW finding trips it again", async () => {
      const w = await world();
      const since = await halted(w);
      expect(await paused(w)).toBe(true);
      const res = await unfreeze(deps(w), w.tenantId, await sign(w, "owner", "reviewed the finding, drift explained", since));
      expect(res).toMatchObject({ halted: false, vaultStillPaused: true, findingsResolved: 1 });
      const br = await rrepo.loadBreakerRow(w.ew.t.db, w.tenantId);
      expect(br.halted).toBe(false);
      const row = (await w.ew.t.db.query<{ resolved_by: string; resolved_reason: string }>("select resolved_by, resolved_reason from breaker_state where tenant_id = $1", [w.tenantId])).rows[0];
      expect(row?.resolved_by).toBe(`owner:${w.ew.v.owner.address.toLowerCase()}`);
      expect(row?.resolved_reason).toBe("reviewed the finding, drift explained");
      // Replaying the same signature is refused: that halt is over.
      await expect(unfreeze(deps(w), w.tenantId, await sign(w, "owner", "again", since))).rejects.toMatchObject({ code: "CONFLICT" });
      // The vault is still paused, so K-16 still sees a halt through the pause; the owner unpauses on chain.
      const state = await call(w.app({ breaker: deps(w) }), "GET", "/v1/breaker", w.token());
      expect(state.json).toMatchObject({ halted: true, kernelHalted: false, vaultPaused: true });
      await w.ew.v.ownerTx("unpause", []);
      expect((await call(w.app({ breaker: deps(w) }), "GET", "/v1/breaker", w.token())).json).toMatchObject({ halted: false, vaultPaused: false });
      // The resolved finding does not re-trip; a different one does.
      expect(await pass(w)).toMatchObject({ tripped: false, findings: [] });
      await rrepo.insertFinding(w.ew.t.db, w.tenantId, "UNKNOWN_RELEASE", "HIGH", "test:new", { intentId: "0x" + "ef".repeat(32) });
      const again = await pass(w);
      expect(again.tripped).toBe(true);
      expect(await paused(w)).toBe(true);
    }, 240_000);

    it("over HTTP: GET /v1/breaker shows the halt and what to sign; POST /v1/breaker/unfreeze with the owner's signature clears it", async () => {
      const w = await world();
      const since = await halted(w);
      const app = w.app({ breaker: deps(w) });
      const st = await call(app, "GET", "/v1/breaker", w.token());
      expect(st.status).toBe(200);
      expect(st.json).toMatchObject({ halted: true, kernelHalted: true, vaultPaused: true, haltedSince: since.toString(), reason: "RECONCILIATION:UNKNOWN_RELEASE" });
      expect(st.json.unfreeze.primaryType).toBe("BreakerUnfreeze");
      const bad = await call(app, "POST", "/v1/breaker/unfreeze", w.token(), await sign(w, "payee", "x", since));
      expect(bad.status).not.toBe(200);
      const ok = await call(app, "POST", "/v1/breaker/unfreeze", w.token(), await sign(w, "owner", "checked the vault on the explorer", since));
      expect(ok.status, JSON.stringify(ok.json)).toBe(200);
      expect(ok.json).toMatchObject({ halted: false, vaultStillPaused: true });
    }, 240_000);
  });

  it("a guardian cannot unpause: pause-only role (the vault refuses, the kernel never asks)", async () => {
    const w = await world();
    const v = w.ew.v;
    await v.dev.setBalance({ address: v.guardian.address, value: 10n ** 20n });
    await pass(w); // healthy
    await v.ownerTx("pause", []);
    await expect(
      v.pub.simulateContract({ address: v.vault, abi: symbolonVaultAbi as Abi, functionName: "unpause", args: [], account: v.guardian.account } as never),
    ).rejects.toThrow();
    expect(await paused(w)).toBe(true);
  }, 240_000);
});
