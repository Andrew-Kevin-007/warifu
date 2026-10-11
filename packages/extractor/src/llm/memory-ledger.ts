// In-memory BudgetLedger: per-day global and per-principal caps in integer micro-USD. For tests, the eval harness
// and local development; production uses a Postgres `llm_budget_ledger` implementation (KERNEL-SVC/WEB) that must
// keep the same contract: reserve() checks AND books in one atomic step.
//
// The window ("day") comes from the ledger's own injected clock function (the server's UTC date); no request field
// can choose or reset it. reserve() is fully synchronous between the read and the write, so concurrent callers
// are serialized by the event loop and cannot all "see room".
import type { BudgetLedger, BudgetRequest, Reservation } from "./budget";

export interface MemoryLedgerOptions {
  readonly globalDailyCapMicroUsd: bigint;
  readonly perPrincipalDailyCapMicroUsd: bigint;
  /** The server's UTC date string, e.g. "2026-10-11". */
  readonly day: () => string;
}

interface Booking {
  readonly day: string;
  readonly principalHash: string;
  readonly reserved: bigint;
}

export class InMemoryBudgetLedger implements BudgetLedger {
  private readonly global = new Map<string, bigint>();
  private readonly perPrincipal = new Map<string, bigint>();
  private readonly bookings = new Map<string, Booking>();
  private seq = 0;
  readonly cacheHits: Array<{ principalHash: string; role: string; model: string }> = [];
  readonly commits: Array<{ id: string; tokensIn: number; tokensOut: number; costMicroUsd: bigint }> = [];
  reserveCalls = 0;

  constructor(private readonly o: MemoryLedgerOptions) {
    if (o.globalDailyCapMicroUsd < 0n || o.perPrincipalDailyCapMicroUsd < 0n) throw new RangeError("caps must be non-negative");
  }

  reserve(req: BudgetRequest): Promise<Reservation> {
    this.reserveCalls++;
    if (typeof req.maxCostMicroUsd !== "bigint" || req.maxCostMicroUsd < 0n || req.principalHash.length === 0) {
      return Promise.resolve({ ok: false, reason: "INVALID_COST" });
    }
    const day = this.o.day();
    const g = this.global.get(day) ?? 0n;
    const pKey = `${day}|${req.principalHash}`;
    const p = this.perPrincipal.get(pKey) ?? 0n;
    if (g + req.maxCostMicroUsd > this.o.globalDailyCapMicroUsd) return Promise.resolve({ ok: false, reason: "GLOBAL_DAILY_CAP" });
    if (p + req.maxCostMicroUsd > this.o.perPrincipalDailyCapMicroUsd) return Promise.resolve({ ok: false, reason: "PRINCIPAL_DAILY_CAP" });
    this.global.set(day, g + req.maxCostMicroUsd);
    this.perPrincipal.set(pKey, p + req.maxCostMicroUsd);
    const id = `res-${++this.seq}`;
    this.bookings.set(id, { day, principalHash: req.principalHash, reserved: req.maxCostMicroUsd });
    return Promise.resolve({ ok: true, id });
  }

  commit(id: string, actual: { tokensIn: number; tokensOut: number; costMicroUsd: bigint }): Promise<void> {
    const b = this.bookings.get(id);
    if (b === undefined) return Promise.reject(new Error("unknown reservation"));
    if (typeof actual.costMicroUsd !== "bigint" || actual.costMicroUsd < 0n) return Promise.reject(new Error("invalid actual cost"));
    // Replace the reservation by the actual cost (which can exceed it if the provider mis-reports; the ledger
    // then carries the overshoot and later reservations see it).
    const delta = actual.costMicroUsd - b.reserved;
    this.global.set(b.day, (this.global.get(b.day) ?? 0n) + delta);
    const pKey = `${b.day}|${b.principalHash}`;
    this.perPrincipal.set(pKey, (this.perPrincipal.get(pKey) ?? 0n) + delta);
    this.bookings.delete(id);
    this.commits.push({ id, ...actual });
    return Promise.resolve();
  }

  recordCacheHit(info: { principalHash: string; role: string; model: string }): Promise<void> {
    this.cacheHits.push(info);
    return Promise.resolve();
  }

  spentToday(): bigint {
    return this.global.get(this.o.day()) ?? 0n;
  }
}
