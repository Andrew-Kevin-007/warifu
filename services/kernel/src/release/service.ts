// The payAt release path (docs/04 s5, docs/02 s5.1 step 6; WP-14):
//
//   due RELEASE head --(fresh context, reevaluate())--> identical fresh RELEASE ? sign Attestation (deadline now+10 min),
//                                                                                 store it QUEUED, then relay (simulate -> send)
//                                                                               : record the fresh outcome as a NEW decision
//                                                                                 superseding the schedule; nothing is signed
//
// Fail closed everywhere: an error before the claim leaves nothing behind (the next tick tries again from scratch); an error
// after the claim leaves a QUEUED row whose SAME signed attestation is re-sent (idempotent: identical calldata = identical Circle
// key, and the vault's used[intentId] refuses a second release) until it expires, then a FRESH re-evaluation is needed. Nothing
// is sent while the breaker is halted or the vault is paused. Confirmation comes only from an indexed Released event
// (release/confirm.ts), never from the relayer's answer.
import { reevaluate } from "@symbolon/kernel-core";
import type { ScheduledRelease } from "@symbolon/kernel-core";
import { Hex32Schema, epochSecondsFromIso } from "@symbolon/schemas";
import type { Address, Hex32, ISODateTime } from "@symbolon/schemas";
import type { Profile } from "../boot";
import type { TxStatus } from "../chain/engagement-chain";
import type { ChainReader } from "../chain/reader";
import { RelayError, ZERO_APPROVAL_REF } from "../chain/relayer";
import type { VaultRelayer } from "../chain/relayer";
import type { Db } from "../db/pool";
import * as base from "../db/repo";
import { recordFinding } from "../engagement/repo";
import { errorFields } from "../log";
import type { Logger } from "../log";
import type { KernelSigner } from "../receipt/build";
import { intentContext, readIntentChain } from "../service/intent-context";
import { recordDecision } from "../service/record";
import { nowIso, plusSeconds } from "../time";
import type { Clock } from "../time";
import { signAttestation } from "./attestation";
import * as repo from "./repo";
import type { ReleaseRow, StoredAttestation } from "./repo";

export interface ReleaseDeps {
  readonly db: Db;
  readonly chain: ChainReader;
  readonly signer: KernelSigner;
  /** null = attestations are signed and stored, nothing is submitted (no relayer configured). */
  readonly relayer: VaultRelayer | null;
  readonly clock: Clock;
  readonly profile: Profile;
  readonly logger: Logger;
  /** Receipt lookups for SUBMITTED transactions (reverted/dropped detection). */
  readonly txStatus?: (txHash: Hex32) => Promise<TxStatus>;
  /** Re-collect the milestone's evidence just before the payAt re-evaluation (fresh CI/URL reads). Errors are logged. */
  readonly recollect?: (tenantId: string, milestoneId: Hex32) => Promise<void>;
  readonly newId?: () => string;
}

/** Do not send an attestation that has less than this left: it could expire in the mempool (the vault would refuse it anyway). */
export const DEADLINE_SAFETY_SECONDS = 30;
/** Back-off after a vault refusal that a rolling window may lift (DailyCap, HourlyCap, TooManyReleases). */
export const WINDOW_BACKOFF_SECONDS = 15 * 60;
/** Back-off after any other refusal. */
export const RETRY_BACKOFF_SECONDS = 60;
/** A SUBMITTED transaction the node does not know after this long is treated as dropped. */
export const DROPPED_AFTER_SECONDS = 120;

export type DueOutcome =
  | { readonly kind: "QUEUED"; readonly release: ReleaseRow }
  | { readonly kind: "SUPERSEDED"; readonly decisionId: string; readonly verdict: string; readonly mismatches: readonly string[] }
  | { readonly kind: "SKIPPED"; readonly why: string };

const WINDOW_ERRORS = new Set(["DailyCap", "HourlyCap", "TooManyReleases"]);

/** TOCTOU: re-evaluate one due scheduled RELEASE and either claim a signed attestation or record the changed outcome. */
export async function processDue(d: ReleaseDeps, tenantId: string, decisionId: string, intentId: Hex32): Promise<DueOutcome> {
  const peekHead = await base.getStoredDecision(d.db, tenantId, decisionId);
  if (peekHead === null || peekHead.decision.verdict !== "RELEASE") return { kind: "SKIPPED", why: "NOT_A_RELEASE" };
  if (d.recollect !== undefined && peekHead.decision.milestoneId !== null) {
    try {
      await d.recollect(tenantId, peekHead.decision.milestoneId);
    } catch (e) {
      // A failed collection is not a pass: the kernel reads whatever evidence is on file (stale/missing => HOLD).
      d.logger.warn("release.recollect_failed", { tenantId, intentId, ...errorFields(e) });
    }
  }
  const view = await readIntentChain(d.db, d.chain, tenantId, intentId);
  return d.db.tx(async (q): Promise<DueOutcome> => {
    await base.lockTenantForDecisions(q, tenantId);
    const now = nowIso(d.clock);
    const ic = await intentContext(q, { tenantId, intentId, profile: d.profile, now, view });
    const head = ic.head;
    if (head.decision.decisionId !== decisionId) return { kind: "SKIPPED", why: "SUPERSEDED_MEANWHILE" };
    const existing = await repo.releaseForIntent(q, tenantId, intentId);
    if (existing !== null && existing.status !== "FAILED") return { kind: "SKIPPED", why: `RELEASE_${existing.status}` };
    if (existing !== null && existing.attempts >= repo.MAX_RELEASE_ATTEMPTS) return { kind: "SKIPPED", why: "ATTEMPTS_EXHAUSTED" };
    const dec = head.decision;
    if (dec.payAt === null || dec.payee === null || dec.releaseAmountBaseUnits === null || dec.engagementId === null || dec.milestoneId === null) {
      return { kind: "SKIPPED", why: "INCOMPLETE_SCHEDULE" }; // never attest a decision missing a bound field
    }
    const scheduled: ScheduledRelease = {
      decisionId: dec.decisionId,
      intentId: dec.intentId,
      payee: dec.payee,
      payAt: dec.payAt,
      releaseAmountBaseUnits: BigInt(dec.releaseAmountBaseUnits),
      planId: dec.planId,
      timingSource: dec.timingSource,
      plannerFallback: dec.plannerFallback,
    };
    const r = reevaluate(view.intent.payload, ic.ctx, ic.policy, scheduled);

    if (!r.attestable || r.attestationDeadline === null) {
      // A changed outcome: the fresh evaluation becomes a new decision that supersedes the schedule. Nothing is signed.
      const rec = await recordDecision({
        q, signer: d.signer, logger: d.logger, evaluation: r.evaluation, ctx: ic.ctx, rawIntent: view.intent.payload,
        supersedes: dec.decisionId, policyHash: ic.policy.policyHash, action: "release.toctou_superseded", actor: "kernel:scheduler",
        ...(d.newId === undefined ? {} : { newId: d.newId }),
      });
      await base.writeAudit(q, "kernel:scheduler", "release.not_attested", { intentId, decisionId: dec.decisionId, supersededBy: rec.decision.decisionId, mismatches: [...r.mismatches] });
      return { kind: "SUPERSEDED", decisionId: rec.decision.decisionId, verdict: rec.decision.verdict, mismatches: r.mismatches };
    }

    const amount = r.evaluation.releaseAmountBaseUnits as string; // attestable => identical to the scheduled amount
    let ownerApproval: StoredAttestation["ownerApproval"] = null;
    if (BigInt(amount) > view.chain.snapshot.humanThreshold) {
      // The vault demands OwnerApproval(intentId, ref.receiptHash, amount, ref.deadline). The kernel's own K-12 already required a
      // bound approval for this amount; we pass exactly that one, and refuse to attest without it (fail closed).
      const a = ic.approval;
      const nowSec = epochSecondsFromIso(now);
      if (a === null || a.amount !== amount || BigInt(a.deadline) < nowSec + BigInt(DEADLINE_SAFETY_SECONDS)) {
        await recordFinding(q, tenantId, "RELEASE_APPROVAL_UNAVAILABLE", "MEDIUM", `${intentId}:${dec.decisionId}`, { intentId, decisionId: dec.decisionId });
        return { kind: "SKIPPED", why: "OWNER_APPROVAL_UNAVAILABLE" };
      }
      ownerApproval = { receiptHash: a.receiptHash, deadline: a.deadline, signature: a.signature };
    }
    const signed = await signAttestation(
      {
        chainId: view.tv.chainId,
        vault: view.tv.vault,
        intentId: dec.intentId,
        engagementId: dec.engagementId,
        milestoneId: dec.milestoneId,
        payee: dec.payee,
        amount,
        receiptHash: head.receiptHash,
        deadline: r.attestationDeadline,
      },
      d.signer,
    );
    const stored: StoredAttestation = {
      message: signed.message,
      digest: signed.digest,
      kernelSig: signed.signature,
      signer: signed.signer,
      ownerApproval,
      reevaluationContextHash: r.evaluation.contextHash,
      reevaluatedAt: now,
    };
    const row = await repo.queueRelease(q, { tenantId, decisionId: dec.decisionId, intentId: dec.intentId, attestation: stored, deadline: r.attestationDeadline });
    await base.writeAudit(q, "kernel:scheduler", "release.attested", {
      intentId,
      decisionId: dec.decisionId,
      receiptHash: head.receiptHash,
      releaseId: row.releaseId,
      attempt: row.attempts,
      reevaluationContextHash: r.evaluation.contextHash,
    });
    d.logger.info("release.attested", { tenantId, intentId, decisionId: dec.decisionId, receiptHash: head.receiptHash, count: row.attempts });
    return { kind: "QUEUED", release: row };
  });
}

export type SendOutcome = "SUBMITTED" | "PENDING" | "FAILED" | "HELD" | "NO_RELAYER";

/** Relay one QUEUED attestation exactly as signed. Never re-signs; never sends while halted, paused or about to expire. */
export async function sendQueued(d: ReleaseDeps, tenantId: string, row: ReleaseRow): Promise<SendOutcome> {
  if (row.status !== "QUEUED") return "HELD";
  if (row.error !== null && row.error.startsWith("ALREADY_USED")) return "PENDING"; // used on chain: wait for the indexer
  const now = nowIso(d.clock);
  const nowSec = epochSecondsFromIso(now);
  const deadlineSec = BigInt(row.attestation.message.deadline);
  if (nowSec + BigInt(DEADLINE_SAFETY_SECONDS) > deadlineSec) {
    await failed(d, tenantId, row, "ATTESTATION_EXPIRED", null);
    return "FAILED";
  }
  // Breaker (K-16) and vault pause are re-checked at send time: a trip after signing stops the attestation here.
  const tv = await (await import("../context/build")).resolveTenantVault(d.db, tenantId, d.chain);
  const [breaker, snapshot] = await Promise.all([base.loadBreaker(d.db, tenantId), d.chain.snapshot(tv.vault)]);
  if (breaker.halted || snapshot.paused) {
    await failed(d, tenantId, row, breaker.halted ? "BREAKER_HALTED" : "VAULT_PAUSED", null);
    return "FAILED";
  }
  if (d.relayer === null) {
    await repo.noteQueued(d.db, row.releaseId, "NO_RELAYER");
    return "NO_RELAYER";
  }
  const m = row.attestation.message;
  const oa = row.attestation.ownerApproval;
  try {
    const { txHash } = await d.relayer.release({
      vault: tv.vault,
      attestation: {
        intentId: m.intentId,
        engagementId: m.engagementId,
        milestoneId: m.milestoneId,
        payee: m.payee as Address,
        amount: BigInt(m.amount),
        receiptHash: m.receiptHash,
        deadline: BigInt(m.deadline),
      },
      kernelSig: row.attestation.kernelSig,
      ref: oa === null ? ZERO_APPROVAL_REF : { receiptHash: oa.receiptHash, deadline: BigInt(oa.deadline) },
      ownerApprovalSig: oa === null ? "0x" : oa.signature,
    });
    await repo.markSubmitted(d.db, row.releaseId, Hex32Schema.parse(txHash), now);
    d.logger.info("release.submitted", { tenantId, intentId: row.intentId, decisionId: row.decisionId, txHash });
    return "SUBMITTED";
  } catch (e) {
    const name = e instanceof RelayError ? e.revertName : null;
    if (name === "CIRCLE_PENDING") {
      await repo.noteQueued(d.db, row.releaseId, "CIRCLE_PENDING");
      return "PENDING";
    }
    if (name === "AlreadyUsed") {
      // The vault already consumed this intentId: our earlier send (or a retry) landed. Never send again; the indexer confirms.
      await repo.noteQueued(d.db, row.releaseId, "ALREADY_USED_ON_CHAIN");
      return "PENDING";
    }
    if (!(e instanceof RelayError)) {
      // Unknown outcome (network, crash inside the client): keep it QUEUED; the SAME attestation is re-sent next tick.
      d.logger.warn("release.relay_error", { tenantId, intentId: row.intentId, ...errorFields(e) });
      await repo.noteQueued(d.db, row.releaseId, "RELAY_ERROR");
      return "PENDING";
    }
    const code = name ?? "RELAY_FAILED";
    await failed(d, tenantId, row, code, plusSeconds(now, WINDOW_ERRORS.has(code) ? WINDOW_BACKOFF_SECONDS : code === "Expired" ? 0 : RETRY_BACKOFF_SECONDS));
    return "FAILED";
  }
}

async function failed(d: ReleaseDeps, tenantId: string, row: ReleaseRow, code: string, next: ISODateTime | null): Promise<void> {
  await repo.markFailed(d.db, row.releaseId, code, next);
  d.logger.warn("release.failed", { tenantId, intentId: row.intentId, decisionId: row.decisionId, reasonCode: code.replace(/[^A-Za-z0-9_]/g, "_").slice(0, 40), count: row.attempts });
  if (row.attempts >= repo.MAX_RELEASE_ATTEMPTS) {
    // docs/02 s6: after N=3 nothing more is sent; a human looks at it. No money moved.
    await recordFinding(d.db, tenantId, "RELEASE_RELAY_FAILED", "MEDIUM", row.intentId, { intentId: row.intentId, decisionId: row.decisionId, error: code.slice(0, 64) });
  }
}

/** SUBMITTED transactions that reverted, or that the node no longer knows after a while, become FAILED (retryable). */
export async function checkSubmitted(d: ReleaseDeps, tenantId: string): Promise<number> {
  if (d.txStatus === undefined) return 0;
  let n = 0;
  const nowSec = epochSecondsFromIso(nowIso(d.clock));
  for (const row of await repo.releasesByStatus(d.db, tenantId, "SUBMITTED")) {
    if (row.txHash === null) continue;
    const st = await d.txStatus(row.txHash);
    const age = row.submittedAt === null ? 0n : nowSec - epochSecondsFromIso(row.submittedAt);
    if (st === "reverted" || (st === "unknown" && age >= BigInt(DROPPED_AFTER_SECONDS))) {
      await failed(d, tenantId, row, st === "reverted" ? "TX_REVERTED" : "TX_DROPPED", null);
      n++;
    }
  }
  return n;
}
