// SQL for the reconciler and the breaker (WP-15, migration 0008). Every statement is parameterised and tenant scoped. Amounts are
// numeric strings (never JS numbers, INV-10).
import { Hex32Schema } from "@symbolon/schemas";
import type { Hex32, ISODateTime } from "@symbolon/schemas";
import type { Queryable } from "../db/pool";
import { toIsoSeconds } from "../time";

export type Severity = "LOW" | "MEDIUM" | "HIGH";

export interface FindingRow {
  readonly id: string;
  readonly kind: string;
  readonly severity: Severity;
  readonly resolved: boolean;
  readonly detail: Record<string, string | number | boolean | null>;
  readonly createdAt: ISODateTime;
}

/** Record a finding once per (tenant, kind, dedupeKey). Returns the new row's id, or null when it already existed. */
export async function insertFinding(
  q: Queryable,
  tenantId: string,
  kind: string,
  severity: Severity,
  dedupeKey: string,
  detail: Record<string, string | number | boolean | null>,
  decisionId: string | null = null,
): Promise<string | null> {
  const r = await q.query<{ id: string }>(
    `insert into reconciliations (tenant_id, kind, severity, decision_id, detail) values ($1,$2,$3,$4,$5::jsonb)
     on conflict (tenant_id, kind, ((detail ->> 'dedupeKey'))) where (detail ->> 'dedupeKey') is not null do nothing returning id`,
    [tenantId, kind, severity, decisionId, JSON.stringify({ ...detail, dedupeKey })],
  );
  return r.rows[0]?.id ?? null;
}

interface RawFinding {
  id: string;
  kind: string;
  severity: Severity;
  resolved: boolean;
  detail: Record<string, string | number | boolean | null>;
  created_at: string;
}
const mapFinding = (x: RawFinding): FindingRow => ({ id: x.id, kind: x.kind, severity: x.severity, resolved: x.resolved, detail: x.detail, createdAt: toIsoSeconds(x.created_at) });

export async function unresolvedHigh(q: Queryable, tenantId: string): Promise<FindingRow[]> {
  const r = await q.query<RawFinding>(
    "select id, kind, severity, resolved, detail, created_at from reconciliations where tenant_id = $1 and severity = 'HIGH' and not resolved order by created_at, id",
    [tenantId],
  );
  return r.rows.map(mapFinding);
}

export async function recentFindings(q: Queryable, tenantId: string, limit: number): Promise<FindingRow[]> {
  const r = await q.query<RawFinding>(
    "select id, kind, severity, resolved, detail, created_at from reconciliations where tenant_id = $1 order by created_at desc, id desc limit $2",
    [tenantId, limit],
  );
  return r.rows.map(mapFinding);
}

/** The owner acknowledged every open finding of this halt. Returns how many were closed. */
export async function resolveOpenFindings(q: Queryable, tenantId: string, by: string): Promise<number> {
  const r = await q.query("update reconciliations set resolved = true, resolved_at = now(), resolved_by = $2 where tenant_id = $1 and not resolved", [tenantId, by.slice(0, 64)]);
  return r.rowCount;
}

// --- breaker ---------------------------------------------------------------------------------------------------------------------

export interface BreakerRow {
  readonly halted: boolean;
  readonly reason: string | null;
  /** epoch seconds of the start of the current halt (null when not halted). */
  readonly since: bigint | null;
  readonly findingId: string | null;
  readonly pauseTx: Hex32 | null;
  readonly pauseError: string | null;
}

export async function loadBreakerRow(q: Queryable, tenantId: string): Promise<BreakerRow> {
  const r = await q.query<{ halted: boolean; reason: string | null; since: string | null; finding_id: string | null; pause_tx: string | null; pause_error: string | null; since_epoch: string | null }>(
    `select halted, reason, since, finding_id, pause_tx, pause_error, floor(extract(epoch from since))::text as since_epoch
       from breaker_state where tenant_id = $1`,
    [tenantId],
  );
  const x = r.rows[0];
  if (x === undefined) return { halted: false, reason: null, since: null, findingId: null, pauseTx: null, pauseError: null };
  return {
    halted: x.halted,
    reason: x.reason,
    since: x.halted && x.since_epoch !== null ? BigInt(x.since_epoch) : null,
    findingId: x.finding_id,
    pauseTx: x.pause_tx === null ? null : Hex32Schema.parse(x.pause_tx),
    pauseError: x.pause_error,
  };
}

/** Halt. Idempotent: an already-halted breaker keeps its original `since`, reason and finding. Returns true when this call tripped it. */
export async function tripBreakerRow(q: Queryable, tenantId: string, reason: string, findingId: string | null): Promise<boolean> {
  const r = await q.query(
    `insert into breaker_state (tenant_id, halted, reason, since, finding_id) values ($1, true, $2, now(), $3)
     on conflict (tenant_id) do update
        set halted = true, reason = excluded.reason, since = now(), finding_id = excluded.finding_id, pause_tx = null, pause_error = null,
            resolved_by = null, resolved_at = null, resolved_reason = null
      where not breaker_state.halted
     returning tenant_id`,
    [tenantId, reason.slice(0, 200), findingId],
  );
  return r.rowCount === 1;
}

export async function notePause(q: Queryable, tenantId: string, txHash: string | null, error: string | null): Promise<void> {
  await q.query("update breaker_state set pause_tx = coalesce($2, pause_tx), pause_error = $3 where tenant_id = $1", [
    tenantId,
    txHash,
    error === null ? null : error.replace(/[^A-Za-z0-9_:. -]/g, "_").slice(0, 200),
  ]);
}

export async function clearBreakerRow(q: Queryable, tenantId: string, by: string, reason: string): Promise<void> {
  await q.query(
    "update breaker_state set halted = false, resolved_by = $2, resolved_at = now(), resolved_reason = $3 where tenant_id = $1",
    [tenantId, by.slice(0, 64), reason.slice(0, 200)],
  );
}

// --- release / event comparison ------------------------------------------------------------------------------------------------

export interface SubmittedRelease {
  readonly intentId: Hex32;
  readonly txHash: Hex32 | null;
  readonly submittedAt: ISODateTime;
}

export async function submittedReleases(q: Queryable, tenantId: string): Promise<SubmittedRelease[]> {
  const r = await q.query<{ intent_id: string; tx_hash: string | null; submitted_at: string }>(
    "select intent_id, tx_hash, submitted_at from releases where tenant_id = $1 and status = 'SUBMITTED' and submitted_at is not null order by submitted_at",
    [tenantId],
  );
  return r.rows.map((x) => ({ intentId: Hex32Schema.parse(x.intent_id), txHash: x.tx_hash === null ? null : Hex32Schema.parse(x.tx_hash), submittedAt: toIsoSeconds(x.submitted_at) }));
}

export interface ReleasedEvent {
  readonly txHash: string;
  readonly logIndex: number;
  readonly blockNumber: bigint;
  readonly intentId: string;
  readonly payee: string;
  readonly amount: string;
  readonly engagementId: string;
  readonly receiptHash: string;
}

export async function releasedEvents(q: Queryable, tenantId: string): Promise<ReleasedEvent[]> {
  const r = await q.query<{ tx_hash: string; log_index: number; block_number: string; data: Record<string, string> }>(
    "select tx_hash, log_index, block_number::text as block_number, data from chain_events where tenant_id = $1 and event = 'Released' and status = 'CONFIRMED' order by block_number, log_index",
    [tenantId],
  );
  return r.rows.map((x) => ({
    txHash: x.tx_hash,
    logIndex: x.log_index,
    blockNumber: BigInt(x.block_number),
    intentId: x.data["intentId"] ?? "",
    payee: x.data["payee"] ?? "",
    amount: x.data["amount"] ?? "",
    engagementId: x.data["engagementId"] ?? "",
    receiptHash: x.data["receiptHash"] ?? "",
  }));
}

export interface ReleaseAttestationRow {
  readonly intentId: string;
  readonly payee: string;
  readonly amount: string;
  readonly engagementId: string;
  readonly receiptHash: string;
}

export async function releaseAttestations(q: Queryable, tenantId: string): Promise<Map<string, ReleaseAttestationRow>> {
  const r = await q.query<{ intent_id: string; attestation: { message: { payee: string; amount: string; engagementId: string; receiptHash: string } } }>(
    "select intent_id, attestation from releases where tenant_id = $1",
    [tenantId],
  );
  return new Map(r.rows.map((x) => [x.intent_id, { intentId: x.intent_id, ...x.attestation.message }]));
}

/** Σ amount of CONFIRMED Released and Withdrawn events up to and including `throughBlock`. */
export async function outflowsThrough(q: Queryable, tenantId: string, throughBlock: bigint): Promise<bigint> {
  const r = await q.query<{ total: string }>(
    `select coalesce(sum((data ->> 'amount')::numeric), 0)::text as total from chain_events
      where tenant_id = $1 and event in ('Released', 'Withdrawn') and status = 'CONFIRMED' and block_number <= $2`,
    [tenantId, throughBlock.toString()],
  );
  return BigInt(r.rows[0]?.total ?? "0");
}

/** The indexer's next block to scan for this tenant (everything before it is applied); null before the first run. */
export async function indexerNextBlock(q: Queryable, tenantId: string): Promise<bigint | null> {
  const r = await q.query<{ next_block: string }>("select next_block::text as next_block from chain_cursors where tenant_id = $1", [tenantId]);
  const x = r.rows[0];
  return x === undefined ? null : BigInt(x.next_block);
}

export interface LedgerState {
  readonly vault: string;
  readonly token: string;
  readonly scannedThrough: bigint;
  readonly deposits: bigint;
}

export async function loadLedger(q: Queryable, tenantId: string): Promise<LedgerState | null> {
  const r = await q.query<{ vault_address: string; token_address: string; scanned_through: string; deposits: string }>(
    "select vault_address, token_address, scanned_through::text as scanned_through, deposits_base_units::text as deposits from reconciler_ledger where tenant_id = $1",
    [tenantId],
  );
  const x = r.rows[0];
  return x === undefined ? null : { vault: x.vault_address, token: x.token_address, scannedThrough: BigInt(x.scanned_through), deposits: BigInt(x.deposits) };
}

export async function saveLedger(q: Queryable, tenantId: string, s: LedgerState): Promise<void> {
  await q.query(
    `insert into reconciler_ledger (tenant_id, vault_address, token_address, scanned_through, deposits_base_units, updated_at)
     values ($1, $2, $3, $4, $5, now())
     on conflict (tenant_id) do update set vault_address = excluded.vault_address, token_address = excluded.token_address,
        scanned_through = excluded.scanned_through, deposits_base_units = excluded.deposits_base_units, updated_at = now()`,
    [tenantId, s.vault, s.token, s.scannedThrough.toString(), s.deposits.toString()],
  );
}

/** Decisions that ended in KERNEL_ERROR (a required check threw) within the window: K-16's exception rate. */
export async function kernelErrorCount(q: Queryable, tenantId: string, since: ISODateTime): Promise<number> {
  const r = await q.query<{ n: string }>(
    "select count(*)::text as n from decisions where tenant_id = $1 and 'KERNEL_ERROR' = any(reasons) and created_at >= $2::timestamptz",
    [tenantId, since],
  );
  return Number.parseInt(r.rows[0]?.n ?? "0", 10);
}

export async function tenantsWithVault(q: Queryable, chainId: number): Promise<Array<{ tenantId: string; vault: string; owner: string }>> {
  const r = await q.query<{ id: string; vault_address: string; owner_address: string }>(
    "select id, vault_address, owner_address from tenants where vault_address is not null and chain_id = $1 order by created_at, id",
    [chainId],
  );
  return r.rows.map((x) => ({ tenantId: x.id, vault: x.vault_address, owner: x.owner_address }));
}
