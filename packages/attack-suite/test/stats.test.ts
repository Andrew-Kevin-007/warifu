// stats.ts against reference values (docs/13 §4.9): closed forms where they exist, published values, and an
// independent exact computation (BigInt binomial coefficients) for the defining equation of the upper bound.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { binomialCdf, clopperPearsonUpper, ruleOfThree, summarizeRate, wilson } from "../src/stats";

/** P(X <= k) by exact integer arithmetic scaled to 1e30: independent of binomialCdf's log-space sum. */
function exactCdf(k: number, n: number, p: number): number {
  const SCALE = 10n ** 30n;
  const pScaled = BigInt(Math.round(p * 1e15)) * 10n ** 15n; // p * 1e30
  const qScaled = SCALE - pScaled;
  let total = 0n; // scaled by 1e30 * 1e(30*n)... computed with powers below, then divided
  const pow = (b: bigint, e: number): bigint => b ** BigInt(e);
  const choose = (nn: number, kk: number): bigint => {
    let r = 1n;
    for (let i = 1; i <= kk; i++) r = (r * BigInt(nn - kk + i)) / BigInt(i);
    return r;
  };
  for (let i = 0; i <= k; i++) total += choose(n, i) * pow(pScaled, i) * pow(qScaled, n - i);
  const denom = pow(SCALE, n);
  return Number((total * 10n ** 18n) / denom) / 1e18;
}

describe("ruleOfThree", () => {
  it("is 3/n, capped at 1", () => {
    expect(ruleOfThree(100)).toBe(0.03);
    expect(ruleOfThree(3)).toBe(1);
    expect(ruleOfThree(1)).toBe(1);
  });
  it("rejects n < 1 and non-integers", () => {
    expect(() => ruleOfThree(0)).toThrow(RangeError);
    expect(() => ruleOfThree(1.5)).toThrow(RangeError);
  });
});

describe("clopperPearsonUpper (one-sided 95 %)", () => {
  it("k = 0 has the closed form 1 - 0.05^(1/n), close to but below 3/n", () => {
    for (const n of [1, 2, 10, 20, 100, 1000]) {
      const closed = 1 - 0.05 ** (1 / n);
      expect(clopperPearsonUpper(0, n)).toBeCloseTo(closed, 12);
      if (n >= 4) expect(clopperPearsonUpper(0, n)).toBeLessThan(3 / n);
    }
  });
  it("k = n is 1", () => {
    for (const n of [1, 5, 40]) expect(clopperPearsonUpper(n, n)).toBe(1);
  });
  it("matches published exact values (4 digits)", () => {
    expect(clopperPearsonUpper(0, 10)).toBeCloseTo(0.2589, 4);
    expect(clopperPearsonUpper(1, 10)).toBeCloseTo(0.3942, 4);
    expect(clopperPearsonUpper(2, 10)).toBeCloseTo(0.5069, 4);
    expect(clopperPearsonUpper(0, 100)).toBeCloseTo(0.0295, 4);
  });
  it("satisfies its defining equation under an independent exact cdf, on a grid including n = 1", () => {
    for (const [k, n] of [[0, 1], [0, 7], [1, 7], [3, 7], [6, 7], [0, 40], [2, 40], [5, 60], [12, 60]] as const) {
      const u = clopperPearsonUpper(k, n);
      expect(exactCdf(k, n, u)).toBeCloseTo(0.05, 6);
      expect(binomialCdf(k, n, u)).toBeCloseTo(0.05, 9);
    }
  });
  it("is increasing in k and decreasing in n, and at least the point estimate", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 300 }), fc.nat(300), (n, kRaw) => {
        const k = kRaw % (n + 1);
        const u = clopperPearsonUpper(k, n);
        expect(u).toBeGreaterThanOrEqual(k / n - 1e-12);
        expect(u).toBeLessThanOrEqual(1);
        if (k < n) expect(clopperPearsonUpper(k + 1, n)).toBeGreaterThan(u);
        expect(clopperPearsonUpper(k, n + 1)).toBeLessThan(u + 1e-12);
      }),
      { numRuns: 100 },
    );
  });
  it("rejects bad input", () => {
    expect(() => clopperPearsonUpper(2, 1)).toThrow(RangeError);
    expect(() => clopperPearsonUpper(-1, 5)).toThrow(RangeError);
    expect(() => clopperPearsonUpper(0, 0)).toThrow(RangeError);
    expect(() => clopperPearsonUpper(0, 5, 1)).toThrow(RangeError);
  });
});

describe("wilson", () => {
  it("k = 0 has upper z^2/(n+z^2) and lower 0; k = n mirrors it", () => {
    const z2 = 1.959963984540054 ** 2;
    for (const n of [1, 10, 100]) {
      expect(wilson(0, n).upper).toBeCloseTo(z2 / (n + z2), 12);
      expect(wilson(0, n).lower).toBe(0);
      expect(wilson(n, n).lower).toBeCloseTo(n / (n + z2), 12);
      expect(wilson(n, n).upper).toBe(1);
    }
    expect(wilson(0, 1).upper).toBeCloseTo(0.7935, 4);
  });
  it("matches a published value: 7 of 20 gives about [0.181, 0.567]", () => {
    const w = wilson(7, 20);
    expect(w.lower).toBeCloseTo(0.1812, 3);
    expect(w.upper).toBeCloseTo(0.5671, 3);
  });
  it("always brackets the point estimate within [0, 1]", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 500 }), fc.nat(500), (n, kRaw) => {
        const k = kRaw % (n + 1);
        const w = wilson(k, n);
        expect(w.lower).toBeLessThanOrEqual(k / n + 1e-12);
        expect(w.upper).toBeGreaterThanOrEqual(k / n - 1e-12);
        expect(w.lower).toBeGreaterThanOrEqual(0);
        expect(w.upper).toBeLessThanOrEqual(1);
      }),
    );
  });
});

describe("summarizeRate", () => {
  it("uses the rule of three at k = 0 and Clopper-Pearson otherwise; no rate without trials", () => {
    expect(summarizeRate(0, 50)).toEqual({ n: 50, k: 0, rate: 0, upper95: 0.06, upper95Method: "rule-of-three" });
    const s = summarizeRate(2, 50);
    expect(s?.upper95Method).toBe("clopper-pearson");
    expect(s?.upper95).toBeCloseTo(clopperPearsonUpper(2, 50), 12);
    expect(summarizeRate(0, 0)).toBeNull();
  });
});
