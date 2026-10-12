// App-clock vs database-clock guard (RT-31). Token expiry is judged by the app clock and by the database clock
// (migration 0004); if the two disagree by more than the skew allowance the service refuses to authenticate anything
// (fail closed) until they agree again. Errors are logged as class and code only.
import { ApiError } from "../errors";
import type { Queryable } from "../db/pool";
import { errorFields } from "../log";
import type { Logger } from "../log";
import type { Clock } from "../time";
import { CLOCK_SKEW_SECONDS } from "./token";

export interface ClockGuard {
  /** Resolves when the clocks agree; throws ApiError UNAVAILABLE otherwise (or when the database cannot be asked). */
  assertSynced(): Promise<void>;
}

export interface ClockGuardOptions {
  readonly db: Queryable;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly maxSkewSec?: number;
  /** How long a verdict is reused. Default 5 s: skew is not a per-request question. */
  readonly cacheMs?: number;
}

/** Skew in seconds (app minus database), or throws if the database cannot answer. */
export async function measureClockSkewSeconds(db: Queryable, clock: Clock): Promise<number> {
  const before = clock();
  const r = await db.query<{ t: string }>("select extract(epoch from clock_timestamp())::text as t");
  const after = clock();
  const dbSec = Number.parseFloat(r.rows[0]?.t ?? "");
  if (!Number.isFinite(dbSec)) throw new Error("database returned no clock");
  const appSec = (before + after) / 2 / 1000;
  return appSec - dbSec;
}

export function createClockGuard(o: ClockGuardOptions): ClockGuard {
  const max = o.maxSkewSec ?? CLOCK_SKEW_SECONDS;
  const cacheMs = o.cacheMs ?? 5_000;
  let verdict: { at: number; ok: boolean } | null = null;
  const unavailable = (): ApiError => new ApiError("UNAVAILABLE", "authentication is temporarily unavailable", {}, { "Retry-After": "5" });
  return {
    async assertSynced() {
      const now = o.clock();
      if (verdict !== null && now - verdict.at < cacheMs) {
        if (verdict.ok) return;
        throw unavailable();
      }
      let ok = false;
      try {
        const skew = await measureClockSkewSeconds(o.db, o.clock);
        ok = Math.abs(skew) <= max;
        if (!ok) o.logger.error("clock.skew", { skewSeconds: Math.round(skew), maxSeconds: max });
      } catch (e) {
        o.logger.error("clock.check_failed", { ...errorFields(e) });
      }
      verdict = { at: now, ok };
      if (!ok) throw unavailable();
    },
  };
}
