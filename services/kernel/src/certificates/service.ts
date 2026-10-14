// Loss Bound Certificate API (docs/16 §7; WP-34): latest published certificate, one by hash, and build.
//   GET  /v1/certificates/:vault            latest published, with a server-side re-check
//   GET  /v1/certificates/:vault/:certHash  one certificate by hash, with a server-side re-check
//   POST /v1/certificates/:vault/build      build from the configured RPC, persist, return (rate limited)
//
// Access (INV-16/17): a caller reads or builds only its OWN tenant's vault, except in the sandbox profile where the
// vault of a `challenge` tenant is public to any authenticated caller (the challenge page embeds it). An unknown or
// foreign vault is a 404, never a hint that it exists.
//
// The response ALWAYS carries a fresh `validity` and `verification` computed against the configured RPC; the stored
// `validity_status` column is the status at build time and is never served as current. Our own signature is not consulted:
// the verification is the same recomputation `pnpm lbc verify` runs (RT-20). Fail closed: if the RPC cannot be read the
// answer is UNVERIFIED, not the stored status.
import { LossBoundCertificateSchema } from "@symbolon/schemas";
import type { LossBoundCertificate } from "@symbolon/schemas";
import { buildFromReader, certificateView, toValidity, verifyCertificate, LbcError, DEFAULT_FRESHNESS_SECONDS } from "@symbolon/blast-radius/lbc";
import type { ChainReader as LbcChainReader, ParsedArtifact, VerifyResult } from "@symbolon/blast-radius/lbc";
import { getAddress } from "viem";
import type { Db } from "../db/pool";
import * as base from "../db/repo";
import { ApiError } from "../errors";
import { errorFields } from "../log";
import type { Logger } from "../log";
import type { Profile } from "../boot";
import type { Clock } from "../time";
import * as repo from "./repo";

export interface CertificateServiceConfig {
  readonly reader: LbcChainReader;
  /** `algorithm.gitSha` of the running build (lowercase hex, 7-40). */
  readonly gitSha: string;
  /** parsed Foundry artifact of the deployed vault build; enables the code-match check */
  readonly artifact?: ParsedArtifact;
  /** parsed `symbolon-blast-validation/1` results, attached to certificates built here */
  readonly validationResults?: unknown;
  readonly detectionLatencySeconds?: number;
  readonly freshnessSeconds?: number;
  readonly limiter?: BuildLimiter;
  /** Time source for certificate freshness and rate limits only (never auth). Absent = the app clock. Tests pin it to the fake chain's time. */
  readonly clock?: Clock;
}

export interface CertificateDeps extends CertificateServiceConfig {
  readonly db: Db;
  readonly clock: Clock;
  readonly profile: Profile;
  readonly logger: Logger;
}

/** Sliding-window limiter keyed by vault, plus a global ceiling. In memory: a restart resets it (builds are idempotent). */
export interface BuildLimiter {
  /** returns 0 when allowed, else the seconds to wait */
  take(key: string, nowMs: number): number;
}
export function createBuildLimiter(perVault = 5, global = 30, windowSeconds = 600): BuildLimiter {
  const per = new Map<string, number[]>();
  let all: number[] = [];
  const prune = (list: number[], now: number): number[] => list.filter((t) => now - t < windowSeconds * 1000);
  return {
    take(key, now) {
      all = prune(all, now);
      const mine = prune(per.get(key) ?? [], now);
      const wait = (list: number[], max: number): number => (list.length >= max ? Math.max(1, Math.ceil((list[0]! + windowSeconds * 1000 - now) / 1000)) : 0);
      const w = Math.max(wait(mine, perVault), wait(all, global));
      if (w > 0) {
        per.set(key, mine);
        return w;
      }
      mine.push(now);
      all.push(now);
      per.set(key, mine);
      if (per.size > 10_000) per.clear(); // bounded memory
      return 0;
    },
  };
}
let defaultLimiter: BuildLimiter | null = null;
const limiterOf = (d: CertificateDeps): BuildLimiter => d.limiter ?? (defaultLimiter ??= createBuildLimiter());

function parseVault(raw: string | undefined): string {
  if (raw === undefined || !/^0x[0-9a-fA-F]{40}$/.test(raw)) throw new ApiError("NOT_FOUND", "not found");
  try {
    return getAddress(raw);
  } catch {
    throw new ApiError("NOT_FOUND", "not found");
  }
}

/** The caller may use `vault` iff it is the caller's tenant vault, or (sandbox profile) the vault of a challenge tenant. */
async function authorize(d: CertificateDeps, tenantId: string, vault: string): Promise<void> {
  const mine = await base.getTenant(d.db, tenantId);
  if (mine !== null && mine.vaultAddress !== null && mine.vaultAddress.toLowerCase() === vault.toLowerCase()) return;
  if (d.profile === "sandbox") {
    const r = await d.db.query<{ kind: string }>("select kind from tenants where lower(vault_address) = lower($1)", [vault]);
    if (r.rows.some((x) => x.kind === "challenge")) return;
  }
  throw new ApiError("NOT_FOUND", "not found");
}

function nowSeconds(d: CertificateDeps): bigint {
  return BigInt(Math.floor(d.clock() / 1000));
}

export interface CertificateResponse {
  readonly certificate: LossBoundCertificate;
  readonly verification: Pick<VerifyResult, "outcome" | "exitCode" | "reasons" | "diffs" | "mode" | "findings" | "latest" | "codeMatch" | "publisher">;
  /** the `/certificate/[vault]` data contract (section order, generated headline, no hand-typed numbers) */
  readonly view: ReturnType<typeof certificateView>;
}

async function recheck(d: CertificateDeps, stored: unknown): Promise<CertificateResponse> {
  const parsed = LossBoundCertificateSchema.safeParse(stored);
  if (!parsed.success) {
    d.logger.error("certificate.stored_invalid", {});
    throw new ApiError("INTERNAL", "internal error; the request was not processed");
  }
  const freshness = d.freshnessSeconds ?? DEFAULT_FRESHNESS_SECONDS;
  const v = await verifyCertificate(parsed.data, d.reader, {
    nowSeconds: nowSeconds(d),
    freshnessSeconds: freshness,
    ...(d.artifact === undefined ? {} : { artifact: d.artifact }),
  });
  const certificate: LossBoundCertificate = { ...parsed.data, validity: toValidity(v, Number(nowSeconds(d)), freshness) };
  const { outcome, exitCode, reasons, diffs, mode, findings, latest, codeMatch, publisher } = v;
  const verification = { outcome, exitCode, reasons, diffs, mode, findings, latest, codeMatch, publisher };
  return { certificate, verification, view: certificateView(certificate, verification) };
}

export async function getLatestCertificate(d: CertificateDeps, tenantId: string, vaultParam: string | undefined): Promise<CertificateResponse> {
  const vault = parseVault(vaultParam);
  await authorize(d, tenantId, vault);
  const row = await repo.latestForVault(d.db, vault);
  if (row === null) throw new ApiError("NOT_FOUND", "no certificate has been published for this vault");
  return recheck(d, row.cert);
}

export async function getCertificateByHash(d: CertificateDeps, tenantId: string, vaultParam: string | undefined, hash: string | undefined): Promise<CertificateResponse> {
  const vault = parseVault(vaultParam);
  if (hash === undefined || !/^0x[0-9a-f]{64}$/.test(hash)) throw new ApiError("NOT_FOUND", "not found");
  await authorize(d, tenantId, vault);
  const row = await repo.byHash(d.db, vault, hash);
  if (row === null) throw new ApiError("NOT_FOUND", "not found");
  return recheck(d, row.cert);
}

export async function buildCertificate(d: CertificateDeps, tenantId: string, vaultParam: string | undefined): Promise<{ response: CertificateResponse; created: boolean }> {
  const vault = parseVault(vaultParam);
  await authorize(d, tenantId, vault);
  const wait = limiterOf(d).take(vault.toLowerCase(), d.clock());
  if (wait > 0) throw new ApiError("RATE_LIMITED", "too many certificate builds for this vault; try again later", { retryAfterSeconds: wait }, { "Retry-After": String(wait) });
  let built;
  try {
    built = await buildFromReader(d.reader, vault, {
      block: "finalized",
      gitSha: d.gitSha,
      nowSeconds: nowSeconds(d),
      ...(d.detectionLatencySeconds === undefined ? {} : { detectionLatencySeconds: d.detectionLatencySeconds }),
      ...(d.freshnessSeconds === undefined ? {} : { freshnessSeconds: d.freshnessSeconds }),
      ...(d.artifact === undefined ? {} : { artifact: d.artifact }),
      ...(d.validationResults === undefined ? {} : { validationResults: d.validationResults }),
    });
  } catch (e) {
    if (e instanceof LbcError) {
      d.logger.warn("certificate.build_refused", { ...errorFields(e) });
      throw new ApiError("UNPROCESSABLE", "a certificate cannot be built for this vault right now", { reason: e.code }, { "Retry-After": "30" });
    }
    d.logger.warn("certificate.build_unavailable", { ...errorFields(e) });
    throw new ApiError("UNAVAILABLE", "the chain could not be read; no certificate was built", {}, { "Retry-After": "10" });
  }
  const created = await repo.insertOnce(d.db, built.cert);
  const response = await recheck(d, built.cert);
  return { response, created };
}
