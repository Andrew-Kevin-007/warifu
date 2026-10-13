// SQL for the release path (WP-14, migration 0007). Every statement is parameterised and tenant scoped. One `releases` row per
// intent (unique, deferrable: so no ON CONFLICT; callers hold the tenant decision lock and select-then-write).
import { Hex32Schema } from "@symbolon/schemas";
import type { Hex32, ISODateTime } from "@symbolon/schemas";
import type { Queryable } from "../db/pool";
import { toIsoSeconds } from "../time";

export type ReleaseStatus = "QUEUED" | "SUBMITTED" | "CONFIRMED" | "FAILED";

/** docs/02 s6: after N=3 failed attempts nothing more is sent (a finding is raised for a human). */
export const MAX_RELEASE_ATTEMPTS = 3;

/** What `releases.attestation` holds: everything needed to re-send the SAME signed message after a crash. */
export interface StoredAttestation {
  readonly message: {
    readonly intentId: Hex32;
    readonly engagementId: Hex32;
    readonly milestoneId: Hex32;
    readonly payee: string;
    readonly amount: string;
    readonly receiptHash: Hex32;
    readonly deadline: string;
  };
  readonly digest: Hex32;
  readonly kernelSig: `0x${string}`;
  readonly signer: string;
  /** null at or below the vault's humanThreshold. */
  readonly ownerApproval: { readonly receiptHash: Hex32; readonly deadline: string; readonly signature: `0x${string}` } | null;
  /** contextHash of the fresh re-evaluation at payAt that made this attestation (the TOCTOU record). */
  readonly reevaluationContextHash: Hex32 | null;
  readonly reevaluatedAt: ISODateTime;
}

export interface ReleaseRow {
  readonly releaseId: string;
  readonly tenantId: string | null;
  readonly decisionId: string;
  readonly intentId: Hex32;
  readonly status: ReleaseStatus;
  readonly attestation: StoredAttestation;
  readonly txHash: Hex32 | null;
  readonly circleTxId: string | null;
  readonly error: string | null;
  readonly attempts: number;
  readonly deadline: ISODateTime | null;
  readonly nextAttemptAt: ISODateTime | null;
  readonly submittedAt: ISODateTime | null;
}

interface RawRelease {
  release_id: string;
  tenant_id: string | null;
  decision_id: string;
  intent_id: string;
  status: ReleaseStatus;
  attestation: StoredAttestation;
  tx_hash: string | null;
  circle_tx_id: string | null;
  error: string | null;
  attempts: number;
  deadline: string | null;
  next_attempt_at: string | null;
  submitted_at: string | null;
}

const COLS = "release_id, tenant_id, decision_id, intent_id, status, attestation, tx_hash, circle_tx_id, error, attempts, deadline, next_attempt_at, submitted_at";

function map(r: RawRelease): ReleaseRow {
  return {
    releaseId: r.release_id,
    tenantId: r.tenant_id,
    decisionId: r.decision_id,
    intentId: Hex32Schema.parse(r.intent_id),
    status: r.status,
    attestation: r.attestation,
    txHash: r.tx_hash === null ? null : Hex32Schema.parse(r.tx_hash),
    circleTxId: r.circle_tx_id,
    error: r.error,
    attempts: r.attempts,
    deadline: r.deadline === null ? null : toIsoSeconds(r.deadline),
    nextAttemptAt: r.next_attempt_at === null ? null : toIsoSeconds(r.next_attempt_at),
    submittedAt: r.submitted_at === null ? null : toIsoSeconds(r.submitted_at),
  };
}

export async function releaseForIntent(q: Queryable, tenantId: string, intentId: string): Promise<ReleaseRow | null> {
  const r = await q.query<RawRelease>(
    `select ${COLS} from releases r where r.intent_id = $2 and exists (select 1 from intents i where i.intent_id = r.intent_id and i.tenant_id = $1)`,
    [tenantId, intentId],
  );
  const row = r.rows[0];
  return row === undefined ? null : map(row);
}

export async function releasesByStatus(q: Queryable, tenantId: string, status: ReleaseStatus): Promise<ReleaseRow[]> {
  const r = await q.query<RawRelease>(`select ${COLS} from releases where tenant_id = $1 and status = $2 order by release_id`, [tenantId, status]);
  return r.rows.map(map);
}

/**
 * RELEASE heads of this tenant whose payAt has come, that are not already on their way: no release row, or a FAILED one that
 * may be retried (attempts below the limit, back-off elapsed). The decision being the HEAD of its supersedes chain is what makes
 * it current: a superseded RELEASE (by a TOCTOU HOLD, an approval, a plan selection) is never processed.
 */
export async function dueReleases(q: Queryable, tenantId: string, now: ISODateTime, limit: number): Promise<Array<{ decisionId: string; intentId: Hex32 }>> {
  const r = await q.query<{ decision_id: string; intent_id: string }>(
    `select d.decision_id, d.intent_id
       from decisions d
      where d.tenant_id = $1 and d.verdict = 'RELEASE' and d.pay_at is not null and d.pay_at <= $2::timestamptz
        and not exists (select 1 from decisions s where s.supersedes = d.decision_id)
        and not exists (
          select 1 from releases x where x.intent_id = d.intent_id
             and not (x.status = 'FAILED' and x.attempts < $3 and (x.next_attempt_at is null or x.next_attempt_at <= $2::timestamptz)))
      order by d.pay_at, d.decision_id
      limit $4`,
    [tenantId, now, MAX_RELEASE_ATTEMPTS, limit],
  );
  return r.rows.map((x) => ({ decisionId: x.decision_id, intentId: Hex32Schema.parse(x.intent_id) }));
}

/** Claim: write the signed attestation as QUEUED (new row, or the FAILED row of an earlier attempt). Caller holds the tenant lock. */
export async function queueRelease(
  q: Queryable,
  i: { tenantId: string; decisionId: string; intentId: Hex32; attestation: StoredAttestation; deadline: ISODateTime },
): Promise<ReleaseRow> {
  const existing = await q.query<{ release_id: string; status: string }>("select release_id, status from releases where intent_id = $1 for update", [i.intentId]);
  const prior = existing.rows[0];
  let r;
  if (prior === undefined) {
    r = await q.query<RawRelease>(
      `insert into releases (tenant_id, decision_id, intent_id, status, attestation, deadline, attempts, updated_at)
       values ($1, $2, $3, 'QUEUED', $4::jsonb, $5::timestamptz, 1, now()) returning ${COLS}`,
      [i.tenantId, i.decisionId, i.intentId, JSON.stringify(i.attestation), i.deadline],
    );
  } else {
    if (prior.status !== "FAILED") throw new Error("a release for this intent is already queued, submitted or confirmed");
    r = await q.query<RawRelease>(
      `update releases set tenant_id = $1, decision_id = $2, status = 'QUEUED', attestation = $4::jsonb, deadline = $5::timestamptz,
              attempts = attempts + 1, tx_hash = null, circle_tx_id = null, error = null, next_attempt_at = null, submitted_at = null, updated_at = now()
        where release_id = $3 returning ${COLS}`,
      [i.tenantId, i.decisionId, prior.release_id, JSON.stringify(i.attestation), i.deadline],
    );
  }
  const row = r.rows[0];
  if (row === undefined) throw new Error("release claim wrote no row");
  return map(row);
}

/**
 * Take the send lease of a QUEUED row: true for exactly one caller until `until`. Two schedulers (or a retry racing a slow send)
 * cannot both relay the same attestation. A crashed sender's lease simply runs out, and the SAME signed attestation is re-sent
 * (the vault's used[intentId] and Circle's call-derived idempotency key are the backstops).
 */
export async function leaseQueued(q: Queryable, releaseId: string, now: ISODateTime, until: ISODateTime): Promise<boolean> {
  const r = await q.query(
    `update releases set next_attempt_at = $3::timestamptz, updated_at = now()
      where release_id = $1 and status = 'QUEUED' and (next_attempt_at is null or next_attempt_at <= $2::timestamptz) returning release_id`,
    [releaseId, now, until],
  );
  return r.rows.length === 1;
}

export async function markSubmitted(q: Queryable, releaseId: string, txHash: Hex32, at: ISODateTime): Promise<void> {
  await q.query(
    "update releases set status = 'SUBMITTED', tx_hash = $2, submitted_at = $3::timestamptz, error = null, updated_at = now() where release_id = $1 and status in ('QUEUED','SUBMITTED')",
    [releaseId, txHash, at],
  );
}

/** A failed attempt. `nextAttemptAt` null = retry on the next tick (when attempts allow). Error is a bounded code, never prose. */
export async function markFailed(q: Queryable, releaseId: string, error: string, nextAttemptAt: ISODateTime | null): Promise<void> {
  await q.query(
    "update releases set status = 'FAILED', error = $2, next_attempt_at = $3::timestamptz, updated_at = now() where release_id = $1 and status in ('QUEUED','SUBMITTED')",
    [releaseId, error.replace(/[^A-Za-z0-9_:. -]/g, "_").slice(0, 200), nextAttemptAt],
  );
}

/** Keep the row QUEUED (relay outcome unknown, e.g. Circle has not reported a hash yet) and note why. */
export async function noteQueued(q: Queryable, releaseId: string, error: string): Promise<void> {
  await q.query("update releases set error = $2, updated_at = now() where release_id = $1 and status = 'QUEUED'", [releaseId, error.replace(/[^A-Za-z0-9_:. -]/g, "_").slice(0, 200)]);
}

// --- approvals ----------------------------------------------------------------------------------------------------------------

export interface ApprovalRow {
  readonly approvalId: string;
  readonly intentId: Hex32;
  readonly receiptHash: Hex32;
  readonly decisionId: string;
  readonly amount: string;
  readonly deadline: string;
  readonly signature: `0x${string}`;
  readonly signer: string;
}

export async function insertApproval(
  q: Queryable,
  a: { tenantId: string; intentId: Hex32; receiptHash: Hex32; decisionId: string; signer: string; amount: string; deadline: string; signature: string },
): Promise<void> {
  await q.query(
    `insert into approvals (tenant_id, intent_id, receipt_hash, decision_id, signer, amount_base_units, deadline, signature, verified)
     select $1, $2, $3, $4, $5, $6, $7::bigint, $8, true
      where not exists (select 1 from approvals where intent_id = $2 and signature = $8)`,
    [a.tenantId, a.intentId, a.receiptHash, a.decisionId, a.signer, a.amount, a.deadline, a.signature],
  );
}

/** The newest verified approval of this intent whose escalation decision is in the intent's supersedes chain ending at `headId`. */
export async function approvalInChain(q: Queryable, tenantId: string, intentId: string, headId: string): Promise<ApprovalRow | null> {
  const r = await q.query<{ approval_id: string; intent_id: string; receipt_hash: string; decision_id: string; amount: string; deadline: string; signature: string; signer: string }>(
    `with recursive chain(decision_id, supersedes) as (
       select decision_id, supersedes from decisions where decision_id = $3 and tenant_id = $1 and intent_id = $2
       union all
       select d.decision_id, d.supersedes from decisions d join chain c on d.decision_id = c.supersedes where d.tenant_id = $1 and d.intent_id = $2
     )
     select a.approval_id, a.intent_id, a.receipt_hash, a.decision_id::text as decision_id, a.amount_base_units::text as amount, a.deadline::text as deadline, a.signature, a.signer
       from approvals a
       join chain c on c.decision_id = a.decision_id
       join receipts r on r.decision_id = a.decision_id and r.receipt_hash = a.receipt_hash
      where a.tenant_id = $1 and a.intent_id = $2 and a.verified
      order by a.created_at desc, a.approval_id desc
      limit 1`,
    [tenantId, intentId, headId],
  );
  const x = r.rows[0];
  if (x === undefined) return null;
  return {
    approvalId: x.approval_id,
    intentId: Hex32Schema.parse(x.intent_id),
    receiptHash: Hex32Schema.parse(x.receipt_hash),
    decisionId: x.decision_id,
    amount: x.amount,
    deadline: x.deadline,
    signature: x.signature as `0x${string}`,
    signer: x.signer,
  };
}

// --- plan offers ----------------------------------------------------------------------------------------------------------------

export async function recordPlanOffer(q: Queryable, tenantId: string, intentId: string, asOf: ISODateTime, planIds: readonly string[]): Promise<void> {
  await q.query("insert into plan_offers (tenant_id, intent_id, as_of, plan_ids) values ($1, $2, $3::timestamptz, $4::text[])", [tenantId, intentId, asOf, [...planIds]]);
}

/** The newest offer (not older than `notBefore`) that contained `planId`: its as_of is the selection's planningAsOf. */
export async function offerContaining(q: Queryable, tenantId: string, intentId: string, planId: string, notBefore: ISODateTime): Promise<ISODateTime | null> {
  const r = await q.query<{ as_of: string }>(
    `select as_of from plan_offers where tenant_id = $1 and intent_id = $2 and $3 = any(plan_ids) and as_of >= $4::timestamptz
      order by as_of desc, id desc limit 1`,
    [tenantId, intentId, planId, notBefore],
  );
  const x = r.rows[0];
  return x === undefined ? null : toIsoSeconds(x.as_of);
}

// --- HOLD re-checks -------------------------------------------------------------------------------------------------------------

/** HOLD heads of this tenant not re-checked since `before` (oldest check first). */
export async function holdsToRecheck(q: Queryable, tenantId: string, before: ISODateTime, limit: number, milestoneId: string | null = null): Promise<Array<{ decisionId: string; intentId: Hex32 }>> {
  const r = await q.query<{ decision_id: string; intent_id: string }>(
    `select d.decision_id, d.intent_id
       from decisions d left join decision_rechecks c on c.decision_id = d.decision_id
      where d.tenant_id = $1 and d.verdict = 'HOLD'
        and not exists (select 1 from decisions s where s.supersedes = d.decision_id)
        and ($4::text is null or d.milestone_id = $4)
        and ($4::text is not null or coalesce(c.checked_at, d.created_at) <= $2::timestamptz)
      order by coalesce(c.checked_at, d.created_at), d.decision_id
      limit $3`,
    [tenantId, before, limit, milestoneId],
  );
  return r.rows.map((x) => ({ decisionId: x.decision_id, intentId: Hex32Schema.parse(x.intent_id) }));
}

export async function markRechecked(q: Queryable, tenantId: string, decisionId: string, at: ISODateTime): Promise<void> {
  await q.query(
    `insert into decision_rechecks (decision_id, tenant_id, checked_at) values ($1, $2, $3::timestamptz)
     on conflict (decision_id) do update set checked_at = excluded.checked_at, checks = decision_rechecks.checks + 1`,
    [decisionId, tenantId, at],
  );
}

export async function tenantsWithVault(q: Queryable, chainId: number): Promise<string[]> {
  const r = await q.query<{ id: string }>("select id from tenants where vault_address is not null and chain_id = $1 order by created_at, id", [chainId]);
  return r.rows.map((x) => x.id);
}
