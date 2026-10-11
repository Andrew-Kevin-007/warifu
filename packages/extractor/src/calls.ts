// Observability for model calls (docs/03 §9): one record per call, shaped like the `agent_calls` table
// (docs/05 §3). Persisting it is the service's job (AgentCallSink); recording is best-effort and must never
// block or alter a decision. Spend accounting is the budget ledger's job, not this table's.
import type { Hex32 } from "@symbolon/schemas";
import type { LlmCallResult } from "./llm/budget";
import type { LlmRole } from "./llm/types";

export interface AgentCallRecord {
  readonly role: LlmRole;
  readonly model: string;
  readonly promptHash: Hex32;
  /** Content hash of the full request (same value as the cache key). */
  readonly inputHash: Hex32;
  /** The model's tool calls and free text, as returned. Contains document-derived strings: store, never log. */
  readonly output: unknown;
  readonly tokensIn: number;
  readonly tokensOut: number;
  readonly latencyMs: number;
  /** numeric(10,6) USD as a string, from integer micro-USD. "0.000000" for cache hits. */
  readonly costUsd: string;
  readonly cacheHit: boolean;
  readonly turn: number;
}

export interface AgentCallSink {
  record(call: AgentCallRecord): Promise<void>;
}

/** 3750n -> "0.003750". Pure integer formatting. */
export function microUsdToUsdString(micro: bigint): string {
  if (micro < 0n) throw new RangeError("negative cost");
  const whole = micro / 1_000_000n;
  const frac = (micro % 1_000_000n).toString().padStart(6, "0");
  return `${whole.toString()}.${frac}`;
}

export function toCallRecord(args: { role: LlmRole; model: string; promptHash: Hex32; turn: number; result: LlmCallResult }): AgentCallRecord {
  const { result } = args;
  return {
    role: args.role,
    model: args.model,
    promptHash: args.promptHash,
    inputHash: result.cacheKey,
    output: { toolCalls: result.response.toolCalls, text: result.response.text },
    tokensIn: result.tokensIn,
    tokensOut: result.tokensOut,
    latencyMs: Math.round(result.latencyMs),
    costUsd: microUsdToUsdString(result.costMicroUsd),
    cacheHit: result.cacheHit,
    turn: args.turn,
  };
}

/** Aggregates for agent_metrics / the eval report. */
export function summarizeCalls(calls: readonly AgentCallRecord[]): {
  calls: number;
  cacheHits: number;
  tokensIn: number;
  tokensOut: number;
  latencyMsP50: number;
  latencyMsP95: number;
} {
  const lat = calls.filter((c) => !c.cacheHit).map((c) => c.latencyMs).sort((a, b) => a - b);
  const pct = (p: number) => (lat.length === 0 ? 0 : (lat[Math.min(lat.length - 1, Math.ceil(p * lat.length) - 1)] ?? 0));
  return {
    calls: calls.length,
    cacheHits: calls.filter((c) => c.cacheHit).length,
    tokensIn: calls.reduce((s, c) => s + c.tokensIn, 0),
    tokensOut: calls.reduce((s, c) => s + c.tokensOut, 0),
    latencyMsP50: pct(0.5),
    latencyMsP95: pct(0.95),
  };
}
