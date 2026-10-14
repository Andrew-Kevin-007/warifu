// Applying (and undoing) indexed vault events to the engagement tables (WP-12). Runs inside the indexer's transaction, so a
// chain_events row and its effect commit together or not at all.
//
// The one rule that matters: an engagement becomes ACTIVE here, from a CONFIRMED on-chain EngagementRegistered, and only
// when the event matches the stored signed terms field by field. A mismatch cancels the engagement (the id can never be
// registered again on chain, QUESTIONS WP-07 item 5) and raises a HIGH finding. Nothing about an engagement is ever
// "assumed registered" because a transaction was submitted.
import { computeTermsHash, epochSecondsFromIso } from "@symbolon/schemas";
import type { Engagement } from "@symbolon/schemas";
import type { VaultEvent } from "@symbolon/chain";
import type { Queryable } from "../db/pool";
import * as base from "../db/repo";
import { confirmReleased, unconfirmReleased } from "../release/confirm";
import * as repo from "./repo";
import type { StoredChainEvent } from "./repo";

export interface EventPlace {
  readonly txHash: string;
  readonly logIndex: number;
  readonly blockNumber: bigint;
}

/** The JSON stored in chain_events.data: every value a string (bigints in decimal), addresses and hashes as emitted. */
export function eventData(ev: VaultEvent): Record<string, string> {
  switch (ev.name) {
    case "ConfigChanged":
      return { configHash: ev.configHash };
    case "EngagementRegistered":
      return {
        engagementId: ev.engagementId, owner: ev.owner, payee: ev.payee, cap: ev.cap.units.toString(), decimals: String(ev.cap.decimals),
        start: ev.start.toString(), end: ev.end.toString(), termsHash: ev.termsHash,
      };
    case "EngagementClosed":
      return { engagementId: ev.engagementId };
    case "Released":
      return { intentId: ev.intentId, engagementId: ev.engagementId, payee: ev.payee, amount: ev.amount.units.toString(), decimals: String(ev.amount.decimals), receiptHash: ev.receiptHash };
    case "PayeeChangeProposed":
      return { engagementId: ev.engagementId, oldPayee: ev.oldPayee, newPayee: ev.newPayee, eta: ev.eta.toString() };
    case "PayeeChangeExecuted":
      return { engagementId: ev.engagementId, oldPayee: ev.oldPayee, newPayee: ev.newPayee };
    case "VaultPaused":
    case "VaultUnpaused":
      return { by: ev.by };
    case "KernelSignerProposed":
      return { next: ev.next, eta: ev.eta.toString() };
    case "KernelSignerRotated":
    case "GuardianChanged":
      return { previous: ev.previous, next: ev.next };
    case "Withdrawn":
      return { to: ev.to, amount: ev.amount.units.toString(), decimals: String(ev.amount.decimals) };
    case "EIP712DomainChanged":
      return {};
    default: {
      const unknown: never = ev;
      void unknown;
      throw new Error("unhandled vault event");
    }
  }
}

const key = (p: EventPlace): string => `${p.txHash}:${String(p.logIndex)}`;
const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/** Fields of the on-chain registration that differ from the stored signed terms (empty = identical). */
export function registrationDiff(e: Engagement, d: Record<string, string>): string[] {
  const diff: string[] = [];
  if (!same(d["termsHash"] ?? "", e.termsHash)) diff.push("termsHash");
  if (computeTermsHash(e) !== e.termsHash) diff.push("storedTermsDoNotHash");
  if (!same(d["owner"] ?? "", e.owner)) diff.push("owner");
  if (!same(d["payee"] ?? "", e.payee)) diff.push("payee");
  if (d["cap"] !== e.capBaseUnits) diff.push("cap");
  if (d["decimals"] !== String(e.currencyDecimals)) diff.push("decimals");
  if (d["start"] !== epochSecondsFromIso(e.start).toString()) diff.push("start");
  if (d["end"] !== epochSecondsFromIso(e.end).toString()) diff.push("end");
  return diff;
}

async function applyRegistered(q: Queryable, tenantId: string, d: Record<string, string>, at: EventPlace): Promise<void> {
  const id = d["engagementId"] ?? "";
  const meta = await repo.getMeta(q, tenantId, id, true);
  if (meta === null) {
    // Registered on chain without going through this kernel: never active here (it has no stored signed terms).
    await repo.recordFinding(q, tenantId, "ENGAGEMENT_UNKNOWN", "HIGH", key(at), { engagementId: id, txHash: at.txHash });
    return;
  }
  if (meta.status === "ACTIVE" && meta.registeredTx === at.txHash) return;
  if (meta.status === "CANCELLED" || meta.status === "CLOSED") return;
  if (meta.ownerSig === null || meta.payeeSig === null) {
    await repo.recordFinding(q, tenantId, "ENGAGEMENT_REGISTERED_WITHOUT_SIGNATURES", "MEDIUM", key(at), { engagementId: id, txHash: at.txHash });
    return;
  }
  const e = await base.loadEngagement(q, tenantId, id);
  if (e === null) return;
  const diff = registrationDiff(e, d);
  if (diff.length > 0) {
    await repo.setStatus(q, tenantId, id, "CANCELLED", ["DRAFT", "AWAITING_PAYEE", "REGISTERING", "ACTIVE"]);
    await repo.recordFinding(q, tenantId, "ENGAGEMENT_TERMS_MISMATCH", "HIGH", key(at), { engagementId: id, txHash: at.txHash, fields: diff.join(",") });
    return;
  }
  await repo.setActive(q, tenantId, id, at.txHash);
}

export async function applyEvent(q: Queryable, tenantId: string, ev: VaultEvent, at: EventPlace): Promise<void> {
  const d = eventData(ev);
  switch (ev.name) {
    case "EngagementRegistered":
      return applyRegistered(q, tenantId, d, at);
    case "EngagementClosed":
      await repo.setStatus(q, tenantId, ev.engagementId, "CLOSED", ["ACTIVE"]);
      return;
    case "PayeeChangeProposed": {
      const open = await repo.openChangeForNewPayee(q, tenantId, ev.engagementId, ev.newPayee);
      if (open === null) {
        await repo.recordFinding(q, tenantId, "PAYEE_CHANGE_NOT_FROM_KERNEL", "MEDIUM", key(at), { engagementId: ev.engagementId, txHash: at.txHash });
        return;
      }
      await repo.setPayeeChangeStatus(q, open.id, "PROPOSED", { proposedTx: at.txHash, etaEpoch: ev.eta, error: null });
      return;
    }
    case "PayeeChangeExecuted": {
      const meta = await repo.getMeta(q, tenantId, ev.engagementId, true);
      if (meta === null) {
        await repo.recordFinding(q, tenantId, "ENGAGEMENT_UNKNOWN", "HIGH", key(at), { engagementId: ev.engagementId, txHash: at.txHash });
        return;
      }
      if (same(meta.payee, ev.newPayee)) return; // already applied
      const changed = await repo.setPayee(q, tenantId, ev.engagementId, ev.newPayee, ev.oldPayee);
      if (changed === 0) {
        await repo.recordFinding(q, tenantId, "PAYEE_CHANGE_OLD_PAYEE_MISMATCH", "HIGH", key(at), { engagementId: ev.engagementId, txHash: at.txHash });
        return;
      }
      const open = await repo.openChangeForNewPayee(q, tenantId, ev.engagementId, ev.newPayee);
      if (open !== null) await repo.setPayeeChangeStatus(q, open.id, "EXECUTED", { executedTx: at.txHash, error: null });
      return;
    }
    case "VaultPaused":
      // A pause cancels every pending payee change on chain (WP-07 item 6); mirror it so no stale PROPOSED row lingers.
      await repo.cancelProposedChanges(q, tenantId);
      return;
    case "Released":
      await confirmReleased(q, tenantId, d, at); // CONFIRMED only when the event matches the signed attestation
      return;
    case "ConfigChanged":
    case "VaultUnpaused":
    case "KernelSignerProposed":
    case "KernelSignerRotated":
    case "GuardianChanged":
    case "Withdrawn":
    case "EIP712DomainChanged":
      return; // recorded in chain_events; other services (reconciler, certificates) read them
    default: {
      const unknown: never = ev;
      void unknown;
      throw new Error("unhandled vault event");
    }
  }
}

/** Reverse the effect of one reorged event. Called newest first. */
export async function undoEvent(q: Queryable, tenantId: string, ev: StoredChainEvent): Promise<void> {
  const d = ev.data;
  switch (ev.event) {
    case "EngagementRegistered":
      await repo.deactivate(q, tenantId, d["engagementId"] ?? "", ev.txHash);
      return;
    case "EngagementClosed":
      await q.query("update engagements set status = 'ACTIVE' where engagement_id = $1 and tenant_id = $2 and status = 'CLOSED' and registered_tx is not null", [d["engagementId"] ?? "", tenantId]);
      return;
    case "PayeeChangeProposed": {
      const c = await repo.changeByTx(q, tenantId, "proposed_tx", ev.txHash);
      if (c !== null) await repo.setPayeeChangeStatus(q, c.id, "SUBMITTED", { proposedTx: null, etaEpoch: null });
      return;
    }
    case "PayeeChangeExecuted": {
      await repo.setPayee(q, tenantId, d["engagementId"] ?? "", d["oldPayee"] ?? "", d["newPayee"] ?? "");
      const c = await repo.changeByTx(q, tenantId, "executed_tx", ev.txHash);
      if (c !== null) await repo.setPayeeChangeStatus(q, c.id, "PROPOSED", { executedTx: null });
      return;
    }
    case "Released":
      await unconfirmReleased(q, tenantId, ev.txHash);
      return;
    default:
      return; // other events have no row effects to reverse
  }
}

/**
 * Engagements with both signatures stored that are not ACTIVE yet, checked against already-confirmed registrations. Covers
 * the orders the log scan alone would miss (a registration indexed before the second signature was stored, or a block revived
 * after a reorg) without ever trusting anything but a CONFIRMED chain_events row.
 */
export async function activatePending(q: Queryable, tenantId: string): Promise<number> {
  let n = 0;
  for (const p of await repo.listPendingRegistrations(q, tenantId)) {
    const events = await repo.registeredEvents(q, tenantId, p.engagementId);
    const ev = events[0];
    if (ev === undefined) continue;
    await applyRegistered(q, tenantId, ev.data, { txHash: ev.txHash, logIndex: ev.logIndex, blockNumber: ev.blockNumber });
    n++;
  }
  return n;
}
