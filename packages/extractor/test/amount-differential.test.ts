// Differential tests against the K-02 text (docs/04 §4 K-02), added after a security-review finding
// ("parser-differential"): wherever the extractor and the kernel could read one string differently, the
// extractor must REFUSE (invalid/ambiguous), never return a different number.
import { formatBaseUnits } from "@symbolon/schemas";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { parseAmountPrinted } from "../src/parse/amount";

type Ref = { kind: "ok"; units: bigint } | { kind: "ambiguous" } | { kind: "reject" };

/**
 * A literal, deliberately simple transcription of K-02 steps 1-4 (looser than the extractor: no group-size
 * validation, NFKC folding). Written independently of src/parse/amount.ts.
 */
function k02Reference(printed: string, decimals: number): Ref {
  const s = printed.normalize("NFKC");
  // step 1: reject non-ASCII digits and scientific notation (after NFKC)
  if (/\p{Nd}/u.test(s.replace(/[0-9]/g, ""))) return { kind: "reject" };
  if (/[0-9][eE][+-]?[0-9]/.test(s)) return { kind: "reject" };
  // step 2: remove currency symbols/codes, treat space/NBSP/thin space/apostrophe as grouping
  let t = s.replace(/US\$|USDC|USD|EURC|EUR|GBP|[$€£]/gi, "");
  t = t.replace(new RegExp("[ \u00a0\u2009\u202f'\u2019]", "g"), "");
  if (!/^[0-9.,]+$/.test(t)) return { kind: "reject" };
  // step 3
  const dots = t.split(".").length - 1;
  const commas = t.split(",").length - 1;
  let intPart: string;
  let frac = "";
  if (dots > 0 && commas > 0) {
    const dec = t.lastIndexOf(".") > t.lastIndexOf(",") ? "." : ",";
    const i = t.lastIndexOf(dec);
    intPart = t.slice(0, i).replace(/[.,]/g, "");
    frac = t.slice(i + 1);
  } else if (dots + commas === 1) {
    const i = t.search(/[.,]/);
    frac = t.slice(i + 1);
    intPart = t.slice(0, i);
    if (frac.length === 3) return { kind: "ambiguous" };
  } else if (dots + commas > 1) {
    intPart = t.replace(/[.,]/g, "");
  } else intPart = t;
  if (intPart === "" || !/^[0-9]*$/.test(frac)) return { kind: "reject" };
  // step 4
  if (frac.length > decimals) return { kind: "reject" };
  return { kind: "ok", units: BigInt(intPart + frac.padEnd(decimals, "0")) };
}

describe("differential: extractor parser vs the K-02 text", () => {
  // [input, what the extractor must do]: a base-unit string, "ambiguous", or "refuse"
  const table: Array<[string, string]> = [
    ["1.000,50", "1000500000"],
    ["1,000.50", "1000500000"],
    ["1.000", "ambiguous"],
    ["1,000", "ambiguous"],
    ["0,500", "ambiguous"],
    ["1.00,50", "refuse"], // bad group size: a loose reader gets 100.50, we refuse
    ["1,0,0.50", "refuse"],
    ["１０００", "refuse"], // full-width digits: K-02 NFKC-folds them; we refuse instead of folding
    ["１,０００.００", "refuse"],
    ["1​000", "refuse"], // zero-width space inside the number would silently join digits
    ["1‮000", "refuse"],
    ["1 000", "refuse"], // narrow NBSP is not in the K-02 grouping set
    ["1’000", "refuse"], // typographic apostrophe likewise
    ["1　000", "refuse"], // ideographic space
    ["−100", "refuse"],
    ["-100", "refuse"],
    ["(100.00)", "refuse"],
    ["+100", "refuse"],
    ["1e3", "refuse"],
    ["1E+3", "refuse"],
    ["0x10", "refuse"],
    ["1USD000", "refuse"], // currency token in the middle would join the digit groups
    ["1 USD 000", "refuse"],
    ["USD 1,000.00 USD", "refuse"],
    ["$ 1,000.00", "1000000000"],
    ["1,000.00 USDC", "1000000000"],
    ["US$1.234,56", "1234560000"],
    ["007", "refuse"], // leading zeros: no spec rule, so refuse
    ["00.50", "refuse"],
    ["0.50", "500000"],
    ["1.0000001", "refuse"], // REFUSE_ROUND
    ["١٢٣", "refuse"],
    ["1,000.", "refuse"],
    [".5", "refuse"],
    ["1 000 000,5", "1000000500000"],
    ["1 000,5", "1000500000"],
    ["1 000,5", "1000500000"],
  ];
  it.each(table)("%j -> %s", (input, expected) => {
    const r = parseAmountPrinted(input, 6);
    if (expected === "ambiguous") expect(r.kind).toBe("ambiguous");
    else if (expected === "refuse") expect(r.kind).toBe("invalid");
    else {
      expect(r.kind).toBe("ok");
      if (r.kind === "ok") expect(r.baseUnits.toString()).toBe(expected);
    }
  });

  it("whenever the extractor accepts, the K-02 reference agrees exactly; whenever it says ambiguous, so does K-02", () => {
    const alphabet = ["0", "1", "2", "5", "9", ".", ",", " ", "'", " ", " ", " ", "$", "U", "S", "D", "C", "-", "e", "１", "​"];
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom(...alphabet), { minLength: 1, maxLength: 14 }).map((a) => a.join("")),
        (s) => {
          const mine = parseAmountPrinted(s, 6);
          if (mine.kind === "invalid") return;
          const ref = k02Reference(s, 6);
          if (mine.kind === "ambiguous") expect(ref.kind, s).toBe("ambiguous");
          else {
            expect(ref.kind, s).toBe("ok");
            if (ref.kind === "ok") expect(mine.baseUnits, s).toBe(ref.units);
          }
        },
      ),
      { numRuns: 20000 },
    );
  });

  it("round-trips: every accepted value re-formats (formatBaseUnits) and re-parses to the same base units", () => {
    const alphabet = ["0", "1", "3", "7", ".", ",", " ", "'", "$"];
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom(...alphabet), { minLength: 1, maxLength: 16 }).map((a) => a.join("")),
        (s) => {
          const r = parseAmountPrinted(s, 6);
          if (r.kind !== "ok") return;
          const canonical = formatBaseUnits(r.baseUnits, 6, { grouping: false, minFractionDigits: 6 });
          const again = parseAmountPrinted(canonical, 6);
          expect(again.kind, `${s} -> ${canonical}`).toBe("ok");
          if (again.kind === "ok") expect(again.baseUnits).toBe(r.baseUnits);
          const grouped = parseAmountPrinted(formatBaseUnits(r.baseUnits, 6), 6);
          // the grouped rendering ("1,234.50") is exact, or ambiguous (lone 3-digit group); never a different number
          if (grouped.kind === "ok") expect(grouped.baseUnits).toBe(r.baseUnits);
        },
      ),
      { numRuns: 20000 },
    );
  });

  it("negative control: a parser that NFKC-folded and stripped currency anywhere WOULD differ on these inputs", () => {
    // Guards the guard: the reference (kernel-style folding) accepts these, the extractor must not.
    for (const s of ["１０００", "1USD000", "1’000"]) {
      expect(k02Reference(s, 6).kind, s).toBe("ok");
      expect(parseAmountPrinted(s, 6).kind, s).toBe("invalid");
    }
  });
});
