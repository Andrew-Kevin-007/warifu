// Kernel-side evidence collectors (docs/04 K-09). Each one turns ONE signed spec entry into a `Collected` observation, or says
// the thing is not there yet. Rules shared by all of them:
//  - the spec entry comes from the signed engagement row, never from an invoice, an intent or the web app;
//  - every observation carries `requirementHash = hashJcs(entry)` so K-09 can match evidence to the exact entry;
//  - fetched bytes are hashed and (for GitHub) JSON-parsed as text; they are never rendered, executed or echoed. `details` is
//    templated from validated fields only, never copied from a response;
//  - a refused source is `result: ERROR` with `payload.reasonCode = "EVIDENCE_SOURCE_DENIED"` (K-09 turns that into
//    HOLD EVIDENCE_SOURCE_DENIED); an unreachable one is `ERROR` with `payload.error`; a mismatch is `FAIL`.
import { hashJcs, sha256Bytes } from "@symbolon/schemas";
import type { EvidenceRequirement, Hex32, JsonObject } from "@symbolon/schemas";
import * as z from "zod";
import { guardedGet } from "./ssrf/guard";
import type { GuardDeps, GuardLimits } from "./ssrf/guard";

export type EvidenceOutcome = "PASS" | "FAIL" | "ERROR";

export interface Collected {
  /** e.g. "github:actions", "url:https://…", "kernel:artifact-upload", "fixture:<id>". */
  readonly source: string;
  readonly payload: JsonObject;
  readonly result: EvidenceOutcome;
  /** Templated by us from validated fields. */
  readonly details: string;
}

/** Nothing to record yet (no matching CI run, run still in progress): the requirement stays EVIDENCE_MISSING. */
export interface NotYet {
  readonly pending: true;
  readonly reason: "NO_MATCHING_RUN" | "RUN_IN_PROGRESS";
}

export const SOURCE_DENIED = "EVIDENCE_SOURCE_DENIED" as const;

export const requirementHash = (r: EvidenceRequirement): Hex32 => hashJcs(r);

export function denial(r: EvidenceRequirement, guardCode: string, urlHash: Hex32 | null): Collected {
  return {
    source: "denied:egress",
    payload: { requirementHash: requirementHash(r), denied: true, reasonCode: SOURCE_DENIED, guardCode, urlHash },
    result: "ERROR",
    details: `${SOURCE_DENIED}: ${guardCode}`,
  };
}

function failure(r: EvidenceRequirement, error: string, urlHash: Hex32 | null): Collected {
  return {
    source: "denied:egress",
    payload: { requirementHash: requirementHash(r), denied: false, error, urlHash },
    result: "ERROR",
    details: `collector error: ${error}`,
  };
}

const urlHashOf = (u: unknown): Hex32 | null => (typeof u === "string" ? hashJcs(u) : null);

// --- URL_HEALTH ---------------------------------------------------------------------------------------------------------------

export interface UrlHealthDeps {
  readonly guard: GuardDeps;
  readonly limits?: Partial<GuardLimits>;
}

/**
 * `allowedHosts` is derived by the caller from this very spec entry (and the tenant policy). The URL is the spec's own URL.
 */
export async function collectUrlHealth(r: Extract<EvidenceRequirement, { type: "URL_HEALTH" }>, allowedHosts: readonly string[], d: UrlHealthDeps): Promise<Collected> {
  const urlHash = urlHashOf(r.url);
  const res = await guardedGet(d.guard, {
    url: r.url,
    allowedHosts,
    headers: { accept: "*/*" },
    redirectIsResult: r.expectStatus >= 300 && r.expectStatus <= 399,
    ...(d.limits === undefined ? {} : { limits: d.limits }),
  });
  if (!res.ok) return res.kind === "denied" ? denial(r, res.code, urlHash) : failure(r, res.code, urlHash);

  const wantsHash = r.contentSha256 !== undefined;
  if (wantsHash && res.truncated) return failure(r, "BODY_TOO_LARGE", urlHash); // cannot hash what we did not read: not a PASS
  const bodySha256 = res.truncated ? null : sha256Bytes(res.body);
  const statusOk = res.status === r.expectStatus;
  const hashMismatch = wantsHash && bodySha256 !== r.contentSha256;
  const pass = statusOk && !hashMismatch;
  // Contract with kernel-core (src/evidence.ts header, WP-05): a URL_HEALTH record's source IS the spec url and payload.url
  // repeats it; the kernel accepts nothing else. (A url over 512 characters cannot be stored as a source: it is then recorded
  // under a hashed source, which the kernel reports as EVIDENCE_SOURCE_DENIED, i.e. it fails closed.)
  return {
    source: r.url.length <= 512 ? r.url : `url:sha256:${hashJcs(r.url)}`,
    payload: {
      requirementHash: requirementHash(r),
      url: r.url,
      finalHost: res.finalHost,
      status: res.status,
      expectStatus: r.expectStatus,
      redirects: res.redirects,
      bodySha256,
      bodyBytes: res.truncated ? null : res.body.byteLength,
      truncated: res.truncated,
      expectedContentSha256: r.contentSha256 ?? null,
      hashMismatch,
    },
    result: pass ? "PASS" : "FAIL",
    details: `URL_HEALTH ${pass ? "ok" : hashMismatch ? "content hash differs from the pinned hash" : "unexpected status"}: got ${String(res.status)}, expected ${String(r.expectStatus)}, host ${res.finalHost}`,
  };
}

// --- CI_PASS (GitHub REST) --------------------------------------------------------------------------------------------------

// VERIFY(V-28): endpoint, query parameters and response fields below are written from the GitHub REST docs for
// "List workflow runs for a workflow" / "List workflow runs for a repository" (GET /repos/{owner}/{repo}/actions/workflows/
// {workflow_id}/runs and GET /repos/{owner}/{repo}/actions/runs; parameters head_sha, branch, per_page; response
// {total_count, workflow_runs[{id, name, head_branch, head_sha, status, conclusion, created_at, updated_at}]};
// header X-GitHub-Api-Version: 2022-11-28). They were NOT re-read against docs.github.com in this offline session. A workflow
// "name with spaces" is not a valid {workflow_id} (GitHub wants the file name or numeric id): the collector sends what the signed
// spec says and an unknown workflow comes back as a non-200, which is ERROR, never PASS.
export const GITHUB_API_HOST = "api.github.com";

const RunSchema = z.object({
  id: z.number().int().nonnegative(),
  head_sha: z.string().regex(/^[0-9a-f]{40}$/),
  head_branch: z.string().max(255).nullable(),
  status: z.string().max(40).nullable(),
  conclusion: z.string().max(40).nullable(),
  created_at: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/),
});
const RunsSchema = z.object({ workflow_runs: z.array(z.unknown()).max(100) });

const SHA_REF = /^[0-9a-f]{7,40}$/i;

/** `.`/`..` segments would let a signed spec steer the request to another API path. */
function safeSegment(s: string): boolean {
  return s !== "." && s !== ".." && !s.includes("..");
}

export interface CiDeps extends UrlHealthDeps {
  /** GitHub token, if one is configured (public repos work without). Never logged; sent only to api.github.com, first hop only. */
  readonly githubToken: string | null;
}

export function githubRunsUrl(r: Extract<EvidenceRequirement, { type: "CI_PASS" }>): string | null {
  const [owner, name] = r.repo.split("/") as [string, string];
  if (!safeSegment(owner) || !safeSegment(name) || !safeSegment(r.ref) || r.ref.startsWith("/")) return null;
  if (r.workflow !== undefined && !safeSegment(r.workflow)) return null;
  const isSha = SHA_REF.test(r.ref);
  const base = `https://${GITHUB_API_HOST}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/actions`;
  const path = r.workflow === undefined ? `${base}/runs` : `${base}/workflows/${encodeURIComponent(r.workflow)}/runs`;
  return `${path}?${isSha ? "head_sha" : "branch"}=${encodeURIComponent(r.ref)}&per_page=30`;
}

export async function collectCiPass(r: Extract<EvidenceRequirement, { type: "CI_PASS" }>, d: CiDeps): Promise<Collected | NotYet> {
  const url = githubRunsUrl(r);
  if (url === null) return denial(r, "SPEC_REFUSED", null);
  const urlHash = urlHashOf(url);
  const headers: Record<string, string> = { accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" };
  if (d.githubToken !== null && d.githubToken !== "") headers["authorization"] = `Bearer ${d.githubToken}`;
  const res = await guardedGet(d.guard, {
    url,
    allowedHosts: [GITHUB_API_HOST],
    headers,
    limits: { ...(d.limits ?? {}), maxRedirects: 0 }, // GitHub answers in place; a redirect is a refusal
  });
  if (!res.ok) return res.kind === "denied" ? denial(r, res.code, urlHash) : failure(r, res.code, urlHash);
  if (res.status !== 200) return failure(r, `HTTP_${String(res.status)}`, urlHash);
  if (res.truncated) return failure(r, "BODY_TOO_LARGE", urlHash);

  let doc: z.infer<typeof RunsSchema>;
  try {
    doc = RunsSchema.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(res.body)));
  } catch {
    return failure(r, "RESPONSE_INVALID", urlHash);
  }
  const isSha = SHA_REF.test(r.ref);
  const want = r.ref.toLowerCase();
  const runs = doc.workflow_runs.flatMap((x) => {
    const p = RunSchema.safeParse(x);
    if (!p.success) return [];
    const m = isSha ? p.data.head_sha.startsWith(want) : p.data.head_branch === r.ref;
    return m ? [p.data] : [];
  });
  if (runs.length === 0) return { pending: true, reason: "NO_MATCHING_RUN" };
  // latest = newest created_at, then highest id (re-runs share a sha and keep a larger id)
  const latest = [...runs].sort((a, b) => (a.created_at === b.created_at ? b.id - a.id : a.created_at < b.created_at ? 1 : -1))[0];
  if (latest === undefined) return { pending: true, reason: "NO_MATCHING_RUN" };
  if (latest.status !== "completed") return { pending: true, reason: "RUN_IN_PROGRESS" };
  const conclusion = latest.conclusion === "success" || latest.conclusion === "failure" || latest.conclusion === "cancelled" || latest.conclusion === "timed_out" ? latest.conclusion : "other";
  const pass = conclusion === "success";
  return {
    source: "github:actions",
    payload: {
      requirementHash: requirementHash(r),
      repo: r.repo,
      ref: r.ref,
      workflow: r.workflow ?? null,
      matchedBy: isSha ? "sha" : "branch",
      runId: latest.id,
      headSha: latest.head_sha,
      conclusion,
      runCreatedAt: latest.created_at,
    },
    result: pass ? "PASS" : "FAIL",
    details: `CI_PASS ${r.repo}@${r.ref}: latest run ${String(latest.id)} concluded ${conclusion}`,
  };
}

// --- ARTIFACT_HASH ------------------------------------------------------------------------------------------------------------

/** The kernel hashes the uploaded bytes itself (INV-23: no decoding, no parsing) and compares with the signed hash. */
export function collectArtifactHash(r: Extract<EvidenceRequirement, { type: "ARTIFACT_HASH" }>, bytes: Uint8Array): Collected {
  const sha256 = sha256Bytes(bytes);
  const match = sha256 === r.sha256;
  return {
    source: "kernel:artifact", // the source kernel-core accepts for ARTIFACT_HASH (WP-05 contract)
    payload: { requirementHash: requirementHash(r), sha256, expectedSha256: r.sha256, size: bytes.byteLength, hashMismatch: !match },
    result: match ? "PASS" : "FAIL",
    details: match ? "ARTIFACT_HASH ok: uploaded bytes match the signed hash" : "ARTIFACT_HASH mismatch: uploaded bytes differ from the signed hash",
  };
}

export const isNotYet = (x: Collected | NotYet): x is NotYet => "pending" in x;
