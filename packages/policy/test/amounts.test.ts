// Policy amounts: decimal strings <-> bigint base units (INV-10). Rounding is refused.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { MAX_UINT256 } from "@symbolon/schemas";
import { formatPolicyAmount, parsePolicyAmount } from "../src/index";
import { PolicyError, failClosed } from "../src/errors";
import { ch, expectPolicyError } from "./helpers";

const RUNS = { numRuns: 1000 };

describe("parsePolicyAmount", () => {
  it("converts exactly", () => {
    expect(parsePolicyAmount("100.000000", 6)).toBe(100_000_000n);
    expect(parsePolicyAmount("100", 6)).toBe(100_000_000n);
    expect(parsePolicyAmount("0.5", 6)).toBe(500_000n);
    expect(parsePolicyAmount("0.000001", 6)).toBe(1n);
    expect(parsePolicyAmount("0", 6)).toBe(0n);
    expect(parsePolicyAmount("7", 0)).toBe(7n);
    expect(parsePolicyAmount("1.000000000000000001", 18)).toBe(1_000_000_000_000_000_001n);
  });

  it("refuses any fraction longer than decimals, even trailing zeros (no rounding)", () => {
    expectPolicyError(() => parsePolicyAmount("1.0000001", 6), "POLICY_INVALID");
    expectPolicyError(() => parsePolicyAmount("1.0000000", 6), "POLICY_INVALID");
    expectPolicyError(() => parsePolicyAmount("1.5", 0), "POLICY_INVALID");
    expect(parsePolicyAmount("1.000000", 6)).toBe(1_000_000n); // control: exactly `decimals` digits
  });

  it("refuses anything outside the decimal grammar", () => {
    const bad = ["", "01", "00", "1.", ".5", "-1", "+1", "1e6", " 1", "1 ", "1,000", "1_000", "0x10", "NaN", "Infinity", ch(0xff11), "1.2.3"];
    for (const s of bad) expectPolicyError(() => parsePolicyAmount(s, 6, "caps.x"), "POLICY_INVALID", "caps.x");
    expectPolicyError(() => parsePolicyAmount("1".repeat(31), 0), "POLICY_INVALID");
    expect(parsePolicyAmount("1".repeat(30), 0)).toBe(BigInt("1".repeat(30)));
    expectPolicyError(() => parsePolicyAmount(`1.${"0".repeat(37)}`, 255), "POLICY_INVALID");
    expectPolicyError(() => parsePolicyAmount(100 as unknown as string, 6), "POLICY_INVALID");
  });

  it("refuses invalid decimals", () => {
    for (const d of [-1, 256, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expectPolicyError(() => parsePolicyAmount("1", d), "POLICY_INVALID");
    }
    expect(parsePolicyAmount("0", 255)).toBe(0n); // control: 255 is a legal decimals value
    expect(parsePolicyAmount("0", 0)).toBe(0n);
  });

  it("bounds the result to uint256 (both sides of the boundary)", () => {
    // MAX_UINT256 = 115792089237316195423570985008 . 687907853269984665640564039457584007 913129639935 (30+36+12 digits)
    const intPart = "115792089237316195423570985008";
    const frac = "687907853269984665640564039457584007";
    const below = parsePolicyAmount(`${intPart}.${frac}`, 48);
    expect(below).toBe(MAX_UINT256 - 913_129_639_935n);
    expectPolicyError(() => parsePolicyAmount("115792089237316195423570985009", 48), "POLICY_INVALID");
    expectPolicyError(() => parsePolicyAmount("1", 78), "POLICY_INVALID"); // 10^78 > 2^256
    expect(parsePolicyAmount("1", 77)).toBe(10n ** 77n); // 10^77 < 2^256
  });
});

describe("formatPolicyAmount", () => {
  it("writes exactly `decimals` fraction digits, no grouping", () => {
    expect(formatPolicyAmount(100_000_000n, 6)).toBe("100.000000");
    expect(formatPolicyAmount(0n, 6)).toBe("0.000000");
    expect(formatPolicyAmount(1n, 6)).toBe("0.000001");
    expect(formatPolicyAmount(1_234_567_000_000n, 6)).toBe("1234567.000000");
    expect(formatPolicyAmount(5n, 0)).toBe("5");
  });
  it("refuses out-of-range values and decimals", () => {
    expectPolicyError(() => formatPolicyAmount(-1n, 6), "POLICY_INVALID");
    expectPolicyError(() => formatPolicyAmount(MAX_UINT256 + 1n, 6), "POLICY_INVALID");
    expectPolicyError(() => formatPolicyAmount(1n, 256), "POLICY_INVALID");
    expect(formatPolicyAmount(MAX_UINT256, 0)).toBe(MAX_UINT256.toString());
  });
});

describe("amount properties (1,000 runs each)", () => {
  const decimals = fc.integer({ min: 0, max: 36 });
  const units = fc.bigInt({ min: 0n, max: 10n ** 40n });

  it("parse(format(u, d), d) === u (and the canonical spelling is a fixed point)", () => {
    fc.assert(
      fc.property(units, decimals, (u, d) => {
        const s = formatPolicyAmount(u, d);
        const whole = d === 0 ? s : s.slice(0, s.indexOf("."));
        fc.pre(whole.length <= 30); // policy grammar: at most 30 integer digits
        expect(parsePolicyAmount(s, d)).toBe(u);
        expect(formatPolicyAmount(parsePolicyAmount(s, d), d)).toBe(s);
      }),
      RUNS,
    );
  });

  it("every spelling with <= d fraction digits parses to the same value as the canonical one", () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 0n, max: 10n ** 24n }), fc.integer({ min: 0, max: 18 }), fc.nat(), (u, d, k) => {
        const canonical = formatPolicyAmount(u, d);
        // Drop some trailing zeros (never a non-zero digit): another legal spelling of the same amount.
        let s = canonical;
        for (let i = 0; i < k % (d + 1) && s.includes(".") && s.endsWith("0"); i++) s = s.slice(0, -1);
        if (s.endsWith(".")) s = s.slice(0, -1);
        expect(parsePolicyAmount(s, d)).toBe(u);
      }),
      RUNS,
    );
  });

  it("a fraction longer than d is always refused, never rounded", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 18 }), fc.integer({ min: 1, max: 18 }), fc.nat({ max: 999_999 }), (d, extra, int) => {
        const frac = "1".padStart(d + extra, "0");
        expect(() => parsePolicyAmount(`${int}.${frac}`, d)).toThrow(PolicyError);
      }),
      RUNS,
    );
  });
});

describe("failClosed", () => {
  it("passes values and PolicyErrors through unchanged", () => {
    expect(failClosed(() => 42)).toBe(42);
    const original = new PolicyError("SCHEMA_INVALID", [{ path: "a", message: "m" }]);
    let caught: unknown;
    try {
      failClosed(() => {
        throw original;
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBe(original);
  });
  it("turns any other exception into a PolicyError with the fallback code", () => {
    expectPolicyError(() => failClosed(() => JSON.parse("{")), "INTERNAL");
    expectPolicyError(() => failClosed(() => { throw "a string"; }, "YAML_SYNTAX"), "YAML_SYNTAX");
    const err = expectPolicyError(() => failClosed(() => { throw new RangeError("x".repeat(500)); }), "INTERNAL");
    expect(err.issues[0]?.message.length).toBeLessThanOrEqual(200);
  });
  it("PolicyError messages summarize the first issue and count the rest", () => {
    const e = new PolicyError("POLICY_INVALID", [
      { path: "a", message: "one" },
      { path: "b", message: "two" },
    ]);
    expect(e.message).toBe("POLICY_INVALID: a: one (+1 more)");
    expect(new PolicyError("INTERNAL", []).message).toBe("INTERNAL");
    expect(Object.isFrozen(e.issues)).toBe(true);
    expect(Object.isFrozen(e.issues[0])).toBe(true);
  });
});
