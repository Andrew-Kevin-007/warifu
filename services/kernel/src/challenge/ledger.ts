// Postgres implementation of the extractor's BudgetLedger over `llm_budget_ledger` (INV-21, docs/15 section 4, docs/05).
//
// reserve() checks AND books in one transaction under a transaction-level advisory lock, so parallel calls cannot each see room and
// jointly overshoot: a booking is a row at the call's MAXIMUM possible cost until commit() replaces it by the actual cost. The
// window ("day") is the database's UTC date; nothing a caller sends can move it. Amounts are integer micro-USD (bigint, never a
// JS number); `est_usd` is numeric(10,6), which is exactly micro-USD, so there is no rounding.
import type { BudgetLedger, BudgetRequest, Reservation } from "@symbolon/extractor";
import type { Db } from "../db/pool";

const LOCK_KEY = "symbolon.llm_budget_ledger";

/** micro-USD (bigint) -> the exact decimal text of numeric(10,6): 1234567 -> "1.234567". */
export function microToDecimal(micro: bigint): string {
  if (micro < 0n) throw new RangeError("negative amount");
  const whole = micro / 1_000_000n;
  const frac = (micro % 1_000_000n).toString().padStart(6, "0");
  return `${whole.toString()}.${frac}`;
}

export interface PgLedgerCaps {
  readonly globalDailyMicroUsd: bigint;
  readonly perPrincipalDailyMicroUsd: bigint;
}

export class PgBudgetLedger implements BudgetLedger {
  constructor(
    private readonly db: Db,
    private readonly caps: PgLedgerCaps,
  ) {
    if (caps.globalDailyMicroUsd < 0n || caps.perPrincipalDailyMicroUsd < 0n) throw new RangeError("caps must be non-negative");
  }

  async reserve(req: BudgetRequest): Promise<Reservation> {
    if (typeof req.maxCostMicroUsd !== "bigint" || req.maxCostMicroUsd < 0n || req.principalHash.length === 0) return { ok: false, reason: "INVALID_COST" };
    try {
      return await this.db.tx(async (q): Promise<Reservation> => {
        await q.query("select pg_advisory_xact_lock(hashtext($1))", [LOCK_KEY]);
        const s = await q.query<{ global: string; mine: string }>(
          `select coalesce(sum(est_usd) * 1000000, 0)::bigint::text as global,
                  coalesce(sum(est_usd) filter (where principal_hash = $1) * 1000000, 0)::bigint::text as mine
             from llm_budget_ledger where day = (now() at time zone 'utc')::date`,
          [req.principalHash],
        );
        const global = BigInt(s.rows[0]?.global ?? "0");
        const mine = BigInt(s.rows[0]?.mine ?? "0");
        if (global + req.maxCostMicroUsd > this.caps.globalDailyMicroUsd) return { ok: false, reason: "GLOBAL_DAILY_CAP" };
        if (mine + req.maxCostMicroUsd > this.caps.perPrincipalDailyMicroUsd) return { ok: false, reason: "PRINCIPAL_DAILY_CAP" };
        const ins = await q.query<{ id: string }>(
          `insert into llm_budget_ledger (day, principal_hash, role, tokens_in, tokens_out, est_usd, cache_hit)
           values ((now() at time zone 'utc')::date, $1, $2, $3, $4, $5::numeric, false) returning id::text`,
          [req.principalHash, req.role, Math.min(req.maxTokensIn, 2_000_000_000), Math.min(req.maxTokensOut, 2_000_000_000), microToDecimal(req.maxCostMicroUsd)],
        );
        return { ok: true, id: ins.rows[0]?.id ?? "" };
      });
    } catch {
      return { ok: false, reason: "LEDGER_UNAVAILABLE" };
    }
  }

  async commit(reservationId: string, actual: { tokensIn: number; tokensOut: number; costMicroUsd: bigint }): Promise<void> {
    if (!/^[0-9]{1,18}$/.test(reservationId)) throw new Error("unknown reservation");
    if (typeof actual.costMicroUsd !== "bigint" || actual.costMicroUsd < 0n) throw new Error("invalid actual cost");
    const r = await this.db.query("update llm_budget_ledger set tokens_in = $2, tokens_out = $3, est_usd = $4::numeric where id = $1::bigint", [
      reservationId,
      Math.min(actual.tokensIn, 2_000_000_000),
      Math.min(actual.tokensOut, 2_000_000_000),
      microToDecimal(actual.costMicroUsd),
    ]);
    if (r.rowCount !== 1) throw new Error("unknown reservation");
  }

  async recordCacheHit(info: { principalHash: string; role: string; model: string }): Promise<void> {
    await this.db.query(
      "insert into llm_budget_ledger (day, principal_hash, role, tokens_in, tokens_out, est_usd, cache_hit) values ((now() at time zone 'utc')::date, $1, $2, 0, 0, 0, true)",
      [info.principalHash, info.role],
    );
  }

  /** Spent (booked) today in micro-USD, for the degrade ladder and the scoreboard. */
  async spentTodayMicroUsd(): Promise<bigint> {
    const r = await this.db.query<{ s: string }>("select coalesce(sum(est_usd) * 1000000, 0)::bigint::text as s from llm_budget_ledger where day = (now() at time zone 'utc')::date");
    return BigInt(r.rows[0]?.s ?? "0");
  }
}
