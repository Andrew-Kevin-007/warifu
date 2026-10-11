// In-memory BudgetLedger: per-day global and per-principal caps in micro-USD. For tests, the eval harness and
// local development; production uses the Postgres `llm_budget_ledger` implementation (KERNEL-SVC/WEB).
// The `day` key comes from an injected function (UTC date string), so this class never reads a clock itself.
import type { BudgetLedger, BudgetRequest, Reservation } from "./budget";

export interface MemoryLedgerOptions {
  readonly globalDailyCapMicroUsd: bigint;
  readonly perPrincipalDailyCapMicroUsd: bigint;
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

  constructor(private readonly o: MemoryLedgerOptions) {}

  reserve(req: BudgetRequest): Promise<Reservation> {
    this.reserveCalls++;
    const day = this.o.day();
    const g = this.global.get(day) ?? 0n;
    const pKey = `${day}|${req.principalHash}`;
    const p = this.perPrincipal.get(pKey) ?? 0n;
    if (g + req.estCostMicroUsd > this.o.globalDailyCapMicroUsd) return Promise.resolve({ ok: false, reason: "GLOBAL_DAILY_CAP" });
    if (p + req.estCostMicroUsd > this.o.perPrincipalDailyCapMicroUsd) return Promise.resolve({ ok: false, reason: "PRINCIPAL_DAILY_CAP" });
    this.global.set(day, g + req.estCostMicroUsd);
    this.perPrincipal.set(pKey, p + req.estCostMicroUsd);
    const id = `res-${++this.seq}`;
    this.bookings.set(id, { day, principalHash: req.principalHash, reserved: req.estCostMicroUsd });
    return Promise.resolve({ ok: true, id });
  }

  commit(id: string, actual: { tokensIn: number; tokensOut: number; costMicroUsd: bigint }): Promise<void> {
    const b = this.bookings.get(id);
    if (b === undefined) return Promise.reject(new Error("unknown reservation"));
    // Replace the estimate by the actual cost.
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
