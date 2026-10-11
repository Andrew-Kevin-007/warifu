// parseMoney (docs/04 K-02): every spec vector, the fail-closed refinements, and P-K02-ROUNDTRIP (1,000 runs).
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { parseMoney } from "../src/index";
import type { MoneyParse } from "../src/index";

const D6 = 6;
const exact = (baseUnits: bigint, decimalSeparator: "." | "," | null = "."): MoneyParse => ({ kind: "EXACT", baseUnits, decimalSeparator });
const AMBIG: MoneyParse = { kind: "AMBIGUOUS", reason: "LONE_SEPARATOR_THREE_DIGITS" };
const MALFORMED: MoneyParse = { kind: "AMBIGUOUS", reason: "MALFORMED" };
const reject = (code: "NON_ASCII_DIGITS" | "SCIENTIFIC" | "REFUSE_ROUND"): MoneyParse => ({ kind: "REJECT", code });

describe("docs/04 K-02 test vectors (decimals = 6), verbatim", () => {
  it.each<[string, MoneyParse]>([
    ["1,000.00", exact(1_000_000_000n, ".")],
    ["1.000,00", exact(1_000_000_000n, ",")],
    ["1.000", AMBIG],
    ["1,5", exact(1_500_000n, ",")],
    ["6.000000", exact(6_000_000n, ".")],
    ["6.00", exact(6_000_000n, ".")],
    ["6.0000001", reject("REFUSE_ROUND")],
    ["1 000,50", exact(1_000_500_000n, ",")],
    ["1'000.50", exact(1_000_500_000n, ".")],
    ["1e3", reject("SCIENTIFIC")],
    ["١٠٠", reject("NON_ASCII_DIGITS")],
    ["$1,000", AMBIG],
    ["$1,000.00", exact(1_000_000_000n, ".")],
  ])("%j -> %o", (printed, expected) => {
    expect(parseMoney(printed, null, D6)).toEqual(expected);
  });
});

describe("separators", () => {
  it.each<[string, MoneyParse]>([
    ["1234", exact(1_234_000_000n, null)],
    ["0.5", exact(500_000n, ".")],
    ["0,05", exact(50_000n, ",")],
    ["3.14159", exact(3_141_590n, ".")], // one separator, >= 4 digits after: decimal
    ["1,0000", exact(1_000_000n, ",")],
    ["1.000.000", exact(1_000_000_000_000n, null)], // repeated: grouping
    ["1,234,567.89", exact(1_234_567_890_000n, ".")],
    ["1.234.567,89", exact(1_234_567_890_000n, ",")],
    ["12,34,567.89", exact(1_234_567_890_000n, ".")], // en-IN lakh grouping
    ["1,00,000", exact(100_000_000_000n, null)],
    ["1 000,50", exact(1_000_500_000n, ",")], // NBSP grouping (NFKC -> space)
    ["1 234 567,5", exact(1_234_567_500_000n, ",")], // narrow NBSP (fr-FR)
    ["1’234.50", exact(1_234_500_000n, ".")], // right single quote (de-CH)
    ["1 000", exact(1_000_000_000n, null)],
    ["1,000.000", exact(1_000_000_000n, ".")], // both present: never ambiguous
  ])("%j -> %o", (printed, expected) => {
    expect(parseMoney(printed, null, D6)).toEqual(expected);
  });

  it.each([
    ["", "empty"],
    [" ", "blank"],
    [".5", "leading separator"],
    ["5.", "trailing separator"],
    ["1,,000", "adjacent separators"],
    ["1. 000", "separator next to space"],
    ["-12,00", "sign"],
    ["(12.00)", "accounting negative"],
    ["1.5M", "multiplier suffix is not a currency"],
    ["12k", "multiplier suffix is not a currency"],
    ["0x10", "hex"],
    ["1,000.00.5", "decimal separator twice"],
    ["1 000.000,50", "space grouping mixed with dot grouping"],
    ["1 000.000.000", "space grouping mixed with repeated dots"],
    ["1'000 000", "two kinds of grouping"],
    ["1.000 000", "space after the decimal separator"],
    ["1,00.50", "bad Western group"],
    ["1.00.000", "lakh grouping only with commas"],
    ["1,2,3", "bad grouping"],
    ["007", "leading zero"],
    ["0012.5", "leading zero before decimal"],
    ["1 00.5", "bad space group"],
    ["12345,678", "bad first group (convention not given -> lone separator, but first group too long)"],
  ])("%j is AMBIGUOUS/MALFORMED-or-lone (%s)", (printed) => {
    const r = parseMoney(printed, null, D6);
    expect(r.kind).toBe("AMBIGUOUS");
  });

  it("a lone separator followed by exactly three digits stays ambiguous even with space grouping", () => {
    expect(parseMoney("1 000,500", null, D6)).toEqual(AMBIG);
  });
});

describe("step 1: digits, scientific notation", () => {
  it("full-width ASCII digits are folded by NFKC (spec order)", () => {
    expect(parseMoney("１，０００．５０", null, D6)).toEqual(exact(1_000_500_000n, "."));
  });

  it.each(["1²", "①,000.00", "𝟏𝟎𝟎.00", "½", "Ⅻ", "۱۲.۰۰", "१००"])("refuses non-ASCII number characters before NFKC: %j", (printed) => {
    expect(parseMoney(printed, null, D6)).toEqual(reject("NON_ASCII_DIGITS"));
  });

  it.each(["1E3", "1.5e+3", "2 e -4", "1,000e2"])("refuses scientific notation: %j", (printed) => {
    expect(parseMoney(printed, null, D6)).toEqual(reject("SCIENTIFIC"));
  });
});

describe("step 2: currency removal is a closed list", () => {
  it.each<[string, MoneyParse]>([
    ["USD 1,000.00", exact(1_000_000_000n)],
    ["1,000.00 USDC", exact(1_000_000_000n)],
    ["usdc1,000.00", exact(1_000_000_000n)],
    ["US$1,000.00", exact(1_000_000_000n)],
    ["€1.000,00", exact(1_000_000_000n, ",")],
    ["1.000,00 EUR", exact(1_000_000_000n, ",")],
    ["£12.50", exact(12_500_000n)],
  ])("%j -> %o", (printed, expected) => {
    expect(parseMoney(printed, null, D6)).toEqual(expected);
  });

  it("an attacker-chosen currency hint never strips characters", () => {
    expect(parseMoney("1.5M", "M", D6)).toEqual(MALFORMED);
    expect(parseMoney("1.5 MIL", "MIL", D6)).toEqual(MALFORMED);
  });
});

describe("step 4: never round", () => {
  it.each(["1,000.0000001", "1.000.000,0000001", "6.0000000"])("%j -> REFUSE_ROUND", (printed) => {
    expect(parseMoney(printed, null, D6)).toEqual(reject("REFUSE_ROUND"));
  });

  it("respects the declared decimals", () => {
    expect(parseMoney("5", null, 0)).toEqual(exact(5n, null));
    expect(parseMoney("5.5", null, 0)).toEqual(reject("REFUSE_ROUND"));
    expect(parseMoney("5.25", null, 2)).toEqual(exact(525n));
    expect(parseMoney("1.5", null, 18)).toEqual(exact(1_500_000_000_000_000_000n));
  });
});

describe("input guards (fail closed)", () => {
  it.each([
    [42 as unknown as string, D6],
    ["1".repeat(257), D6],
    ["1.00", -1],
    ["1.00", 256],
    ["1.00", 1.5],
  ])("%j with decimals %s -> MALFORMED", (printed, decimals) => {
    expect(parseMoney(printed, null, decimals)).toEqual(MALFORMED);
  });
});

describe("convention (line items only)", () => {
  it("resolves only the lone-separator-three-digits case", () => {
    expect(parseMoney("1,000", null, D6, { convention: "." })).toEqual(exact(1_000_000_000n, null));
    expect(parseMoney("1,000", null, D6, { convention: "," })).toEqual(exact(1_000_000n, ","));
    expect(parseMoney("1.000", null, D6, { convention: "," })).toEqual(exact(1_000_000_000n, null));
    expect(parseMoney("1,5", null, D6, { convention: "." })).toEqual(exact(1_500_000n, ","));
    expect(parseMoney("1 000,500", null, D6, { convention: "." })).toEqual(MALFORMED);
    expect(parseMoney("12345,678", null, D6, { convention: "." })).toEqual(MALFORMED);
  });
});

// --- P-K02-ROUNDTRIP --------------------------------------------------------------------------------

function groupWestern(int: string, sep: string): string {
  return int.replace(/\B(?=(\d{3})+(?!\d))/g, sep);
}

function groupIndian(int: string): string {
  if (int.length <= 3) return int;
  const last = int.slice(-3);
  const head = int.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ",");
  return `${head},${last}`;
}

type Style = "en-US" | "de-DE" | "fr-FR" | "de-CH" | "en-IN" | "plain";

/** Exact formatter: shows `k` fraction digits where k >= the significant fraction digits (never loses value). */
function format(m: bigint, k: number, style: Style, prefix: string, suffix: string): string {
  const int = (m / 1_000_000n).toString();
  const frac = (m % 1_000_000n).toString().padStart(6, "0").slice(0, k);
  const [grouped, dec] = (
    {
      "en-US": [groupWestern(int, ","), "."],
      "de-DE": [groupWestern(int, "."), ","],
      "fr-FR": [groupWestern(int, " "), ","],
      "de-CH": [groupWestern(int, "’"), "."],
      "en-IN": [groupIndian(int), "."],
      plain: [int, "."],
    } as const
  )[style];
  return `${prefix}${grouped}${k > 0 ? `${dec}${frac}` : ""}${suffix}`;
}

function significantFractionDigits(m: bigint): number {
  const frac = (m % 1_000_000n).toString().padStart(6, "0");
  return frac.replace(/0+$/, "").length;
}

describe("P-K02-ROUNDTRIP", () => {
  it("parseMoney(format(m)) is m or AMBIGUOUS, never a different value, for 6 locale formatters", () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 0n, max: 10n ** 18n }),
        fc.constantFrom<Style>("en-US", "de-DE", "fr-FR", "de-CH", "en-IN", "plain"),
        fc.integer({ min: 0, max: 6 }),
        fc.constantFrom("", "$", "USD ", "€"),
        fc.constantFrom("", " USDC", " USD", "$"),
        (m, style, extra, prefix, suffix) => {
          const sig = significantFractionDigits(m);
          const k = Math.min(6, sig + (extra % (7 - sig)));
          const r = parseMoney(format(m, k, style, prefix, suffix), null, 6);
          if (r.kind === "EXACT") expect(r.baseUnits).toBe(m);
          else expect(r).toEqual(AMBIG);
        },
      ),
      { numRuns: 1000 },
    );
  });

  it("is total: never throws and always returns one of the three kinds, for arbitrary text", () => {
    fc.assert(
      fc.property(fc.string({ unit: "grapheme", maxLength: 40 }), fc.integer({ min: 0, max: 30 }), (s, d) => {
        const r = parseMoney(s, null, d);
        expect(["EXACT", "AMBIGUOUS", "REJECT"]).toContain(r.kind);
        if (r.kind === "EXACT") expect(r.baseUnits >= 0n).toBe(true);
      }),
      { numRuns: 1000 },
    );
  });
});
