// The vault event indexer (WP-12; docs/05 section 6). Polls the trusted RPC, decodes with @symbolon/chain, and writes
// chain_events + their effects in one transaction per block range.
//
//  - CONFIRMATION DEPTH: only blocks <= head - confirmations are read, so a log is applied only once it is that deep.
//    Arc is documented as final on inclusion (docs/05 s6) and the default is still 2: VERIFY(V-24) finality is not
//    checked against Arc here, depth is configuration, not an assumption.
//  - IDEMPOTENT on (tx_hash, log_index): reading a range twice changes nothing; the same tx mined again in a different
//    block (after a reorg) revives its row instead of duplicating it.
//  - REORG-SAFE: every applied block's hash is stored. Each run first re-checks the stored hashes of the recent window against
//    the node; a block whose hash changed is marked REORGED, its effects are undone (an engagement activated by it is no
//    longer ACTIVE), a HIGH finding is raised and the cursor rewinds. A log whose block hash differs from the canonical one
//    at fetch time aborts the run (it raced a reorg).
//  - FAIL CLOSED: a log from the vault that does not decode stalls the cursor (finding HIGH) instead of being skipped;
//    nothing becomes ACTIVE because an event could not be read.
//  - DECODING IS NOT AUTHENTICATION: logs come only from the configured RPC for the tenant's vault address, and decimals are
//    verified on chain first (assertTokenDecimals).
import { ChainError, decodeVaultLog } from "@symbolon/chain";
import type { Address, Hex32 } from "@symbolon/schemas";
import type { EngagementChain } from "../chain/engagement-chain";
import type { Db } from "../db/pool";
import * as base from "../db/repo";
import { errorFields } from "../log";
import type { Logger } from "../log";
import { activatePending, applyEvent, eventData, undoEvent } from "./apply";
import * as repo from "./repo";

export interface IndexerOptions {
  /** Blocks behind the head that must pass before a log is applied. */
  readonly confirmations: bigint;
  /** Largest eth_getLogs range per request. */
  readonly maxBlockRange: bigint;
  /** Where a tenant with no cursor starts (the vault's deployment block; 0 on a local chain). */
  readonly startBlock: bigint;
  /** How many blocks behind the safe head are re-verified against the node on every run. */
  readonly reorgLookback: bigint;
}

export const DEFAULT_INDEXER_OPTIONS: IndexerOptions = { confirmations: 2n, maxBlockRange: 2000n, startBlock: 0n, reorgLookback: 64n };

export interface IndexerDeps {
  readonly db: Db;
  readonly chain: EngagementChain;
  readonly logger: Logger;
}

export type IndexOutcome = "OK" | "LOCKED" | "STALLED" | "RACED" | "NOTHING";

export interface IndexResult {
  readonly outcome: IndexOutcome;
  readonly applied: number;
  readonly reorged: number;
  readonly nextBlock: bigint;
}

function assertOptions(o: IndexerOptions): void {
  if (o.confirmations < 0n || o.maxBlockRange < 1n || o.startBlock < 0n || o.reorgLookback < 0n) throw new RangeError("invalid indexer options");
}

/** Mark reorged blocks and undo their effects. Returns the number of events undone. */
export async function detectReorgs(d: IndexerDeps, tenantId: string, safeHead: bigint, o: IndexerOptions): Promise<number> {
  const from = safeHead > o.reorgLookback ? safeHead - o.reorgLookback : 0n;
  const known = await repo.confirmedBlocksSince(d.db, tenantId, from);
  const bad: Array<{ blockNumber: bigint; blockHash: string; now: Hex32 | null }> = [];
  for (const b of known) {
    const now = await d.chain.blockHash(b.blockNumber);
    if (now === null || now.toLowerCase() !== b.blockHash.toLowerCase()) bad.push({ ...b, now });
  }
  if (bad.length === 0) return 0;
  return d.db.tx(async (q) => {
    if (!(await repo.lockIndexer(q, tenantId))) return 0;
    const events = await repo.eventsInBlocks(q, tenantId, bad.map((b) => b.blockNumber));
    for (const ev of events) {
      await undoEvent(q, tenantId, ev);
      await repo.markReorged(q, ev.id);
    }
    for (const b of bad) {
      await repo.recordFinding(q, tenantId, "CHAIN_REORG", "HIGH", `${b.blockNumber.toString()}:${b.blockHash}`, { blockHash: b.blockHash, replacedBy: b.now ?? "none" });
    }
    const lowest = bad.reduce((m, b) => (b.blockNumber < m ? b.blockNumber : m), bad[0]?.blockNumber ?? 0n);
    await repo.lowerCursor(q, tenantId, lowest);
    return events.length;
  });
}

/** Re-check submissions that never turned into an event: a reverted tx frees the engagement / change for a fresh relay. */
export async function reconcileSubmissions(d: IndexerDeps, tenantId: string): Promise<void> {
  const pending = await repo.listPendingRegistrations(d.db, tenantId);
  for (const p of pending) {
    if (p.submittedTx === null) continue;
    if ((await d.chain.txStatus(p.submittedTx as Hex32)) === "reverted") {
      await repo.clearSubmission(d.db, tenantId, p.engagementId, "TX_REVERTED");
      d.logger.warn("engagement.registration_reverted", { tenantId, engagementId: p.engagementId, txHash: p.submittedTx });
    }
  }
  for (const c of await repo.submittedPayeeChanges(d.db, tenantId)) {
    const exec = c.status === "EXECUTING";
    const tx = exec ? c.executedTx : c.submittedTx;
    if (tx === null) continue;
    if ((await d.chain.txStatus(tx as Hex32)) === "reverted") {
      await repo.setPayeeChangeStatus(d.db, c.id, exec ? "PROPOSED" : "FAILED", exec ? { executedTx: null, error: "TX_REVERTED" } : { error: "TX_REVERTED" });
    }
  }
}

/** One indexing pass for one tenant. Safe to run concurrently with itself (an advisory lock makes the loser a no-op). */
export async function indexTenant(d: IndexerDeps, tenantId: string, options: Partial<IndexerOptions> = {}): Promise<IndexResult> {
  const o: IndexerOptions = { ...DEFAULT_INDEXER_OPTIONS, ...options };
  assertOptions(o);
  const tenant = await base.getTenant(d.db, tenantId);
  if (tenant === null || tenant.vaultAddress === null) throw new Error("tenant has no vault to index");
  if (tenant.chainId !== d.chain.chainId) throw new Error("tenant chain differs from the configured RPC chain");
  const vault = tenant.vaultAddress as Address;

  const head = await d.chain.latestBlock();
  const safeHead = head.number - o.confirmations;
  if (safeHead < 0n) return { outcome: "NOTHING", applied: 0, reorged: 0, nextBlock: 0n };

  const reorged = await detectReorgs(d, tenantId, safeHead, o);
  await repo.ensureCursor(d.db, tenantId, tenant.chainId, vault, o.startBlock);
  const decimals = await d.chain.verifiedDecimals(vault);

  let applied = 0;
  let outcome: IndexOutcome = "NOTHING";
  for (;;) {
    const next = (await repo.getCursor(d.db, tenantId)) ?? o.startBlock;
    if (next > safeHead) break;
    const to = next + o.maxBlockRange - 1n < safeHead ? next + o.maxBlockRange - 1n : safeHead;
    const logs = await d.chain.logs(vault, next, to);

    // The blocks these logs claim must still be the canonical ones now, or the range raced a reorg.
    const seen = new Map<string, bigint>();
    for (const l of logs) if (l.blockNumber !== null) seen.set(l.blockHash, l.blockNumber);
    for (const [hash, n] of seen) {
      const canonical = await d.chain.blockHash(n);
      if (canonical === null || canonical.toLowerCase() !== hash.toLowerCase()) return { outcome: "RACED", applied, reorged, nextBlock: next };
    }

    const sorted = [...logs].sort((a, b) => Number((a.blockNumber ?? 0n) - (b.blockNumber ?? 0n)) || (a.logIndex ?? 0) - (b.logIndex ?? 0));
    let decoded;
    try {
      decoded = sorted.map((l) => ({ log: l, ...decodeVaultLog(l, { vault, decimals }) }));
    } catch (e) {
      const code = e instanceof ChainError ? e.code : "DECODE";
      await repo.recordFinding(d.db, tenantId, "UNDECODABLE_VAULT_LOG", "HIGH", `${String(next)}-${String(to)}:${code}`, { fromBlock: Number(next), toBlock: Number(to), code });
      d.logger.error("indexer.stalled", { tenantId, reasonCode: code.replace(/[^A-Za-z0-9_]/g, "_").slice(0, 40), ...errorFields(e) });
      return { outcome: "STALLED", applied, reorged, nextBlock: next };
    }

    const locked = await d.db.tx(async (q) => {
      if (!(await repo.lockIndexer(q, tenantId))) return false;
      if ((await repo.getCursor(q, tenantId)) !== next) return true; // another pass moved the cursor: re-read it
      for (const x of decoded) {
        const place = { txHash: x.meta.transactionHash.toLowerCase(), logIndex: x.meta.logIndex, blockNumber: x.meta.blockNumber };
        const outcomeOfRecord = await repo.recordChainEvent(q, {
          tenantId, event: x.event.name, txHash: place.txHash, logIndex: place.logIndex, blockNumber: place.blockNumber, blockHash: x.log.blockHash.toLowerCase(), data: eventData(x.event),
        });
        if (outcomeOfRecord !== "SAME") {
          await applyEvent(q, tenantId, x.event, place);
          applied++;
        }
      }
      await repo.setCursor(q, tenantId, to + 1n);
      return true;
    });
    if (!locked) return { outcome: "LOCKED", applied, reorged, nextBlock: next };
    outcome = "OK";
  }

  await d.db.tx(async (q) => {
    if (await repo.lockIndexer(q, tenantId)) await activatePending(q, tenantId);
  });
  await reconcileSubmissions(d, tenantId);
  const cursor = (await repo.getCursor(d.db, tenantId)) ?? 0n;
  if (applied > 0) d.logger.info("indexer.applied", { tenantId, count: applied });
  return { outcome, applied, reorged, nextBlock: cursor };
}

/** Index every tenant that has a vault. A failing tenant is logged and does not stop the others. */
export async function indexAll(d: IndexerDeps, options: Partial<IndexerOptions> = {}): Promise<Map<string, IndexResult | "ERROR">> {
  const out = new Map<string, IndexResult | "ERROR">();
  const tenants = await d.db.query<{ id: string }>("select id from tenants where vault_address is not null and chain_id = $1 order by created_at", [d.chain.chainId]);
  for (const t of tenants.rows) {
    try {
      out.set(t.id, await indexTenant(d, t.id, options));
    } catch (e) {
      out.set(t.id, "ERROR");
      d.logger.error("indexer.failed", { tenantId: t.id, ...errorFields(e) });
    }
  }
  return out;
}

export interface IndexerLoop {
  stop(): Promise<void>;
}

/** Poll forever (docs/05 s6: every 5 s). One pass at a time; errors are logged and the loop continues. */
export function startIndexerLoop(d: IndexerDeps, o: { options?: Partial<IndexerOptions>; intervalMs: number; after?: () => Promise<void> }): IndexerLoop {
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;
  let running: Promise<void> = Promise.resolve();
  const tick = (): void => {
    running = (async () => {
      try {
        await indexAll(d, o.options);
        if (o.after !== undefined) await o.after();
      } catch (e) {
        d.logger.error("indexer.loop_failed", { ...errorFields(e) });
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
