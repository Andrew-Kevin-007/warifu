// Evidence assessment for K-09 EVIDENCE_MATCH and K-14 timing (docs/04 K-09, docs/15 §2/§5; WP-05).
// PURE: it evaluates only the Evidence[] the kernel service collected and put in the context. It never fetches,
// resolves or opens anything (the SSRF guard, DNS pinning and the collectors are services/kernel, WP-13); the pure
// side decides which SOURCES are acceptable and whether each requirement of the SIGNED milestone spec is met.
//
// Contract binding on KERNEL-SVC (WP-13 collectors, WP-32 sandbox injection; docs/QUESTIONS.md "WP-05"):
//   every Evidence: EvidenceSchema-valid, collectedBy 'kernel', milestoneId = the milestone, collectedAt <= now
//   production sources and payloads, per requirement type:
//     OWNER_ACK      source 'eip712:MilestoneAck'  payload {milestoneId, artifactHash, override, deadline, signer}
//                    (the verified MilestoneAck message plus the recovered signer; signer must be engagement.owner)
//     CI_PASS        source 'github:actions'       payload {repo, ref, headSha, conclusion, workflow?}
//     URL_HEALTH     source = the spec url         payload {url, status, bodySha256 (0x.. or null)}
//     ARTIFACT_HASH  source 'kernel:artifact'      payload {sha256}
//   sandbox (profile 'sandbox', EVIDENCE_MODE=fixtures): source 'fixture:<fixtureId>' and payload.requirement equal
//   (JCS) to the spec entry it satisfies; the fixture's `result` is authoritative and nothing else is read.
// Outcomes per requirement: SATISFIED | MISSING (none, stale, collector ERROR) | FAILED (FAIL result, red CI,
// wrong status, wrong commit) | TAMPERED (pinned hash differs) | DENIED (source not acceptable: fixture outside
// the sandbox, a non-fixture in the sandbox, an un-allowlisted or malformed URL in production).
// Readings fixed here: freshness (policy.evidence.freshnessHours) applies to every type, not only OWNER_ACK; the
// LATEST matching observation decides; an owner override (OWNER_ACK with override=true, production only, when
// policy.evidence.allowOwnerOverride) satisfies MISSING/FAILED/DENIED requirements but never a TAMPERED one; an empty
// evidenceSpec (all_of over nothing, signed by both parties) is satisfied at invoiceReceivedAt.
import { EvidenceSchema, epochSecondsFromIso, jcs } from "@symbolon/schemas";
import type { Address, Evidence, EvidenceRequirement, ISODateTime, Milestone, UUID } from "@symbolon/schemas";
import type { LoadedPolicy } from "@symbolon/policy";
import type { KernelContext } from "./context";

export type RequirementState = "SATISFIED" | "MISSING" | "FAILED" | "TAMPERED" | "DENIED";

export interface RequirementStatus {
  readonly index: number;
  readonly type: EvidenceRequirement["type"];
  readonly state: RequirementState;
  /** collectedAt of the evidence that satisfied it (or of the override ack). */
  readonly satisfiedAt: ISODateTime | null;
  readonly evidenceId: UUID | null;
  /** Kernel-written; never quotes collector details or payload text. */
  readonly detail: string;
}

export interface EvidenceAssessment {
  readonly requirements: readonly RequirementStatus[];
  readonly satisfied: boolean;
  /** When the all_of became true (max over requirements); null unless satisfied. */
  readonly satisfiedAt: ISODateTime | null;
  /** Evidence entries ignored: malformed, not kernel-collected, another milestone, or dated after now. */
  readonly ignored: number;
  readonly overrideBy: UUID | null;
}

export const SOURCE_OWNER_ACK = "eip712:MilestoneAck";
export const SOURCE_GITHUB = "github:actions";
export const SOURCE_ARTIFACT = "kernel:artifact";
const FIXTURE_SOURCE = /^fixture:[A-Za-z0-9._-]{1,64}$/;
const HEX32 = /^0x[0-9a-f]{64}$/;
const SHA40 = /^[0-9a-f]{40}$/i;
const UINT = /^(0|[1-9][0-9]{0,19})$/;

// --- URL source policy (the pure half of the SSRF guard) -------------------------------------------------------

export type UrlDenial = "SCHEME" | "USERINFO" | "IP_LITERAL" | "PORT" | "HOST_SYNTAX" | "NOT_ALLOWLISTED";
export type UrlDecision = { readonly allowed: true; readonly host: string } | { readonly allowed: false; readonly reason: UrlDenial };

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const LETTER_START = /^[a-z]/;

/**
 * May the kernel accept evidence about `url`? https only; port 443 only; no userinfo; a DNS host name (ASCII,
 * lowercase-compared, >= 2 labels, last label starting with a letter, so no IPv4/IPv6 literal in any spelling, no
 * trailing dot); and the host must match `policy.evidence.urlAllowlist` ("https://host" exactly or
 * "https://*.host" for strict subdomains). The service still resolves once, pins the IP and blocks non-global
 * ranges (WP-13); this function decides the source, it never connects.
 */
export function urlSourceDecision(url: string, allowlist: readonly string[]): UrlDecision {
  if (typeof url !== "string" || !url.startsWith("https://")) return { allowed: false, reason: "SCHEME" };
  const rest = url.slice("https://".length);
  const end = rest.search(/[/?#]/);
  const authority = end === -1 ? rest : rest.slice(0, end);
  if (authority.includes("@")) return { allowed: false, reason: "USERINFO" };
  if (authority.startsWith("[")) return { allowed: false, reason: "IP_LITERAL" };
  const colon = authority.lastIndexOf(":");
  if (colon !== -1 && authority.slice(colon + 1) !== "443") return { allowed: false, reason: "PORT" };
  const host = (colon === -1 ? authority : authority.slice(0, colon)).toLowerCase();
  const labels = host.split(".");
  if (host.length > 253 || labels.length < 2 || !labels.every((l) => LABEL.test(l))) return { allowed: false, reason: "HOST_SYNTAX" };
  if (!LETTER_START.test(labels[labels.length - 1] as string)) return { allowed: false, reason: "IP_LITERAL" };
  for (const pattern of allowlist) {
    const base = pattern.slice("https://".length);
    if (base.startsWith("*.")) {
      if (host.endsWith(base.slice(1))) return { allowed: true, host };
    } else if (host === base) {
      return { allowed: true, host };
    }
  }
  return { allowed: false, reason: "NOT_ALLOWLISTED" };
}

// --- payload readers (payload is collector JSON: read defensively, never trusted for shape) ----------------------

type Json = Readonly<Record<string, unknown>>;
const isRecord = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (o: Json, k: string): string | null => (typeof o[k] === "string" ? (o[k] as string) : null);

/** Is this OWNER_ACK evidence a valid acknowledgement of `milestoneId` by `owner`? (override flag returned) */
function readAck(e: Evidence, milestoneId: string, owner: Address): { readonly override: boolean } | null {
  const p = e.payload;
  if (!isRecord(p)) return null;
  const signer = str(p, "signer");
  const deadline = str(p, "deadline");
  const artifactHash = str(p, "artifactHash");
  if (str(p, "milestoneId") !== milestoneId || signer === null || signer.toLowerCase() !== owner.toLowerCase()) return null;
  if (artifactHash === null || !HEX32.test(artifactHash) || typeof p.override !== "boolean") return null;
  if (deadline === null || !UINT.test(deadline) || BigInt(deadline) < epochSecondsFromIso(e.collectedAt)) return null;
  return { override: p.override };
}

// --- assessment ------------------------------------------------------------------------------------------------

interface Observation {
  readonly evidence: Evidence;
  /** The requirement outcome this observation implies when it is the latest one. */
  readonly state: Exclude<RequirementState, "DENIED">;
  readonly detail: string;
}

const later = (a: Evidence, b: Evidence): boolean => a.collectedAt > b.collectedAt || (a.collectedAt === b.collectedAt && a.evidenceId > b.evidenceId);

/** PASS => the type-specific condition; FAIL => FAILED; ERROR (collector could not decide) => MISSING. */
function resultState(e: Evidence, passCondition: () => Observation["state"]): Observation["state"] {
  if (e.result === "PASS") return passCondition();
  return e.result === "FAIL" ? "FAILED" : "MISSING";
}

/**
 * Production: does `e` observe requirement `req`? Returns the implied outcome, or null when `e` is about something
 * else (another repo, another url, another hash). Source acceptance is checked by the caller.
 */
function observeProduction(req: EvidenceRequirement, e: Evidence, milestoneId: string, owner: Address): Observation | null {
  const p = e.payload;
  if (req.type === "OWNER_ACK") {
    if (readAck(e, milestoneId, owner) === null) return null;
    return { evidence: e, state: resultState(e, () => "SATISFIED"), detail: "owner acknowledgement" };
  }
  if (!isRecord(p)) return null;
  if (req.type === "CI_PASS") {
    if (str(p, "repo") !== req.repo || str(p, "ref") !== req.ref) return null;
    if (req.workflow !== undefined && str(p, "workflow") !== req.workflow) return null;
    const headSha = str(p, "headSha");
    // A ref pinned to a commit sha must be exactly the commit CI ran on; a branch ref takes the run as reported.
    const wrongCommit = SHA40.test(req.ref) && (headSha === null || headSha.toLowerCase() !== req.ref.toLowerCase());
    return { evidence: e, state: resultState(e, () => (str(p, "conclusion") !== "success" || wrongCommit ? "FAILED" : "SATISFIED")), detail: "CI run" };
  }
  if (req.type === "URL_HEALTH") {
    if (str(p, "url") !== req.url) return null;
    const state = resultState(e, () => {
      if (p.status !== req.expectStatus) return "FAILED";
      if (req.contentSha256 !== undefined && p.bodySha256 !== req.contentSha256) return "TAMPERED";
      return "SATISFIED";
    });
    return { evidence: e, state, detail: "URL health" };
  }
  // ARTIFACT_HASH: the kernel-computed hash of the uploaded artifact must equal the signed spec hash.
  if (typeof p.sha256 !== "string") return null;
  return { evidence: e, state: resultState(e, () => (p.sha256 === req.sha256 ? "SATISFIED" : "TAMPERED")), detail: "artifact hash" };
}

/** The only source a production collector may report for this requirement. */
function productionSource(req: EvidenceRequirement): string {
  if (req.type === "URL_HEALTH") return req.url;
  return req.type === "OWNER_ACK" ? SOURCE_OWNER_ACK : req.type === "CI_PASS" ? SOURCE_GITHUB : SOURCE_ARTIFACT;
}

function assessRequirement(index: number, req: EvidenceRequirement, pool: readonly Evidence[], ctx: KernelContext, policy: LoadedPolicy, milestoneId: string, owner: Address): RequirementStatus {
  const sameType = pool.filter((e) => e.type === req.type);
  const base = { index, type: req.type };
  let observations: Observation[];
  let deniedSources = 0;
  if (ctx.profile !== "production") {
    // Sandbox (and anything that is not exactly 'production'): fixtures only, nothing else is evidence.
    observations = [];
    for (const e of sameType) {
      const p = e.payload;
      if (FIXTURE_SOURCE.test(e.source) && isRecord(p) && jcs(p.requirement ?? null) === jcs(req)) {
        observations.push({ evidence: e, state: resultState(e, () => "SATISFIED"), detail: "sandbox fixture" });
      } else {
        deniedSources++;
      }
    }
  } else {
    if (req.type === "URL_HEALTH") {
      const decision = urlSourceDecision(req.url, policy.policy.evidence.urlAllowlist);
      if (!decision.allowed) return { ...base, state: "DENIED", satisfiedAt: null, evidenceId: null, detail: `URL source denied (${decision.reason})` };
    }
    observations = [];
    for (const e of sameType) {
      if (e.source !== productionSource(req)) {
        deniedSources++;
        continue;
      }
      const o = observeProduction(req, e, milestoneId, owner);
      if (o !== null) observations.push(o);
    }
  }
  const freshFor = BigInt(policy.policy.evidence.freshnessHours) * 3_600n;
  const now = epochSecondsFromIso(ctx.now);
  const fresh = observations.filter((o) => now - epochSecondsFromIso(o.evidence.collectedAt) <= freshFor);
  if (fresh.length === 0) {
    if (observations.length > 0) return { ...base, state: "MISSING", satisfiedAt: null, evidenceId: null, detail: `only stale evidence (older than ${policy.policy.evidence.freshnessHours} h)` };
    if (deniedSources > 0) return { ...base, state: "DENIED", satisfiedAt: null, evidenceId: null, detail: `${deniedSources} evidence record(s) from a source not accepted under the ${ctx.profile} profile` };
    return { ...base, state: "MISSING", satisfiedAt: null, evidenceId: null, detail: "no kernel-collected evidence" };
  }
  const latest = fresh.reduce((best, o) => (later(o.evidence, best.evidence) ? o : best));
  return {
    ...base,
    state: latest.state,
    satisfiedAt: latest.state === "SATISFIED" ? latest.evidence.collectedAt : null,
    evidenceId: latest.evidence.evidenceId,
    detail: `${latest.detail}: ${latest.state.toLowerCase()}`,
  };
}

/** The latest fresh, valid owner-override acknowledgement (production only, when the policy allows overrides). */
function overrideAck(pool: readonly Evidence[], ctx: KernelContext, policy: LoadedPolicy, milestoneId: string, owner: Address): Evidence | null {
  if (ctx.profile !== "production" || !policy.policy.evidence.allowOwnerOverride) return null;
  const freshFor = BigInt(policy.policy.evidence.freshnessHours) * 3_600n;
  const now = epochSecondsFromIso(ctx.now);
  const acks = pool.filter(
    (e) =>
      e.type === "OWNER_ACK" &&
      e.source === SOURCE_OWNER_ACK &&
      e.result === "PASS" &&
      now - epochSecondsFromIso(e.collectedAt) <= freshFor &&
      readAck(e, milestoneId, owner)?.override === true,
  );
  return acks.length === 0 ? null : acks.reduce((best, e) => (later(e, best) ? e : best));
}

/**
 * Assess the signed milestone's evidenceSpec (all_of) against ctx.evidence. `owner` is the engagement owner (the only
 * valid OWNER_ACK signer).
 */
export function assessEvidence(milestone: Milestone, owner: Address, ctx: KernelContext, policy: LoadedPolicy): EvidenceAssessment {
  const now = epochSecondsFromIso(ctx.now);
  const pool: Evidence[] = [];
  let ignored = 0;
  for (const raw of ctx.evidence) {
    const parsed = EvidenceSchema.safeParse(raw);
    if (!parsed.success || parsed.data.milestoneId !== milestone.milestoneId || epochSecondsFromIso(parsed.data.collectedAt) > now) {
      ignored++;
      continue;
    }
    pool.push(parsed.data);
  }
  let requirements = milestone.evidenceSpec.map((req, i) => assessRequirement(i, req, pool, ctx, policy, milestone.milestoneId, owner));
  const ack = overrideAck(pool, ctx, policy, milestone.milestoneId, owner);
  if (ack !== null) {
    requirements = requirements.map((r) =>
      r.state === "SATISFIED" || r.state === "TAMPERED" ? r : { ...r, state: "SATISFIED", satisfiedAt: ack.collectedAt, evidenceId: ack.evidenceId, detail: "satisfied by owner override (OWNER_ACK override=true)" },
    );
  }
  const satisfied = requirements.every((r) => r.state === "SATISFIED");
  // When the all_of became true: the latest satisfying observation (canonical ISO strings order as instants);
  // an empty spec is satisfied once the invoice is in.
  const times = requirements.map((r) => r.satisfiedAt as ISODateTime);
  const satisfiedAt = !satisfied ? null : times.length === 0 ? ctx.invoiceReceivedAt : times.reduce((a, b) => (b > a ? b : a));
  return { requirements, satisfied, satisfiedAt, ignored, overrideBy: ack === null ? null : ack.evidenceId };
}

// --- collection plan (P-SANDBOX-NO-FETCH) --------------------------------------------------------------------

/** What the service's collectors may do for each requirement. In the sandbox there is never a URL to fetch. */
export type CollectorRequest =
  | { readonly kind: "FIXTURE"; readonly index: number }
  | { readonly kind: "OWNER_ACK"; readonly index: number }
  | { readonly kind: "GITHUB_ACTIONS"; readonly index: number; readonly repo: string; readonly ref: string }
  | { readonly kind: "URL_HEALTH"; readonly index: number; readonly url: string }
  | { readonly kind: "ARTIFACT"; readonly index: number; readonly sha256: string }
  | { readonly kind: "DENIED"; readonly index: number; readonly reason: UrlDenial };

/**
 * The collection plan for a milestone's evidenceSpec. Sandbox: every entry is FIXTURE (the service may only look up
 * the scenario fixture store; no outbound request of any kind). Production: one collector per type; a URL is only
 * ever handed out when it passes urlSourceDecision against the policy allowlist, otherwise DENIED.
 */
export function evidenceCollectionPlan(milestone: Milestone, profile: KernelContext["profile"], policy: LoadedPolicy): readonly CollectorRequest[] {
  return milestone.evidenceSpec.map((req, index): CollectorRequest => {
    if (profile !== "production") return { kind: "FIXTURE", index };
    if (req.type === "OWNER_ACK") return { kind: "OWNER_ACK", index };
    if (req.type === "CI_PASS") return { kind: "GITHUB_ACTIONS", index, repo: req.repo, ref: req.ref };
    if (req.type === "URL_HEALTH") {
      const d = urlSourceDecision(req.url, policy.policy.evidence.urlAllowlist);
      return d.allowed ? { kind: "URL_HEALTH", index, url: req.url } : { kind: "DENIED", index, reason: d.reason };
    }
    return { kind: "ARTIFACT", index, sha256: req.sha256 };
  });
}
