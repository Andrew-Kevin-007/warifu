// K-15 RECONCILIATION_WITNESS (chain side) and K-16 CIRCUIT_BREAKER trip (docs/04 s4; WP-15).
//
// One pass per tenant, every 60 s and whenever a webhook asks (a webhook only TRIGGERS a pass; the evidence is the chain):
//   1. RELEASE_UNCONFIRMED   a SUBMITTED release has no indexed Released event: MEDIUM after 120 s, HIGH after 10 min
//   2. UNKNOWN_RELEASE       an indexed Released event for an intent this kernel has no release row for: HIGH (signer compromise?)
//      RELEASE_MISMATCH      a Released event that disagrees with what this kernel signed (payee, amount, engagement, receipt): HIGH
//   3. BALANCE_DRIFT         token balance at a block != deposits - Σ Released - Σ Withdrawn (same block, from chain): HIGH
//   4. KERNEL_EXCEPTION_RATE more than 5 KERNEL_ERROR decisions in 10 minutes: HIGH
// Any unresolved HIGH finding trips the breaker (breaker_state.halted; every evaluate() then returns HOLD BREAKER_HALTED and the
// release path refuses to send) and the GUARDIAN key pauses the vault. Only the owner clears it (reconcile/unfreeze.ts).
// The pass never throws: a chain read that fails is logged and that check is skipped for this pass (an RPC outage is not
// evidence of drift; the release path fails closed on its own when it cannot read the chain).
import { epochSecondsFromIso } from "@symbolon/schemas";
import type { Address, ISODateTime } from "@symbolon/schemas";
import type { GuardianPauser } from "../chain/guardian";
import type { ChainReader } from "../chain/reader";
import type { Db } from "../db/pool";
import * as base from "../db/repo";
import { errorFields } from "../log";
import type { Logger } from "../log";
import { nowIso, plusSeconds } from "../time";
import type { Clock } from "../time";
import type { LedgerChain } from "./ledger";
import * as repo from "./repo";

export interface ReconcilerDeps {
  readonly db: Db;
  /** Vault snapshot reads (token address, paused). */
  readonly chain: ChainReader;
  readonly ledger: LedgerChain;
  /** null = no guardian key configured: the breaker still halts the kernel; the vault is not paused (a finding says so). */
  readonly guardian: GuardianPauser | null;
  readonly clock: Clock;
  readonly logger: Logger;
}

export interface ReconcilerOptions {
  /** RELEASE_UNCONFIRMED becomes a finding after this long (docs/04 K-15: 120 s). */
  readonly unconfirmedAfterSeconds: number;
  /** ... and HIGH after this long (10 min). */
  readonly unconfirmedHighAfterSeconds: number;
  /** K-16: more than this many kernel exceptions ... */
  readonly maxKernelErrors: number;
  /** ... within this window. */
  readonly kernelErrorWindowSeconds: number;
  /** Where deposit scanning starts for a tenant that has no ledger yet (the vault's deployment block). */
  readonly startBlock: bigint;
  /** Largest eth_getLogs range per request. */
  readonly maxBlockRange: bigint;
}

export const DEFAULT_RECONCILER_OPTIONS: ReconcilerOptions = {
  unconfirmedAfterSeconds: 120,
  unconfirmedHighAfterSeconds: 600,
  maxKernelErrors: 5,
  kernelErrorWindowSeconds: 600,
  startBlock: 0n,
  maxBlockRange: 2000n,
};

export interface PassResult {
  readonly tenantId: string;
  /** Findings recorded by THIS pass (new rows only). */
  readonly findings: ReadonlyArray<{ readonly kind: string; readonly severity: repo.Severity }>;
  /** true when this pass moved the breaker from OK to HALTED. */
  readonly tripped: boolean;
  /** true when the vault is paused (already, or by this pass). */
  readonly paused: boolean;
  /** Checks that could not run this pass (chain read failed, no cursor yet). */
  readonly skipped: readonly string[];
}

const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

export async function reconcileTenant(d: ReconcilerDeps, tenantId: string, tenantVault: string, opts: Partial<ReconcilerOptions> = {}): Promise<PassResult> {
  const o: ReconcilerOptions = { ...DEFAULT_RECONCILER_OPTIONS, ...opts };
  const vault = tenantVault as Address;
  const now = nowIso(d.clock);
  const nowSec = epochSecondsFromIso(now);
  const found: Array<{ kind: string; severity: repo.Severity }> = [];
  const skipped: string[] = [];
  const record = async (kind: string, severity: repo.Severity, key: string, detail: Record<string, string | number | boolean | null>): Promise<void> => {
    const id = await repo.insertFinding(d.db, tenantId, kind, severity, key, detail);
    if (id !== null) {
      found.push({ kind, severity });
      d.logger.warn("reconcile.finding", { tenantId, reasonCode: kind });
    }
  };
  const guarded = async (what: string, f: () => Promise<void>): Promise<void> => {
    try {
      await f();
    } catch (e) {
      skipped.push(what);
      d.logger.warn("reconcile.check_failed", { tenantId, reasonCode: what, ...errorFields(e) });
    }
  };

  // 1. SUBMITTED releases the chain has not confirmed.
  await guarded("RELEASE_UNCONFIRMED", async () => {
    for (const r of await repo.submittedReleases(d.db, tenantId)) {
      const age = nowSec - epochSecondsFromIso(r.submittedAt);
      if (age >= BigInt(o.unconfirmedHighAfterSeconds)) {
        await record("RELEASE_UNCONFIRMED", "HIGH", `${r.intentId}:high`, { intentId: r.intentId, txHash: r.txHash, ageSeconds: age.toString() });
      } else if (age >= BigInt(o.unconfirmedAfterSeconds)) {
        await record("RELEASE_UNCONFIRMED", "MEDIUM", `${r.intentId}:medium`, { intentId: r.intentId, txHash: r.txHash, ageSeconds: age.toString() });
      }
    }
  });

  // 2. Released events the kernel did not (or not exactly) sign for.
  await guarded("UNKNOWN_RELEASE", async () => {
    const known = await repo.releaseAttestations(d.db, tenantId);
    for (const e of await repo.releasedEvents(d.db, tenantId)) {
      const place = `${e.txHash}:${String(e.logIndex)}`;
      const a = known.get(e.intentId);
      if (a === undefined) {
        await record("UNKNOWN_RELEASE", "HIGH", place, { intentId: e.intentId, txHash: e.txHash, payee: e.payee, amount: e.amount });
        continue;
      }
      const diff: string[] = [];
      if (!same(e.payee, a.payee)) diff.push("payee");
      if (e.amount !== a.amount) diff.push("amount");
      if (!same(e.engagementId, a.engagementId)) diff.push("engagementId");
      if (!same(e.receiptHash, a.receiptHash)) diff.push("receiptHash");
      if (diff.length > 0) await record("RELEASE_MISMATCH", "HIGH", place, { intentId: e.intentId, txHash: e.txHash, fields: diff.join(",") });
    }
  });

  // 3. Balance identity at one consistent block (the indexer's applied head, so events and balance describe the same state).
  const snapshot = await d.chain.snapshot(vault).catch((e: unknown) => {
    skipped.push("SNAPSHOT");
    d.logger.warn("reconcile.snapshot_failed", { tenantId, ...errorFields(e) });
    return null;
  });
  if (snapshot !== null) {
    await guarded("BALANCE_DRIFT", async () => {
      const next = await repo.indexerNextBlock(d.db, tenantId);
      if (next === null || next === 0n) {
        skipped.push("BALANCE_DRIFT:NO_CURSOR");
        return;
      }
      const at = next - 1n; // every event up to and including this block is applied
      const head = await d.ledger.latestBlock();
      const block = at > head ? head : at;
      const token = snapshot.token as Address;
      let ledger = await repo.loadLedger(d.db, tenantId);
      if (ledger !== null && (!same(ledger.vault, vault) || !same(ledger.token, token))) ledger = null; // a different vault/token: start over
      let scanned = ledger === null ? o.startBlock - 1n : ledger.scannedThrough;
      let deposits = ledger === null ? 0n : ledger.deposits;
      while (scanned < block) {
        const from = scanned + 1n;
        const to = from + o.maxBlockRange - 1n > block ? block : from + o.maxBlockRange - 1n;
        deposits += await d.ledger.inflow(token, vault, from, to);
        scanned = to;
      }
      await repo.saveLedger(d.db, tenantId, { vault, token, scannedThrough: scanned, deposits });
      const outflows = await repo.outflowsThrough(d.db, tenantId, block);
      const expected = deposits - outflows;
      const actual = await d.ledger.balanceAt(token, vault, block);
      if (actual !== expected) {
        await record("BALANCE_DRIFT", "HIGH", `${expected.toString()}:${actual.toString()}`, {
          atBlock: block.toString(),
          expectedBaseUnits: expected.toString(),
          actualBaseUnits: actual.toString(),
        });
      }
    });
  }

  // 4. Kernel exception rate.
  await guarded("KERNEL_EXCEPTION_RATE", async () => {
    const since: ISODateTime = plusSeconds(now, -o.kernelErrorWindowSeconds);
    const n = await repo.kernelErrorCount(d.db, tenantId, since);
    if (n > o.maxKernelErrors) {
      const bucket = nowSec / BigInt(o.kernelErrorWindowSeconds);
      await record("KERNEL_EXCEPTION_RATE", "HIGH", `bucket:${bucket.toString()}`, { count: n, windowSeconds: o.kernelErrorWindowSeconds });
    }
  });

  // K-16: any unresolved HIGH finding halts the kernel; the guardian then pauses the vault.
  let tripped = false;
  const open = await repo.unresolvedHigh(d.db, tenantId);
  const breaker = await repo.loadBreakerRow(d.db, tenantId);
  if (open.length > 0 && !breaker.halted) {
    const first = open[0];
    const reason = `RECONCILIATION:${first?.kind ?? "HIGH"}`;
    tripped = await d.db.tx(async (q) => {
      await base.lockTenantForDecisions(q, tenantId); // serialise with evaluate-and-persist: nothing is decided half-way through the trip
      const t = await repo.tripBreakerRow(q, tenantId, reason, first?.id ?? null);
      if (t) await base.writeAudit(q, "kernel:reconciler", "breaker.tripped", { tenantId, reason, findings: open.map((f) => f.kind).slice(0, 10) });
      return t;
    });
    if (tripped) d.logger.error("breaker.tripped", { tenantId, reasonCode: reason.replace(/[^A-Za-z0-9_]/g, "_").slice(0, 40) });
  }

  // Pause the vault whenever the breaker is halted and the vault is not (also retries a pause that failed earlier).
  let paused = snapshot?.paused ?? false;
  const halted = tripped || breaker.halted || open.length > 0;
  if (halted && !paused) {
    if (d.guardian === null) {
      await repo.notePause(d.db, tenantId, null, "NO_GUARDIAN_CONFIGURED");
      d.logger.error("breaker.no_guardian", { tenantId });
    } else {
      try {
        const r = await d.guardian.pause(vault);
        paused = true;
        await repo.notePause(d.db, tenantId, r.txHash, null);
        await base.writeAudit(d.db, "kernel:guardian", "vault.paused", { tenantId, txHash: r.txHash });
      } catch (e) {
        await repo.notePause(d.db, tenantId, null, "PAUSE_FAILED");
        d.logger.error("breaker.pause_failed", { tenantId, ...errorFields(e) });
      }
    }
  }
  return { tenantId, findings: found, tripped, paused, skipped };
}

/** One pass over every tenant that has a vault on this chain. Never throws. */
export async function reconcileAll(d: ReconcilerDeps, chainId: number, opts: Partial<ReconcilerOptions> = {}): Promise<PassResult[]> {
  const out: PassResult[] = [];
  let tenants: Awaited<ReturnType<typeof repo.tenantsWithVault>> = [];
  try {
    tenants = await repo.tenantsWithVault(d.db, chainId);
  } catch (e) {
    d.logger.error("reconcile.tenants_failed", { ...errorFields(e) });
  }
  for (const t of tenants) {
    try {
      out.push(await reconcileTenant(d, t.tenantId, t.vault, opts));
    } catch (e) {
      d.logger.error("reconcile.pass_failed", { tenantId: t.tenantId, ...errorFields(e) });
    }
  }
  return out;
}

export interface ReconcilerLoop {
  stop(): Promise<void>;
  /** Run a pass now (the webhook trigger); concurrent passes are coalesced into the one already running. */
  trigger(): Promise<void>;
}

export function startReconcilerLoop(d: ReconcilerDeps, o: { chainId: number; intervalMs: number; options?: Partial<ReconcilerOptions> }): ReconcilerLoop {
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;
  let running: Promise<void> | null = null;
  const pass = (): Promise<void> => {
    if (running !== null) return running;
    const p = (async () => {
      try {
        await reconcileAll(d, o.chainId, o.options);
      } finally {
        running = null;
      }
    })();
    running = p;
    return p;
  };
  const tick = (): void => {
    void pass().finally(() => {
      if (!stopped) timer = setTimeout(tick, o.intervalMs);
    });
  };
  tick();
  return {
    async stop() {
      stopped = true;
      if (timer !== null) clearTimeout(timer);
      await running;
    },
    trigger: pass,
  };
}
