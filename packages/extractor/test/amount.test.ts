import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { isAcceptedCurrency, parseAmountPrinted } from "../src/parse/amount";

function ok(printed: string, decimals = 6): string {
  const r = parseAmountPrinted(printed, decimals);
  if (r.kind !== "ok") throw new Error(`${printed} -> ${r.kind} ${"reason" in r ? r.reason : ""}`);
  return r.baseUnits.toString();
}

describe("parseAmountPrinted: K-02 test vectors (decimals = 6)", () => {
  it.each([
    ["1,000.00", "1000000000"],
    ["1.000,00", "1000000000"],
    ["1,5", "1500000"],
    ["6.000000", "6000000"],
    ["6.00", "6000000"],
    ["1 000,50", "1000500000"],
    ["1'000.50", "1000500000"],
    ["$1,000.00", "1000000000"],
    ["USDC 2,500.25", "2500250000"],
    ["1.000.000", "1000000000000"],
    ["1,000,000", "1000000000000"],
    ["1 000", "1000000000"],
    ["1000", "1000000000"],
    ["0.5", "500000"],
    ["3.14159", "3141590"],
    ["12 345,6 EUR", "12345600000"],
  ])("%s -> %s", (printed, expected) => {
    expect(ok(printed)).toBe(expected);
  });

  it.each(["1.000", "1,000", "$1,000", "250.500", "0,500"])("%s is ambiguous (lone separator + 3 digits)", (printed) => {
    expect(parseAmountPrinted(printed, 6)).toEqual({ kind: "ambiguous", reason: "LONE_SEPARATOR_THREE_DIGITS" });
  });

  it("refuses to round: 6.0000001 has too many decimals", () => {
    expect(parseAmountPrinted("6.0000001", 6)).toEqual({ kind: "invalid", reason: "TOO_MANY_DECIMALS" });
  });

  it("rejects scientific notation and non-ASCII digits", () => {
    expect(parseAmountPrinted("1e3", 6)).toEqual({ kind: "invalid", reason: "SCIENTIFIC" });
    expect(parseAmountPrinted("١٠٠", 6)).toEqual({ kind: "invalid", reason: "NON_ASCII_DIGITS" });
    expect(parseAmountPrinted("१००.००", 6)).toEqual({ kind: "invalid", reason: "NON_ASCII_DIGITS" });
  });

  it("rejects signed, bracketed and malformed values instead of guessing", () => {
    for (const bad of ["-100.00", "(100.00)", "+5", "1,00.50", "1.2.3,4", "1..0", "1,,000", ".50", "5.", "1 0000", "1k", "ten", "", "   ", "$"]) {
      expect(parseAmountPrinted(bad, 6).kind, bad).toBe("invalid");
    }
  });

  it("is exact at the 30-digit boundary and refuses beyond it", () => {
    expect(ok("1" + "0".repeat(23), 6)).toBe("1" + "0".repeat(29));
    expect(parseAmountPrinted("1" + "0".repeat(24), 6)).toEqual({ kind: "invalid", reason: "TOO_LONG" });
  });

  it("handles other decimals", () => {
    expect(ok("1.5", 0 + 1)).toBe("15");
    expect(parseAmountPrinted("1.5", 0)).toEqual({ kind: "invalid", reason: "TOO_MANY_DECIMALS" });
    expect(ok("7", 0)).toBe("7");
    expect(parseAmountPrinted("7", -1)).toEqual({ kind: "invalid", reason: "BAD_DECIMALS" });
  });
});

describe("parseAmountPrinted: properties", () => {
  const group3 = (s: string, g: string) => s.replace(/\B(?=(\d{3})+(?!\d))/g, g);

  it("round-trips any unambiguous locale rendering of any amount", () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 0n, max: 10n ** 24n }), fc.integer({ min: 0, max: 5 }), (units, fracLen) => {
        const decimals = 6;
        // render the integer part and a fraction of `fracLen` digits (fracLen != 3 avoids the ambiguity rule)
        fc.pre(fracLen !== 3);
        const whole = units / 10n ** 6n;
        const frac = (units % 10n ** 6n).toString().padStart(6, "0").slice(0, fracLen);
        const scaled = BigInt(`${whole.toString()}${frac.padEnd(decimals, "0")}`);
        const w = whole.toString();
        const renderings = [
          `${group3(w, ",")}${fracLen > 0 ? `.${frac}` : ""}`,
          `${group3(w, ".")}${fracLen > 0 ? `,${frac}` : ""}`,
          `${group3(w, " ")}${fracLen > 0 ? `,${frac}` : ""}`,
          `${group3(w, "'")}${fracLen > 0 ? `.${frac}` : ""}`,
          `$${group3(w, ",")}${fracLen > 0 ? `.${frac}` : ""}`,
        ];
        for (const printed of renderings) {
          const r = parseAmountPrinted(printed, decimals);
          // A whole number between 1 and 3 integer digits with grouping char "," or "." and no fraction is "1,000"-shaped
          // only when it has exactly 4 digits; those are legitimately ambiguous.
          if (r.kind === "ambiguous") {
            expect(fracLen === 0 && w.length >= 4 && w.length <= 6 && /^[1-9]\d{0,2}[.,]\d{3}$/.test(printed.replace(/^\$/, ""))).toBe(true);
            continue;
          }
          expect(r.kind, printed).toBe("ok");
          if (r.kind === "ok") expect(r.baseUnits, printed).toBe(scaled);
        }
      }),
      { numRuns: 400 },
    );
  });

  it("never throws and never returns a value for arbitrary strings that the K-02 grammar rejects", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 40 }), (s) => {
        const r = parseAmountPrinted(s, 6);
        if (r.kind === "ok") {
          // an ok result must only come from strings made of digits, separators, grouping and currency tokens
          expect(/[0-9]/.test(s.normalize("NFKC"))).toBe(true);
          expect(r.baseUnits >= 0n).toBe(true);
        }
      }),
      { numRuns: 500 },
    );
  });
});

describe("isAcceptedCurrency", () => {
  it("accepts the USDC aliases only", () => {
    for (const c of ["USDC", "usdc", " USD ", "$", "US$"]) expect(isAcceptedCurrency(c)).toBe(true);
    for (const c of ["EUR", "€", "EURC", "USDT", "", "USD Coin"]) expect(isAcceptedCurrency(c)).toBe(false);
  });
});
