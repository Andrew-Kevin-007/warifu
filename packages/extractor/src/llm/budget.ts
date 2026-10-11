// Budget ledger wrapper (INV-21; docs/03 §2 guardrail 10; docs/05 `llm_budget_ledger`).
//
// Every paid model call goes through BudgetedLlm:
//   1. content-hash cache lookup (a hit is free and recorded as cache_hit);
//   2. RESERVE THE MAXIMUM POSSIBLE COST of the call before it is made: an upper bound on input tokens
//      (UTF-8 bytes of everything sent; a token is never shorter than a byte) plus `maxOutputTokens`, at the
//      operator's price. The ledger must grant the reservation atomically against the remaining per-principal
//      AND global budget (check and book in one step; e.g. a single conditional UPDATE in SQL), so parallel
//      calls cannot each see room and jointly exceed the cap. A denial, an invalid request, an unpriced model or
//      a ledger error all FAIL CLOSED with BudgetExhaustedError. There is no fallback to a cheaper or weaker
//      model: exhaustion means no new intent;
//   3. call the provider. EVERY attempt counts: if the call fails or times out the reservation is settled at the
//      full reserved maximum (the provider may have billed); a malformed usage report is also settled at the
//      maximum. A caller that retries makes a new call() and therefore a new reservation;
//   4. on success settle to the actual cost and cache the response.
// Money is integer micro-USD (bigint); token counts must be non-negative safe integers. The budget window (the
// "day") is owned by the ledger and read from ITS clock; nothing the caller passes can move or reset it.
// The ledger itself (Postgres `llm_budget_ledger`) is KERNEL-SVC/WEB's; this package defines the interface.
import { jcs, sha256Utf8, type Hex32 } from "@symbolon/schemas";
import type { LlmClient, LlmRequest, LlmResponse } from "./types";

export type BudgetDenyReason =
  | "GLOBAL_DAILY_CAP"
  | "PRINCIPAL_DAILY_CAP"
  | "RATE_LIMIT"
  | "LEDGER_UNAVAILABLE"
  | "UNPRICED_MODEL"
  | "INVALID_COST";

export type Reservation = { readonly ok: true; readonly id: string } | { readonly ok: false; readonly reason: BudgetDenyReason };

export interface BudgetRequest {
  /** Salted hash of the caller (never a raw IP/user id). */
  readonly principalHash: string;
  readonly role: LlmRequest["role"];
  readonly model: string;
  /** Upper bound on input tokens. */
  readonly maxTokensIn: number;
  readonly maxTokensOut: number;
  /** The MAXIMUM possible cost of the call, integer micro-USD (1e-6 USD). Reserved in full. */
  readonly maxCostMicroUsd: bigint;
}

export interface BudgetLedger {
  /** Atomically book `maxCostMicroUsd` against the principal's and the global remaining budget, or deny. */
  reserve(request: BudgetRequest): Promise<Reservation>;
  /** Replace the reservation by the amount actually spent (which may be the full reserved maximum). */
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

export function isTokenCount(n: unknown): n is number {
  return typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
}

/**
 * Price table supplied by the operator. There is intentionally NO built-in default: provider prices are not
 * known to this package (VERIFY(V-22)), and an unpriced model cannot be budgeted, so it is denied.
 */
export class CostModel {
  private readonly prices: ReadonlyMap<string, ModelPrice>;
  constructor(prices: Readonly<Record<string, ModelPrice>>) {
    const m = new Map<string, ModelPrice>();
    for (const [model, p] of Object.entries(prices)) {
      if (typeof p.inPerMTok !== "bigint" || typeof p.outPerMTok !== "bigint" || p.inPerMTok < 0n || p.outPerMTok < 0n) {
        throw new RangeError(`invalid price for ${model}: prices are non-negative bigint micro-USD per million tokens`);
      }
      m.set(model, p);
    }
    this.prices = m;
  }

  has(model: string): boolean {
    return this.prices.has(model);
  }

  /** Cost in micro-USD, rounded UP per side. Unknown model or non-integer/negative token counts are denied. */
  cost(model: string, tokensIn: number, tokensOut: number): bigint {
    const p = this.prices.get(model);
    if (p === undefined) throw new BudgetExhaustedError("UNPRICED_MODEL");
    if (!isTokenCount(tokensIn) || !isTokenCount(tokensOut)) throw new BudgetExhaustedError("INVALID_COST");
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

const encoder = new TextEncoder();

/**
 * UPPER BOUND on input tokens: the UTF-8 byte length of everything sent (system, tools, messages). A token
 * is never shorter than one byte, so this cannot under-count; it over-reserves, and the surplus is released
 * when the call settles at its actual cost.
 */
export function maxInputTokens(request: LlmRequest): number {
  let bytes = encoder.encode(request.system).length + encoder.encode(JSON.stringify(request.tools)).length;
  for (const m of request.messages) {
    bytes += encoder.encode(m.role === "user" || m.role === "tool_result" ? m.text : JSON.stringify(m.toolCalls)).length;
  }
  return bytes;
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
    // A missing ledger must never degrade to "allow": refuse to construct.
    if (!o.ledger || typeof o.ledger.reserve !== "function" || typeof o.ledger.commit !== "function") {
      throw new BudgetExhaustedError("LEDGER_UNAVAILABLE");
    }
    if (!o.costModel || !o.inner || !o.cache || typeof o.principalHash !== "string" || o.principalHash.length === 0) {
      throw new BudgetExhaustedError("LEDGER_UNAVAILABLE");
    }
    this.clock = o.clock ?? (() => performance.now());
  }

  async call(request: LlmRequest): Promise<LlmCallResult> {
    if (!Number.isSafeInteger(request.maxOutputTokens) || request.maxOutputTokens <= 0) throw new BudgetExhaustedError("INVALID_COST");
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

    const maxTokensIn = maxInputTokens(request);
    const maxCost = this.o.costModel.cost(request.model, maxTokensIn, request.maxOutputTokens); // throws if unpriced/invalid
    if (maxCost < 0n) throw new BudgetExhaustedError("INVALID_COST");

    let reservation: Reservation;
    try {
      reservation = await this.o.ledger.reserve({
        principalHash: this.o.principalHash,
        role: request.role,
        model: request.model,
        maxTokensIn,
        maxTokensOut: request.maxOutputTokens,
        maxCostMicroUsd: maxCost,
      });
    } catch {
      throw new BudgetExhaustedError("LEDGER_UNAVAILABLE");
    }
    if (!reservation.ok) throw new BudgetExhaustedError(reservation.reason);

    const settle = async (tokensIn: number, tokensOut: number, costMicroUsd: bigint): Promise<boolean> => {
      try {
        await this.o.ledger.commit(reservation.id, { tokensIn, tokensOut, costMicroUsd });
        return false;
      } catch {
        return true; // the reservation (an upper bound) already holds the spend
      }
    };

    let response: LlmResponse;
    try {
      response = await this.o.inner.complete(request);
    } catch (e) {
      // Every attempt counts: a failed or timed-out call may still have been billed. Settle at the maximum.
      await settle(maxTokensIn, request.maxOutputTokens, maxCost);
      throw e;
    }

    let tokensIn = response.usage?.tokensIn;
    let tokensOut = response.usage?.tokensOut;
    let cost: bigint;
    if (isTokenCount(tokensIn) && isTokenCount(tokensOut)) {
      cost = this.o.costModel.cost(request.model, tokensIn, tokensOut);
    } else {
      // Unknown/invalid usage report: unknown cost is charged at the reserved maximum, never at zero.
      tokensIn = maxTokensIn;
      tokensOut = request.maxOutputTokens;
      cost = maxCost;
    }
    const ledgerCommitFailed = await settle(tokensIn as number, tokensOut as number, cost);
    await this.o.cache.set(cacheKey, response);
    return {
      response,
      cacheKey,
      cacheHit: false,
      latencyMs: this.clock() - t0,
      tokensIn: tokensIn as number,
      tokensOut: tokensOut as number,
      costMicroUsd: cost,
      ledgerCommitFailed,
    };
  }

  /** Drop a cached answer that failed validation, so a bad response is not replayed for free. */
  evict(cacheKey: Hex32): Promise<void> {
    return this.o.cache.delete(cacheKey);
  }
}
