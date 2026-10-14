// The evidence service (docs/04 K-09, docs/05 section 4: POST /evidence/collect, /evidence/artifact, /evidence/ack).
//
// Who may produce evidence, by profile (INV-16, RT-02):
//   production  `source.kind = "live"`: CI_PASS (GitHub REST) and URL_HEALTH (guarded fetch) are collected by the kernel; ARTIFACT_HASH
//               comes from bytes uploaded to the kernel and hashed by it; OWNER_ACK from an owner EIP-712 signature the kernel verifies.
//   sandbox     `source.kind = "fixtures"`: NO network code is reachable. Evidence exists only if the scenario fixture store holds a
//               record for the exact spec entry; everything else is EVIDENCE_SOURCE_DENIED. Uploads and acks are refused (an attacker
//               cannot upload a file or sign as the owner; the scenario's own acks are fixtures).
// The factory refuses the wrong pairing, so a mis-wired sandbox cannot grow a socket and a mis-wired production cannot accept invented
// evidence. Every URL fetched comes from the SIGNED engagement's spec entry (its row is re-hashed against termsHash first).
import { SOURCE_OWNER_ACK } from "@symbolon/kernel-core";
import { eip712Digest, eip712DomainSeparator, EvidenceSchema, Hex32Schema, HexBytesSchema, Uint64StringSchema, hashJcs, symbolonDomain, toTypedDataJson, untrusted } from "@symbolon/schemas";
import type { Evidence, EvidenceRequirement, Hex32 } from "@symbolon/schemas";
import { randomUUID } from "node:crypto";
import * as z from "zod";
import type { Profile } from "../boot";
import type { BlobStore } from "../blob/store";
import type { ChainReader } from "../chain/reader";
import type { EngagementChain } from "../chain/engagement-chain";
import { ContextError, resolveTenantVault } from "../context/build";
import type { Db } from "../db/pool";
import { loadEvidence } from "../db/repo";
import { ApiError } from "../errors";
import { errorFields } from "../log";
import type { Logger } from "../log";
import { nowIso } from "../time";
import type { Clock } from "../time";
import { collectArtifactHash, collectCiPass, collectUrlHealth, denial, isNotYet } from "./collectors";
import type { Collected, NotYet } from "./collectors";
import type { FixtureStore } from "./fixtures";
import { fixtureToCollected } from "./fixtures";
import * as repo from "./repo";
import type { GuardDeps, GuardLimits } from "./ssrf/guard";
import { hostMatches, originPatternHost, parseEvidenceUrl } from "./ssrf/url";

export type EvidenceSource =
  | { readonly kind: "fixtures"; readonly fixtures: FixtureStore }
  | { readonly kind: "live"; readonly guard: GuardDeps; readonly githubToken: string | null; readonly limits?: Partial<GuardLimits> };

export interface EvidenceServiceDeps {
  readonly db: Db;
  readonly clock: Clock;
  readonly profile: Profile;
  readonly logger: Logger;
  readonly source: EvidenceSource;
  readonly chain: ChainReader;
  readonly engagementChain: Pick<EngagementChain, "chainId" | "domainSeparator" | "isValidSignature">;
  readonly blobs: BlobStore;
  /** Largest artifact the kernel will hash. */
  readonly maxArtifactBytes: number;
  /** Tenant policy `evidence.urlAllowlist`. Default: read and verify the tenant's stored policy. */
  readonly policyUrlAllowlist?: (tenantId: string) => Promise<readonly string[]>;
  readonly newUuid?: () => string;
}

/** INV-16: the sandbox has no network path for evidence; production never accepts fixture evidence. */
export function assertEvidencePairing(profile: Profile, source: EvidenceSource): void {
  if (profile === "sandbox" && source.kind !== "fixtures") throw new Error("the sandbox profile may only use fixture evidence (INV-16, RT-02)");
  if (profile === "production" && source.kind !== "live") throw new Error("the production profile may not use fixture evidence (INV-16)");
}

const MAX_ACK_HORIZON_SECONDS = 30 * 24 * 3600;
const ACK_REQUIREMENT: EvidenceRequirement = { type: "OWNER_ACK" };

// --- shared ---------------------------------------------------------------------------------------------------------------------

function unavailable(e: unknown, logger: Logger): ApiError {
  if (e instanceof ApiError) return e;
  logger.error("evidence.unavailable", { ...errorFields(e) });
  if (e instanceof repo.TermsRowInconsistent) return new ApiError("TERMS_MISMATCH", "the stored terms do not match their termsHash; refusing");
  return new ApiError("UNAVAILABLE", "the service cannot complete this request right now");
}

async function scope(d: EvidenceServiceDeps, tenantId: string, milestoneId: Hex32): Promise<repo.MilestoneScope> {
  const s = await repo.loadMilestoneScope(d.db, tenantId, milestoneId);
  if (s === null) throw new ApiError("NOT_FOUND", "not found");
  if (s.engagement.status !== "ACTIVE") throw new ApiError("CONFLICT", "the engagement is not active", { status: s.engagement.status });
  return s;
}

function toEvidence(id: string, milestoneId: Hex32, type: Evidence["type"], at: string, c: Collected, payloadHash: Hex32): Evidence {
  return EvidenceSchema.parse({
    evidenceId: id,
    milestoneId,
    type,
    collectedBy: "kernel",
    collectedAt: at,
    source: c.source,
    payload: c.payload,
    payloadHash,
    result: c.result,
    details: untrusted(c.details),
  });
}

interface Persisted {
  readonly evidence: Evidence[];
  readonly unchanged: number;
}

async function persist(d: EvidenceServiceDeps, milestoneId: Hex32, items: ReadonlyArray<{ type: Evidence["type"]; collected: Collected; dedupe: boolean }>): Promise<Persisted> {
  const at = nowIso(d.clock);
  const mint = d.newUuid ?? randomUUID;
  const evidence: Evidence[] = [];
  let unchanged = 0;
  await d.db.tx(async (q) => {
    for (const it of items) {
      const payloadHash = hashJcs(it.collected.payload);
      const evidenceId = mint();
      const ev = toEvidence(evidenceId, milestoneId, it.type, at, it.collected, payloadHash);
      const inserted = await repo.insertEvidence(q, { evidenceId, milestoneId, type: it.type, collectedAt: at, collected: it.collected, payloadHash }, it.dedupe);
      if (inserted) evidence.push(ev);
      else unchanged++;
    }
  });
  return { evidence, unchanged };
}

// --- POST /evidence/collect -------------------------------------------------------------------------------------------------------

const CollectBodySchema = z.strictObject({ milestoneId: Hex32Schema });

export interface CollectResponse {
  readonly milestoneId: Hex32;
  readonly mode: "fixtures" | "live";
  /** Rows written by this call. */
  readonly evidence: Evidence[];
  /** Identical refusals/fixtures already on file (not written again). */
  readonly unchanged: number;
  /** Refused sources: K-09 reads these as HOLD EVIDENCE_SOURCE_DENIED. */
  readonly denied: ReadonlyArray<{ index: number; type: EvidenceRequirement["type"]; reasonCode: "EVIDENCE_SOURCE_DENIED"; guardCode: string }>;
  /** Not there yet (no matching CI run, run in progress): the requirement stays EVIDENCE_MISSING. */
  readonly pending: ReadonlyArray<{ index: number; type: EvidenceRequirement["type"]; reason: string }>;
  /** Come in through their own endpoint (signature / upload), never by fetching. */
  readonly awaiting: ReadonlyArray<{ index: number; type: EvidenceRequirement["type"]; via: string }>;
}

async function allowedHostsFor(d: EvidenceServiceDeps, tenantId: string, r: Extract<EvidenceRequirement, { type: "URL_HEALTH" }>): Promise<string[]> {
  const parsed = parseEvidenceUrl(r.url);
  if (!parsed.ok) return []; // the guard reports the exact grammar violation
  const policy = await (d.policyUrlAllowlist ?? ((t: string) => repo.loadPolicyUrlAllowlist(d.db, t)))(tenantId);
  // An empty policy list adds no restriction (the signed spec is the authority); a non-empty one narrows it.
  if (policy.length > 0) {
    const patterns = policy.map(originPatternHost).filter((p): p is string => p !== null);
    if (!patterns.some((p) => hostMatches(parsed.url.host, p))) return [];
  }
  return [parsed.url.host];
}

export async function collectEvidence(d: EvidenceServiceDeps, tenantId: string, raw: unknown): Promise<CollectResponse> {
  const body = CollectBodySchema.safeParse(raw);
  if (!body.success) throw new ApiError("BAD_REQUEST", "expected {milestoneId}");
  try {
    const { milestone } = await scope(d, tenantId, body.data.milestoneId);
    const spec = milestone.evidenceSpec;
    const now = nowIso(d.clock);
    const items: Array<{ type: Evidence["type"]; collected: Collected; dedupe: boolean }> = [];
    const denied: Array<CollectResponse["denied"][number]> = [];
    const pending: Array<CollectResponse["pending"][number]> = [];
    const awaiting: Array<CollectResponse["awaiting"][number]> = [];
    const source = d.source;

    const note = (index: number, r: EvidenceRequirement, c: Collected): void => {
      if (c.payload["denied"] === true) {
        const guardCode = typeof c.payload["guardCode"] === "string" ? c.payload["guardCode"] : "UNKNOWN";
        denied.push({ index, type: r.type, reasonCode: "EVIDENCE_SOURCE_DENIED", guardCode });
        d.logger.warn("evidence.denied", { tenantId, milestoneId: milestone.milestoneId, reasonCode: guardCode.replace(/[^A-Za-z0-9_]/g, "_").slice(0, 40), ...(typeof c.payload["urlHash"] === "string" ? { urlHash: c.payload["urlHash"] } : {}) });
      }
    };

    if (source.kind === "fixtures") {
      // No fetch of any kind. A reference with no fixture is a refusal, whatever it says.
      spec.forEach((r, index) => {
        const fx = source.fixtures.find(milestone.milestoneId, r, now);
        const c = fx === null ? denial(r, "EGRESS_DISABLED", null) : fixtureToCollected(fx, r);
        items.push({ type: r.type, collected: c, dedupe: true });
        note(index, r, c);
      });
    } else {
      const outcomes = await Promise.all(
        spec.map(async (r, index): Promise<{ index: number; r: EvidenceRequirement; c: Collected | NotYet | null }> => {
          switch (r.type) {
            case "URL_HEALTH":
              return { index, r, c: await collectUrlHealth(r, await allowedHostsFor(d, tenantId, r), { guard: source.guard, ...(source.limits === undefined ? {} : { limits: source.limits }) }) };
            case "CI_PASS":
              return { index, r, c: await collectCiPass(r, { guard: source.guard, githubToken: source.githubToken, ...(source.limits === undefined ? {} : { limits: source.limits }) }) };
            case "OWNER_ACK":
            case "ARTIFACT_HASH":
              return { index, r, c: null };
            default: {
              const never: never = r;
              return never;
            }
          }
        }),
      );
      for (const o of outcomes) {
        if (o.c === null) awaiting.push({ index: o.index, type: o.r.type, via: o.r.type === "OWNER_ACK" ? "POST /v1/evidence/ack" : "POST /v1/evidence/artifact" });
        else if (isNotYet(o.c)) pending.push({ index: o.index, type: o.r.type, reason: o.c.reason });
        else {
          // refusals dedupe (they repeat on every call); real observations never do (a later one is fresher)
          items.push({ type: o.r.type, collected: o.c, dedupe: o.c.payload["denied"] === true });
          note(o.index, o.r, o.c);
        }
      }
    }

    const saved = await persist(d, milestone.milestoneId, items);
    d.logger.info("evidence.collected", { tenantId, milestoneId: milestone.milestoneId, count: saved.evidence.length });
    return { milestoneId: milestone.milestoneId, mode: source.kind, evidence: saved.evidence, unchanged: saved.unchanged, denied, pending, awaiting };
  } catch (e) {
    throw unavailable(e, d.logger);
  }
}

// --- POST /evidence/artifact ------------------------------------------------------------------------------------------------------

export interface ArtifactResponse {
  readonly sha256: Hex32;
  readonly size: number;
  readonly evidence: Evidence;
}

/** The bytes are hashed and stored opaquely. They are never decoded, sniffed, decompressed or parsed (INV-23, RT-03). */
export async function uploadArtifact(d: EvidenceServiceDeps, tenantId: string, rawMilestoneId: unknown, bytes: Uint8Array): Promise<ArtifactResponse> {
  if (d.source.kind !== "live") throw new ApiError("FORBIDDEN", "artifact uploads are not accepted by the sandbox profile");
  const mid = Hex32Schema.safeParse(rawMilestoneId);
  if (!mid.success) throw new ApiError("BAD_REQUEST", "expected a milestoneId");
  if (bytes.byteLength === 0) throw new ApiError("BAD_REQUEST", "empty artifact");
  if (bytes.byteLength > d.maxArtifactBytes) throw new ApiError("PAYLOAD_TOO_LARGE", "artifact is too large", { maxBytes: d.maxArtifactBytes });
  try {
    const { milestone } = await scope(d, tenantId, mid.data);
    const reqs = milestone.evidenceSpec.filter((r): r is Extract<EvidenceRequirement, { type: "ARTIFACT_HASH" }> => r.type === "ARTIFACT_HASH");
    if (reqs.length === 0) throw new ApiError("UNPROCESSABLE", "this milestone does not require an artifact hash");
    const probe = collectArtifactHash(reqs[0] as (typeof reqs)[number], bytes);
    const sha256 = probe.payload["sha256"] as Hex32;
    // compare against the entry the upload matches, else the first one (recorded as a mismatch, never a pass)
    const req = reqs.find((r) => r.sha256 === sha256) ?? (reqs[0] as (typeof reqs)[number]);
    const collected = collectArtifactHash(req, bytes);
    try {
      await d.blobs.put(sha256.slice(2), bytes);
    } catch (cause) {
      d.logger.error("evidence.blob_failed", { ...errorFields(cause) });
      throw new ApiError("UNAVAILABLE", "artifact storage is not available");
    }
    const saved = await persist(d, milestone.milestoneId, [{ type: "ARTIFACT_HASH", collected, dedupe: false }]);
    const ev = saved.evidence[0];
    if (ev === undefined) throw new ApiError("INTERNAL", "evidence was not recorded");
    d.logger.info("evidence.artifact", { tenantId, milestoneId: milestone.milestoneId, count: bytes.byteLength });
    return { sha256, size: bytes.byteLength, evidence: ev };
  } catch (e) {
    throw unavailable(e, d.logger);
  }
}

// --- POST /evidence/ack -----------------------------------------------------------------------------------------------------------

const AckBodySchema = z.strictObject({
  milestoneId: Hex32Schema,
  artifactHash: Hex32Schema,
  override: z.boolean(),
  deadline: Uint64StringSchema,
  signature: HexBytesSchema,
});

/**
 * Verify an owner's EIP-712 `MilestoneAck` (docs/06) under the vault's own domain and record it. The signer must be the owner
 * named in the SIGNED engagement. Whether `override` is honoured is K-09's call (policy.evidence.allowOwnerOverride); it is
 * recorded verbatim.
 */
export async function submitOwnerAck(d: EvidenceServiceDeps, tenantId: string, raw: unknown): Promise<Evidence> {
  if (d.source.kind !== "live") throw new ApiError("FORBIDDEN", "owner acks are not accepted by the sandbox profile (scenario acks are fixtures)");
  const body = AckBodySchema.safeParse(raw);
  if (!body.success) throw new ApiError("BAD_REQUEST", "not a valid milestone ack");
  const a = body.data;
  const nowSec = BigInt(Math.floor(d.clock() / 1000));
  const deadline = BigInt(a.deadline);
  if (deadline <= nowSec) throw new ApiError("UNPROCESSABLE", "the ack has expired");
  if (deadline > nowSec + BigInt(MAX_ACK_HORIZON_SECONDS)) throw new ApiError("UNPROCESSABLE", "the ack deadline is too far in the future");
  try {
    const { engagement, milestone } = await scope(d, tenantId, a.milestoneId);
    const needsAck = milestone.evidenceSpec.some((r) => r.type === "OWNER_ACK");
    if (!needsAck && !a.override) throw new ApiError("UNPROCESSABLE", "this milestone does not take an owner ack (an override ack is the only exception)");

    const tv = await resolveTenantVault(d.db, tenantId, d.chain);
    if (d.engagementChain.chainId !== tv.chainId) throw new ContextError("CHAIN_MISMATCH", "tenant chain differs from the configured RPC chain");
    const domain = symbolonDomain(tv.chainId, tv.vault);
    if ((await d.engagementChain.domainSeparator(tv.vault)) !== eip712DomainSeparator(domain)) throw new ContextError("CHAIN_MISMATCH", "the vault's EIP-712 domain differs from the one derived for it");

    const td = toTypedDataJson("MilestoneAck", domain, { milestoneId: a.milestoneId, artifactHash: a.artifactHash, override: a.override, deadline: a.deadline });
    if (!(await d.engagementChain.isValidSignature(engagement.owner, eip712Digest(td), a.signature))) {
      throw new ApiError("BAD_SIGNATURE", "the signature does not verify for the engagement owner over this ack");
    }
    const collected: Collected = {
      source: SOURCE_OWNER_ACK,
      payload: {
        requirementHash: hashJcs(ACK_REQUIREMENT),
        milestoneId: milestone.milestoneId,
        signer: engagement.owner,
        artifactHash: a.artifactHash,
        override: a.override,
        deadline: a.deadline,
        signature: a.signature,
        chainId: tv.chainId,
        vault: tv.vault,
      },
      result: "PASS",
      details: a.override ? "OWNER_ACK (override) signed by the engagement owner" : "OWNER_ACK signed by the engagement owner",
    };
    // the same signed ack twice is one observation; a fresh signature is a fresh observation
    const saved = await persist(d, milestone.milestoneId, [{ type: "OWNER_ACK", collected, dedupe: true }]);
    const ev = saved.evidence[0];
    if (ev !== undefined) {
      d.logger.info("evidence.ack", { tenantId, milestoneId: milestone.milestoneId });
      return ev;
    }
    // idempotent replay: return the stored row
    const existing = await d.db.query<{ evidence_id: string }>(
      `select evidence_id from evidence where milestone_id = $1 and type = 'OWNER_ACK' and payload_hash = $2 order by collected_at desc limit 1`,
      [milestone.milestoneId, hashJcs(collected.payload)],
    );
    const id = existing.rows[0]?.evidence_id;
    const row = id === undefined ? undefined : (await loadEvidence(d.db, tenantId, milestone.milestoneId)).evidence.find((x) => x.evidenceId === id);
    if (row === undefined) throw new ApiError("INTERNAL", "evidence was not recorded");
    return row;
  } catch (e) {
    throw unavailable(e, d.logger);
  }
}
