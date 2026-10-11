// Budget ledger wrapper (INV-21; docs/03 §2 guardrail 10; docs/05 `llm_budget_ledger`).
//
// Every paid model call goes through BudgetedLlm:
//   1. content-hash cache lookup (a hit is free and recorded as cache_hit);
//   2. reserve the ESTIMATED spend with the ledger BEFORE calling the provider; denial, ledger error or an
//      unpriced model all FAIL CLOSED with BudgetExhaustedError. There is deliberately no fallback path to a
//      cheaper or weaker model: exhaustion means no new intent;
//   3. call the provider; on success commit actual usage; on provider failure the reservation is kept as spent
//      (the provider may have billed) and the error propagates;
//   4. cache the response.
// The ledger itself (Postgres `llm_budget_ledger`, per-principal and global daily caps) is KERNEL-SVC/WEB's;
// this package defines the interface it must satisfy.
import { jcs, sha256Utf8, type Hex32 } from "@symbolon/schemas";
import type { LlmClient, LlmRequest, LlmResponse } from "./types";

export type BudgetDenyReason = "GLOBAL_DAILY_CAP" | "PRINCIPAL_DAILY_CAP" | "RATE_LIMIT" | "LEDGER_UNAVAILABLE" | "UNPRICED_MODEL";

export type Reservation = { readonly ok: true; readonly id: string } | { readonly ok: false; readonly reason: BudgetDenyReason };

export interface BudgetRequest {
  /** Salted hash of the caller (never a raw IP/user id). */
  readonly principalHash: string;
  readonly role: LlmRequest["role"];
  readonly model: string;
  readonly estTokensIn: number;
  readonly maxTokensOut: number;
  /** Integer micro-USD (1e-6 USD); bigint to keep money out of floats. */
  readonly estCostMicroUsd: bigint;
}

export interface BudgetLedger {
  reserve(request: BudgetRequest): Promise<Reservation>;
  commit(reservationId: string, actual: { tokensIn: number; tokensOut: number; costMicroUsd: bigint }): Promise<void>;
  recordCacheHit(info: { principalHash: string; role: LlmRequest["role"]; model: string }): Promise<void>;
}

export class BudgetExhaustedError extends Error {
  constructor(readonly reason: BudgetDenyReason) {
    super(`LLM budget denied: ${reason}`);
    this.name = "BudgetExhaustedError";
  }
}

export interface ModelPrice {
  /** micro-USD per 1,000,000 input tokens */
  readonly inPerMTok: bigint;
  /** micro-USD per 1,000,000 output tokens */
  readonly outPerMTok: bigint;
}

/**
 * Price table supplied by the operator. There is intentionally NO built-in default: provider prices are not
 * known to this package (VERIFY(V-22)), and an unpriced model cannot be budgeted, so it is denied.
 */
export class CostModel {
  constructor(private readonly prices: Readonly<Record<string, ModelPrice>>) {}

  has(model: string): boolean {
    return Object.prototype.hasOwnProperty.call(this.prices, model);
  }

  cost(model: string, tokensIn: number, tokensOut: number): bigint {
    const p = this.has(model) ? this.prices[model] : undefined;
    if (p === undefined) throw new BudgetExhaustedError("UNPRICED_MODEL");
    const ceilDiv = (a: bigint) => (a + 999_999n) / 1_000_000n;
    return ceilDiv(BigInt(tokensIn) * p.inPerMTok) + ceilDiv(BigInt(tokensOut) * p.outPerMTok);
  }
}

export interface CallCache {
  get(key: Hex32): Promise<LlmResponse | undefined>;
  set(key: Hex32, value: LlmResponse): Promise<void>;
  delete(key: Hex32): Promise<void>;
}

/** Bounded in-memory cache (oldest-first eviction). Production uses a shared store keyed the same way. */
export class MemoryCallCache implements CallCache {
  private readonly map = new Map<Hex32, LlmResponse>();
  constructor(private readonly maxEntries = 1024) {}
  get(key: Hex32): Promise<LlmResponse | undefined> {
    return Promise.resolve(this.map.get(key));
  }
  set(key: Hex32, value: LlmResponse): Promise<void> {
    this.map.set(key, value);
    while (this.map.size > this.maxEntries) {
      const oldest = this.map.keys().next();
      if (oldest.done === true) break;
      this.map.delete(oldest.value);
    }
    return Promise.resolve();
  }
  delete(key: Hex32): Promise<void> {
    this.map.delete(key);
    return Promise.resolve();
  }
  get size(): number {
    return this.map.size;
  }
}

/** Content hash of everything that determines the model's answer. */
export function requestCacheKey(request: LlmRequest): Hex32 {
  return sha256Utf8(
    jcs({
      role: request.role,
      model: request.model,
      system: request.system,
      messages: request.messages,
      tools: request.tools,
      toolChoice: request.toolChoice,
      maxOutputTokens: request.maxOutputTokens,
    }),
  );
}

/** Conservative input-token estimate (over-counts: ~3 chars per token). ESTIMATE only, used for reservation. */
export function estimateTokensIn(request: LlmRequest): number {
  let chars = request.system.length + JSON.stringify(request.tools).length;
  for (const m of request.messages) {
    chars += m.role === "user" || m.role === "tool_result" ? m.text.length : JSON.stringify(m.toolCalls).length;
  }
  return Math.ceil(chars / 3);
}

export interface LlmCallResult {
  readonly response: LlmResponse;
  readonly cacheKey: Hex32;
  readonly cacheHit: boolean;
  readonly latencyMs: number;
  readonly tokensIn: number;
  readonly tokensOut: number;
  readonly costMicroUsd: bigint;
  readonly ledgerCommitFailed: boolean;
}

export interface BudgetedLlmOptions {
  readonly inner: LlmClient;
  readonly ledger: BudgetLedger;
  readonly cache: CallCache;
  readonly costModel: CostModel;
  readonly principalHash: string;
  /** Monotonic millisecond clock (injected so tests are deterministic). */
  readonly clock?: () => number;
}

export class BudgetedLlm {
  private readonly clock: () => number;
  constructor(private readonly o: BudgetedLlmOptions) {
    this.clock = o.clock ?? (() => performance.now());
  }

  async call(request: LlmRequest): Promise<LlmCallResult> {
    const cacheKey = requestCacheKey(request);
    const t0 = this.clock();

    const hit = await this.o.cache.get(cacheKey);
    if (hit !== undefined) {
      try {
        await this.o.ledger.recordCacheHit({ principalHash: this.o.principalHash, role: request.role, model: request.model });
      } catch {
        // A cache hit costs nothing; failing to record it must not turn a free answer into an outage.
      }
      return { response: hit, cacheKey, cacheHit: true, latencyMs: this.clock() - t0, tokensIn: 0, tokensOut: 0, costMicroUsd: 0n, ledgerCommitFailed: false };
    }

    const estTokensIn = estimateTokensIn(request);
    let estCost: bigint;
    try {
      estCost = this.o.costModel.cost(request.model, estTokensIn, request.maxOutputTokens);
    } catch (e) {
      throw e instanceof BudgetExhaustedError ? e : new BudgetExhaustedError("UNPRICED_MODEL");
    }

    let reservation: Reservation;
    try {
      reservation = await this.o.ledger.reserve({
        principalHash: this.o.principalHash,
        role: request.role,
        model: request.model,
        estTokensIn,
        maxTokensOut: request.maxOutputTokens,
        estCostMicroUsd: estCost,
      });
    } catch {
      throw new BudgetExhaustedError("LEDGER_UNAVAILABLE");
    }
    if (!reservation.ok) throw new BudgetExhaustedError(reservation.reason);

    // The provider call. A failure here propagates; the reservation stays booked (it may have been billed).
    const response = await this.o.inner.complete(request);

    const costMicroUsd = this.o.costModel.cost(request.model, response.usage.tokensIn, response.usage.tokensOut);
    let ledgerCommitFailed = false;
    try {
      await this.o.ledger.commit(reservation.id, { tokensIn: response.usage.tokensIn, tokensOut: response.usage.tokensOut, costMicroUsd });
    } catch {
      ledgerCommitFailed = true; // the reservation (an over-estimate) already holds the spend
    }
    await this.o.cache.set(cacheKey, response);
    return {
      response,
      cacheKey,
      cacheHit: false,
      latencyMs: this.clock() - t0,
      tokensIn: response.usage.tokensIn,
      tokensOut: response.usage.tokensOut,
      costMicroUsd,
      ledgerCommitFailed,
    };
  }

  /** Drop a cached answer that failed validation, so a bad response is not replayed for free. */
  evict(cacheKey: Hex32): Promise<void> {
    return this.o.cache.delete(cacheKey);
  }
}
