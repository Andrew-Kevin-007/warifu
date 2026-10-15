// The scheduler (docs/02 s5.1 step 6, docs/04 s5; WP-14). One tick per tenant, in this order, each step independent and fail-closed:
//   1. SUBMITTED transactions that reverted or vanished  -> FAILED (retryable, with a FRESH re-evaluation)
//   2. QUEUED attestations (crash recovery, retries)     -> relay the SAME signed attestation (lease: one sender at a time)
//   3. RELEASE heads whose payAt has come                -> TOCTOU re-evaluation -> attestation -> relay, or a superseding decision
//   4. HOLD heads not re-checked for a while             -> re-evaluate; a new decision only when the outcome changed
// An error in one item is logged (class and code only) and never stops the others; nothing is sent when a step fails. Two
// schedulers over one database are safe: the claim is serialised by the tenant decision lock and the unique release row, and the
// send by the row lease; the vault's used[intentId] is the on-chain backstop.
import { Hex32Schema } from "@symbolon/schemas";
import type { Hex32 } from "@symbolon/schemas";
import { errorFields } from "../log";
import { reevaluateStored } from "../service/reeval";
import { nowIso, plusSeconds } from "../time";
import * as repo from "./repo";
import { checkSubmitted, processDue, sendQueued } from "./service";
import type { DueOutcome, ReleaseDeps, SendOutcome } from "./service";

export interface TickOptions {
  /** Most due releases handled per tenant per tick. */
  readonly batch: number;
  /** A HOLD is not re-checked more often than this. */
  readonly recheckAfterSeconds: number;
}

export const DEFAULT_TICK_OPTIONS: TickOptions = { batch: 25, recheckAfterSeconds: 60 };

export interface TickSummary {
  readonly tenantId: string;
  readonly due: number;
  readonly queued: number;
  readonly superseded: number;
  readonly sent: number;
  readonly rechecked: number;
  readonly errors: number;
}

/** Re-evaluate HOLD and ESCALATE heads (optionally only those of one milestone, e.g. right after evidence was collected). */
export async function recheckHolds(d: ReleaseDeps, tenantId: string, o: { milestoneId?: Hex32 | null; recheckAfterSeconds?: number; limit?: number } = {}): Promise<number> {
  const now = nowIso(d.clock);
  const before = plusSeconds(now, -(o.recheckAfterSeconds ?? DEFAULT_TICK_OPTIONS.recheckAfterSeconds));
  const holds = await repo.holdsToRecheck(d.db, tenantId, before, o.limit ?? 25, o.milestoneId ?? null);
  let changed = 0;
  for (const h of holds) {
    try {
      const r = await reevaluateStored(d, tenantId, h.intentId, { action: "intent.rechecked", actor: "kernel:scheduler", heads: ["HOLD", "ESCALATE"], onlyIfChanged: true });
      if (r.recorded !== null) changed++;
    } catch (e) {
      d.logger.warn("scheduler.recheck_failed", { tenantId, intentId: h.intentId, ...errorFields(e) });
    }
  }
  return changed;
}

export async function tickTenant(d: ReleaseDeps, tenantId: string, opts: Partial<TickOptions> = {}): Promise<TickSummary> {
  const o: TickOptions = { ...DEFAULT_TICK_OPTIONS, ...opts };
  let due = 0;
  let queued = 0;
  let superseded = 0;
  let sent = 0;
  let errors = 0;
  const guard = async <T>(what: string, intentId: Hex32 | null, f: () => Promise<T>): Promise<T | null> => {
    try {
      return await f();
    } catch (e) {
      errors++;
      d.logger.warn(`scheduler.${what}_failed`, { tenantId, ...(intentId === null ? {} : { intentId }), ...errorFields(e) });
      return null;
    }
  };
  const countSend = (s: SendOutcome | null): void => {
    if (s === "SUBMITTED") sent++;
  };

  await guard("check_submitted", null, () => checkSubmitted(d, tenantId));

  for (const row of (await guard("list_queued", null, () => repo.releasesByStatus(d.db, tenantId, "QUEUED"))) ?? []) {
    countSend(await guard("send", row.intentId, () => sendQueued(d, tenantId, row)));
  }

  const now = nowIso(d.clock);
  const dueList = (await guard("list_due", null, () => repo.dueReleases(d.db, tenantId, now, o.batch))) ?? [];
  for (const item of dueList) {
    due++;
    const out: DueOutcome | null = await guard("process_due", item.intentId, () => processDue(d, tenantId, item.decisionId, Hex32Schema.parse(item.intentId)));
    if (out === null) continue;
    if (out.kind === "SUPERSEDED") superseded++;
    if (out.kind === "QUEUED") {
      queued++;
      countSend(await guard("send", item.intentId, () => sendQueued(d, tenantId, out.release)));
    }
  }

  const rechecked = (await guard("recheck", null, () => recheckHolds(d, tenantId, { recheckAfterSeconds: o.recheckAfterSeconds, limit: o.batch }))) ?? 0;
  return { tenantId, due, queued, superseded, sent, rechecked, errors };
}

/** One pass over every tenant that has a vault on this chain. */
export async function tickAll(d: ReleaseDeps, chainId: number, opts: Partial<TickOptions> = {}): Promise<TickSummary[]> {
  const out: TickSummary[] = [];
  let tenants: string[] = [];
  try {
    tenants = await repo.tenantsWithVault(d.db, chainId);
  } catch (e) {
    d.logger.error("scheduler.tenants_failed", { ...errorFields(e) });
  }
  for (const t of tenants) out.push(await tickTenant(d, t, opts));
  return out;
}

export interface SchedulerLoop {
  stop(): Promise<void>;
}

/** Tick forever (one pass at a time). Errors are logged and the loop continues. */
export function startSchedulerLoop(d: ReleaseDeps, o: { chainId: number; intervalMs: number; options?: Partial<TickOptions> }): SchedulerLoop {
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;
  let running: Promise<void> = Promise.resolve();
  const tick = (): void => {
    running = (async () => {
      try {
        await tickAll(d, o.chainId, o.options);
      } catch (e) {
        d.logger.error("scheduler.loop_failed", { ...errorFields(e) });
      }
      if (!stopped) timer = setTimeout(tick, o.intervalMs);
    })();
  };
  tick();
  return {
    async stop() {
      stopped = true;
      if (timer !== null) clearTimeout(timer);
      await running;
    },
  };
}
