// T1 weak-evidence exposure (docs/08 §4, docs/16 §2.3). Pure: the caller reads the terms files and passes parsed JSON.
//
// Off-chain terms can never LOWER a bound (docs/16 §2.3): each engagement's terms are admitted only if their
// recomputed termsHash equals the on-chain `termsHash`; otherwise (wrong, missing, malformed) that engagement is
// reported TERMS_UNVERIFIED and its exposure counts as its FULL cap. With no terms supplied at all the figure is
// "NOT_COMPUTED", never "0".
//
// Strength (docs/08 §4 table, evidence is `all_of` per milestone):
//   STRONG  OWNER_ACK; CI_PASS pinned to a 40-hex commit sha
//   MEDIUM  ARTIFACT_HASH; CI_PASS on a branch ref; URL_HEALTH with contentSha256 (interpretation: the payee must
//           produce the pinned bytes; docs/QUESTIONS.md WP-34)
//   WEAK    URL_HEALTH without contentSha256; an empty spec
// A milestone is exposed iff its spec is empty or EVERY requirement is WEAK (satisfying any non-weak requirement
// needs something an attacker who only controls a URL does not have).
import { EngagementSchema, EngagementTermsPreimageSchema, computeTermsHash, hashJcs } from "@symbolon/schemas";
import type { EvidenceRequirement, Hex32 } from "@symbolon/schemas";
import type { EngagementState } from "./types";

export type EvidenceStrength = "STRONG" | "MEDIUM" | "WEAK";

export function classifyRequirement(r: EvidenceRequirement): EvidenceStrength {
  switch (r.type) {
    case "OWNER_ACK":
      return "STRONG";
    case "CI_PASS":
      return /^[0-9a-fA-F]{40}$/.test(r.ref) ? "STRONG" : "MEDIUM";
    case "ARTIFACT_HASH":
      return "MEDIUM";
    case "URL_HEALTH":
      return r.contentSha256 === undefined ? "WEAK" : "MEDIUM";
    default: {
      const unreachable: never = r;
      return unreachable;
    }
  }
}

export interface ParsedTerms {
  readonly engagementId: Hex32;
  /** recomputed from the document: keccak256(JCS(terms without signatures)) */
  readonly termsHash: Hex32;
  readonly cap: bigint;
  readonly milestones: readonly { readonly milestoneId: Hex32; readonly slug: string; readonly amount: bigint; readonly strength: EvidenceStrength | "NONE" }[];
}

/** Accepts the full `Engagement` shape (what the API returns) or the bare terms preimage. null when it is neither. */
export function parseTermsDocument(json: unknown): ParsedTerms | null {
  const full = EngagementSchema.safeParse(json);
  if (full.success) {
    const e = full.data;
    return summarize(e.engagementId, computeTermsHash(e), BigInt(e.capBaseUnits), e.milestones);
  }
  const pre = EngagementTermsPreimageSchema.safeParse(json);
  if (pre.success) {
    const p = pre.data;
    return summarize(p.engagementId, hashJcs(p), BigInt(p.cap), p.milestones);
  }
  return null;
}

function summarize(
  engagementId: Hex32,
  termsHash: Hex32,
  cap: bigint,
  milestones: readonly { milestoneId: Hex32; slug: string; amountBaseUnits: string; evidenceSpec: readonly EvidenceRequirement[] }[],
): ParsedTerms {
  return {
    engagementId,
    termsHash,
    cap,
    milestones: milestones.map((m) => {
      const strengths = m.evidenceSpec.map(classifyRequirement);
      const strength: EvidenceStrength | "NONE" = strengths.length === 0 ? "NONE" : strengths.every((s) => s === "WEAK") ? "WEAK" : strengths.includes("STRONG") ? "STRONG" : "MEDIUM";
      return { milestoneId: m.milestoneId, slug: m.slug, amount: BigInt(m.amountBaseUnits), strength };
    }),
  };
}

export type TermsStatus = "VERIFIED" | "TERMS_UNVERIFIED";

export interface EngagementExposure {
  readonly engagementId: Hex32;
  readonly status: TermsStatus;
  readonly exposure: bigint;
  /** milestones whose evidence is weak (or absent): the ones to harden */
  readonly weakMilestones: readonly { readonly milestoneId: Hex32; readonly slug: string; readonly amount: bigint }[];
}

export interface WeakEvidenceResult {
  readonly total: bigint;
  readonly perEngagement: readonly EngagementExposure[];
}

/**
 * `counted` are the engagements that count toward the bound (active, not ended). `supplied` are the parsed terms
 * documents the caller found (any order, possibly with strangers and duplicates).
 */
export function computeWeakEvidenceExposure(counted: readonly EngagementState[], supplied: readonly ParsedTerms[]): WeakEvidenceResult {
  const byId = new Map<string, ParsedTerms[]>();
  for (const t of supplied) {
    const list = byId.get(t.engagementId.toLowerCase()) ?? [];
    list.push(t);
    byId.set(t.engagementId.toLowerCase(), list);
  }
  let total = 0n;
  const perEngagement: EngagementExposure[] = [];
  const ordered = [...counted].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const e of ordered) {
    const candidates = (byId.get(e.id.toLowerCase()) ?? []).filter((t) => t.termsHash.toLowerCase() === e.termsHash.toLowerCase() && t.cap === e.cap);
    // Two different documents cannot both hash to the on-chain termsHash; identical duplicates are harmless.
    const t = candidates[0];
    if (t === undefined) {
      perEngagement.push({ engagementId: e.id, status: "TERMS_UNVERIFIED", exposure: e.cap, weakMilestones: [] });
      total += e.cap;
      continue;
    }
    const weak = t.milestones.filter((m) => m.strength === "WEAK" || m.strength === "NONE");
    const sum = weak.reduce((acc, m) => acc + m.amount, 0n);
    const exposure = sum < e.cap ? sum : e.cap;
    perEngagement.push({ engagementId: e.id, status: "VERIFIED", exposure, weakMilestones: weak.map((m) => ({ milestoneId: m.milestoneId, slug: m.slug, amount: m.amount })) });
    total += exposure;
  }
  return { total, perEngagement };
}
