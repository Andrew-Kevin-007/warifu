import { describe, expect, it } from "vitest";
import { BudgetExhaustedError, BudgetedLlm, CostModel, MemoryCallCache, requestCacheKey, type BudgetLedger } from "../src/llm/budget";
import { createAnthropicClient } from "../src/llm/anthropic";
import { InMemoryBudgetLedger } from "../src/llm/memory-ledger";
import { RecordingLlm, ReplayLlm } from "../src/llm/recorded";
import { ProviderError, type LlmRequest, type LlmResponse } from "../src/llm/types";
import { ScriptedLlm, TEST_PRICES, makeBudgeted } from "./helpers";

const req = (over: Partial<LlmRequest> = {}): LlmRequest => ({
  role: "extractor_a",
  model: "model-a",
  system: "sys",
  messages: [{ role: "user", text: "doc" }],
  tools: [{ name: "submit_extraction", description: "d", inputSchema: { type: "object" } }],
  toolChoice: { type: "any" },
  maxOutputTokens: 1000,
  ...over,
});
const resp = (n = 100): LlmResponse => ({ toolCalls: [{ id: "c1", name: "submit_extraction", input: { ok: true } }], text: null, usage: { tokensIn: n, tokensOut: 50 } });

describe("BudgetedLlm (INV-21)", () => {
  it("charges the ledger, returns the response and reports usage/latency/cost", async () => {
    const { llm, ledger } = makeBudgeted(new ScriptedLlm(() => resp(1000)));
    const r = await llm.call(req());
    expect(r.cacheHit).toBe(false);
    expect(r.tokensIn).toBe(1000);
    expect(r.latencyMs).toBe(5);
    // 1000 in @ 3_000_000/MTok = 3000 µUSD; 50 out @ 15_000_000/MTok = 750 µUSD
    expect(r.costMicroUsd).toBe(3750n);
    expect(ledger.spentToday()).toBe(3750n); // estimate replaced by actual
    expect(ledger.commits).toHaveLength(1);
  });

  it("content-hash cache: identical request is free, never reaches the provider or reserve()", async () => {
    const inner = new ScriptedLlm(() => resp());
    const { llm, ledger } = makeBudgeted(inner);
    const a = await llm.call(req());
    const before = ledger.spentToday();
    const b = await llm.call(req());
    expect(b.cacheHit).toBe(true);
    expect(b.costMicroUsd).toBe(0n);
    expect(inner.requests).toHaveLength(1);
    expect(ledger.reserveCalls).toBe(1);
    expect(ledger.spentToday()).toBe(before);
    expect(ledger.cacheHits).toHaveLength(1);
    expect(b.response).toEqual(a.response);
    // a different request is a miss
    const c = await llm.call(req({ messages: [{ role: "user", text: "other" }] }));
    expect(c.cacheHit).toBe(false);
  });

  it("fails closed when the global cap is exhausted: no provider call, no weaker model", async () => {
    const inner = new ScriptedLlm(() => resp());
    const { llm } = makeBudgeted(inner, { global: 1n });
    await expect(llm.call(req())).rejects.toMatchObject({ name: "BudgetExhaustedError", reason: "GLOBAL_DAILY_CAP" });
    expect(inner.requests).toHaveLength(0);
  });

  it("enforces the per-principal cap", async () => {
    const inner = new ScriptedLlm(() => resp());
    const { llm } = makeBudgeted(inner, { principal: 1n });
    await expect(llm.call(req())).rejects.toMatchObject({ reason: "PRINCIPAL_DAILY_CAP" });
    expect(inner.requests).toHaveLength(0);
  });

  it("denies an unpriced model (cannot be budgeted)", async () => {
    const inner = new ScriptedLlm(() => resp());
    const { llm } = makeBudgeted(inner);
    await expect(llm.call(req({ model: "mystery-model" }))).rejects.toMatchObject({ reason: "UNPRICED_MODEL" });
    expect(inner.requests).toHaveLength(0);
  });

  it("denies when the ledger throws (ledger outage is not a free pass)", async () => {
    const inner = new ScriptedLlm(() => resp());
    const broken: BudgetLedger = {
      reserve: () => Promise.reject(new Error("db down")),
      commit: () => Promise.resolve(),
      recordCacheHit: () => Promise.resolve(),
    };
    const llm = new BudgetedLlm({ inner, ledger: broken, cache: new MemoryCallCache(), costModel: TEST_PRICES, principalHash: "p" });
    await expect(llm.call(req())).rejects.toBeInstanceOf(BudgetExhaustedError);
    expect(inner.requests).toHaveLength(0);
  });

  it("keeps the reservation booked when the provider fails, and does not cache the failure", async () => {
    const inner = new ScriptedLlm(() => {
      throw new ProviderError("boom");
    });
    const { llm, ledger, cache } = makeBudgeted(inner);
    await expect(llm.call(req())).rejects.toBeInstanceOf(ProviderError);
    expect(ledger.spentToday() > 0n).toBe(true);
    expect(cache.size).toBe(0);
  });

  it("a failed commit does not lose the response (the reservation already holds the spend)", async () => {
    const inner = new ScriptedLlm(() => resp());
    const base = new InMemoryBudgetLedger({ globalDailyCapMicroUsd: 10n ** 9n, perPrincipalDailyCapMicroUsd: 10n ** 9n, day: () => "d" });
    const ledger: BudgetLedger = { reserve: (r) => base.reserve(r), commit: () => Promise.reject(new Error("x")), recordCacheHit: (i) => base.recordCacheHit(i) };
    const llm = new BudgetedLlm({ inner, ledger, cache: new MemoryCallCache(), costModel: TEST_PRICES, principalHash: "p" });
    const r = await llm.call(req());
    expect(r.ledgerCommitFailed).toBe(true);
  });

  it("evict() drops a cached answer", async () => {
    const inner = new ScriptedLlm(() => resp());
    const { llm } = makeBudgeted(inner);
    const a = await llm.call(req());
    await llm.evict(a.cacheKey);
    const b = await llm.call(req());
    expect(b.cacheHit).toBe(false);
    expect(inner.requests).toHaveLength(2);
  });

  it("cache key covers every input that shapes the answer", () => {
    const k = requestCacheKey(req());
    for (const v of [req({ system: "sys2" }), req({ model: "model-b" }), req({ maxOutputTokens: 999 }), req({ toolChoice: { type: "tool", name: "submit_extraction" } }), req({ role: "extractor_b" })]) {
      expect(requestCacheKey(v)).not.toBe(k);
    }
    expect(requestCacheKey(req())).toBe(k);
  });
});

describe("CostModel", () => {
  it("rounds up and rejects unknown models", () => {
    const c = new CostModel({ m: { inPerMTok: 1n, outPerMTok: 1n } });
    expect(c.cost("m", 1, 1)).toBe(2n); // ceil each side
    expect(() => c.cost("x", 1, 1)).toThrow(BudgetExhaustedError);
    expect(() => c.cost("toString", 1, 1)).toThrow(BudgetExhaustedError); // prototype keys are not models
  });
});

describe("record / replay", () => {
  it("replays a recording and fails closed on a miss", async () => {
    const rec = new RecordingLlm(new ScriptedLlm(() => resp(7)));
    await rec.complete(req());
    const replay = new ReplayLlm(rec.recordings);
    expect((await replay.complete(req())).usage.tokensIn).toBe(7);
    await expect(replay.complete(req({ system: "different" }))).rejects.toBeInstanceOf(ProviderError);
    expect(replay.misses).toBe(1);
  });
});

describe("createAnthropicClient (fake fetch)", () => {
  const okFetch = (captured: { url?: string; init?: RequestInit }): typeof fetch =>
    (async (url: string | URL | Request, init?: RequestInit) => {
      captured.url = String(url);
      captured.init = init as RequestInit;
      return new Response(
        JSON.stringify({ content: [{ type: "text", text: "hi" }, { type: "tool_use", id: "tu1", name: "submit_extraction", input: { a: 1 } }], usage: { input_tokens: 12, output_tokens: 3 } }),
        { status: 200 },
      );
    }) as typeof fetch;

  it("sends the documented shape and parses tool_use + usage", async () => {
    const cap: { url?: string; init?: RequestInit } = {};
    const c = createAnthropicClient({ apiKey: "test-key-not-real", fetch: okFetch(cap) });
    const r = await c.complete(
      req({ messages: [{ role: "user", text: "doc" }, { role: "assistant", toolCalls: [{ id: "x", name: "read_context", input: { kind: "engagement" } }] }, { role: "tool_result", callId: "x", text: "{}" }] }),
    );
    expect(cap.url).toBe("https://api.anthropic.com/v1/messages");
    const body = JSON.parse(String(cap.init?.body)) as Record<string, unknown>;
    expect(body.model).toBe("model-a");
    expect(body.max_tokens).toBe(1000);
    expect(body.tool_choice).toEqual({ type: "any" });
    expect((body.messages as Array<{ role: string }>).map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(r.toolCalls).toEqual([{ id: "tu1", name: "submit_extraction", input: { a: 1 } }]);
    expect(r.text).toBe("hi");
    expect(r.usage).toEqual({ tokensIn: 12, tokensOut: 3 });
    expect((cap.init?.headers as Record<string, string>)["x-api-key"]).toBe("test-key-not-real");
  });

  it("maps HTTP errors, network errors and malformed bodies to ProviderError without leaking the key", async () => {
    const key = "test-key-not-real";
    const mk = (f: typeof fetch) => createAnthropicClient({ apiKey: key, fetch: f }).complete(req());
    const e500 = await mk((async () => new Response("secret body", { status: 500 })) as typeof fetch).catch((e: unknown) => e);
    expect(e500).toBeInstanceOf(ProviderError);
    expect(String((e500 as Error).message)).not.toContain(key);
    expect(String((e500 as Error).message)).not.toContain("secret body");
    await expect(mk((async () => { throw new Error(`fail with ${key}`); }) as typeof fetch)).rejects.toThrow(/provider request failed/);
    await expect(mk((async () => new Response("not json", { status: 200 })) as typeof fetch)).rejects.toBeInstanceOf(ProviderError);
    await expect(mk((async () => new Response(JSON.stringify({ content: [] }), { status: 200 })) as typeof fetch)).rejects.toBeInstanceOf(ProviderError);
  });

  it("refuses an empty key", () => {
    expect(() => createAnthropicClient({ apiKey: "", fetch })).toThrow();
  });
});
