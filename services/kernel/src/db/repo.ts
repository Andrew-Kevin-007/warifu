// Repositories: every SQL statement the service issues lives here, parameterised (no string-built SQL; untrusted
// values never reach a statement text, INV-15), and every query that touches tenant data carries the tenant id.
// Money columns are numeric(40,0): they are selected `::text` and become bigint/decimal strings, never JS numbers.
import * as z from "zod";
import {
  AddressSchema,
  AmountSchema,
  CheckIdSchema,
  DecisionSchema,
  EngagementSchema,
  EvidenceSchema,
  Hex32Schema,
  ISODateTimeSchema,
  PaymentTermsSchema,
  PlanModeSchema,
  ReasonCodeSchema,
  ReceiptSchema,
} from "@symbolon/schemas";
import type { ApprovalView, Decision, Engagement, Evidence, Hex32, ISODateTime, Milestone, PaymentTerms, Receipt, UUID } from "@symbolon/schemas";
import type { DecisionSummary, FindingRef } from "@symbolon/kernel-core";
import { normalizeInvoiceNumber } from "@symbolon/kernel-core";
import { toIsoSeconds } from "../time";
import type { Queryable } from "./pool";
import type { Profile } from "../boot";

// --- tenants & deployment profile -----------------------------------------------------------------------------------------

export interface TenantRow {
  readonly id: UUID;
  readonly kind: "pilot" | "demo" | "challenge";
  readonly vaultAddress: string | null;
  readonly chainId: number;
  readonly network: "testnet" | "mainnet" | "local";
  readonly policy: unknown;
  readonly policyHash: string;
}

export async function getTenant(q: Queryable, tenantId: string): Promise<TenantRow | null> {
  const r = await q.query<{ id: string; kind: TenantRow["kind"]; vault_address: string | null; chain_id: string; network: TenantRow["network"]; policy: unknown; policy_hash: string }>(
    "select id, kind, vault_address, chain_id::text as chain_id, network, policy, policy_hash from tenants where id = $1",
    [tenantId],
  );
  const row = r.rows[0];
  if (row === undefined) return null;
  return { id: row.id, kind: row.kind, vaultAddress: row.vault_address, chainId: Number.parseInt(row.chain_id, 10), network: row.network, policy: row.policy, policyHash: row.policy_hash };
}

export async function getDeploymentProfile(q: Queryable): Promise<Profile | null> {
  const r = await q.query<{ profile: string }>("select profile from deployment_profile where id = 1");
  const p = r.rows[0]?.profile;
  return p === "production" || p === "sandbox" ? p : null;
}

/** Tenant kinds present in this database that do not belong to `profile` (INV-16/17 defence in depth at boot). */
export async function foreignTenantKinds(q: Queryable, profile: Profile): Promise<string[]> {
  const r = await q.query<{ kind: string }>(
    profile === "sandbox" ? "select distinct kind from tenants where kind <> 'challenge'" : "select distinct kind from tenants where kind = 'challenge'",
  );
  return r.rows.map((x) => x.kind);
}

// --- documents --------------------------------------------------------------------------------------------------------------

export interface DocumentRow {
  readonly documentId: UUID;
  readonly tenantId: UUID;
  readonly rawHash: Hex32;
  readonly normalizedHash: Hex32;
  readonly blobSha256: Hex32 | null;
  readonly mime: string;
  readonly storageKey: string | null;
  readonly normalizedText: string;
  readonly zeroWidthCount: number;
  readonly receivedAt: ISODateTime;
  readonly createdAt: ISODateTime;
}

interface RawDocumentRow {
  document_id: string;
  tenant_id: string;
  raw_hash: string;
  normalized_hash: string | null;
  blob_sha256: string | null;
  mime: string;
  storage_key: string | null;
  normalized_text: string;
  zero_width_count: number;
  received_at: string;
  created_at: string;
}

const DOCUMENT_COLUMNS = "document_id, tenant_id, raw_hash, normalized_hash, blob_sha256, mime, storage_key, normalized_text, zero_width_count, received_at, created_at";

function mapDocument(r: RawDocumentRow): DocumentRow {
  const raw = Hex32Schema.parse(r.raw_hash);
  const normalizedHash = Hex32Schema.safeParse(r.normalized_hash);
  if (!normalizedHash.success) throw new Error("document row has no valid normalized_hash"); // service-written rows always have one
  return {
    documentId: r.document_id,
    tenantId: r.tenant_id,
    rawHash: raw,
    normalizedHash: normalizedHash.data,
    blobSha256: r.blob_sha256 === null ? null : Hex32Schema.parse(r.blob_sha256),
    mime: r.mime,
    storageKey: r.storage_key,
    normalizedText: r.normalized_text,
    zeroWidthCount: r.zero_width_count,
    receivedAt: toIsoSeconds(r.received_at),
    createdAt: toIsoSeconds(r.created_at),
  };
}

export async function getDocument(q: Queryable, tenantId: string, documentId: string): Promise<DocumentRow | null> {
  const r = await q.query<RawDocumentRow>(`select ${DOCUMENT_COLUMNS} from documents where tenant_id = $1 and document_id = $2`, [tenantId, documentId]);
  const row = r.rows[0];
  return row === undefined ? null : mapDocument(row);
}

export interface NewDocument {
  readonly tenantId: UUID;
  readonly rawHash: Hex32;
  readonly normalizedHash: Hex32;
  readonly blobSha256: Hex32 | null;
  readonly mime: string;
  readonly storageKey: string | null;
  readonly normalizedText: string;
  readonly zeroWidthCount: number;
  readonly receivedAt: ISODateTime;
}

/**
 * Insert a document unless this tenant already holds one with the same rawHash, in which case the EXISTING row (with its
 * original received_at) is returned. Re-posting a document can therefore never move the discount clock (INV-19).
 * An advisory lock on (tenant, rawHash) closes the check-then-insert race.
 */
export async function insertDocumentOnce(q: Queryable, d: NewDocument): Promise<{ doc: DocumentRow; created: boolean }> {
  await q.query("select pg_advisory_xact_lock(hashtextextended($1, 1))", [`doc:${d.tenantId}:${d.rawHash}`]);
  const existing = await q.query<RawDocumentRow>(`select ${DOCUMENT_COLUMNS} from documents where tenant_id = $1 and raw_hash = $2 order by received_at, document_id limit 1`, [d.tenantId, d.rawHash]);
  const found = existing.rows[0];
  if (found !== undefined) return { doc: mapDocument(found), created: false };
  const ins = await q.query<RawDocumentRow>(
    `insert into documents (tenant_id, raw_hash, normalized_hash, blob_sha256, mime, storage_key, normalized_text, zero_width_count, received_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9::timestamptz) returning ${DOCUMENT_COLUMNS}`,
    [d.tenantId, d.rawHash, d.normalizedHash, d.blobSha256, d.mime, d.storageKey, d.normalizedText, d.zeroWidthCount, d.receivedAt],
  );
  const row = ins.rows[0];
  if (row === undefined) throw new Error("document insert returned no row");
  return { doc: mapDocument(row), created: true };
}

// --- engagements --------------------------------------------------------------------------------------------------------------

interface EngagementRow {
  engagement_id: string;
  tenant_id: string;
  owner: string;
  payee: string;
  payee_label: string;
  currency: string;
  currency_decimals: number;
  cap_base_units: string;
  start_at: string;
  end_at: string;
  sequential: boolean;
  terms: unknown;
  terms_hash: string;
  owner_sig: string | null;
  payee_sig: string | null;
  nonce: string;
  status: string;
  registered_tx: string | null;
}

interface MilestoneRow {
  milestone_id: string;
  slug: string;
  description: string;
  amount_base_units: string;
  partial_allowed: boolean;
  immediate: boolean;
  due_date: string | null;
  category: string;
  evidence_spec: unknown;
  status: string;
}

/** Order of the milestones as signed (the termsHash preimage keeps array order). */
function signedMilestoneOrder(terms: unknown): string[] {
  const ms = (terms as { milestones?: unknown } | null)?.milestones;
  if (!Array.isArray(ms)) return [];
  return ms.map((m) => (m as { milestoneId?: unknown } | null)?.milestoneId).filter((x): x is string => typeof x === "string");
}

/**
 * The tenant's engagement with its milestones. Built from the row columns (not from `terms`) except for the
 * milestone order and `paymentTerms`, which only the signed terms carry. K-05 recomputes termsHash from exactly this
 * object and compares it with the on-chain hash, so a row edited after signing is refused there. Anything that does not
 * parse as an Engagement throws (fail closed: the caller returns 503, never a decision on half-read data).
 */
export async function loadEngagement(q: Queryable, tenantId: string, engagementId: string): Promise<Engagement | null> {
  const e = await q.query<EngagementRow>(
    `select engagement_id, tenant_id, owner, payee, payee_label, currency, currency_decimals, cap_base_units::text as cap_base_units,
            start_at, end_at, sequential, terms, terms_hash, owner_sig, payee_sig, nonce::text as nonce, status, registered_tx
       from engagements where engagement_id = $1 and tenant_id = $2`,
    [engagementId, tenantId],
  );
  const row = e.rows[0];
  if (row === undefined) return null;
  const ms = await q.query<MilestoneRow>(
    `select milestone_id, slug, description, amount_base_units::text as amount_base_units, partial_allowed, immediate, due_date, category, evidence_spec, status
       from milestones where engagement_id = $1`,
    [engagementId],
  );
  const order = signedMilestoneOrder(row.terms);
  const rank = (id: string): number => {
    const i = order.indexOf(id);
    return i === -1 ? Number.MAX_SAFE_INTEGER : i;
  };
  const milestones = [...ms.rows]
    .sort((a, b) => rank(a.milestone_id) - rank(b.milestone_id) || a.slug.localeCompare(b.slug))
    .map(
      (m): Milestone => ({
        milestoneId: Hex32Schema.parse(m.milestone_id),
        slug: m.slug,
        description: m.description,
        amountBaseUnits: m.amount_base_units,
        partialAllowed: m.partial_allowed,
        immediate: m.immediate,
        dueDate: m.due_date === null ? null : toIsoSeconds(m.due_date),
        category: m.category,
        evidenceSpec: m.evidence_spec as Milestone["evidenceSpec"],
        status: m.status as Milestone["status"],
      }),
    );
  const rawTerms = (row.terms as { paymentTerms?: unknown } | null)?.paymentTerms ?? null;
  const paymentTerms: PaymentTerms | null = rawTerms === null ? null : PaymentTermsSchema.parse(rawTerms);
  return EngagementSchema.parse({
    engagementId: row.engagement_id,
    tenantId: row.tenant_id,
    owner: row.owner,
    payee: row.payee,
    payeeLabel: row.payee_label,
    currency: row.currency,
    currencyDecimals: row.currency_decimals,
    capBaseUnits: row.cap_base_units,
    start: toIsoSeconds(row.start_at),
    end: toIsoSeconds(row.end_at),
    sequential: row.sequential,
    milestones,
    paymentTerms,
    termsHash: row.terms_hash,
    ownerSig: row.owner_sig,
    payeeSig: row.payee_sig,
    nonce: row.nonce,
    status: row.status,
    registeredTx: row.registered_tx,
  });
}

// --- ledger-derived context ---------------------------------------------------------------------------------------------------

const big = (v: string | null | undefined): bigint => (v === null || v === undefined || v === "" ? 0n : BigInt(v));

/**
 * The head of each supersedes chain decided in the last 90 days (docs/QUESTIONS WP-04 item 1). `excludeIntentId` removes one
 * intent's own chain, for a re-evaluation of that intent (plan selection).
 */
export async function loadPriorDecisions(q: Queryable, tenantId: string, now: ISODateTime, excludeIntentId: string | null): Promise<DecisionSummary[]> {
  const r = await q.query<{
    decision_id: string;
    intent_id: string;
    verdict: string;
    engagement_id: string | null;
    milestone_id: string | null;
    payee: string | null;
    amount: string | null;
    release_amount: string | null;
    created_at: string;
    doc_hash: string;
    invoice_number: string | null;
  }>(
    `select d.decision_id, d.intent_id, d.verdict, d.engagement_id, d.milestone_id, d.payee,
            d.amount_base_units::text as amount, d.release_amount_base_units::text as release_amount, d.created_at,
            doc.raw_hash as doc_hash, i.payload #>> '{extraction,a,invoiceNumber}' as invoice_number
       from decisions d
       join intents i on i.intent_id = d.intent_id
       join documents doc on doc.document_id = i.document_id
      where d.tenant_id = $1
        and d.created_at >= ($2::timestamptz - interval '90 days')
        and not exists (select 1 from decisions s where s.supersedes = d.decision_id)
        and ($3::text is null or d.intent_id <> $3)
      order by d.created_at, d.decision_id`,
    [tenantId, now, excludeIntentId],
  );
  return r.rows.map(
    (x): DecisionSummary => ({
      decisionId: x.decision_id,
      intentId: Hex32Schema.parse(x.intent_id),
      verdict: x.verdict as DecisionSummary["verdict"],
      docHash: Hex32Schema.parse(x.doc_hash),
      engagementId: x.engagement_id === null ? null : Hex32Schema.parse(x.engagement_id),
      milestoneId: x.milestone_id === null ? null : Hex32Schema.parse(x.milestone_id),
      payee: x.payee === null ? null : AddressSchema.parse(x.payee),
      normInvoiceNo: x.invoice_number === null ? null : normalizeInvoiceNumber(x.invoice_number),
      amountBaseUnits: x.amount === null ? null : BigInt(x.amount),
      releaseAmountBaseUnits: x.release_amount === null ? null : BigInt(x.release_amount),
      createdAt: toIsoSeconds(x.created_at),
    }),
  );
}

export interface ReleasedTotalsRow {
  readonly engagementTotal: bigint;
  readonly tenantDay: bigint;
  readonly tenantWeek: bigint;
  readonly payeeDay: bigint;
  readonly payeeCountDay: number;
  /** WP-05 K-12: tenant-wide RELEASE count in the same 24 h window (velocity.maxReleasesPerDay). */
  readonly tenantCountDay: number;
  readonly categoryMonth: Record<string, bigint>;
  readonly pendingReleases: bigint;
}

/**
 * Totals of RELEASE decisions (heads) including decided-but-unsettled ones (race guard, docs/04 s2). A decision is dated by
 * its payAt when it has one (a payment scheduled for tomorrow still counts today), else by creation. `excludeDecisionId`
 * removes the decision being re-evaluated at its payAt, which must not count against itself.
 */
export async function loadReleasedTotals(
  q: Queryable,
  tenantId: string,
  now: ISODateTime,
  engagementId: string | null,
  payee: string | null,
  excludeDecisionId: string | null,
): Promise<ReleasedTotalsRow> {
  const base = `
    from decisions d
    where d.tenant_id = $1 and d.verdict = 'RELEASE'
      and not exists (select 1 from decisions s where s.supersedes = d.decision_id)
      and ($2::uuid is null or d.decision_id <> $2)`;
  const amt = "coalesce(d.release_amount_base_units, d.amount_base_units, 0)";
  const eff = "coalesce(d.pay_at, d.created_at)";
  const r = await q.query<{ engagement_total: string; tenant_day: string; tenant_week: string; payee_day: string; payee_count_day: string; tenant_count_day: string; pending: string }>(
    `select coalesce(sum(${amt}) filter (where $3::text is not null and d.engagement_id = $3), 0)::text as engagement_total,
            coalesce(sum(${amt}) filter (where ${eff} > $5::timestamptz - interval '24 hours'), 0)::text as tenant_day,
            coalesce(sum(${amt}) filter (where ${eff} > $5::timestamptz - interval '7 days'), 0)::text as tenant_week,
            coalesce(sum(${amt}) filter (where $4::text is not null and d.payee = $4 and ${eff} > $5::timestamptz - interval '24 hours'), 0)::text as payee_day,
            count(*) filter (where $4::text is not null and d.payee = $4 and ${eff} > $5::timestamptz - interval '24 hours')::text as payee_count_day,
            count(*) filter (where ${eff} > $5::timestamptz - interval '24 hours')::text as tenant_count_day,
            coalesce(sum(${amt}) filter (where not exists (select 1 from releases r where r.decision_id = d.decision_id and r.status = 'CONFIRMED')), 0)::text as pending
       ${base}`,
    [tenantId, excludeDecisionId, engagementId, payee, now],
  );
  const row = r.rows[0];
  const cats = await q.query<{ category: string; total: string }>(
    `select m.category, coalesce(sum(${amt}), 0)::text as total
       from decisions d join milestones m on m.milestone_id = d.milestone_id
      where d.tenant_id = $1 and d.verdict = 'RELEASE'
        and not exists (select 1 from decisions s where s.supersedes = d.decision_id)
        and ($2::uuid is null or d.decision_id <> $2)
        and (${eff} at time zone 'utc') >= date_trunc('month', $3::timestamptz at time zone 'utc')
      group by m.category`,
    [tenantId, excludeDecisionId, now],
  );
  const categoryMonth: Record<string, bigint> = Object.create(null) as Record<string, bigint>;
  for (const c of cats.rows) categoryMonth[c.category] = big(c.total);
  return {
    engagementTotal: big(row?.engagement_total),
    tenantDay: big(row?.tenant_day),
    tenantWeek: big(row?.tenant_week),
    payeeDay: big(row?.payee_day),
    payeeCountDay: Number.parseInt(row?.payee_count_day ?? "0", 10),
    tenantCountDay: Number.parseInt(row?.tenant_count_day ?? "0", 10),
    categoryMonth,
    pendingReleases: big(row?.pending),
  };
}

/** Milestones of the tenant's ACTIVE engagements that fall due within `lookaheadDays` (docs/04 s2 obligations14d). */
export async function loadObligations(q: Queryable, tenantId: string, now: ISODateTime, lookaheadDays: number): Promise<bigint> {
  const r = await q.query<{ total: string }>(
    `select coalesce(sum(m.amount_base_units), 0)::text as total
       from milestones m join engagements e on e.engagement_id = m.engagement_id
      where e.tenant_id = $1 and e.status = 'ACTIVE' and m.status in ('PENDING', 'EVIDENCE_OK')
        and m.due_date is not null and m.due_date <= $2::timestamptz + make_interval(days => $3::int)`,
    [tenantId, now, lookaheadDays],
  );
  return big(r.rows[0]?.total);
}

export async function loadPayeeHistory(q: Queryable, tenantId: string, payee: string | null): Promise<{ priorPayments: number; onTime: number; disputes: number }> {
  if (payee === null) return { priorPayments: 0, onTime: 0, disputes: 0 };
  const paid = await q.query<{ n: string }>(
    `select count(*)::text as n from releases r join decisions d on d.decision_id = r.decision_id
      where d.tenant_id = $1 and d.payee = $2 and r.status = 'CONFIRMED'`,
    [tenantId, payee],
  );
  const disputes = await q.query<{ n: string }>(
    `select count(*)::text as n from milestones m join engagements e on e.engagement_id = m.engagement_id
      where e.tenant_id = $1 and e.payee = $2 and m.status = 'DISPUTED'`,
    [tenantId, payee],
  );
  // onTime is not tracked anywhere yet; 0 is the conservative reading (no on-time history is claimed).
  return { priorPayments: Number.parseInt(paid.rows[0]?.n ?? "0", 10), onTime: 0, disputes: Number.parseInt(disputes.rows[0]?.n ?? "0", 10) };
}

/** Distinct intents escalated today (UTC), in total and per engagement (K-12 escalation budget). */
export async function loadEscalations(q: Queryable, tenantId: string, now: ISODateTime, excludeIntentId: string | null): Promise<{ today: number; todayByEngagement: Record<string, number> }> {
  const r = await q.query<{ engagement_id: string | null; n: string }>(
    `select engagement_id, count(distinct intent_id)::text as n from decisions
      where tenant_id = $1 and verdict = 'ESCALATE'
        and (created_at at time zone 'utc')::date = ($2::timestamptz at time zone 'utc')::date
        and ($3::text is null or intent_id <> $3)
      group by engagement_id`,
    [tenantId, now, excludeIntentId],
  );
  const byEng: Record<string, number> = Object.create(null) as Record<string, number>;
  let today = 0;
  for (const x of r.rows) {
    const n = Number.parseInt(x.n, 10);
    today += n;
    if (x.engagement_id !== null) byEng[x.engagement_id] = n;
  }
  return { today, todayByEngagement: byEng };
}

export async function loadBreaker(q: Queryable, tenantId: string): Promise<{ halted: boolean; reason: string | null }> {
  const r = await q.query<{ halted: boolean; reason: string | null }>("select halted, reason from breaker_state where tenant_id = $1", [tenantId]);
  const row = r.rows[0];
  return row === undefined ? { halted: false, reason: null } : { halted: row.halted, reason: row.reason };
}

/**
 * Kernel-collected evidence for one milestone of one of the tenant's engagements: the LATEST `limit` observations (default 64,
 * the receipt's cap on evidence entries), oldest first. K-09 decides on the latest fresh observation per requirement, so an
 * observation older than the newest 64 cannot decide a verdict. Rows that do not parse are skipped (treated as missing).
 */
export const EVIDENCE_CONTEXT_LIMIT = 64;
export async function loadEvidence(q: Queryable, tenantId: string, milestoneId: string, limit: number = EVIDENCE_CONTEXT_LIMIT): Promise<{ evidence: Evidence[]; skipped: number }> {
  const r = await q.query<{
    evidence_id: string;
    milestone_id: string;
    type: string;
    collected_by: string;
    collected_at: string;
    source: string;
    payload: unknown;
    payload_hash: string;
    result: string;
    details: string | null;
  }>(
    `select ev.evidence_id, ev.milestone_id, ev.type, ev.collected_by, ev.collected_at, ev.source, ev.payload, ev.payload_hash, ev.result, ev.details
       from evidence ev
       join milestones m on m.milestone_id = ev.milestone_id
       join engagements e on e.engagement_id = m.engagement_id
      where e.tenant_id = $1 and ev.milestone_id = $2
      order by ev.collected_at desc, ev.evidence_id desc
      limit $3`,
    [tenantId, milestoneId, limit],
  );
  r.rows.reverse();
  const evidence: Evidence[] = [];
  let skipped = 0;
  for (const x of r.rows) {
    const parsed = EvidenceSchema.safeParse({
      evidenceId: x.evidence_id,
      milestoneId: x.milestone_id,
      type: x.type,
      collectedBy: x.collected_by,
      collectedAt: toIsoSeconds(x.collected_at),
      source: x.source,
      payload: x.payload ?? null,
      payloadHash: x.payload_hash,
      result: x.result,
      details: x.details ?? "",
    });
    if (parsed.success) evidence.push(parsed.data);
    else skipped++;
  }
  return { evidence, skipped };
}

// --- intents, decisions, receipts ---------------------------------------------------------------------------------------------

export async function getIntentRow(q: Queryable, tenantId: string, intentId: string): Promise<{ intentId: Hex32; documentId: UUID; payload: unknown; createdAt: ISODateTime } | null> {
  const r = await q.query<{ intent_id: string; document_id: string; payload: unknown; created_at: string }>(
    "select intent_id, document_id, payload, created_at from intents where tenant_id = $1 and intent_id = $2",
    [tenantId, intentId],
  );
  const x = r.rows[0];
  return x === undefined ? null : { intentId: Hex32Schema.parse(x.intent_id), documentId: x.document_id, payload: x.payload, createdAt: toIsoSeconds(x.created_at) };
}

export interface IntentListItem {
  readonly intentId: Hex32;
  readonly createdAt: ISODateTime;
  readonly verdict: string | null;
  readonly reasons: readonly string[];
  readonly payee: string | null;
  readonly amountBaseUnits: string | null;
  readonly releaseAmountBaseUnits: string | null;
  readonly receiptHash: string | null;
  readonly releaseStatus: string | null;
}

/**
 * The tenant's newest intents with their latest decision (dashboard feed). Identifiers, codes and amounts only: no document text, no
 * payload, nothing an attacker typed (INV-15). Reason codes are re-validated against the code pattern.
 */
export async function listIntents(q: Queryable, tenantId: string, limit: number): Promise<IntentListItem[]> {
  const r = await q.query<{
    intent_id: string; created_at: string; verdict: string | null; reasons: string[] | null; payee: string | null;
    amount: string | null; release_amount: string | null; receipt_hash: string | null; release_status: string | null;
  }>(
    `select i.intent_id, i.created_at, d.verdict, d.reasons, d.payee, d.amount_base_units::text as amount,
            d.release_amount_base_units::text as release_amount, rc.receipt_hash,
            (select x.status from releases x where x.decision_id = d.decision_id order by x.updated_at desc limit 1) as release_status
       from intents i
       left join lateral (select * from decisions s where s.intent_id = i.intent_id and not exists (select 1 from decisions n where n.supersedes = s.decision_id)
                          order by s.created_at desc limit 1) d on true
       left join receipts rc on rc.decision_id = d.decision_id
      where i.tenant_id = $1
      order by i.created_at desc
      limit $2`,
    [tenantId, Math.max(1, Math.min(limit, 100))],
  );
  return r.rows.map((x) => ({
    intentId: Hex32Schema.parse(x.intent_id),
    createdAt: toIsoSeconds(x.created_at),
    verdict: x.verdict,
    reasons: (x.reasons ?? []).filter((c) => /^[A-Z][A-Z0-9_]{0,63}$/.test(c)),
    payee: x.payee,
    amountBaseUnits: x.amount,
    releaseAmountBaseUnits: x.release_amount,
    receiptHash: x.receipt_hash,
    releaseStatus: x.release_status,
  }));
}

export interface PilotStatsRow {
  readonly network: string;
  readonly businesses: number;
  readonly releases: number;
  readonly payees: number;
  readonly valueBaseUnits: string;
}

/**
 * The sanitized `public_pilot_stats` view (tenants.kind = 'pilot', INV-17): demo, challenge and house traffic are excluded by
 * construction. Payees are counted from the same pilot-only, CONFIRMED releases (distinct addresses, never listed).
 */
export async function pilotStats(q: Queryable): Promise<PilotStatsRow[]> {
  const r = await q.query<{ network: string; businesses: string; releases: string; value_base_units: string; payees: string }>(
    `select s.network, s.businesses::text, s.releases::text, s.value_base_units::text,
            coalesce((select count(distinct d.payee) from tenants t
                        join decisions d on d.tenant_id = t.id
                        join releases r on r.decision_id = d.decision_id and r.status = 'CONFIRMED'
                       where t.kind = 'pilot' and t.network = s.network), 0)::text as payees
       from public_pilot_stats s order by s.network`,
  );
  return r.rows.map((x) => ({ network: x.network, businesses: Number.parseInt(x.businesses, 10), releases: Number.parseInt(x.releases, 10), payees: Number.parseInt(x.payees, 10), valueBaseUnits: x.value_base_units }));
}

/** Insert the intent unless it exists. Returns the tenant that owns the stored row (a different tenant is a hard conflict). */
export async function insertIntentOnce(q: Queryable, i: { intentId: string; tenantId: string; documentId: string; payloadJson: string }): Promise<{ ownerTenantId: string; created: boolean }> {
  const ins = await q.query<{ intent_id: string }>(
    "insert into intents (intent_id, tenant_id, document_id, payload) values ($1, $2, $3, $4::jsonb) on conflict (intent_id) do nothing returning intent_id",
    [i.intentId, i.tenantId, i.documentId, i.payloadJson],
  );
  if (ins.rowCount === 1) return { ownerTenantId: i.tenantId, created: true };
  const own = await q.query<{ tenant_id: string }>("select tenant_id from intents where intent_id = $1", [i.intentId]);
  return { ownerTenantId: own.rows[0]?.tenant_id ?? "", created: false };
}

/** Replace the stored proposal of an existing intent (plan selection). The caller writes an audit_log row. */
export async function updateIntentPayload(q: Queryable, tenantId: string, intentId: string, payloadJson: string): Promise<void> {
  await q.query("update intents set payload = $3::jsonb where tenant_id = $1 and intent_id = $2", [tenantId, intentId, payloadJson]);
}

export async function latestDecisionIdForIntent(q: Queryable, tenantId: string, intentId: string): Promise<string | null> {
  const r = await q.query<{ decision_id: string }>(
    "select decision_id from decisions d where d.tenant_id = $1 and d.intent_id = $2 and not exists (select 1 from decisions s where s.supersedes = d.decision_id) order by d.created_at desc, d.decision_id desc limit 1",
    [tenantId, intentId],
  );
  return r.rows[0]?.decision_id ?? null;
}

/** Kernel outputs stored next to a decision (not part of the Decision schema): see migration 0007. */
export interface DecisionExtras {
  readonly approvableFindings: readonly FindingRef[];
  readonly planSummary: PlanSummary | null;
}
export type PlanSummary = NonNullable<ApprovalView["planSummary"]>;
export const NO_EXTRAS: DecisionExtras = { approvableFindings: [], planSummary: null };

export async function insertDecision(q: Queryable, d: Decision, extras: DecisionExtras = NO_EXTRAS): Promise<void> {
  await q.query(
    `insert into decisions (decision_id, tenant_id, intent_id, verdict, checks, reasons, payee, amount_base_units, engagement_id, milestone_id,
                            pay_at, timing_source, policy_hash, kernel_version, context_hash, agent_recommendation, human_explanation, supersedes,
                            created_at, release_amount_base_units, plan_id, planner_fallback, invoice_received_at, approvable_findings, plan_summary)
     values ($1, $2, $3, $4, $5::jsonb, $6::text[], $7, $8, $9, $10, $11::timestamptz, $12, $13, $14, $15, $16::jsonb, $17, $18, $19::timestamptz, $20, $21, $22, $23::timestamptz,
             $24::jsonb, $25::jsonb)`,
    [
      d.decisionId,
      d.tenantId,
      d.intentId,
      d.verdict,
      JSON.stringify(d.checks),
      [...d.reasons],
      d.payee,
      d.amountBaseUnits,
      d.engagementId,
      d.milestoneId,
      d.payAt,
      d.timingSource,
      d.policyHash,
      d.kernelVersion,
      d.contextHash,
      d.agentRecommendation === null ? null : JSON.stringify(d.agentRecommendation),
      d.humanExplanation,
      d.supersedes,
      d.createdAt,
      d.releaseAmountBaseUnits,
      d.planId,
      d.plannerFallback,
      d.invoiceReceivedAt,
      JSON.stringify(extras.approvableFindings.map((f) => ({ checkId: f.checkId, code: f.code }))),
      extras.planSummary === null ? null : JSON.stringify(extras.planSummary),
    ],
  );
}

const FindingsSchema = z.array(z.strictObject({ checkId: CheckIdSchema, code: ReasonCodeSchema })).max(64);
const PlanSummarySchema = z.strictObject({ planId: Hex32Schema, mode: PlanModeSchema, payAt: ISODateTimeSchema, discountValue: AmountSchema });

/** The stored extras of a decision of this tenant (null when there is no such decision). Malformed JSON throws (fail closed). */
export async function getDecisionExtras(q: Queryable, tenantId: string, decisionId: string): Promise<DecisionExtras | null> {
  const r = await q.query<{ approvable_findings: unknown; plan_summary: unknown }>(
    "select approvable_findings, plan_summary from decisions where tenant_id = $1 and decision_id = $2",
    [tenantId, decisionId],
  );
  const row = r.rows[0];
  if (row === undefined) return null;
  return {
    approvableFindings: FindingsSchema.parse(row.approvable_findings),
    planSummary: row.plan_summary === null ? null : PlanSummarySchema.parse(row.plan_summary),
  };
}

export async function insertReceipt(q: Queryable, r: { receiptHash: string; decisionId: string; receipt: Receipt; signature: string; signer: string }): Promise<void> {
  await q.query(
    "insert into receipts (receipt_hash, decision_id, receipt, signature, signer, issued_at) values ($1, $2, $3::jsonb, $4, $5, $6::timestamptz)",
    [r.receiptHash, r.decisionId, JSON.stringify(r.receipt), r.signature, r.signer, r.receipt.issuedAt],
  );
}

export interface StoredDecision {
  readonly decision: Decision;
  readonly receipt: Receipt;
  readonly receiptHash: Hex32;
  readonly signature: string;
  readonly signer: string;
}

interface DecisionJoin {
  human_explanation: string | null;
  receipt_hash: string;
  receipt: unknown;
  signature: string;
  signer: string;
}

function mapStored(x: DecisionJoin): StoredDecision {
  const receipt = ReceiptSchema.parse(x.receipt);
  // Decision = receipt.decision + the explanation (kept out of the receipt body; its hash is inside).
  const decision = DecisionSchema.parse({ ...receipt.decision, humanExplanation: x.human_explanation });
  return { decision, receipt, receiptHash: Hex32Schema.parse(x.receipt_hash), signature: x.signature, signer: x.signer };
}

const DECISION_JOIN = `select d.human_explanation, r.receipt_hash, r.receipt, r.signature, r.signer
                         from decisions d join receipts r on r.decision_id = d.decision_id`;

export async function getStoredDecision(q: Queryable, tenantId: string, decisionId: string): Promise<StoredDecision | null> {
  const r = await q.query<DecisionJoin>(`${DECISION_JOIN} where d.tenant_id = $1 and d.decision_id = $2`, [tenantId, decisionId]);
  const x = r.rows[0];
  return x === undefined ? null : mapStored(x);
}

export async function getLatestStoredDecisionForIntent(q: Queryable, tenantId: string, intentId: string): Promise<StoredDecision | null> {
  const r = await q.query<DecisionJoin>(
    `${DECISION_JOIN} where d.tenant_id = $1 and d.intent_id = $2 and not exists (select 1 from decisions s where s.supersedes = d.decision_id)
      order by d.created_at desc, d.decision_id desc limit 1`,
    [tenantId, intentId],
  );
  const x = r.rows[0];
  return x === undefined ? null : mapStored(x);
}

export async function getStoredReceipt(q: Queryable, tenantId: string, receiptHash: string): Promise<StoredDecision | null> {
  const r = await q.query<DecisionJoin>(`${DECISION_JOIN} where d.tenant_id = $1 and r.receipt_hash = $2`, [tenantId, receiptHash]);
  const x = r.rows[0];
  return x === undefined ? null : mapStored(x);
}

export async function writeAudit(q: Queryable, actor: string, action: string, detail: Record<string, unknown>): Promise<void> {
  await q.query("insert into audit_log (actor, action, detail) values ($1, $2, $3::jsonb)", [actor, action, JSON.stringify(detail)]);
}

/** Per-tenant serialisation of evaluate-and-persist, so the caps and duplicate guards see every earlier decision (race guard). */
export async function lockTenantForDecisions(q: Queryable, tenantId: string): Promise<void> {
  await q.query("select pg_advisory_xact_lock(hashtextextended($1, 2))", [`decide:${tenantId}`]);
}
