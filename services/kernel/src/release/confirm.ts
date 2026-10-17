// A release becomes CONFIRMED only from an indexed `Released` event that matches the stored attestation (docs/05 s6, docs/06 B.2,
// RT-30: K-15 trusts chain events, never a relayer answer or a webhook). Runs inside the indexer's transaction (apply.ts).
//
//   match      intentId has a releases row AND payee, amount, engagementId, receiptHash equal the signed attestation => CONFIRMED
//   mismatch   the vault paid something other than what this kernel signed for that intentId => HIGH finding, row untouched
//   unknown    the vault released an intentId this kernel has no release row for => HIGH finding (WP-15 trips the breaker on it)
import type { Queryable } from "../db/pool";
import { recordFinding } from "../engagement/repo";

interface EventPlace {
  readonly txHash: string;
  readonly logIndex: number;
}

const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

interface Row {
  release_id: string;
  status: string;
  attestation: { message: { payee: string; amount: string; engagementId: string; receiptHash: string } };
}

export type ConfirmOutcome = "CONFIRMED" | "ALREADY" | "MISMATCH" | "UNKNOWN";

/** The Released event data as stored in chain_events (see eventData in engagement/apply.ts). */
export async function confirmReleased(q: Queryable, tenantId: string, d: Record<string, string>, at: EventPlace): Promise<ConfirmOutcome> {
  const intentId = d["intentId"] ?? "";
  const r = await q.query<Row>(
    `select r.release_id, r.status, r.attestation from releases r
      where r.intent_id = $2 and exists (select 1 from intents i where i.intent_id = r.intent_id and i.tenant_id = $1) for update`,
    [tenantId, intentId],
  );
  const row = r.rows[0];
  const place = `${at.txHash}:${String(at.logIndex)}`;
  if (row === undefined) {
    await recordFinding(q, tenantId, "UNKNOWN_RELEASE", "HIGH", place, { intentId, txHash: at.txHash, payee: d["payee"] ?? "", amount: d["amount"] ?? "" });
    return "UNKNOWN";
  }
  const m = row.attestation.message;
  const diff: string[] = [];
  if (!same(d["payee"] ?? "", m.payee)) diff.push("payee");
  if (d["amount"] !== m.amount) diff.push("amount");
  if (!same(d["engagementId"] ?? "", m.engagementId)) diff.push("engagementId");
  if (!same(d["receiptHash"] ?? "", m.receiptHash)) diff.push("receiptHash");
  if (diff.length > 0) {
    await recordFinding(q, tenantId, "RELEASE_MISMATCH", "HIGH", place, { intentId, txHash: at.txHash, fields: diff.join(",") });
    return "MISMATCH";
  }
  if (row.status === "CONFIRMED") return "ALREADY";
  await q.query("update releases set status = 'CONFIRMED', tx_hash = $2, confirmed_at = now(), error = null, updated_at = now() where release_id = $1", [row.release_id, at.txHash]);
  await syncMilestonePaid(q, row.release_id);
  return "CONFIRMED";
}

// The milestone's gross amount covered by CONFIRMED releases (the same gross K-04 reads from RELEASE decisions).
const CONFIRMED_GROSS = `(select coalesce(sum(d2.amount_base_units), 0) from decisions d2 join releases r2 on r2.decision_id = d2.decision_id
                           where d2.milestone_id = m.milestone_id and d2.verdict = 'RELEASE' and r2.status = 'CONFIRMED')`;

/**
 * A milestone becomes PAID only from CONFIRMED releases (chain events, never a relayer answer): an all-or-nothing milestone after its
 * first confirmed release, a `partialAllowed` one once the confirmed gross amounts cover the milestone amount (the reading K-04 uses,
 * docs/04). K-05 then rejects any further release and `sequential` engagements may move to the next milestone.
 */
export async function syncMilestonePaid(q: Queryable, releaseId: string): Promise<void> {
  await q.query(
    `update milestones m set status = 'PAID'
      where m.milestone_id = (select d.milestone_id from decisions d join releases r on r.decision_id = d.decision_id where r.release_id = $1)
        and m.status in ('PENDING', 'EVIDENCE_OK')
        and (not m.partial_allowed or ${CONFIRMED_GROSS} >= m.amount_base_units)`,
    [releaseId],
  );
}

/** A reorged release no longer covers its milestone: PAID goes back to PENDING (evidence is re-collected before any new release). */
async function unpayMilestones(q: Queryable, tenantId: string, txHash: string): Promise<void> {
  await q.query(
    `update milestones m set status = 'PENDING'
      where m.status = 'PAID'
        and m.milestone_id in (select d.milestone_id from decisions d join releases r on r.decision_id = d.decision_id
                                where d.tenant_id = $1 and r.tx_hash = $2)
        and (not m.partial_allowed or ${CONFIRMED_GROSS} < m.amount_base_units)
        and (m.partial_allowed or not exists (select 1 from decisions d3 join releases r3 on r3.decision_id = d3.decision_id
                                                where d3.milestone_id = m.milestone_id and d3.verdict = 'RELEASE' and r3.status = 'CONFIRMED'))`,
    [tenantId, txHash],
  );
}

/** A reorged `Released` log: the confirmation it gave is withdrawn; the row goes back to SUBMITTED (the reconciler re-checks it). */
export async function unconfirmReleased(q: Queryable, tenantId: string, txHash: string): Promise<void> {
  await q.query(
    "update releases set status = 'SUBMITTED', confirmed_at = null, updated_at = now() where tenant_id = $1 and tx_hash = $2 and status = 'CONFIRMED'",
    [tenantId, txHash],
  );
  await unpayMilestones(q, tenantId, txHash);
}
