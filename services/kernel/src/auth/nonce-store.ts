// Durable nonce store (RT-31, SEC-14): the database is the source of truth for "this token was already used", so a token
// captured on one instance cannot be replayed on another and a restart forgets nothing. Any failure is a reject.
import type { Queryable } from "../db/pool";

export type ClaimResult = "OK" | "REPLAYED" | "EXPIRED" | "TTL_TOO_LONG";

export interface NonceStore {
  /**
   * OK = first use (claimed). Everything else rejects; the DATABASE clock decides EXPIRED / TTL_TOO_LONG (see 0004).
   * Throws on any error: callers must fail closed.
   */
  claim(nonce: string, tenantId: string, expiresAtSec: number): Promise<ClaimResult>;
}

const RESULTS: ReadonlySet<string> = new Set(["OK", "REPLAYED", "EXPIRED", "TTL_TOO_LONG"]);

export function pgNonceStore(db: Queryable): NonceStore {
  return {
    async claim(nonce, tenantId, expiresAtSec) {
      const r = await db.query<{ claimed: string }>("select claim_service_token_nonce($1, $2::uuid, to_timestamp($3)) as claimed", [
        nonce,
        tenantId,
        expiresAtSec,
      ]);
      const v = r.rows[0]?.claimed;
      if (typeof v !== "string" || !RESULTS.has(v)) throw new Error("nonce store returned no verdict");
      return v as ClaimResult;
    },
  };
}
