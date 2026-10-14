// Edge behaviour of bounds.ts that the certificate relies on (fail closed at the uint256 edge, zero windows, zero divisors).
// Added by WP-34 after the verifier mutation test showed these guards were untested.
import { describe, expect, it } from "vitest";
import { BoundsError, MAX_UINT256, boundT3c, boundT3cWithWindows, ceilDiv, maxDetectionSeconds, assertBoundInputs } from "../src/bounds";
import type { BoundInputs } from "../src/bounds";

const base: BoundInputs = { B: 10n, P: 5n, D: 8n, H: 5n, hc: 0n, N: 64n, sumRemaining: 10n };

describe("uint256 edge", () => {
  it("accepts exactly 2^256-1 in every field and refuses 2^256", () => {
    for (const k of ["B", "H", "hc", "sumRemaining", "P", "D", "N"] as const) {
      expect(() => assertBoundInputs({ ...base, [k]: MAX_UINT256 })).not.toThrow();
      expect(() => assertBoundInputs({ ...base, [k]: MAX_UINT256 + 1n })).toThrow(BoundsError);
    }
    expect(() => maxDetectionSeconds(base, MAX_UINT256)).not.toThrow();
    expect(() => maxDetectionSeconds(base, MAX_UINT256 + 1n)).toThrow(/INVALID_TARGET/);
  });
  it("a bound at the uint256 edge is still exact", () => {
    const i = { ...base, B: MAX_UINT256, D: MAX_UINT256, P: MAX_UINT256, H: MAX_UINT256, sumRemaining: MAX_UINT256, N: 1n };
    expect(boundT3c(i, 86_400n).value).toBe(MAX_UINT256);
  });
});

describe("zero divisors throw BoundsError, not a raw RangeError", () => {
  it("ceilDiv by zero or a negative", () => {
    expect(() => ceilDiv(1n, 0n)).toThrow(BoundsError);
    expect(() => ceilDiv(-1n, 1n)).toThrow(BoundsError);
    expect(ceilDiv(0n, 1n)).toBe(0n);
  });
  it("window lengths must be positive", () => {
    expect(() => boundT3cWithWindows(base, 10n, { daySeconds: 0n, hourSeconds: 1n })).toThrow(BoundsError);
    expect(() => boundT3cWithWindows(base, 10n, { daySeconds: 1n, hourSeconds: 0n })).toThrow(BoundsError);
    expect(() => boundT3cWithWindows(base, 10n, { daySeconds: 1n, hourSeconds: 1n })).not.toThrow();
  });
});

describe("maxDetectionSeconds uses min(B, sumRemaining) for the 'never exceeds' test", () => {
  it("B small, sumRemaining large: a target at B is unbounded; one below is not", () => {
    const i: BoundInputs = { B: 10n, P: 5n, D: 5n, H: 5n, hc: 0n, N: 64n, sumRemaining: 1000n };
    expect(maxDetectionSeconds(i, 10n)).toBe("UNBOUNDED_BELOW_TARGET");
    expect(maxDetectionSeconds(i, 9n)).toBe(86_400n); // floor(9/5)=1 window
  });
  it("sumRemaining small, B large: same from the other side", () => {
    const i: BoundInputs = { B: 1000n, P: 5n, D: 5n, H: 5n, hc: 0n, N: 64n, sumRemaining: 10n };
    expect(maxDetectionSeconds(i, 10n)).toBe("UNBOUNDED_BELOW_TARGET");
    expect(maxDetectionSeconds(i, 9n)).toBe(86_400n);
  });
});
