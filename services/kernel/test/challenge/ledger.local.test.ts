import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PgBudgetLedger, microToDecimal } from "../../src/challenge/ledger";
import { dbSuiteEnabled, openTestDb } from "../helpers/pgdb";
import type { TestDb } from "../helpers/pgdb";

const enabled = dbSuiteEnabled("challenge-ledger.local");
const usd = (n: number): bigint => BigInt(n) * 1_000_000n;
const req = (principalHash: string, maxCostMicroUsd: bigint) => ({ principalHash, role: "extractor_a" as const, model: "m", maxTokensIn: 1000, maxTokensOut: 100, maxCostMicroUsd });

describe("microToDecimal", () => {
  it("is exact for numeric(10,6)", () => {
    expect(microToDecimal(0n)).toBe("0.000000");
    expect(microToDecimal(1n)).toBe("0.000001");
    expect(microToDecimal(1_234_567n)).toBe("1.234567");
    expect(microToDecimal(5_000_000n)).toBe("5.000000");
    expect(() => microToDecimal(-1n)).toThrow();
  });
});

describe.skipIf(!enabled)("local: PgBudgetLedger over real Postgres (INV-21)", () => {
  let t: TestDb;
  beforeAll(() => {
    t = openTestDb("sandbox");
  }, 120_000);
  afterAll(async () => {
    await t.close();
  }, 120_000);

  it("books at the maximum, refuses past the global cap and the per-principal cap, and commit replaces the booking by the actual cost", async () => {
    const l = new PgBudgetLedger(t.db, { globalDailyMicroUsd: usd(5), perPrincipalDailyMicroUsd: usd(2) });
    const a = await l.reserve(req("p-a", usd(2)));
    expect(a.ok).toBe(true);
    expect(await l.reserve(req("p-a", 1n))).toEqual({ ok: false, reason: "PRINCIPAL_DAILY_CAP" });
    const b = await l.reserve(req("p-b", usd(2)));
    expect(b.ok).toBe(true);
    expect(await l.reserve(req("p-c", usd(2)))).toEqual({ ok: false, reason: "GLOBAL_DAILY_CAP" }); // 4 + 2 > 5
    expect(await l.spentTodayMicroUsd()).toBe(usd(4));
    if (a.ok) await l.commit(a.id, { tokensIn: 10, tokensOut: 5, costMicroUsd: 123n }); // the call was cheap: the room comes back
    expect(await l.spentTodayMicroUsd()).toBe(usd(2) + 123n);
    expect((await l.reserve(req("p-c", usd(2)))).ok).toBe(true);
  });

  it("parallel reservations can never jointly exceed the cap (the check and the booking are one step)", async () => {
    const l = new PgBudgetLedger(t.db, { globalDailyMicroUsd: usd(100), perPrincipalDailyMicroUsd: usd(100) });
    const before = await l.spentTodayMicroUsd();
    const room = usd(100) - before;
    const each = usd(1);
    const results = await Promise.all(Array.from({ length: 150 }, (_, i) => l.reserve(req(`race-${String(i % 7)}`, each))));
    const granted = results.filter((r) => r.ok).length;
    expect(BigInt(granted) * each).toBeLessThanOrEqual(room);
    expect(await l.spentTodayMicroUsd()).toBeLessThanOrEqual(usd(100));
    expect(granted).toBeGreaterThan(0);
  }, 60_000);

  it("a cache hit costs nothing and is recorded; bad input and an unknown reservation fail closed", async () => {
    const l = new PgBudgetLedger(t.db, { globalDailyMicroUsd: usd(1), perPrincipalDailyMicroUsd: usd(1) });
    const before = await l.spentTodayMicroUsd();
    await l.recordCacheHit({ principalHash: "p-x", role: "extractor_a", model: "m" });
    expect(await l.spentTodayMicroUsd()).toBe(before);
    const hits = await t.db.query<{ n: string }>("select count(*)::text as n from llm_budget_ledger where cache_hit");
    expect(Number.parseInt(hits.rows[0]?.n ?? "0", 10)).toBeGreaterThanOrEqual(1);
    expect(await l.reserve(req("", 1n))).toEqual({ ok: false, reason: "INVALID_COST" });
    expect(await l.reserve(req("p", -1n))).toEqual({ ok: false, reason: "INVALID_COST" });
    await expect(l.commit("999999999", { tokensIn: 1, tokensOut: 1, costMicroUsd: 1n })).rejects.toThrow();
    await expect(l.commit("not-an-id", { tokensIn: 1, tokensOut: 1, costMicroUsd: 1n })).rejects.toThrow();
  });
});
