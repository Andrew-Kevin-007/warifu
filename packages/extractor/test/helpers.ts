// Test doubles for the network edge ONLY (AGENTS.md §5): a scripted model client. Everything above it is real.
import { BudgetedLlm, CostModel, MemoryCallCache } from "../src/llm/budget";
import { InMemoryBudgetLedger } from "../src/llm/memory-ledger";
import type { LlmClient, LlmRequest, LlmResponse } from "../src/llm/types";

export class ScriptedLlm implements LlmClient {
  readonly requests: LlmRequest[] = [];
  constructor(private readonly handler: (req: LlmRequest, n: number) => LlmResponse | Promise<LlmResponse>) {}
  async complete(request: LlmRequest): Promise<LlmResponse> {
    this.requests.push(request);
    return this.handler(request, this.requests.length);
  }
}

export const TEST_PRICES = new CostModel({
  "model-a": { inPerMTok: 3_000_000n, outPerMTok: 15_000_000n }, // placeholder figures for tests only
  "model-b": { inPerMTok: 1_000_000n, outPerMTok: 5_000_000n },
  "claude-sonnet-5-5": { inPerMTok: 3_000_000n, outPerMTok: 15_000_000n },
  "claude-haiku-5-5": { inPerMTok: 1_000_000n, outPerMTok: 5_000_000n },
});

export function makeBudgeted(inner: LlmClient, caps?: { global?: bigint; principal?: bigint }) {
  const ledger = new InMemoryBudgetLedger({
    globalDailyCapMicroUsd: caps?.global ?? 10_000_000n,
    perPrincipalDailyCapMicroUsd: caps?.principal ?? 10_000_000n,
    day: () => "2026-10-11",
  });
  const cache = new MemoryCallCache();
  let t = 0;
  const llm = new BudgetedLlm({ inner, ledger, cache, costModel: TEST_PRICES, principalHash: "p1", clock: () => (t += 5) });
  return { llm, ledger, cache };
}
