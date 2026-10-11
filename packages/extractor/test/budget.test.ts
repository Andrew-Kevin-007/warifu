// INV-21 hardening after a security-review finding ("budget-cap-bypass"): reservation of the MAXIMUM possible
// cost before every call, every attempt counted, integer money, unknown price/ledger => refuse.
import { describe, expect, it } from "vitest";
import { BudgetExhaustedError, BudgetedLlm, CostModel, MemoryCallCache, maxInputTokens, type BudgetLedger } from "../src/llm/budget";
import { InMemoryBudgetLedger } from "../src/llm/memory-ledger";
import { ProviderError, type LlmRequest, type LlmResponse } from "../src/llm/types";
import { ScriptedLlm, TEST_PRICES } from "./helpers";

const mkReq = (text: string, over: Partial<LlmRequest> = {}): LlmRequest => ({
  role: "extractor_a",
  model: "model-a",
  system: "s",
  messages: [{ role: "user", text }],
  tools: [],
  toolChoice: { type: "any" },
  maxOutputTokens: 1000,
  ...over,
});
const ok = (tin = 10, tout = 10): LlmResponse => ({ toolCalls: [], text: null, usage: { tokensIn: tin, tokensOut: tout } });
const tick = () => new Promise<void>((r) => setTimeout(r, 1));

// max cost of mkReq("x") on model-a: in = bytes(system "s"=1 + tools "[]"=2 + "x"=1) = 4 tokens -> ceil(4*3) = 12 µUSD;
// out = 1000 tokens * 15 = 15000 µUSD  => 15012 µUSD.
const MAX_COST = 15_012n;

function setup(opts: { global: bigint; principal?: bigint; inner: ScriptedLlm; principalHash?: string; ledger?: BudgetLedger }) {
  const ledger = new InMemoryBudgetLedger({ globalDailyCapMicroUsd: opts.global, perPrincipalDailyCapMicroUsd: opts.principal ?? opts.global, day: () => "2026-10-11" });
  const llm = new BudgetedLlm({ inner: opts.inner, ledger: opts.ledger ?? ledger, cache: new MemoryCallCache(), costModel: TEST_PRICES, principalHash: opts.principalHash ?? "p1" });
  return { llm, ledger };
}

describe("reservation of the maximum possible cost", () => {
  it("the max input bound is the UTF-8 byte length (never fewer tokens than bytes)", () => {
    expect(maxInputTokens(mkReq("x"))).toBe(4);
    expect(maxInputTokens(mkReq("€"))).toBe(1 + 2 + 3); // multi-byte characters count per byte
  });

  it("concurrent calls that would jointly exceed the cap: only the ones that fit run", async () => {
    // cap fits exactly 2 maximum-cost reservations
    const inner = new ScriptedLlm(async () => {
      await tick();
      return ok(10, 10);
    });
    const { llm, ledger } = setup({ global: MAX_COST * 2n, inner });
    const results = await Promise.allSettled(["a", "b", "c", "d", "e"].map((t) => llm.call(mkReq(t))));
    const fulfilled = results.filter((r) => r.status === "fulfilled").length;
    const refused = results.filter((r) => r.status === "rejected" && r.reason instanceof BudgetExhaustedError).length;
    expect(fulfilled).toBe(2);
    expect(refused).toBe(3);
    expect(inner.requests).toHaveLength(2); // refused calls never reached the provider
    expect(ledger.spentToday() <= MAX_COST * 2n).toBe(true);
  });

  it("negative control: a ledger that checks but does not book (check-then-spend) overspends, so the test above is sensitive", async () => {
    const inner = new ScriptedLlm(async () => {
      await tick();
      return ok(10, 10);
    });
    const real = new InMemoryBudgetLedger({ globalDailyCapMicroUsd: MAX_COST * 2n, perPrincipalDailyCapMicroUsd: MAX_COST * 2n, day: () => "d" });
    let calls = 0;
    const broken: BudgetLedger = {
      // checks the cap against spend-so-far but never books the reservation: the classic race
      reserve: async () => (real.spentToday() + MAX_COST <= MAX_COST * 2n ? { ok: true, id: `r${calls++}` } : { ok: false, reason: "GLOBAL_DAILY_CAP" }),
      commit: async () => {},
      recordCacheHit: async () => {},
    };
    const { llm } = setup({ global: 0n, inner, ledger: broken });
    const results = await Promise.allSettled(["a", "b", "c", "d", "e"].map((t) => llm.call(mkReq(t))));
    expect(results.filter((r) => r.status === "fulfilled").length).toBeGreaterThan(2); // would overspend
  });

  it("refuses a call whose MAX cost exceeds what is left, even though its actual cost would have fit", async () => {
    const inner = new ScriptedLlm(() => ok(1, 1)); // would cost ~18 µUSD
    const { llm } = setup({ global: MAX_COST - 1n, inner });
    await expect(llm.call(mkReq("x"))).rejects.toMatchObject({ reason: "GLOBAL_DAILY_CAP" });
    expect(inner.requests).toHaveLength(0);
  });

  it("settles to the actual cost afterwards, releasing the unused part of the reservation", async () => {
    const inner = new ScriptedLlm(() => ok(10, 10));
    const { llm, ledger } = setup({ global: MAX_COST * 2n, inner });
    const r = await llm.call(mkReq("x"));
    expect(r.costMicroUsd).toBe(30n + 150n);
    expect(ledger.spentToday()).toBe(180n);
    // the released headroom lets another full-size call in
    await llm.call(mkReq("y"));
    await llm.call(mkReq("z"));
    expect(inner.requests).toHaveLength(3);
  });

  it("enforces the per-principal cap independently of the global cap", async () => {
    const inner = new ScriptedLlm(() => ok());
    const { llm } = setup({ global: MAX_COST * 100n, principal: MAX_COST - 1n, inner });
    await expect(llm.call(mkReq("x"))).rejects.toMatchObject({ reason: "PRINCIPAL_DAILY_CAP" });
  });

  it("the caller cannot move the budget window: the day comes from the ledger's own clock", async () => {
    let day = "2026-10-11";
    const ledger = new InMemoryBudgetLedger({ globalDailyCapMicroUsd: MAX_COST + 400n, perPrincipalDailyCapMicroUsd: MAX_COST + 400n, day: () => day });
    const inner = new ScriptedLlm(() => ok(10, 10));
    const llm = new BudgetedLlm({ inner, ledger, cache: new MemoryCallCache(), costModel: TEST_PRICES, principalHash: "p" });
    await llm.call(mkReq("a")); // settles at 180 µUSD
    await llm.call(mkReq("b"));
    // a request carries no day/window field at all; only the server clock rolling over opens a new window
    expect(Object.keys(mkReq("a"))).not.toContain("day");
    expect(ledger.spentToday()).toBe(360n);
    day = "2026-10-12";
    expect(ledger.spentToday()).toBe(0n);
  });
});

describe("every attempt is counted", () => {
  it("failed and timed-out attempts are charged at the full reserved maximum; retries reserve again", async () => {
    let n = 0;
    const inner = new ScriptedLlm(() => {
      n++;
      if (n <= 2) throw new ProviderError("timeout", true);
      return ok(10, 10);
    });
    const { llm, ledger } = setup({ global: MAX_COST * 10n, inner });
    for (let i = 0; i < 2; i++) await expect(llm.call(mkReq("x"))).rejects.toBeInstanceOf(ProviderError);
    expect(ledger.spentToday()).toBe(MAX_COST * 2n); // two failed attempts, each at the maximum
    await llm.call(mkReq("x")); // third attempt succeeds
    expect(ledger.spentToday()).toBe(MAX_COST * 2n + 180n);
    expect(ledger.reserveCalls).toBe(3);
  });

  it("a retry loop cannot outrun the cap: once failed attempts exhaust it, retries are refused", async () => {
    const inner = new ScriptedLlm(() => {
      throw new ProviderError("down", true);
    });
    const { llm } = setup({ global: MAX_COST * 3n, inner });
    const outcomes: string[] = [];
    for (let i = 0; i < 6; i++) {
      await llm.call(mkReq("x")).catch((e: unknown) => outcomes.push(e instanceof BudgetExhaustedError ? "refused" : "provider"));
    }
    expect(outcomes).toEqual(["provider", "provider", "provider", "refused", "refused", "refused"]);
    expect(inner.requests).toHaveLength(3);
  });

  it("an invalid usage report is charged at the maximum, never at zero", async () => {
    const bad = [{ tokensIn: Number.NaN, tokensOut: 5 }, { tokensIn: -1, tokensOut: 5 }, { tokensIn: 1.5, tokensOut: 5 }, { tokensIn: 5, tokensOut: Infinity }];
    for (const usage of bad) {
      const inner = new ScriptedLlm(() => ({ toolCalls: [], text: null, usage }));
      const { llm, ledger } = setup({ global: MAX_COST * 2n, inner });
      const r = await llm.call(mkReq("x"));
      expect(r.costMicroUsd).toBe(MAX_COST);
      expect(ledger.spentToday()).toBe(MAX_COST);
    }
  });
});

describe("integer money; unknown price or missing ledger means refuse", () => {
  it("unknown model is refused before any reservation or provider call", async () => {
    const inner = new ScriptedLlm(() => ok());
    const { llm, ledger } = setup({ global: 10n ** 12n, inner });
    await expect(llm.call(mkReq("x", { model: "no-such-model" }))).rejects.toMatchObject({ reason: "UNPRICED_MODEL" });
    expect(ledger.reserveCalls).toBe(0);
    expect(inner.requests).toHaveLength(0);
  });

  it.each([Number.NaN, -1, 0, 1.5, Infinity])("invalid maxOutputTokens %s is refused", async (bad) => {
    const inner = new ScriptedLlm(() => ok());
    const { llm } = setup({ global: 10n ** 12n, inner });
    await expect(llm.call(mkReq("x", { maxOutputTokens: bad }))).rejects.toMatchObject({ reason: "INVALID_COST" });
    expect(inner.requests).toHaveLength(0);
  });

  it("CostModel rejects negative or non-bigint prices and bad token counts", () => {
    expect(() => new CostModel({ m: { inPerMTok: -1n, outPerMTok: 1n } })).toThrow(RangeError);
    expect(() => new CostModel({ m: { inPerMTok: 1 as unknown as bigint, outPerMTok: 1n } })).toThrow(RangeError);
    const c = new CostModel({ m: { inPerMTok: 1n, outPerMTok: 1n } });
    for (const bad of [Number.NaN, -1, 1.5, Infinity]) expect(() => c.cost("m", bad, 1)).toThrow(BudgetExhaustedError);
  });

  it("a missing or malformed ledger refuses to construct (never 'allow and log')", () => {
    const base = { inner: new ScriptedLlm(() => ok()), cache: new MemoryCallCache(), costModel: TEST_PRICES, principalHash: "p" };
    expect(() => new BudgetedLlm({ ...base, ledger: undefined as unknown as BudgetLedger })).toThrow(BudgetExhaustedError);
    expect(() => new BudgetedLlm({ ...base, ledger: {} as unknown as BudgetLedger })).toThrow(BudgetExhaustedError);
    expect(() => new BudgetedLlm({ ...base, ledger: new InMemoryBudgetLedger({ globalDailyCapMicroUsd: 1n, perPrincipalDailyCapMicroUsd: 1n, day: () => "d" }), principalHash: "" })).toThrow(BudgetExhaustedError);
  });

  it("the in-memory ledger refuses negative reservations", async () => {
    const l = new InMemoryBudgetLedger({ globalDailyCapMicroUsd: 100n, perPrincipalDailyCapMicroUsd: 100n, day: () => "d" });
    const r = await l.reserve({ principalHash: "p", role: "extractor_a", model: "m", maxTokensIn: 1, maxTokensOut: 1, maxCostMicroUsd: -5n });
    expect(r).toEqual({ ok: false, reason: "INVALID_COST" });
  });
});
