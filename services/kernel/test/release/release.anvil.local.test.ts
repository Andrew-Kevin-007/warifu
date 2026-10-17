/* eslint-disable @typescript-eslint/no-explicit-any */
// WP-14 acceptance, part 2: the whole payment path against a REAL anvil node and the REAL SymbolonVault (contracts/out).
//
//   engagement (dual-signed, registered, indexed) -> invoice -> evidence -> decision RELEASE (payAt) -> payAt TOCTOU
//   re-evaluation -> kernel-signed Attestation -> relayer -> vault.release() -> Released event -> indexer CONFIRMS
//   -> packages/receipts verifies the receipt AND its on-chain anchor (library, and the `verify-receipt` CLI over RPC).
//
// Only the clock is simulated (service time runs ahead of real time and the chain is warped with it). A local pass is a smoke
// test of the logic, not a claim about Arc (V-15, V-19).
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { symbolonVaultAbi } from "@symbolon/chain";
import type { RawLog } from "@symbolon/chain";
import { buildApprovalTypedData, verifyReceipt } from "@symbolon/receipts";
import { checkReleasedAnchor } from "@symbolon/receipts/anchor";
import { epochSecondsFromIso, isoFromEpochSeconds, symbolonDomain } from "@symbolon/schemas";
import type { Hex32 } from "@symbolon/schemas";
import type { Abi, Address } from "viem";
import { afterEach, describe, expect, it } from "vitest";
import * as base from "../../src/db/repo";
import { RelayError } from "../../src/chain/relayer";
import type { VaultRelayer } from "../../src/chain/relayer";
import { releaseForIntent } from "../../src/release/repo";
import { recheckHolds, tickTenant } from "../../src/release/scheduler";
import { processDue, SEND_LEASE_SECONDS } from "../../src/release/service";
import { USDC } from "../helpers/anvil-vault";
import { anvilSuiteEnabled, openChainReleaseWorld } from "../helpers/chain-release-world";
import type { ChainReleaseWorld } from "../helpers/chain-release-world";
import { dbSuiteEnabled } from "../helpers/pgdb";
import { call } from "../helpers/world";

const enabled = anvilSuiteEnabled("release.anvil.local") && dbSuiteEnabled("release.anvil.local");
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");

describe.skipIf(!enabled)("local: release path on a real anvil + the real SymbolonVault (WP-14)", () => {
  const open: ChainReleaseWorld[] = [];
  const tmp: string[] = [];
  afterEach(async () => {
    while (open.length > 0) await open.pop()?.close();
    while (tmp.length > 0) rmSync(tmp.pop() as string, { recursive: true, force: true });
  });
  const world = async (o: Parameters<typeof openChainReleaseWorld>[0] = {}): Promise<ChainReleaseWorld> => {
    const w = await openChainReleaseWorld(o);
    open.push(w);
    return w;
  };

  /** Submit an invoice, satisfy its evidence and let the re-check schedule it. Returns the scheduled RELEASE head. */
  async function schedule(w: ChainReleaseWorld) {
    const sub = await w.submit();
    expect(sub.status, JSON.stringify(sub.json)).toBe(201);
    await w.ack();
    await recheckHolds(w.releaseDeps(), w.tenantId, { milestoneId: w.milestoneId });
    const intentId = sub.json.intentId as Hex32;
    const head = await base.getLatestStoredDecisionForIntent(w.ew.t.db, w.tenantId, intentId);
    return { intentId, head };
  }
  const payAtOf = (h: Awaited<ReturnType<typeof schedule>>["head"]): bigint => epochSecondsFromIso(h?.decision.payAt as string);
  const row = (w: ChainReleaseWorld, intentId: string) => releaseForIntent(w.ew.t.db, w.tenantId, intentId);
  const nowAfter = async (w: ChainReleaseWorld, t: bigint): Promise<void> => w.advanceTo(t + 1n);

  async function allLogs(w: ChainReleaseWorld): Promise<RawLog[]> {
    const logs = await w.ew.v.pub.getLogs({ address: w.ew.v.vault, fromBlock: 0n, toBlock: "latest" });
    return logs.map((l) => ({ address: l.address, topics: l.topics, data: l.data, blockNumber: l.blockNumber, transactionHash: l.transactionHash, logIndex: l.logIndex }));
  }

  async function receiptOf(w: ChainReleaseWorld, receiptHash: string): Promise<any> {
    const r = await call(w.app(), "GET", `/v1/receipts/${receiptHash}`, w.token());
    expect(r.status).toBe(200);
    return r.json;
  }

  async function verifyWithAnchor(w: ChainReleaseWorld, signed: any) {
    const v = w.ew.v;
    const decimals = Number(await v.pub.readContract({ address: v.vault, abi: symbolonVaultAbi as Abi, functionName: "tokenDecimals" }));
    const kernelSigner = (await v.pub.readContract({ address: v.vault, abi: symbolonVaultAbi as Abi, functionName: "kernelSigner" })) as Address;
    const logs = await allLogs(w);
    return verifyReceipt(
      { receipt: signed.receipt, receiptHash: signed.receiptHash, signature: signed.signature, signer: signed.signer },
      {
        domain: symbolonDomain(31337, v.vault),
        expectedSigner: kernelSigner,
        expectedReceiptHash: signed.receiptHash,
        checkAnchor: async (receipt, hash) => checkReleasedAnchor(receipt, hash, logs, { vault: v.vault, decimals }),
      },
    );
  }

  it("intent -> decision -> receipt -> Released event -> verify-receipt anchor passes (library and CLI)", async () => {
    const w = await world();
    const v = w.ew.v;
    const { intentId, head } = await schedule(w);
    expect(head?.decision.verdict).toBe("RELEASE");
    expect(head?.decision.releaseAmountBaseUnits).toBe("9800000"); // 10 USDC gross, 2 % early-pay discount
    expect(head?.decision.payee?.toLowerCase()).toBe(v.payee.address.toLowerCase());
    const scheduledReceipt = head!.receiptHash;
    const payAt = payAtOf(head);

    // Before payAt: nothing moves, nothing is signed.
    expect(await tickTenant(w.releaseDeps(), w.tenantId)).toMatchObject({ due: 0, sent: 0 });
    expect(await w.balanceOf(v.payee.address)).toBe(0n);
    expect(await row(w, intentId)).toBeNull();

    // At payAt: TOCTOU re-evaluation -> attestation -> relayer -> vault.
    await nowAfter(w, payAt);
    const t = await tickTenant(w.releaseDeps(), w.tenantId);
    expect(t).toMatchObject({ due: 1, queued: 1, sent: 1, superseded: 0, errors: 0 });
    const sent = await row(w, intentId);
    expect(sent?.status).toBe("SUBMITTED");
    expect(sent?.txHash).toMatch(/^0x[0-9a-f]{64}$/);
    // The vault paid the payee the DISCOUNTED amount; the intent id is consumed on chain.
    expect(await w.balanceOf(v.payee.address)).toBe(9_800_000n);
    expect(await w.usedOnChain(intentId)).toBe(true);

    // Only the indexed Released event confirms (never the relayer's answer).
    expect((await row(w, intentId))?.status).toBe("SUBMITTED");
    await w.index();
    const done = await row(w, intentId);
    expect(done?.status).toBe("CONFIRMED");
    expect(done?.txHash).toBe(sent?.txHash);
    // The confirmed release is what marks the milestone PAID (so K-05 rejects a second release and sequential engagements advance).
    const ms = await w.ew.t.db.query<{ status: string }>("select status from milestones where milestone_id = $1", [w.milestoneId]);
    expect(ms.rows[0]?.status).toBe("PAID");
    const intent = await call(w.app(), "GET", `/v1/intents/${intentId}`, w.token());
    expect(intent.json.release).toMatchObject({ status: "CONFIRMED", txHash: sent?.txHash });

    // The receipt the vault anchored is the scheduled RELEASE receipt; it verifies, signer pinned to vault.kernelSigner().
    const logs = await allLogs(w);
    const released = logs.filter((l) => l.topics[0] !== undefined);
    expect(released.length).toBeGreaterThan(0);
    const signed = await receiptOf(w, scheduledReceipt);
    expect(signed.tx).toMatchObject({ status: "CONFIRMED" });
    const report = await verifyWithAnchor(w, signed);
    expect(report.ok, JSON.stringify(report.checks)).toBe(true);
    expect(report.signerPinned).toBe(true);
    const anchor = report.checks.find((c) => c.id === "ANCHOR");
    expect(anchor?.status).toBe("PASS");
    expect(anchor?.detail).toMatch(/9800000 base units/);

    // The same, through the shipped CLI over RPC (exit code 0 = verified).
    const dir = mkdtempSync(join(tmpdir(), "symbolon-receipt-"));
    tmp.push(dir);
    const file = join(dir, "receipt.json");
    writeFileSync(file, JSON.stringify({ receipt: signed.receipt, receiptHash: signed.receiptHash, signature: signed.signature, signer: signed.signer }));
    const cli = spawnSync(process.execPath, [join(REPO_ROOT, "packages/receipts/bin/verify-receipt.mjs"), file, "--vault", v.vault, "--rpc", v.url, "--json"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      timeout: 90_000,
    });
    expect(cli.status, `${cli.stdout}\n${cli.stderr}`).toBe(0);
    expect(JSON.parse(cli.stdout)).toMatchObject({ ok: true });

    // A tampered receipt (different amount) is NOT verified: the hash and the anchor both refuse it.
    const tampered = JSON.parse(JSON.stringify(signed));
    tampered.receipt.decision.releaseAmountBaseUnits = "9800001";
    const bad = await verifyWithAnchor(w, tampered);
    expect(bad.ok).toBe(false);

    // The earlier HOLD receipt of the same intent is not anchored by any Released event.
    const holdDec = await w.ew.t.db.query<{ receipt_hash: string }>(
      "select r.receipt_hash from decisions d join receipts r on r.decision_id = d.decision_id where d.intent_id = $1 and d.verdict = 'HOLD' limit 1",
      [intentId],
    );
    const holdHash = holdDec.rows[0]?.receipt_hash;
    expect(holdHash).toBeDefined();
    const holdReport = await verifyWithAnchor(w, await receiptOf(w, holdHash as string));
    expect(holdReport.ok).toBe(true);

    // Idempotent: more ticks do nothing, and replaying the SAME signed attestation at the vault is refused (used[intentId]).
    expect(await tickTenant(w.releaseDeps(), w.tenantId)).toMatchObject({ due: 0, sent: 0 });
    const m = done!.attestation.message;
    const again = w.ew.relayer.release({
      vault: v.vault,
      attestation: { ...m, payee: m.payee as Address, amount: BigInt(m.amount), deadline: BigInt(m.deadline) },
      kernelSig: done!.attestation.kernelSig,
      ref: { receiptHash: `0x${"0".repeat(64)}` as Hex32, deadline: 0n },
      ownerApprovalSig: "0x",
    });
    await expect(again).rejects.toMatchObject({ name: "RelayError", revertName: "AlreadyUsed" });
    expect(await w.balanceOf(v.payee.address)).toBe(9_800_000n);
  }, 240_000);

  it("a human-gated release (amount above the vault's humanThreshold) passes the owner's OwnerApproval through to the vault", async () => {
    const w = await world({ gross: 24n * USDC }); // discounted 23.52 USDC > 20 USDC threshold, <= 25 USDC per-tx cap
    const v = w.ew.v;
    const sub = await w.submit();
    expect(sub.status, JSON.stringify(sub.json)).toBe(201);
    await w.ack();
    await recheckHolds(w.releaseDeps(), w.tenantId, { milestoneId: w.milestoneId });
    const intentId = sub.json.intentId as Hex32;
    const esc = await base.getLatestStoredDecisionForIntent(w.ew.t.db, w.tenantId, intentId);
    expect(esc?.decision.verdict).toBe("ESCALATE");
    expect(esc?.decision.reasons).toContain("HUMAN_REQUIRED");
    expect(esc?.decision.releaseAmountBaseUnits).toBe("23520000");
    // No approval: nothing is released even when payAt passes.
    const payAt = payAtOf(esc);
    await w.advanceTo(payAt - 300n);
    await recheckHolds(w.releaseDeps(), w.tenantId, { milestoneId: w.milestoneId, recheckAfterSeconds: 0 });
    const cur = await base.getLatestStoredDecisionForIntent(w.ew.t.db, w.tenantId, intentId);
    expect(cur?.decision.verdict).toBe("ESCALATE");

    // The owner signs exactly what the approval view shows (10-minute life).
    const deadline = w.now() + 600n;
    const td = buildApprovalTypedData({
      intentId,
      receiptHash: cur!.receiptHash,
      releaseBaseUnits: cur!.decision.releaseAmountBaseUnits as string,
      expiresAt: isoFromEpochSeconds(deadline),
      domain: symbolonDomain(31337, v.vault),
    });
    expect(td.ok).toBe(true);
    const signature = await v.signTyped(v.owner, td.ok ? (td.value as any) : null);
    const ap = await call(w.app(), "POST", "/v1/approvals", w.token(), {
      intentId,
      receiptHash: cur!.receiptHash,
      amount: cur!.decision.releaseAmountBaseUnits,
      deadline: deadline.toString(),
      signature,
    });
    expect(ap.status, JSON.stringify(ap.json)).toBe(200);
    expect(ap.json.decision.verdict).toBe("RELEASE");
    const finalReceipt = ap.json.receiptHash as string;

    await nowAfter(w, payAt);
    const t = await tickTenant(w.releaseDeps(), w.tenantId);
    expect(t).toMatchObject({ due: 1, queued: 1, sent: 1, errors: 0 });
    expect(await w.balanceOf(v.payee.address)).toBe(23_520_000n);
    await w.index();
    expect((await row(w, intentId))?.status).toBe("CONFIRMED");
    const signed = await receiptOf(w, finalReceipt);
    const report = await verifyWithAnchor(w, signed);
    expect(report.ok, JSON.stringify(report.checks)).toBe(true);
    // The anchored receipt is the FINAL release receipt, not the escalation the owner signed for.
    expect(finalReceipt).not.toBe(cur!.receiptHash);
  }, 240_000);

  describe("changes between decision and release that must not move money (real vault)", () => {
    it("breaker tripped -> HOLD BREAKER_HALTED, vault untouched", async () => {
      const w = await world();
      const { intentId, head } = await schedule(w);
      await w.ew.t.db.query("insert into breaker_state (tenant_id, halted, reason, since) values ($1, true, 'test', now())", [w.tenantId]);
      await nowAfter(w, payAtOf(head));
      expect(await tickTenant(w.releaseDeps(), w.tenantId)).toMatchObject({ due: 1, superseded: 1, sent: 0 });
      const h = await base.getLatestStoredDecisionForIntent(w.ew.t.db, w.tenantId, intentId);
      expect(h?.decision.verdict).toBe("HOLD");
      expect(h?.decision.reasons).toContain("BREAKER_HALTED");
      expect(await w.balanceOf(w.ew.v.payee.address)).toBe(0n);
      expect(await w.usedOnChain(intentId)).toBe(false);
      expect(await row(w, intentId)).toBeNull();
    });

    it("engagement closed on chain by the owner -> REJECT, vault untouched", async () => {
      const w = await world();
      const { intentId, head } = await schedule(w);
      await w.ew.v.ownerTx("closeEngagement", [w.engagementId]);
      await nowAfter(w, payAtOf(head));
      expect(await tickTenant(w.releaseDeps(), w.tenantId)).toMatchObject({ due: 1, superseded: 1, sent: 0 });
      const h = await base.getLatestStoredDecisionForIntent(w.ew.t.db, w.tenantId, intentId);
      expect(h?.decision.verdict).not.toBe("RELEASE");
      expect(await w.balanceOf(w.ew.v.payee.address)).toBe(0n);
      expect(await w.usedOnChain(intentId)).toBe(false);
    });

    it("vault paused by the owner after the attestation was signed -> nothing sent (HOLD BREAKER_HALTED); after unpause it re-schedules and releases once", async () => {
      const w = await world();
      const { intentId, head } = await schedule(w);
      await nowAfter(w, payAtOf(head));
      expect((await processDue(w.releaseDeps(), w.tenantId, head!.decision.decisionId, intentId)).kind).toBe("QUEUED");
      await w.ew.v.ownerTx("pause", []);
      await tickTenant(w.releaseDeps(), w.tenantId);
      expect(await w.balanceOf(w.ew.v.payee.address)).toBe(0n);
      expect(await w.usedOnChain(intentId)).toBe(false);
      const held = await base.getLatestStoredDecisionForIntent(w.ew.t.db, w.tenantId, intentId);
      expect(held?.decision.verdict).toBe("HOLD");
      expect(held?.decision.reasons).toContain("BREAKER_HALTED");
      expect(["FAILED", "QUEUED"]).toContain((await row(w, intentId))?.status);
      // While paused, further passes still move nothing.
      for (let i = 0; i < 3; i++) await tickTenant(w.releaseDeps(), w.tenantId);
      expect(await w.balanceOf(w.ew.v.payee.address)).toBe(0n);
      // The owner unpauses: after the re-check interval the HOLD is re-evaluated. The 2 % window has closed by now (its last safe
      // instant was payAt), so the fresh schedule is the FULL amount at the due date; the discount is never taken silently late.
      await w.ew.v.ownerTx("unpause", []);
      await w.advanceTo(w.now() + 61n);
      await tickTenant(w.releaseDeps(), w.tenantId);
      const again = await base.getLatestStoredDecisionForIntent(w.ew.t.db, w.tenantId, intentId);
      expect(again?.decision.verdict).toBe("RELEASE");
      expect(again?.decision.releaseAmountBaseUnits).toBe("10000000");
      expect(payAtOf(again)).toBeGreaterThan(w.now());
      expect(await w.balanceOf(w.ew.v.payee.address)).toBe(0n);
      await nowAfter(w, payAtOf(again));
      await w.ack(); // the first acknowledgement (max 30 days) lapsed on the way; the owner acknowledges again
      expect(await tickTenant(w.releaseDeps(), w.tenantId)).toMatchObject({ due: 1, queued: 1, sent: 1, errors: 0 });
      expect(await w.balanceOf(w.ew.v.payee.address)).toBe(10_000_000n);
      expect(await w.usedOnChain(intentId)).toBe(true);
      expect((await row(w, intentId))?.attempts).toBe(2);
    });
  });

  describe("crash safety against the real vault", () => {
    it("crash between claim and send: after restart the SAME attestation is sent and the payee is paid exactly once", async () => {
      const w = await world();
      const { intentId, head } = await schedule(w);
      await nowAfter(w, payAtOf(head));
      expect((await processDue(w.releaseDeps(), w.tenantId, head!.decision.decisionId, intentId)).kind).toBe("QUEUED");
      const claimed = await row(w, intentId);
      expect(claimed?.status).toBe("QUEUED");
      expect(await w.balanceOf(w.ew.v.payee.address)).toBe(0n);
      // restart
      expect(await tickTenant(w.releaseDeps(), w.tenantId)).toMatchObject({ sent: 1, queued: 0 });
      expect((await row(w, intentId))?.attestation.kernelSig).toBe(claimed?.attestation.kernelSig);
      expect(await tickTenant(w.releaseDeps(), w.tenantId)).toMatchObject({ sent: 0 });
      expect(await w.balanceOf(w.ew.v.payee.address)).toBe(9_800_000n);
    });

    it("the transaction landed but the answer was lost: the retry is refused by the vault (AlreadyUsed), money moved once, the indexer confirms", async () => {
      const w = await world();
      const { intentId, head } = await schedule(w);
      await nowAfter(w, payAtOf(head));
      const real: VaultRelayer = w.ew.relayer;
      let sends = 0;
      const lossy: VaultRelayer = {
        ...real,
        async release(i) {
          sends++;
          const r = await real.release(i);
          if (sends === 1) throw new Error("socket hang up"); // the tx is mined, the caller never hears
          return r;
        },
      };
      const deps = () => w.releaseDeps({ relayer: lossy });
      expect(await tickTenant(deps(), w.tenantId)).toMatchObject({ queued: 1, sent: 0 });
      expect((await row(w, intentId))?.status).toBe("QUEUED");
      expect(await w.balanceOf(w.ew.v.payee.address)).toBe(9_800_000n); // it did land
      // Within the lease nothing happens; after it, the retry is simulated, refused as AlreadyUsed and parked (never re-sent).
      await w.advanceTo(w.now() + BigInt(SEND_LEASE_SECONDS) + 1n);
      await tickTenant(deps(), w.tenantId);
      expect(sends).toBe(2);
      const parked = await row(w, intentId);
      expect(parked?.status).toBe("QUEUED");
      expect(parked?.error).toMatch(/^ALREADY_USED/);
      await w.advanceTo(w.now() + BigInt(SEND_LEASE_SECONDS) + 1n);
      await tickTenant(deps(), w.tenantId);
      expect(sends).toBe(2); // never sent again
      await w.index();
      expect((await row(w, intentId))?.status).toBe("CONFIRMED");
      expect(await w.balanceOf(w.ew.v.payee.address)).toBe(9_800_000n);
    });
  });

  it("RelayError carries the vault's custom error name (the scheduler's retry policy depends on it)", () => {
    expect(new RelayError("x", "DailyCap").revertName).toBe("DailyCap");
  });
});
