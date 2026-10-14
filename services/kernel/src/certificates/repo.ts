// `certificates` persistence (supabase 0002_v2.sql): one row per certHash. `validity_status` is the status AT BUILD TIME;
// the API never serves it as current (service.ts re-verifies against the RPC on every read).
import type { LossBoundCertificate } from "@symbolon/schemas";
import type { Queryable } from "../db/pool";

export interface CertificateRow {
  readonly certHash: string;
  readonly vault: string;
  readonly cert: unknown;
  readonly validityStatus: string;
  readonly builtAt: string;
}

interface Raw {
  cert_hash: string;
  vault: string;
  cert: unknown;
  validity_status: string;
  built_at: string;
}
const map = (r: Raw): CertificateRow => ({ certHash: r.cert_hash, vault: r.vault, cert: r.cert, validityStatus: r.validity_status, builtAt: String(r.built_at) });

/** Newest first; ties on built_at (same transaction instant) are broken by block number so the later block wins. */
export async function latestForVault(q: Queryable, vault: string): Promise<CertificateRow | null> {
  const r = await q.query<Raw>(
    "select cert_hash, vault, cert, validity_status, built_at from certificates where lower(vault) = lower($1) order by built_at desc, block_number desc, cert_hash limit 1",
    [vault],
  );
  return r.rows[0] === undefined ? null : map(r.rows[0]);
}

export async function byHash(q: Queryable, vault: string, certHash: string): Promise<CertificateRow | null> {
  const r = await q.query<Raw>("select cert_hash, vault, cert, validity_status, built_at from certificates where lower(vault) = lower($1) and cert_hash = $2", [vault, certHash]);
  return r.rows[0] === undefined ? null : map(r.rows[0]);
}

/** Idempotent on certHash (the same state at the same block is the same document). true when a row was written. */
export async function insertOnce(q: Queryable, cert: LossBoundCertificate): Promise<boolean> {
  const r = await q.query(
    "insert into certificates (cert_hash, vault, chain_id, block_number, block_hash, cert, validity_status) values ($1, $2, $3, $4, $5, $6::jsonb, $7) on conflict (cert_hash) do nothing",
    [cert.certHash, cert.subject.vault, cert.subject.chainId, cert.asOf.blockNumber, cert.asOf.blockHash, JSON.stringify(cert), cert.validity.status],
  );
  return r.rowCount > 0;
}
