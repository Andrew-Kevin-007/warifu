/* eslint-disable @typescript-eslint/no-explicit-any */
// WP-14 acceptance, part 1: the payAt release path over a REAL Postgres (all migrations), the real Hono app, the real kernel and
// the real receipts/attestation signing. Faked: only the chain READ edge (as in world.ts) and the relayer (a recorder with scripted
// outcomes). The same path against a real anvil + the real SymbolonVault is in release.anvil.local.test.ts.
//
// Every "must NOT release" case asserts the same four things: the scheduler reports a superseding decision, the relayer was
// never called, no `releases` row exists, and the new head decision supersedes the scheduled one with the expected verdict/reason.
import { afterEach, describe, expect, it } from "vitest";
import { normalizePolicy } from "@symbolon/policy";
import { EIP712_TYPES, epochSecondsFromIso, isoFromEpochSeconds, symbolonDomain } from "@symbolon/schemas";
import { buildApprovalTypedData } from "@symbolon/receipts";
import { recoverTypedDataAddress } from "viem";
import { collectEvidence } from "../../src/evidence/service";
import * as base from "../../src/db/repo";
import { DEADLINE_SAFETY_SECONDS, SEND_LEASE_SECONDS, processDue } from "../../src/release/service";
import { recheckHolds, tickTenant } from "../../src/release/scheduler";
import { releaseForIntent } from "../../src/release/repo";
import { dbSuiteEnabled } from "../helpers/pgdb";
import { evidenceDeps, fakeEngagementChain, jsonResponse, netStub } from "../helpers/evidence-world";
import { openReleaseWorld, relayRefused } from "../helpers/release-world";
import type { ReleaseWorld, ReleaseWorldOptions } from "../helpers/release-world";
import { CHAIN_ID, VAULT, call } from "../helpers/world";

const enabled = dbSuiteEnabled("release.local");
const SHA = "c".repeat(40);

interface Scheduled {
  readonly intentId: string;
  readonly decisionId: string;
  readonly payAt: bigint;
  readonly amount: string;
  readonly receiptHash: string;
}

describe.skipIf(!enabled)("local: payAt release path, TOCTOU re-evaluation (WP-14)", () => {
  const open: ReleaseWorld[] = [];
  afterEach(async () => {
    while (open.length > 0) await open.pop()?.close();
  });
  const world = async (o: ReleaseWorldOptions = {}): Promise<ReleaseWorld> => {
    const r = await openReleaseWorld(o);
    open.push(r);
    return r;
  };

  /** Submit an invoice, satisfy its evidence and let the HOLD re-check schedule it: a RELEASE head with a future payAt. */
  async function schedule(r: ReleaseWorld, afterSubmit: () => Promise<void> = () => r.ack()): Promise<Scheduled> {
    const sub = await r.submit();
    expect(sub.status).toBe(201);
    expect(sub.json.decision.verdict).toBe("HOLD");
    await afterSubmit();
    await recheckHolds(r.release(), r.tenantId, { milestoneId: r.milestone });
    return headScheduled(r, sub.json.intentId);
  }
  async function headScheduled(r: ReleaseWorld, intentId: string): Promise<Scheduled> {
    const head = await base.getLatestStoredDecisionForIntent(r.w.t.db, r.tenantId, intentId);
    const d = head?.decision;
    expect(d?.verdict, JSON.stringify(d?.reasons)).toBe("RELEASE");
    return {
      intentId,
      decisionId: d?.decisionId as string,
      payAt: epochSecondsFromIso(d?.payAt as string),
      amount: d?.releaseAmountBaseUnits as string,
      receiptHash: head?.receiptHash as string,
    };
  }
  const head = (r: ReleaseWorld, s: Scheduled) => base.getLatestStoredDecisionForIntent(r.w.t.db, r.tenantId, s.intentId);
  const releaseRow = (r: ReleaseWorld, s: Scheduled) => releaseForIntent(r.w.t.db, r.tenantId, s.intentId);

  /** The "must not release" contract of one TOCTOU case. */
  async function expectNotReleased(r: ReleaseWorld, s: Scheduled, verdict: string, reason: string): Promise<void> {
    r.advanceTo(s.payAt + 1n);
    const t = await tickTenant(r.release(), r.tenantId);
    expect(t).toMatchObject({ due: 1, superseded: 1, queued: 0, sent: 0, errors: 0 });
    expect(r.relayer.calls).toHaveLength(0);
    expect(await releaseRow(r, s)).toBeNull();
    const h = await head(r, s);
    expect(h?.decision.verdict).toBe(verdict);
    expect(h?.decision.reasons).toContain(reason);
    expect(h?.decision.supersedes).toBe(s.decisionId);
    expect(h?.receiptHash).not.toBe(s.receiptHash);
    // The superseded schedule is never processed again, and a second tick has nothing to do.
    const again = await tickTenant(r.release(), r.tenantId);
    expect(again).toMatchObject({ due: 0, queued: 0, sent: 0 });
    expect(r.relayer.calls).toHaveLength(0);
  }

  it("happy path: at payAt the kernel re-evaluates, signs an attestation for the DISCOUNTED amount, relays once, and anchors the scheduled receipt", async () => {
    const r = await world();
    const s = await schedule(r);
    expect(s.amount).toBe("980000000"); // 2 % of the 1,000 USDC gross
    // Before payAt nothing is due.
    expect(await tickTenant(r.release(), r.tenantId)).toMatchObject({ due: 0, queued: 0, sent: 0 });
    expect(r.relayer.calls).toHaveLength(0);

    r.advanceTo(s.payAt + 1n);
    const t = await tickTenant(r.release(), r.tenantId);
    expect(t).toMatchObject({ due: 1, queued: 1, sent: 1, superseded: 0, errors: 0 });
    expect(r.relayer.calls).toHaveLength(1);
    const a = r.relayer.calls[0]!;
    // The intent id is derived from the GROSS amount, the vault is paid the discounted release amount (INV-19, K-04).
    expect(a.attestation.intentId).toBe(s.intentId);
    expect(a.attestation.amount).toBe(BigInt(s.amount));
    expect(a.attestation.payee).toBe(r.engagement.payee);
    expect(a.attestation.engagementId).toBe(r.engagement.engagementId);
    expect(a.attestation.milestoneId).toBe(r.milestone);
    expect(a.attestation.receiptHash).toBe(s.receiptHash);
    // deadline = re-evaluation instant + 10 minutes
    const row = await releaseRow(r, s);
    expect(row?.status).toBe("SUBMITTED");
    expect(row?.attempts).toBe(1);
    const reevaluatedAt = epochSecondsFromIso(row!.attestation.reevaluatedAt);
    expect(a.attestation.deadline).toBe(reevaluatedAt + 600n);
    expect(a.vault.toLowerCase()).toBe(VAULT.toLowerCase());
    // The signature recovers to the kernel signer over the vault's EIP-712 domain.
    const recovered = await recoverTypedDataAddress({
      domain: { name: "SymbolonVault", version: "1", chainId: CHAIN_ID, verifyingContract: VAULT },
      types: { Attestation: EIP712_TYPES.Attestation.map((f) => ({ name: f.name, type: f.type })) },
      primaryType: "Attestation",
      message: { ...a.attestation },
      signature: a.kernelSig,
    });
    expect(recovered.toLowerCase()).toBe(r.signerAddress.toLowerCase());
    // At or below the human threshold: no owner approval is attached.
    expect(a.ownerApprovalSig).toBe("0x");
    expect(a.ref.deadline).toBe(0n);
    // The head decision is still the scheduled RELEASE (an unchanged outcome is not re-recorded).
    expect((await head(r, s))?.decision.decisionId).toBe(s.decisionId);
    // Nothing more happens on further ticks: the release is in flight.
    expect(await tickTenant(r.release(), r.tenantId)).toMatchObject({ due: 0, queued: 0, sent: 0 });
    expect(r.relayer.calls).toHaveLength(1);
  });

  describe("changes between decision and release that must NOT release", () => {
    it("policy change: the owner's per-tx cap is lowered below the amount -> REJECT CAP_PER_TX", async () => {
      const r = await world();
      const s = await schedule(r);
      await setPolicy(r, (p) => ({ ...p, caps: { ...p.caps, perTxHardCap: "500" } }));
      await expectNotReleased(r, s, "REJECT", "CAP_PER_TX");
    });

    it("policy change: the human-approval threshold is lowered below the amount -> ESCALATE HUMAN_REQUIRED", async () => {
      const r = await world();
      const s = await schedule(r);
      await setPolicy(r, (p) => ({ ...p, caps: { ...p.caps, humanApprovalAbove: "100" } }));
      await expectNotReleased(r, s, "ESCALATE", "HUMAN_REQUIRED");
    });

    it("policy document edited without its hash (tampering): the context cannot be built, so nothing is attested (fail closed)", async () => {
      const r = await world();
      const s = await schedule(r);
      const cur = (await r.w.t.db.query<{ policy: any }>("select policy from tenants where id = $1", [r.tenantId])).rows[0]!.policy;
      await r.w.t.db.query("update tenants set policy = $2::jsonb where id = $1", [r.tenantId, JSON.stringify({ ...cur, caps: { ...cur.caps, perTxHardCap: "1" } })]);
      r.advanceTo(s.payAt + 1n);
      const t = await tickTenant(r.release(), r.tenantId);
      expect(t).toMatchObject({ due: 1, queued: 0, sent: 0, errors: 1 });
      expect(r.relayer.calls).toHaveLength(0);
      expect(await releaseRow(r, s)).toBeNull();
    });

    it("breaker trip: the tenant breaker is HALTED -> HOLD BREAKER_HALTED", async () => {
      const r = await world();
      const s = await schedule(r);
      await r.w.t.db.query(
        "insert into breaker_state (tenant_id, halted, reason, since) values ($1, true, 'test: reconciliation finding', now()) on conflict (tenant_id) do update set halted = true",
        [r.tenantId],
      );
      await expectNotReleased(r, s, "HOLD", "BREAKER_HALTED");
    });

    it("evidence turns red: the pre-release re-collection sees CI failing -> HOLD EVIDENCE_FAILED", async () => {
      const r = await world({ evidenceSpec: [{ type: "CI_PASS", repo: "acme/site", ref: SHA, workflow: "ci.yml" } as never] });
      let conclusion = "success";
      const net = netStub({ "api.github.com": ["140.82.112.5"] }, () =>
        jsonResponse({ workflow_runs: [{ id: 1, head_branch: "main", head_sha: SHA, status: "completed", conclusion, created_at: "2026-10-12T08:00:00Z" }] }),
      );
      const ev = evidenceDeps(r.w, { kind: "live", guard: net, githubToken: null }, { clock: r.nowMs, engagementChain: fakeEngagementChain() });
      const collect = async (): Promise<void> => void (await collectEvidence(ev, r.tenantId, { milestoneId: r.milestone }));
      const s = await schedule(r, collect);
      expect(s.amount).toBe("980000000");
      conclusion = "failure";
      r.advanceTo(s.payAt + 1n);
      const t = await tickTenant(r.release({ recollect: async (tenantId, milestoneId) => void (await collectEvidence(ev, tenantId, { milestoneId })) }), r.tenantId);
      expect(t).toMatchObject({ due: 1, superseded: 1, queued: 0, sent: 0 });
      expect(r.relayer.calls).toHaveLength(0);
      expect(await releaseRow(r, s)).toBeNull();
      const h = await head(r, s);
      expect(h?.decision.verdict).toBe("HOLD");
      expect(h?.decision.reasons).toContain("EVIDENCE_FAILED");
      expect(h?.decision.supersedes).toBe(s.decisionId);
    });

    it("evidence goes stale: the owner acknowledgement is older than the freshness window at payAt -> HOLD, nothing released", async () => {
      const r = await world({ policy: { evidence: { freshnessHours: 120, allowOwnerOverride: true, urlAllowlist: [] } } });
      const s = await schedule(r); // valid when scheduled (freshness 5 days), stale by payAt (about 10 days)
      r.advanceTo(s.payAt + 1n);
      const t = await tickTenant(r.release(), r.tenantId);
      expect(t).toMatchObject({ due: 1, superseded: 1, queued: 0, sent: 0 });
      expect(r.relayer.calls).toHaveLength(0);
      expect(await releaseRow(r, s)).toBeNull();
      const h = await head(r, s);
      expect(h?.decision.verdict).toBe("HOLD");
      expect(h?.decision.reasons).toEqual(expect.arrayContaining([expect.stringMatching(/^EVIDENCE_/)]));
    });

    it("payee change pending on chain -> HOLD PAYEE_CHANGE_PENDING", async () => {
      const r = await world();
      const s = await schedule(r);
      r.w.chain.payeeChangePending = true;
      await expectNotReleased(r, s, "HOLD", "PAYEE_CHANGE_PENDING");
    });

    it("payee changed on chain (the registered payee is no longer the one the schedule names) -> no release", async () => {
      const r = await world();
      const s = await schedule(r);
      const reg = r.w.chain.engagements.get(r.engagement.engagementId)!;
      r.w.chain.engagements.set(r.engagement.engagementId, { ...reg, payee: "0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359" });
      r.advanceTo(s.payAt + 1n);
      const t = await tickTenant(r.release(), r.tenantId);
      expect(t).toMatchObject({ due: 1, superseded: 1, queued: 0, sent: 0 });
      expect(r.relayer.calls).toHaveLength(0);
      expect(await releaseRow(r, s)).toBeNull();
      expect((await head(r, s))?.decision.verdict).not.toBe("RELEASE");
    });

    it("engagement closed on chain -> no release", async () => {
      const r = await world();
      const s = await schedule(r);
      const reg = r.w.chain.engagements.get(r.engagement.engagementId)!;
      r.w.chain.engagements.set(r.engagement.engagementId, { ...reg, active: false });
      r.advanceTo(s.payAt + 1n);
      const t = await tickTenant(r.release(), r.tenantId);
      expect(t).toMatchObject({ due: 1, superseded: 1, queued: 0, sent: 0 });
      expect(r.relayer.calls).toHaveLength(0);
      expect((await head(r, s))?.decision.verdict).not.toBe("RELEASE");
    });

    it("the discount window closed before the scheduler ran -> ESCALATE DISCOUNT_WINDOW_CLOSED, never a silent switch to the full amount", async () => {
      const r = await world();
      const s = await schedule(r);
      // payAt is windowEnd - 60 min. A scheduler that was down for two hours wakes up after the window.
      r.advanceTo(s.payAt + 2n * 3600n);
      const t = await tickTenant(r.release(), r.tenantId);
      expect(t).toMatchObject({ due: 1, superseded: 1, queued: 0, sent: 0 });
      expect(r.relayer.calls).toHaveLength(0);
      expect(await releaseRow(r, s)).toBeNull();
      const h = await head(r, s);
      expect(h?.decision.verdict).toBe("ESCALATE");
      expect(h?.decision.reasons).toContain("DISCOUNT_WINDOW_CLOSED");
      expect(h?.decision.supersedes).toBe(s.decisionId);
    });

    it("approval expiry: an owner approval that lapsed between decision and release -> ESCALATE HUMAN_REQUIRED, no release", async () => {
      // A 1,000 USDC invoice against a 500 USDC human threshold (policy and vault): the owner must sign.
      const r = await world({ humanApprovalAbove: "500", humanThresholdUnits: 500_000_000n });
      const sub = await r.submit();
      await r.ack();
      await recheckHolds(r.release(), r.tenantId, { milestoneId: r.milestone });
      const esc = await base.getLatestStoredDecisionForIntent(r.w.t.db, r.tenantId, sub.json.intentId);
      expect(esc?.decision.verdict).toBe("ESCALATE");
      expect(esc?.decision.reasons).toContain("HUMAN_REQUIRED");
      await approve(r, sub.json.intentId, esc!.receiptHash, esc!.decision.releaseAmountBaseUnits as string, 600);
      const s = await headScheduled(r, sub.json.intentId);
      // The approval lives 10 minutes; payAt is days away.
      expect(s.payAt).toBeGreaterThan(r.now() + 3600n);
      await expectNotReleased(r, s, "ESCALATE", "HUMAN_REQUIRED");
    });
  });

  it("a human-gated release carries the stored OwnerApproval to the vault (ref + signature), bound to the escalation receipt", async () => {
    const r = await world({ humanApprovalAbove: "500", humanThresholdUnits: 500_000_000n });
    const sub = await r.submit();
    await r.ack();
    await recheckHolds(r.release(), r.tenantId, { milestoneId: r.milestone });
    const esc = await base.getLatestStoredDecisionForIntent(r.w.t.db, r.tenantId, sub.json.intentId);
    expect(esc?.decision.verdict).toBe("ESCALATE");
    // Sign shortly before payAt so the 10-minute approval is still valid when the scheduler runs.
    const payAtOfPlan = (await call(r.app(), "GET", `/v1/intents/${sub.json.intentId}/plans`, r.token())).json;
    expect(payAtOfPlan).toBeTruthy();
    const target = epochSecondsFromIso(esc!.decision.payAt ?? (payAtOfPlan.plans?.[0]?.payAt as string));
    r.advanceTo(target - 300n);
    await recheckHolds(r.release(), r.tenantId, { milestoneId: r.milestone, recheckAfterSeconds: 0 });
    const cur = await base.getLatestStoredDecisionForIntent(r.w.t.db, r.tenantId, sub.json.intentId);
    expect(cur?.decision.verdict).toBe("ESCALATE");
    await approve(r, sub.json.intentId, cur!.receiptHash, cur!.decision.releaseAmountBaseUnits as string, 600);
    const s = await headScheduled(r, sub.json.intentId);
    r.advanceTo(s.payAt + 1n);
    const t = await tickTenant(r.release(), r.tenantId);
    expect(t).toMatchObject({ due: 1, queued: 1, sent: 1, errors: 0 });
    const a = r.relayer.calls[0]!;
    expect(a.ownerApprovalSig).toMatch(/^0x[0-9a-f]{130}$/);
    expect(a.ref.receiptHash).toBe(cur!.receiptHash); // the ESCALATION receipt the owner reviewed
    expect(a.attestation.receiptHash).toBe(s.receiptHash); // the final RELEASE receipt
    expect(a.ref.receiptHash).not.toBe(a.attestation.receiptHash);
    expect(a.ref.deadline).toBeGreaterThanOrEqual(a.attestation.deadline - 600n);
  });

  describe("crash safety and idempotency", () => {
    it("crash between claim and send: the SAME signed attestation is sent after restart, exactly once", async () => {
      const r = await world();
      const s = await schedule(r);
      r.advanceTo(s.payAt + 1n);
      // The process dies right after the claim: a QUEUED row exists, nothing was sent.
      const out = await processDue(r.release(), r.tenantId, s.decisionId, s.intentId as never);
      expect(out.kind).toBe("QUEUED");
      expect(r.relayer.calls).toHaveLength(0);
      const claimed = await releaseRow(r, s);
      expect(claimed?.status).toBe("QUEUED");
      // Restart: a fresh scheduler pass finds the QUEUED row and sends it; it does NOT sign a second attestation.
      const t = await tickTenant(r.release(), r.tenantId);
      expect(t).toMatchObject({ sent: 1, queued: 0, errors: 0 });
      expect(r.relayer.calls).toHaveLength(1);
      const sent = r.relayer.calls[0]!;
      expect(sent.kernelSig).toBe(claimed?.attestation.kernelSig);
      expect(sent.attestation.deadline).toBe(BigInt(claimed!.attestation.message.deadline));
      expect((await releaseRow(r, s))?.attempts).toBe(1);
      // And once more: nothing.
      await tickTenant(r.release(), r.tenantId);
      expect(r.relayer.calls).toHaveLength(1);
    });

    it("two schedulers racing on one intent produce one release row and one send", async () => {
      const r = await world();
      const s = await schedule(r);
      r.advanceTo(s.payAt + 1n);
      const [a, b] = await Promise.all([tickTenant(r.release(), r.tenantId), tickTenant(r.release(), r.tenantId)]);
      expect(a.sent + b.sent).toBe(1);
      expect(r.relayer.calls).toHaveLength(1);
      const n = await r.w.t.db.query<{ n: string }>("select count(*)::text as n from releases where intent_id = $1", [s.intentId]);
      expect(n.rows[0]?.n).toBe("1");
    });

    it("unknown relay outcome (crash inside the send): the row stays QUEUED under a lease, then the SAME attestation is re-sent", async () => {
      const r = await world();
      const s = await schedule(r);
      r.relayer.script.push(new Error("socket hang up")); // the first send's outcome is unknown
      r.advanceTo(s.payAt + 1n);
      const t1 = await tickTenant(r.release(), r.tenantId);
      expect(t1).toMatchObject({ queued: 1, sent: 0 });
      expect(r.relayer.calls).toHaveLength(1);
      const row = await releaseRow(r, s);
      expect(row?.status).toBe("QUEUED");
      expect(row?.error).toBe("RELAY_ERROR");
      // Inside the lease another scheduler leaves the row alone.
      await tickTenant(r.release(), r.tenantId);
      expect(r.relayer.calls).toHaveLength(1);
      // The lease runs out: the identical attestation (same calldata, so the same Circle idempotency key) goes out again.
      r.advance(SEND_LEASE_SECONDS + 1);
      const t3 = await tickTenant(r.release(), r.tenantId);
      expect(t3).toMatchObject({ sent: 1 });
      expect(r.relayer.calls).toHaveLength(2);
      expect(r.relayer.calls[1]).toEqual(r.relayer.calls[0]);
      expect((await releaseRow(r, s))?.status).toBe("SUBMITTED");
      expect((await releaseRow(r, s))?.attempts).toBe(1);
    });

    it("the vault already consumed the intent (our earlier send landed): never sent again, wait for the indexer", async () => {
      const r = await world();
      const s = await schedule(r);
      r.relayer.script.push(relayRefused("AlreadyUsed"));
      r.advanceTo(s.payAt + 1n);
      await tickTenant(r.release(), r.tenantId);
      expect(r.relayer.calls).toHaveLength(1);
      const row = await releaseRow(r, s);
      expect(row?.status).toBe("QUEUED");
      expect(row?.error).toMatch(/^ALREADY_USED/);
      r.advance(SEND_LEASE_SECONDS + 1);
      await tickTenant(r.release(), r.tenantId);
      expect(r.relayer.calls).toHaveLength(1);
    });

    it("breaker tripped AFTER the attestation was signed: the send is refused and the row FAILS (no money moves)", async () => {
      const r = await world();
      const s = await schedule(r);
      r.advanceTo(s.payAt + 1n);
      expect((await processDue(r.release(), r.tenantId, s.decisionId, s.intentId as never)).kind).toBe("QUEUED");
      await r.w.t.db.query("insert into breaker_state (tenant_id, halted, reason, since) values ($1, true, 'test', now())", [r.tenantId]);
      await tickTenant(r.release(), r.tenantId);
      expect(r.relayer.calls).toHaveLength(0);
      const row = await releaseRow(r, s);
      expect(row?.status).toBe("FAILED");
      expect(row?.error).toBe("BREAKER_HALTED");
    });

    it("vault paused after the attestation was signed: nothing is sent", async () => {
      const r = await world();
      const s = await schedule(r);
      r.advanceTo(s.payAt + 1n);
      expect((await processDue(r.release(), r.tenantId, s.decisionId, s.intentId as never)).kind).toBe("QUEUED");
      r.w.chain.paused = true;
      await tickTenant(r.release(), r.tenantId);
      expect(r.relayer.calls).toHaveLength(0);
      expect((await releaseRow(r, s))?.error).toBe("VAULT_PAUSED");
    });

    it("an attestation about to expire is never sent; the retry is a FRESH re-evaluation with a new signature and deadline", async () => {
      const r = await world();
      const s = await schedule(r);
      r.advanceTo(s.payAt + 1n);
      expect((await processDue(r.release(), r.tenantId, s.decisionId, s.intentId as never)).kind).toBe("QUEUED");
      const first = await releaseRow(r, s);
      r.advance(600 - DEADLINE_SAFETY_SECONDS + 5); // inside the safety margin of the first attestation
      const t = await tickTenant(r.release(), r.tenantId);
      expect(t).toMatchObject({ queued: 1, sent: 1, errors: 0 });
      expect(r.relayer.calls).toHaveLength(1); // only the NEW attestation reached the relayer
      const row = await releaseRow(r, s);
      expect(row?.status).toBe("SUBMITTED");
      expect(row?.attempts).toBe(2);
      expect(row?.attestation.kernelSig).not.toBe(first?.attestation.kernelSig);
      expect(BigInt(row!.attestation.message.deadline)).toBeGreaterThan(BigInt(first!.attestation.message.deadline));
      expect(r.relayer.calls[0]?.attestation.deadline).toBe(BigInt(row!.attestation.message.deadline));
    });

    it("a refused or failing relay is retried at most 3 times, then a finding is raised and nothing more is sent", async () => {
      const r = await world();
      const s = await schedule(r);
      for (let i = 0; i < 3; i++) r.relayer.script.push(relayRefused("PerTxCap"));
      r.advanceTo(s.payAt + 1n);
      for (let i = 0; i < 6; i++) {
        await tickTenant(r.release(), r.tenantId);
        r.advance(2 * 60); // beyond the 60 s retry back-off
      }
      expect(r.relayer.calls).toHaveLength(3);
      const row = await releaseRow(r, s);
      expect(row?.status).toBe("FAILED");
      expect(row?.attempts).toBe(3);
      const f = await r.w.t.db.query<{ kind: string }>("select kind from reconciliations where tenant_id = $1", [r.tenantId]);
      expect(f.rows.map((x) => x.kind)).toContain("RELEASE_RELAY_FAILED");
    });
  });

  /** Replace the tenant's policy by a valid one (hash recomputed), as the owner's policy-update path would. */
  async function setPolicy(r: ReleaseWorld, change: (p: any) => unknown): Promise<void> {
    const cur = (await r.w.t.db.query<{ policy: any }>("select policy from tenants where id = $1", [r.tenantId])).rows[0]!.policy;
    const next = normalizePolicy(change(cur));
    await r.w.t.db.query("update tenants set policy = $2::jsonb, policy_hash = $3 where id = $1", [r.tenantId, JSON.stringify(next.policy), next.policyHash]);
  }

  /** Sign and POST an OwnerApproval for the pending escalation (EIP-712, throwaway owner key). */
  async function approve(r: ReleaseWorld, intentId: string, receiptHash: string, amount: string, ttl: number): Promise<void> {
    const deadline = r.now() + BigInt(ttl);
    const td = buildApprovalTypedData({
      intentId: intentId as never,
      receiptHash: receiptHash as never,
      releaseBaseUnits: amount,
      expiresAt: isoFromEpochSeconds(deadline),
      domain: symbolonDomain(CHAIN_ID, VAULT as never),
    });
    if (!td.ok) throw new Error(`approval typed data: ${JSON.stringify(td.error)} ${intentId} ${receiptHash} ${amount}`);
    const m = td.value.message as Record<string, string>;
    const signature = await r.owner.signTypedData({
      domain: { name: "SymbolonVault", version: "1", chainId: CHAIN_ID, verifyingContract: VAULT as `0x${string}` },
      types: { OwnerApproval: EIP712_TYPES.OwnerApproval.map((f) => ({ name: f.name, type: f.type })) },
      primaryType: "OwnerApproval",
      message: { intentId: m["intentId"] as `0x${string}`, receiptHash: m["receiptHash"] as `0x${string}`, amount: BigInt(m["amount"] as string), deadline: BigInt(m["deadline"] as string) },
    } as never);
    const res = await call(r.app(), "POST", "/v1/approvals", r.token(), { intentId, receiptHash, amount, deadline: deadline.toString(), signature });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    expect(res.json.decision.verdict).toBe("RELEASE");
  }

});
