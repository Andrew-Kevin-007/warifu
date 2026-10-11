import { isChecksumAddress, UUIDSchema, Hex32Schema } from "@symbolon/schemas";
import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import { addressFromLabel, gitShaFromLabel, hex32FromLabel, uuidFromLabel } from "../src/ids";
import { NUMBER_STYLES, classifyPrinted, parsePrinted, printAmount } from "../src/money-format";
import { Rng } from "../src/prng";
import { addDays, addSeconds, dateOf } from "../src/time";

describe("Rng", () => {
  it("is deterministic per seed and differs across seeds", () => {
    const a = new Rng("s1");
    const b = new Rng("s1");
    const c = new Rng("s2");
    const xs = Array.from({ length: 50 }, () => a.nextU32());
    expect(Array.from({ length: 50 }, () => b.nextU32())).toEqual(xs);
    expect(Array.from({ length: 50 }, () => c.nextU32())).not.toEqual(xs);
  });

  it("int(n) stays in range and covers it (statistical sanity, fixed seed)", () => {
    const r = new Rng("coverage");
    const seen = new Set<number>();
    for (let i = 0; i < 2000; i++) {
      const v = r.int(7);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(7);
      seen.add(v);
    }
    expect(seen.size).toBe(7);
  });

  it("int(n) is roughly uniform (chi-square bound, fixed seed)", () => {
    const r = new Rng("uniform");
    const n = 5;
    const counts = new Array<number>(n).fill(0);
    const trials = 20_000;
    for (let i = 0; i < trials; i++) {
      const k = r.int(n);
      counts[k] = (counts[k] ?? 0) + 1;
    }
    const expected = trials / n;
    const chi = counts.reduce((acc, c) => acc + (c - expected) ** 2 / expected, 0);
    expect(chi).toBeLessThan(18.5); // 4 degrees of freedom, p ~ 0.001
  });

  it("shuffle is a permutation and child streams are independent of draws on the parent", () => {
    const r = new Rng("shuf");
    const items = [1, 2, 3, 4, 5, 6, 7, 8];
    const out = r.shuffle(items);
    expect([...out].sort()).toEqual(items);
    const p1 = new Rng("p");
    const p2 = new Rng("p");
    p1.nextU32();
    p1.nextU32();
    expect(p1.child("x").nextU32()).toBe(p2.child("x").nextU32());
  });

  it("rejects bad arguments instead of returning garbage", () => {
    const r = new Rng("bad");
    expect(() => r.int(0)).toThrow();
    expect(() => r.int(1.5)).toThrow();
    expect(() => r.pick([])).toThrow();
    expect(() => r.range(3, 2)).toThrow();
  });
});

describe("label-derived identities", () => {
  it("addresses are valid EIP-55, stable and distinct", () => {
    const a = addressFromLabel("x");
    expect(isChecksumAddress(a)).toBe(true);
    expect(addressFromLabel("x")).toBe(a);
    expect(addressFromLabel("y")).not.toBe(a);
  });

  it("many labels all give valid checksummed addresses", () => {
    fc.assert(fc.property(fc.string({ maxLength: 40 }), (s) => isChecksumAddress(addressFromLabel(s))), { numRuns: 200 });
  });

  it("uuid, hex32 and sha follow their schemas", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 40 }), (s) => {
        expect(UUIDSchema.safeParse(uuidFromLabel(s)).success).toBe(true);
        expect(Hex32Schema.safeParse(hex32FromLabel(s)).success).toBe(true);
        expect(gitShaFromLabel(s)).toMatch(/^[0-9a-f]{40}$/);
      }),
      { numRuns: 100 },
    );
  });
});

describe("time helpers", () => {
  it("adds seconds and days on canonical instants", () => {
    expect(addSeconds("2026-11-02T09:00:00Z", 1)).toBe("2026-11-02T09:00:01Z");
    expect(addDays("2026-12-31T23:59:59Z", 1)).toBe("2027-01-01T23:59:59Z");
    expect(addSeconds("2026-11-02T00:00:00Z", -1)).toBe("2026-11-01T23:59:59Z");
    expect(dateOf("2026-11-02T09:00:00Z")).toBe("2026-11-02");
  });
});

describe("amount printing", () => {
  it("prints the same value in every style and a style-aware parser reads it back (property)", () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 0n, max: 10n ** 15n }), fc.constantFrom(...NUMBER_STYLES), fc.constantFrom(0, 2, 6), (units, style, fraction) => {
        const printed = printAmount(units, 6, style, { fractionDigits: fraction });
        expect(parsePrinted(printed, 6, style)).toBe(units);
      }),
      { numRuns: 400 },
    );
  });

  it("never rounds: a value with seven decimals cannot be printed with six", () => {
    expect(printAmount(8_000_001n, 6, "plain")).toBe("8.000001");
    expect(printAmount(8_000_000n, 6, "plain")).toBe("8.00");
    expect(printAmount(8_000_000n, 6, "us", { fractionDigits: 6 })).toBe("8.000000");
    expect(printAmount(1_234_567_890_000n, 6, "eu")).toBe("1.234.567,89");
    expect(printAmount(1_234_567_890_000n, 6, "swiss")).toBe("1'234'567.89");
  });

  it("classifies separators like K-02 step 3", () => {
    expect(classifyPrinted("1,000.50")).toBe(".");
    expect(classifyPrinted("1.000,50")).toBe(",");
    expect(classifyPrinted("1.000")).toBe("ambiguous");
    expect(classifyPrinted("1,000")).toBe("ambiguous");
    expect(classifyPrinted("12,000")).toBe("ambiguous");
    expect(classifyPrinted("1,5")).toBe(",");
    expect(classifyPrinted("3.14159")).toBe(".");
    expect(classifyPrinted("1.000.000")).toBe("none");
    expect(classifyPrinted("1000")).toBe("none");
    expect(classifyPrinted("8.000000")).toBe(".");
  });

  it("whole-unit prints of two fraction digits are never ambiguous", () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 1n, max: 10n ** 12n }), fc.constantFrom(...NUMBER_STYLES), (units, style) => {
        const p = printAmount(units * 1_000_000n, 6, style);
        expect(classifyPrinted(p)).not.toBe("ambiguous");
      }),
      { numRuns: 300 },
    );
  });
});
