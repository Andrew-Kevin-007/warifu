import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  ChainError,
  MAX_DECIMALS,
  MAX_UINT256,
  addMoney,
  compareMoney,
  convertDecimals,
  equalsMoney,
  formatBaseUnits,
  formatMoney,
  formatUnits,
  money,
  parseMoney,
  subMoney,
  toBaseUnits,
  type ChainErrorCode,
} from "../src/index";

function code(fn: () => unknown): ChainErrorCode | "no-throw" {
  try {
    fn();
    return "no-throw";
  } catch (e) {
    if (e instanceof ChainError) return e.code;
    throw e;
  }
}

describe("toBaseUnits / formatUnits: examples and edges", () => {
  it.each([
    ["0", 6, 0n],
    ["1", 6, 1_000_000n],
    ["1.5", 6, 1_500_000n],
    ["0.000001", 6, 1n],
    ["123456789.123456", 6, 123_456_789_123_456n],
    ["1", 18, 10n ** 18n],
    ["0.000000000000000001", 18, 1n],
    ["7", 0, 7n],
    ["1.50", 1, 15n], // excess zeros lose nothing
    ["5.0", 0, 5n],
  ] as const)("toBaseUnits(%s, %i) = %s", (text, d, expected) => {
    expect(toBaseUnits(text, d)).toBe(expected);
  });

  it.each([
    [0n, 6, "0"],
    [1n, 6, "0.000001"],
    [1_000_000n, 6, "1"],
    [1_500_000n, 6, "1.5"],
    [10n ** 18n, 18, "1"],
    [1n, 18, "0.000000000000000001"],
    [7n, 0, "7"],
    [100n, 2, "1"],
    [101n, 2, "1.01"],
  ] as const)("formatUnits(%s, %i) = %s", (units, d, expected) => {
    expect(formatUnits(units, d)).toBe(expected);
  });

  it("handles the uint256 boundary at 6 and 18 decimals", () => {
    for (const d of [0, 6, 18, MAX_DECIMALS]) {
      expect(toBaseUnits(formatUnits(MAX_UINT256, d), d)).toBe(MAX_UINT256);
    }
  });

  it("rejects anything above uint256 (negative control: the exact maximum is accepted above)", () => {
    expect(code(() => toBaseUnits((MAX_UINT256 + 1n).toString(), 0))).toBe("OVERFLOW");
    expect(code(() => money(MAX_UINT256 + 1n, 6))).toBe("INVALID_AMOUNT");
  });
});

describe("toBaseUnits: rejects non-canonical input (fail closed)", () => {
  it.each([
    "",
    " 1",
    "1 ",
    "1,000",
    "1_000",
    "+1",
    "-1",
    "-0",
    "1e6",
    "1E6",
    "0x10",
    ".5",
    "5.",
    "01",
    "00.5",
    "1.2.3",
    "١", // arabic-indic digit one
    "１", // full-width digit
    "1\n",
    "NaN",
    "Infinity",
  ])("rejects %j", (text) => {
    expect(code(() => toBaseUnits(text, 6))).toBe("INVALID_AMOUNT");
  });

  it("rejects over-long text before parsing", () => {
    expect(code(() => toBaseUnits("1".repeat(121), 6))).toBe("INVALID_AMOUNT");
  });

  it("rejects non-string input at runtime", () => {
    expect(code(() => toBaseUnits(1.5 as unknown as string, 6))).toBe("INVALID_AMOUNT");
    expect(code(() => toBaseUnits(null as unknown as string, 6))).toBe("INVALID_AMOUNT");
  });

  it("refuses to round: precision loss is an error, never truncation", () => {
    expect(code(() => toBaseUnits("0.0000001", 6))).toBe("PRECISION_LOSS");
    expect(code(() => toBaseUnits("1.5", 0))).toBe("PRECISION_LOSS");
    expect(code(() => toBaseUnits("0.0000010000001", 6))).toBe("PRECISION_LOSS");
    expect(code(() => toBaseUnits("0.0000010", 6))).toBe("no-throw"); // trailing zero beyond 6 is exact
  });

  it.each([-1, 1.5, 37, 255, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])("rejects decimals %s", (d) => {
    expect(code(() => toBaseUnits("1", d))).toBe("INVALID_DECIMALS");
    expect(code(() => formatUnits(1n, d))).toBe("INVALID_DECIMALS");
    expect(code(() => money(1n, d))).toBe("INVALID_DECIMALS");
  });

  it("rejects a string or a number where decimals belong", () => {
    expect(code(() => toBaseUnits("1", "6" as unknown as number))).toBe("INVALID_DECIMALS");
  });
});

describe("Money", () => {
  it("is validated and frozen", () => {
    const m = money(5n, 6);
    expect(Object.isFrozen(m)).toBe(true);
    expect(code(() => money(-1n, 6))).toBe("INVALID_AMOUNT");
    expect(code(() => money(1 as unknown as bigint, 6))).toBe("INVALID_AMOUNT");
  });

  it("add / sub / compare require the same decimals", () => {
    const a = money(1_000_000n, 6);
    const b = money(1_000_000n, 18);
    expect(code(() => addMoney(a, b))).toBe("DECIMALS_MISMATCH");
    expect(code(() => subMoney(a, b))).toBe("DECIMALS_MISMATCH");
    expect(code(() => compareMoney(a, b))).toBe("DECIMALS_MISMATCH");
    expect(equalsMoney(a, b)).toBe(false); // same units, different scale: not equal
    expect(addMoney(a, a).units).toBe(2_000_000n);
    expect(subMoney(a, a).units).toBe(0n);
  });

  it("subtraction below zero and addition above uint256 throw", () => {
    expect(code(() => subMoney(money(1n, 6), money(2n, 6)))).toBe("UNDERFLOW");
    expect(code(() => addMoney(money(MAX_UINT256, 6), money(1n, 6)))).toBe("OVERFLOW");
    expect(addMoney(money(MAX_UINT256 - 1n, 6), money(1n, 6)).units).toBe(MAX_UINT256);
  });

  it("compareMoney orders", () => {
    expect(compareMoney(money(1n, 6), money(2n, 6))).toBe(-1);
    expect(compareMoney(money(2n, 6), money(2n, 6))).toBe(0);
    expect(compareMoney(money(3n, 6), money(2n, 6))).toBe(1);
  });

  it("parseMoney / formatMoney round-trip", () => {
    expect(formatMoney(parseMoney("12.345678", 6))).toBe("12.345678");
  });
});

describe("convertDecimals: the 6 <-> 18 bridge", () => {
  it("6 -> 18 is exact: 1 USDC (ERC-20) is 1e18 native units", () => {
    expect(convertDecimals(money(1_000_000n, 6), 18)).toEqual({ units: 10n ** 18n, decimals: 18 });
    expect(convertDecimals(money(1n, 6), 18).units).toBe(10n ** 12n);
  });

  it("18 -> 6 is exact only when the 12 low digits are zero", () => {
    expect(convertDecimals(money(10n ** 18n, 18), 6).units).toBe(1_000_000n);
    expect(convertDecimals(money(10n ** 12n, 18), 6).units).toBe(1n);
    expect(code(() => convertDecimals(money(10n ** 12n + 1n, 18), 6))).toBe("PRECISION_LOSS");
    expect(code(() => convertDecimals(money(1n, 18), 6))).toBe("PRECISION_LOSS");
  });

  it("floor and ceil are explicit opt-ins and differ by exactly one base unit", () => {
    const m = money(10n ** 12n + 1n, 18);
    expect(convertDecimals(m, 6, "floor").units).toBe(1n);
    expect(convertDecimals(m, 6, "ceil").units).toBe(2n);
    // exact multiples are unchanged by any mode
    expect(convertDecimals(money(3n * 10n ** 12n, 18), 6, "ceil").units).toBe(3n);
  });

  it("scaling up past uint256 overflows", () => {
    expect(code(() => convertDecimals(money(MAX_UINT256, 6), 18))).toBe("OVERFLOW");
  });

  it("same decimals is the identity; unknown rounding mode is refused", () => {
    expect(convertDecimals(money(5n, 6), 6).units).toBe(5n);
    expect(code(() => convertDecimals(money(10n ** 12n + 1n, 18), 6, "round" as never))).toBe("INVALID_AMOUNT");
  });

  it("a 6-decimal amount misread as 18 decimals is a 10^12 error that equalsMoney exposes", () => {
    const real = money(25_000_000n, 6); // 25 USDC
    const misread = money(25_000_000n, 18);
    expect(equalsMoney(real, misread)).toBe(false);
    expect(equalsMoney(convertDecimals(real, 18), misread)).toBe(false);
    expect(formatUnits(misread.units, 18)).toBe("0.000000000025");
  });
});

describe("properties (1,000 runs)", () => {
  const decimalsArb = fc.integer({ min: 0, max: MAX_DECIMALS });
  const unitsArb = fc.oneof(
    fc.bigInt({ min: 0n, max: MAX_UINT256 }),
    fc.bigInt({ min: 0n, max: 10n ** 12n }),
    fc.constantFrom(0n, 1n, MAX_UINT256, MAX_UINT256 - 1n, 10n ** 6n, 10n ** 18n, 10n ** 18n - 1n),
  );

  it("toBaseUnits(formatUnits(u, d), d) === u for decimals 0..36", () => {
    fc.assert(
      fc.property(unitsArb, decimalsArb, (u, d) => toBaseUnits(formatUnits(u, d), d) === u),
      { numRuns: 1000 },
    );
  });

  it("formatUnits(toBaseUnits(text, d), d) is the minimal spelling of text", () => {
    const textArb = fc
      .tuple(fc.bigInt({ min: 0n, max: 10n ** 30n }), fc.bigInt({ min: 0n, max: 10n ** 18n - 1n }), fc.integer({ min: 0, max: 18 }))
      .map(([whole, frac, d]) => ({ d, text: d === 0 ? whole.toString() : `${whole.toString()}.${(frac % 10n ** BigInt(d)).toString().padStart(d, "0")}` }));
    fc.assert(
      fc.property(textArb, ({ d, text }) => {
        const out = formatUnits(toBaseUnits(text, d), d);
        // same value: re-parse both
        return toBaseUnits(out, d) === toBaseUnits(text, d) && !/\.0*$/.test(out) && !/\.\d*0$/.test(out);
      }),
      { numRuns: 1000 },
    );
  });

  it("agrees with the independent schemas formatter (formatBaseUnits, no grouping, no min fraction)", () => {
    fc.assert(
      fc.property(unitsArb, decimalsArb, (u, d) => formatUnits(u, d) === formatBaseUnits(u, d, { grouping: false, minFractionDigits: 0 })),
      { numRuns: 1000 },
    );
  });

  it("6 -> 18 -> 6 is lossless; 18 -> 6 -> 18 loses exactly the remainder", () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 0n, max: MAX_UINT256 / 10n ** 12n }), (u) => {
        const up = convertDecimals(money(u, 6), 18);
        return convertDecimals(up, 6).units === u;
      }),
      { numRuns: 1000 },
    );
    fc.assert(
      fc.property(fc.bigInt({ min: 0n, max: MAX_UINT256 }), (u) => {
        const down = convertDecimals(money(u, 18), 6, "floor");
        const back = convertDecimals(down, 18);
        return u - back.units === u % 10n ** 12n;
      }),
      { numRuns: 1000 },
    );
  });

  it("add then sub restores the operand; comparison matches bigint order", () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 0n, max: MAX_UINT256 / 2n }), fc.bigInt({ min: 0n, max: MAX_UINT256 / 2n }), decimalsArb, (a, b, d) => {
        const ma = money(a, d);
        const mb = money(b, d);
        return subMoney(addMoney(ma, mb), mb).units === a && compareMoney(ma, mb) === (a < b ? -1 : a > b ? 1 : 0);
      }),
      { numRuns: 1000 },
    );
  });
});
