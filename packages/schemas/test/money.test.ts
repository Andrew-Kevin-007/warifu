import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { MAX_UINT256, formatBaseUnits, parseBaseUnits } from "../src/index";

/** Inverse of formatBaseUnits for the property test, written independently (string surgery, no floats). */
function unformat(display: string, decimals: number): bigint {
  const negative = display.startsWith("-");
  const [i = "", f = ""] = display.replace(/^-/, "").replace(/,/g, "").split(".");
  const v = BigInt(i) * 10n ** BigInt(decimals) + (decimals === 0 ? 0n : BigInt(f.padEnd(decimals, "0") || "0"));
  return negative ? -v : v;
}

describe("formatBaseUnits (the single bigint -> display formatter)", () => {
  it("docstring examples", () => {
    expect(formatBaseUnits(5000000n, 6)).toBe("5.00");
    expect(formatBaseUnits("1234567", 6)).toBe("1.234567");
    expect(formatBaseUnits(1000000000000n, 6)).toBe("1,000,000.00");
    expect(formatBaseUnits(7n, 0)).toBe("7");
  });

  it("never rounds: the smallest unit stays visible", () => {
    expect(formatBaseUnits(1n, 6)).toBe("0.000001");
    expect(formatBaseUnits(1n, 18)).toBe("0.000000000000000001");
    expect(formatBaseUnits(1000000000000000001n, 18)).toBe("1.000000000000000001");
  });

  it("is exact for every value (round-trip property)", () => {
    fc.assert(
      fc.property(fc.bigInt({ min: -MAX_UINT256, max: MAX_UINT256 }), fc.integer({ min: 0, max: 36 }), fc.boolean(), (v, d, grouping) => {
        expect(unformat(formatBaseUnits(v, d, { grouping }), d)).toBe(v);
      }),
      { numRuns: 1000 },
    );
  });

  it("bigint and string inputs agree", () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 0n, max: MAX_UINT256 }), fc.integer({ min: 0, max: 30 }), (v, d) => {
        expect(formatBaseUnits(v.toString(), d)).toBe(formatBaseUnits(v, d));
      }),
    );
  });

  it("rejects non-canonical strings and bad decimals", () => {
    for (const s of ["01", "-0", "+1", "1.5", " 1", "1e6", "", "0x10", "1".repeat(81)]) {
      expect(() => formatBaseUnits(s, 6), s).toThrow(RangeError);
      expect(() => parseBaseUnits(s), s).toThrow(RangeError);
    }
    for (const d of [-1, 256, 1.5, Number.NaN]) expect(() => formatBaseUnits(1n, d)).toThrow(RangeError);
    expect(() => formatBaseUnits(1n, 6, { minFractionDigits: -1 })).toThrow(RangeError);
  });
});
