// SQL for the engagement service (WP-12). Parameterised only; every statement that touches tenant data carries the tenant
// id; numeric(40,0) columns travel as text and become bigint in code (INV-10).
import { termsPreimage } from "@symbolon/schemas";
import type { Engagement } from "@symbolon/schemas";
import type { Queryable } from "../db/pool";

// --- engagements ----------------------------------------------------------------------------------------------------------

export interface EngagementMeta {
  readonly status: string;
  readonly ownerSig: string | null;
  readonly payeeSig: string | null;
  readonly termsHash: string;
  readonly submittedTx: string | null;
  readonly registeredTx: string | null;
  readonly registrationError: string | null;
  readonly registrationAttempts: number;
  readonly payee: string;
}

interface MetaRow {
  status: string;
  owner_sig: string | null;
  payee_sig: string | null;
  terms_hash: string;
  submitted_tx: string | null;
  registered_tx: string | null;
  registration_error: string | null;
  registration_attempts: number;
  payee: string;
}

const mapMeta = (r: MetaRow): EngagementMeta => ({
  status: r.status,
  ownerSig: r.owner_sig,
  payeeSig: r.payee_sig,
  termsHash: r.terms_hash,
  submittedTx: r.submitted_tx,
  registeredTx: r.registered_tx,
  registrationError: r.registration_error,
  registrationAttempts: r.registration_attempts,
  payee: r.payee,
});

const META_COLUMNS = "status, owner_sig, payee_sig, terms_hash, submitted_tx, registered_tx, registration_error, registration_attempts, payee";

export async function getMeta(q: Queryable, tenantId: string, engagementId: string, lock = false): Promise<EngagementMeta | null> {
  const r = await q.query<MetaRow>(`select ${META_COLUMNS} from engagements where engagement_id = $1 and tenant_id = $2${lock ? " for update" : ""}`, [engagementId, tenantId]);
  const row = r.rows[0];
  return row === undefined ? null : mapMeta(row);
}

/** Insert a DRAFT engagement and its milestones. The stored `terms` is exactly the termsHash preimage. */
export async function insertDraft(q: Queryable, e: Engagement): Promise<void> {
  await q.query(
    `insert into engagements (engagement_id, tenant_id, owner, payee, payee_label, currency, currency_decimals, cap_base_units, start_at, end_at,
                              sequential, terms, terms_hash, owner_sig, payee_sig, nonce, status, registered_tx)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9::timestamptz,$10::timestamptz,$11,$12::jsonb,$13,null,null,$14,'DRAFT',null)`,
    [
      e.engagementId, e.tenantId, e.owner, e.payee, e.payeeLabel, e.currency, e.currencyDecimals, e.capBaseUnits, e.start, e.end,
      e.sequential, JSON.stringify(termsPreimage(e)), e.termsHash, e.nonce,
    ],
  );
  for (const m of e.milestones) {
    await q.query(
      `insert into milestones (milestone_id, engagement_id, slug, description, amount_base_units, partial_allowed, immediate, due_date, category, evidence_spec, status)
       values ($1,$2,$3,$4,$5,$6,$7,$8::timestamptz,$9,$10::jsonb,'PENDING')`,
      [m.milestoneId, e.engagementId, m.slug, m.description, m.amountBaseUnits, m.partialAllowed, m.immediate, m.dueDate, m.category, JSON.stringify(m.evidenceSpec)],
    );
  }
}

export async function storeSignature(q: Queryable, tenantId: string, engagementId: string, role: "owner" | "payee", signature: string, status: string): Promise<void> {
  const col = role === "owner" ? "owner_sig" : "payee_sig";
  await q.query(`update engagements set ${col} = $3, status = $4 where engagement_id = $1 and tenant_id = $2`, [engagementId, tenantId, signature, status]);
}

export async function markSubmitted(q: Queryable, tenantId: string, engagementId: string, txHash: string): Promise<void> {
  await q.query(
    "update engagements set submitted_tx = $3, submitted_at = now(), registration_error = null, registration_attempts = registration_attempts + 1 where engagement_id = $1 and tenant_id = $2",
    [engagementId, tenantId, txHash],
  );
}

export async function markRelayFailed(q: Queryable, tenantId: string, engagementId: string, errorCode: string): Promise<void> {
  await q.query(
    "update engagements set registration_error = $3, registration_attempts = registration_attempts + 1 where engagement_id = $1 and tenant_id = $2",
    [engagementId, tenantId, errorCode.slice(0, 200)],
  );
}

/** The submitted tx is known not to have registered (reverted or replaced): allow a fresh relay. */
export async function clearSubmission(q: Queryable, tenantId: string, engagementId: string, errorCode: string): Promise<void> {
  await q.query("update engagements set submitted_tx = null, submitted_at = null, registration_error = $3 where engagement_id = $1 and tenant_id = $2", [engagementId, tenantId, errorCode.slice(0, 200)]);
}

/** ACTIVE is written here and only here (called by the indexer after a confirmed, matching EngagementRegistered). */
export async function setActive(q: Queryable, tenantId: string, engagementId: string, txHash: string): Promise<void> {
  await q.query(
    "update engagements set status = 'ACTIVE', registered_tx = $3, registration_error = null where engagement_id = $1 and tenant_id = $2 and owner_sig is not null and payee_sig is not null",
    [engagementId, tenantId, txHash],
  );
}

export async function setStatus(q: Queryable, tenantId: string, engagementId: string, status: string, onlyFrom: readonly string[]): Promise<number> {
  const r = await q.query("update engagements set status = $3 where engagement_id = $1 and tenant_id = $2 and status = any($4::text[])", [engagementId, tenantId, status, [...onlyFrom]]);
  return r.rowCount;
}

/** Undo an activation whose block was reorged: not ACTIVE any more, no registration tx. */
export async function deactivate(q: Queryable, tenantId: string, engagementId: string, txHash: string): Promise<void> {
  await q.query(
    "update engagements set status = 'REGISTERING', registered_tx = null where engagement_id = $1 and tenant_id = $2 and status = 'ACTIVE' and registered_tx = $3",
    [engagementId, tenantId, txHash],
  );
}

export async function setPayee(q: Queryable, tenantId: string, engagementId: string, newPayee: string, expectedCurrent: string): Promise<number> {
  const r = await q.query("update engagements set payee = $3 where engagement_id = $1 and tenant_id = $2 and lower(payee) = lower($4)", [engagementId, tenantId, newPayee, expectedCurrent]);
  return r.rowCount;
}

/** Engagements waiting for the chain: both signatures stored, not yet ACTIVE. */
export async function listPendingRegistrations(q: Queryable, tenantId: string): Promise<Array<{ engagementId: string; submittedTx: string | null; status: string; submittedAgeSeconds: number | null }>> {
  const r = await q.query<{ engagement_id: string; submitted_tx: string | null; status: string; age: number | null }>(
    "select engagement_id, submitted_tx, status, extract(epoch from now() - submitted_at)::int as age from engagements where tenant_id = $1 and status in ('DRAFT','AWAITING_PAYEE','REGISTERING') and owner_sig is not null and payee_sig is not null order by created_at",
    [tenantId],
  );
  return r.rows.map((x) => ({ engagementId: x.engagement_id, submittedTx: x.submitted_tx, status: x.status, submittedAgeSeconds: x.age }));
}

// --- chain_events and the cursor ---------------------------------------------------------------------------------------------

export interface ChainEventInput {
  readonly tenantId: string;
  readonly event: string;
  readonly txHash: string;
  readonly logIndex: number;
  readonly blockNumber: bigint;
  readonly blockHash: string;
  readonly data: Record<string, string>;
}

export type RecordOutcome = "NEW" | "SAME" | "CHANGED";

/**
 * Idempotent on (tx_hash, log_index). The same log read again from the same block is SAME (nothing to do). The same tx
 * seen in a different block (it was mined again after a reorg) revives the row (CHANGED). A row of ANOTHER tenant under
 * the same key is a hard error: a log belongs to exactly one vault.
 */
export async function recordChainEvent(q: Queryable, e: ChainEventInput): Promise<RecordOutcome> {
  const existing = await q.query<{ tenant_id: string; block_hash: string | null; status: string }>(
    "select tenant_id, block_hash, status from chain_events where tx_hash = $1 and log_index = $2 for update",
    [e.txHash, e.logIndex],
  );
  const row = existing.rows[0];
  if (row === undefined) {
    await q.query(
      "insert into chain_events (tenant_id, event, tx_hash, log_index, block_number, block_hash, data, status) values ($1,$2,$3,$4,$5,$6,$7::jsonb,'CONFIRMED')",
      [e.tenantId, e.event, e.txHash, e.logIndex, e.blockNumber.toString(), e.blockHash, JSON.stringify(e.data)],
    );
    return "NEW";
  }
  if (row.tenant_id !== e.tenantId) throw new Error("chain event key belongs to another tenant");
  if (row.status === "CONFIRMED" && row.block_hash === e.blockHash) return "SAME";
  await q.query(
    "update chain_events set block_number = $3, block_hash = $4, data = $5::jsonb, event = $6, status = 'CONFIRMED', reorged_at = null, indexed_at = now() where tx_hash = $1 and log_index = $2",
    [e.txHash, e.logIndex, e.blockNumber.toString(), e.blockHash, JSON.stringify(e.data), e.event],
  );
  return "CHANGED";
}

export interface StoredChainEvent {
  readonly id: string;
  readonly event: string;
  readonly txHash: string;
  readonly logIndex: number;
  readonly blockNumber: bigint;
  readonly blockHash: string;
  readonly data: Record<string, string>;
}

interface EventRow {
  id: string;
  event: string;
  tx_hash: string;
  log_index: number;
  block_number: string;
  block_hash: string;
  data: Record<string, string>;
}
const mapEvent = (r: EventRow): StoredChainEvent => ({ id: r.id, event: r.event, txHash: r.tx_hash, logIndex: r.log_index, blockNumber: BigInt(r.block_number), blockHash: r.block_hash, data: r.data });
const EVENT_COLUMNS = "id::text as id, event, tx_hash, log_index, block_number::text as block_number, block_hash, data";

export async function confirmedBlocksSince(q: Queryable, tenantId: string, fromBlock: bigint): Promise<Array<{ blockNumber: bigint; blockHash: string }>> {
  const r = await q.query<{ block_number: string; block_hash: string }>(
    "select distinct block_number::text as block_number, block_hash from chain_events where tenant_id = $1 and status = 'CONFIRMED' and block_hash is not null and block_number >= $2 order by 1",
    [tenantId, fromBlock.toString()],
  );
  return r.rows.map((x) => ({ blockNumber: BigInt(x.block_number), blockHash: x.block_hash }));
}

/** Newest first (undo order). */
export async function eventsInBlocks(q: Queryable, tenantId: string, blocks: readonly bigint[]): Promise<StoredChainEvent[]> {
  const r = await q.query<EventRow>(
    `select ${EVENT_COLUMNS} from chain_events where tenant_id = $1 and status = 'CONFIRMED' and block_number = any($2::bigint[]) order by block_number desc, log_index desc for update`,
    [tenantId, blocks.map((b) => b.toString())],
  );
  return r.rows.map(mapEvent);
}

export async function markReorged(q: Queryable, id: string): Promise<void> {
  await q.query("update chain_events set status = 'REORGED', reorged_at = now() where id = $1::bigint", [id]);
}

/** Confirmed registrations of one engagement, newest first. */
export async function registeredEvents(q: Queryable, tenantId: string, engagementId: string): Promise<StoredChainEvent[]> {
  const r = await q.query<EventRow>(
    `select ${EVENT_COLUMNS} from chain_events where tenant_id = $1 and event = 'EngagementRegistered' and status = 'CONFIRMED' and data ->> 'engagementId' = $2 order by block_number, log_index`,
    [tenantId, engagementId],
  );
  return r.rows.map(mapEvent);
}

export async function getCursor(q: Queryable, tenantId: string): Promise<bigint | null> {
  const r = await q.query<{ next_block: string }>("select next_block::text as next_block from chain_cursors where tenant_id = $1", [tenantId]);
  const v = r.rows[0]?.next_block;
  return v === undefined ? null : BigInt(v);
}

export async function ensureCursor(q: Queryable, tenantId: string, chainId: number, vault: string, startBlock: bigint): Promise<void> {
  await q.query("insert into chain_cursors (tenant_id, chain_id, vault_address, next_block) values ($1,$2,$3,$4) on conflict (tenant_id) do nothing", [tenantId, chainId, vault, startBlock.toString()]);
}

export async function setCursor(q: Queryable, tenantId: string, nextBlock: bigint): Promise<void> {
  await q.query("update chain_cursors set next_block = $2, updated_at = now() where tenant_id = $1", [tenantId, nextBlock.toString()]);
}

/** Never moves the cursor forward: used by the reorg handler to rescan from the lowest reorged block. */
export async function lowerCursor(q: Queryable, tenantId: string, nextBlock: bigint): Promise<void> {
  await q.query("update chain_cursors set next_block = least(next_block, $2), updated_at = now() where tenant_id = $1", [tenantId, nextBlock.toString()]);
}

export async function lockIndexer(q: Queryable, tenantId: string): Promise<boolean> {
  const r = await q.query<{ ok: boolean }>("select pg_try_advisory_xact_lock(hashtextextended($1, 3)) as ok", [`index:${tenantId}`]);
  return r.rows[0]?.ok === true;
}

export async function lockEngagementFlow(q: Queryable, engagementId: string): Promise<void> {
  await q.query("select pg_advisory_xact_lock(hashtextextended($1, 4))", [`engagement:${engagementId}`]);
}

// --- reconciliations (one row per distinct finding) ------------------------------------------------------------------------

export async function recordFinding(
  q: Queryable,
  tenantId: string,
  kind: string,
  severity: "LOW" | "MEDIUM" | "HIGH",
  dedupeKey: string,
  detail: Record<string, string | number | boolean | null>,
): Promise<void> {
  await q.query(
    "insert into reconciliations (tenant_id, kind, severity, detail) values ($1,$2,$3,$4::jsonb) on conflict (tenant_id, kind, ((detail ->> 'dedupeKey'))) where (detail ->> 'dedupeKey') is not null do nothing",
    [tenantId, kind, severity, JSON.stringify({ ...detail, dedupeKey })],
  );
}

// --- payee changes -----------------------------------------------------------------------------------------------------------

export type PayeeChangeStatus = "COLLECTING" | "SUBMITTING" | "SUBMITTED" | "PROPOSED" | "EXECUTING" | "EXECUTED" | "CANCELLED" | "FAILED";
export const OPEN_PAYEE_CHANGE = ["COLLECTING", "SUBMITTING", "SUBMITTED", "PROPOSED", "EXECUTING"] as const;

export interface PayeeChangeRow {
  readonly id: string;
  readonly tenantId: string;
  readonly engagementId: string;
  readonly oldPayee: string;
  readonly newPayee: string;
  readonly nonce: string;
  readonly ownerSig: string | null;
  readonly oldSig: string | null;
  readonly newSig: string | null;
  readonly status: PayeeChangeStatus;
  readonly submittedTx: string | null;
  readonly proposedTx: string | null;
  readonly executedTx: string | null;
  readonly etaEpoch: bigint | null;
  readonly error: string | null;
}

interface PcRow {
  id: string;
  tenant_id: string;
  engagement_id: string;
  old_payee: string;
  new_payee: string;
  nonce: string;
  owner_sig: string | null;
  old_sig: string | null;
  new_sig: string | null;
  status: PayeeChangeStatus;
  submitted_tx: string | null;
  proposed_tx: string | null;
  executed_tx: string | null;
  eta_epoch: string | null;
  error: string | null;
}
const PC_COLUMNS = "id, tenant_id, engagement_id, old_payee, new_payee, nonce::text as nonce, owner_sig, old_sig, new_sig, status, submitted_tx, proposed_tx, executed_tx, eta_epoch::text as eta_epoch, error";
const mapPc = (r: PcRow): PayeeChangeRow => ({
  id: r.id,
  tenantId: r.tenant_id,
  engagementId: r.engagement_id,
  oldPayee: r.old_payee,
  newPayee: r.new_payee,
  nonce: r.nonce,
  ownerSig: r.owner_sig,
  oldSig: r.old_sig,
  newSig: r.new_sig,
  status: r.status,
  submittedTx: r.submitted_tx,
  proposedTx: r.proposed_tx,
  executedTx: r.executed_tx,
  etaEpoch: r.eta_epoch === null ? null : BigInt(r.eta_epoch),
  error: r.error,
});

export async function getPayeeChange(q: Queryable, tenantId: string, id: string, lock = false): Promise<PayeeChangeRow | null> {
  const r = await q.query<PcRow>(`select ${PC_COLUMNS} from payee_changes where id = $1 and tenant_id = $2${lock ? " for update" : ""}`, [id, tenantId]);
  const row = r.rows[0];
  return row === undefined ? null : mapPc(row);
}

export async function listPayeeChanges(q: Queryable, tenantId: string, engagementId: string): Promise<PayeeChangeRow[]> {
  const r = await q.query<PcRow>(`select ${PC_COLUMNS} from payee_changes where tenant_id = $1 and engagement_id = $2 order by created_at, nonce`, [tenantId, engagementId]);
  return r.rows.map(mapPc);
}

export async function openPayeeChange(q: Queryable, tenantId: string, engagementId: string): Promise<PayeeChangeRow | null> {
  const r = await q.query<PcRow>(`select ${PC_COLUMNS} from payee_changes where tenant_id = $1 and engagement_id = $2 and status = any($3::text[]) for update`, [tenantId, engagementId, [...OPEN_PAYEE_CHANGE]]);
  const row = r.rows[0];
  return row === undefined ? null : mapPc(row);
}

export async function maxPayeeChangeNonce(q: Queryable, engagementId: string): Promise<bigint> {
  const r = await q.query<{ n: string | null }>("select max(nonce)::text as n from payee_changes where engagement_id = $1", [engagementId]);
  const v = r.rows[0]?.n;
  return v === null || v === undefined ? 0n : BigInt(v);
}

export async function insertPayeeChange(q: Queryable, c: { tenantId: string; engagementId: string; oldPayee: string; newPayee: string; nonce: string }): Promise<string> {
  const r = await q.query<{ id: string }>(
    "insert into payee_changes (tenant_id, engagement_id, old_payee, new_payee, nonce, status) values ($1,$2,$3,$4,$5,'COLLECTING') returning id",
    [c.tenantId, c.engagementId, c.oldPayee, c.newPayee, c.nonce],
  );
  const id = r.rows[0]?.id;
  if (id === undefined) throw new Error("insert returned no id");
  return id;
}

export async function storePayeeChangeSig(q: Queryable, id: string, role: "owner" | "oldPayee" | "newPayee", signature: string): Promise<void> {
  const col = role === "owner" ? "owner_sig" : role === "oldPayee" ? "old_sig" : "new_sig";
  await q.query(`update payee_changes set ${col} = $2, updated_at = now() where id = $1`, [id, signature]);
}

export async function setPayeeChangeStatus(
  q: Queryable,
  id: string,
  status: PayeeChangeStatus,
  f: { submittedTx?: string | null; proposedTx?: string | null; executedTx?: string | null; etaEpoch?: bigint | null; error?: string | null } = {},
): Promise<void> {
  await q.query(
    `update payee_changes set status = $2,
        submitted_tx = case when $3::boolean then $4 else submitted_tx end,
        proposed_tx = case when $5::boolean then $6 else proposed_tx end,
        executed_tx = case when $7::boolean then $8 else executed_tx end,
        eta_epoch = case when $9::boolean then $10::bigint else eta_epoch end,
        error = case when $11::boolean then $12 else error end,
        updated_at = now()
      where id = $1`,
    [
      id, status,
      f.submittedTx !== undefined, f.submittedTx ?? null,
      f.proposedTx !== undefined, f.proposedTx ?? null,
      f.executedTx !== undefined, f.executedTx ?? null,
      f.etaEpoch !== undefined, f.etaEpoch === undefined || f.etaEpoch === null ? null : f.etaEpoch.toString(),
      f.error !== undefined, f.error === undefined || f.error === null ? null : f.error.slice(0, 200),
    ],
  );
}

/** Open changes of an engagement that match a chain event's new payee (case-insensitive). */
export async function openChangeForNewPayee(q: Queryable, tenantId: string, engagementId: string, newPayee: string): Promise<PayeeChangeRow | null> {
  const r = await q.query<PcRow>(
    `select ${PC_COLUMNS} from payee_changes where tenant_id = $1 and engagement_id = $2 and lower(new_payee) = lower($3) and status = any($4::text[]) for update`,
    [tenantId, engagementId, newPayee, [...OPEN_PAYEE_CHANGE]],
  );
  const row = r.rows[0];
  return row === undefined ? null : mapPc(row);
}

export async function changeByTx(q: Queryable, tenantId: string, column: "proposed_tx" | "executed_tx", txHash: string): Promise<PayeeChangeRow | null> {
  const r = await q.query<PcRow>(`select ${PC_COLUMNS} from payee_changes where tenant_id = $1 and ${column} = $2 for update`, [tenantId, txHash]);
  const row = r.rows[0];
  return row === undefined ? null : mapPc(row);
}

export async function cancelProposedChanges(q: Queryable, tenantId: string): Promise<number> {
  const r = await q.query("update payee_changes set status = 'CANCELLED', error = 'VAULT_PAUSED', updated_at = now() where tenant_id = $1 and status in ('PROPOSED','EXECUTING')", [tenantId]);
  return r.rowCount;
}

export async function submittedPayeeChanges(q: Queryable, tenantId: string): Promise<Array<{ change: PayeeChangeRow; ageSeconds: number }>> {
  const r = await q.query<PcRow & { age: number }>(
    `select ${PC_COLUMNS}, extract(epoch from now() - updated_at)::int as age from payee_changes where tenant_id = $1 and status in ('SUBMITTED','EXECUTING') and (submitted_tx is not null or executed_tx is not null)`,
    [tenantId],
  );
  return r.rows.map((x) => ({ change: mapPc(x), ageSeconds: x.age }));
}
