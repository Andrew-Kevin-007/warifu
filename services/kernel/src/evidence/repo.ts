// Evidence persistence (docs/05 `evidence` table). Tenant scoped through the milestone's engagement. Rows are written ONLY by
// the evidence service (collected_by is the literal 'kernel', also a CHECK constraint); nothing the web app or an LLM sends is
// ever stored as evidence.
import { computeTermsHash } from "@symbolon/schemas";
import type { Engagement, Hex32, ISODateTime, Milestone } from "@symbolon/schemas";
import type { Queryable } from "../db/pool";
import * as base from "../db/repo";
import { normalizePolicy } from "@symbolon/policy";
import type { Collected } from "./collectors";

export interface MilestoneScope {
  readonly engagement: Engagement;
  readonly milestone: Milestone;
}

/**
 * The tenant's milestone with its signed engagement, or null when it is not the tenant's. A row whose terms no longer hash to the
 * stored termsHash is refused (throws): the spec we would fetch from must be exactly what the parties signed.
 */
export async function loadMilestoneScope(q: Queryable, tenantId: string, milestoneId: Hex32): Promise<MilestoneScope | null> {
  const r = await q.query<{ engagement_id: string }>(
    `select m.engagement_id from milestones m join engagements e on e.engagement_id = m.engagement_id where e.tenant_id = $1 and m.milestone_id = $2`,
    [tenantId, milestoneId],
  );
  const engagementId = r.rows[0]?.engagement_id;
  if (engagementId === undefined) return null;
  const engagement = await base.loadEngagement(q, tenantId, engagementId);
  if (engagement === null) return null;
  if (computeTermsHash(engagement) !== engagement.termsHash) throw new TermsRowInconsistent();
  const milestone = engagement.milestones.find((m) => m.milestoneId === milestoneId);
  return milestone === undefined ? null : { engagement, milestone };
}

export class TermsRowInconsistent extends Error {
  constructor() {
    super("the stored engagement does not match its termsHash");
    this.name = "TermsRowInconsistent";
  }
}

export interface NewEvidence {
  readonly evidenceId: string;
  readonly milestoneId: Hex32;
  readonly type: "OWNER_ACK" | "CI_PASS" | "URL_HEALTH" | "ARTIFACT_HASH";
  readonly collectedAt: ISODateTime;
  readonly collected: Collected;
  readonly payloadHash: Hex32;
}

/**
 * Insert one observation. `dedupe` skips the insert when an identical observation (same type, source, payload hash and result)
 * already exists: used for fixtures and refusals, which would otherwise pile up on every collect call. Live observations are
 * never deduped, because a later identical result is fresher evidence (`collected_at` is what the freshness window reads).
 */
export async function insertEvidence(q: Queryable, e: NewEvidence, dedupe: boolean): Promise<boolean> {
  const r = await q.query(
    `insert into evidence (evidence_id, milestone_id, type, collected_by, collected_at, source, payload, payload_hash, result, details)
     select $1::uuid, $2::text, $3::text, 'kernel', $4::timestamptz, $5::text, $6::jsonb, $7::text, $8::text, $9::text
      where not ($10::boolean and exists (select 1 from evidence where milestone_id = $2::text and type = $3::text and source = $5::text and payload_hash = $7::text and result = $8::text))`,
    [e.evidenceId, e.milestoneId, e.type, e.collectedAt, e.collected.source, JSON.stringify(e.collected.payload), e.payloadHash, e.collected.result, e.collected.details, dedupe],
  );
  return r.rowCount === 1;
}

/** The tenant policy's `evidence.urlAllowlist` (host patterns), after the stored policy is verified against its stored hash. */
export async function loadPolicyUrlAllowlist(q: Queryable, tenantId: string): Promise<readonly string[]> {
  const t = await base.getTenant(q, tenantId);
  if (t === null) throw new Error("unknown tenant");
  const loaded = normalizePolicy(t.policy);
  if (loaded.policyHash !== t.policyHash) throw new Error("stored policy does not match its stored hash");
  return loaded.policy.evidence.urlAllowlist;
}
