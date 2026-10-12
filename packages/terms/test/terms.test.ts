// Golden and edge-case tests for @symbolon/terms (docs/03 §5.2, docs/13 §4.1 "packages/terms").
// Every expected number below is computed by hand in the comment next to it, not by the code under test.
import { describe, expect, it } from "vitest";
import { MAX_UINT256 } from "@symbolon/schemas";
import type { PaymentTerms } from "@symbolon/schemas";
import {
  PACKAGE_NAME,
  addDays,
  amountDue,
  discountValue,
  discountWindowEnd,
  dueDate,
  impliedAprBps,
  isWithinDiscountWindow,
  termsImpliedAprBps,
} from "../src/index";
import type { TermsErrorCode, TermsResult } from "../src/index";

function value<T>(r: TermsResult<T>): T {
  if (!r.ok) throw new Error(`expected ok, got ${r.error.code}: ${r.error.message}`);
  return r.value;
}

function code<T>(r: TermsResult<T>): TermsErrorCode {
  if (r.ok) throw new Error("expected an error");
  return r.error.code;
}

const TWO_TEN_NET_30: PaymentTerms = {
  netDays: 30,
  earlyPay: { discountBps: 200, withinDays: 10 },
  payBeforeDueBufferHours: 24,
  allowImmediate: true,
};
const NET_30: PaymentTerms = { netDays: 30, earlyPay: null, payBeforeDueBufferHours: 24, allowImmediate: true };
const RECEIVED = "2026-10-01T09:30:00Z";

describe("package", () => {
  it("exports its name", () => {
    expect(PACKAGE_NAME).toBe("@symbolon/terms");
  });
});

describe("discountValue = floor(gross * bps / 10000)", () => {
  it.each([
    // [gross, bps, expected, hand computation]
    [1_000_000_000n, 200, 20_000_000n, "1e9 * 200 / 1e4 = 2e7 exactly"],
    [999n, 200, 19n, "999 * 200 = 199800; / 10000 = 19.98 -> 19"],
    [1n, 2000, 0n, "2000 / 10000 = 0.2 -> 0"],
    [0n, 200, 0n, "zero gross"],
    [12_345n, 1, 1n, "12345 / 10000 = 1.2345 -> 1"],
    [9_999n, 1, 0n, "9999 / 10000 = 0.9999 -> 0"],
    [10_000n, 1, 1n, "exactly one unit"],
    [123_456_789n, 0, 0n, "0 bps"],
    [123_456_789n, 10_000, 123_456_789n, "100 % (bound of the generic helper)"],
    [MAX_UINT256, 10_000, MAX_UINT256, "uint256 max at 100 %"],
  ])("gross %s at %s bps -> %s (%s)", (gross, bps, expected) => {
    expect(value(discountValue(gross, bps))).toBe(expected);
  });

  it.each([
    [-1n, 200, "INVALID_AMOUNT"],
    [MAX_UINT256 + 1n, 200, "INVALID_AMOUNT"],
    [1n, -1, "INVALID_BPS"],
    [1n, 10_001, "INVALID_BPS"],
    [1n, 1.5, "INVALID_BPS"],
    [1n, Number.NaN, "INVALID_BPS"],
  ] as const)("refuses gross %s / bps %s with %s", (gross, bps, expected) => {
    expect(code(discountValue(gross, bps))).toBe(expected);
  });

  it("refuses a number where a bigint is required (no implicit coercion)", () => {
    expect(code(discountValue(1000 as unknown as bigint, 200))).toBe("INVALID_AMOUNT");
  });
});

describe("impliedAprBps golden table", () => {
  it.each([
    // [bps, withinDays, netDays, expected, hand computation]
    [200, 10, 30, 3724n, "200*365*10000 = 730,000,000; 9800*20 = 196,000; 196,000*3724 = 729,904,000 (rem 96,000)"],
    [100, 15, 45, 1228n, "100*3,650,000 = 365,000,000; 9900*30 = 297,000; 297,000*1228 = 364,716,000 (rem 284,000)"],
    [500, 10, 30, 9605n, "500*3,650,000 = 1,825,000,000; 9500*20 = 190,000; 190,000*9605 = 1,824,950,000 (rem 50,000)"],
    [1, 10, 30, 18n, "bps -> 0: 3,650,000 / (9999*20 = 199,980) = 18.25"],
    [0, 10, 30, 0n, "0 bps"],
    [200, 10, 11, 74489n, "netDays = withinDays + 1: 730,000,000 / 9800 = 74,489.79"],
    [2000, 1, 2, 912500n, "2000*3,650,000 = 7,300,000,000 / (8000*1) = 912,500 exactly"],
    [200, 0, 30, 2482n, "withinDays 0: 730,000,000 / (9800*30 = 294,000) = 2482.99"],
  ])("%s bps within %s net %s -> %s (%s)", (discountBps, withinDays, netDays, expected) => {
    expect(value(impliedAprBps({ discountBps, withinDays, netDays }))).toBe(expected);
  });

  it.each([
    [{ discountBps: 10_000, withinDays: 10, netDays: 30 }, "INVALID_BPS"],
    [{ discountBps: -1, withinDays: 10, netDays: 30 }, "INVALID_BPS"],
    [{ discountBps: 200, withinDays: 30, netDays: 30 }, "INVALID_DAYS"],
    [{ discountBps: 200, withinDays: 31, netDays: 30 }, "INVALID_DAYS"],
    [{ discountBps: 200, withinDays: -1, netDays: 30 }, "INVALID_DAYS"],
    [{ discountBps: 200, withinDays: 10, netDays: 3651 }, "INVALID_DAYS"],
    [{ discountBps: 200, withinDays: 10, netDays: 30.5 }, "INVALID_DAYS"],
  ] as const)("refuses %o with %s", (input, expected) => {
    expect(code(impliedAprBps(input))).toBe(expected);
  });

  it("termsImpliedAprBps reads the signed terms (null when there is no discount)", () => {
    expect(value(termsImpliedAprBps(TWO_TEN_NET_30))).toBe(3724n);
    expect(value(termsImpliedAprBps(NET_30))).toBeNull();
    expect(value(termsImpliedAprBps(null))).toBeNull();
  });

  it("termsImpliedAprBps refuses terms outside PaymentTermsSchema", () => {
    const bad = { ...TWO_TEN_NET_30, earlyPay: { discountBps: 200, withinDays: 30 } };
    expect(code(termsImpliedAprBps(bad))).toBe("INVALID_TERMS");
  });
});

describe("time helpers", () => {
  it("adds whole days in UTC seconds", () => {
    expect(value(addDays(RECEIVED, 10))).toBe("2026-10-11T09:30:00Z");
    expect(value(addDays("2028-02-28T23:59:59Z", 1))).toBe("2028-02-29T23:59:59Z"); // leap year
    expect(value(addDays(RECEIVED, 0))).toBe(RECEIVED);
    expect(value(dueDate(RECEIVED, 30))).toBe("2026-10-31T09:30:00Z");
    expect(value(discountWindowEnd(RECEIVED, 10))).toBe("2026-10-11T09:30:00Z");
  });

  it("refuses non-canonical instants and out-of-range results", () => {
    expect(code(addDays("2026-10-01T09:30:00.000Z", 1))).toBe("INVALID_TIME");
    expect(code(addDays("2026-10-01", 1))).toBe("INVALID_TIME");
    expect(code(addDays(12 as unknown as string, 1))).toBe("INVALID_TIME");
    expect(code(addDays("9999-12-31T00:00:00Z", 1))).toBe("INVALID_TIME");
    expect(code(addDays(RECEIVED, -1))).toBe("INVALID_DAYS");
    expect(code(addDays(RECEIVED, 3651))).toBe("INVALID_DAYS");
  });

  it("window membership is inclusive at the boundary, exclusive one second later", () => {
    expect(value(isWithinDiscountWindow("2026-10-11T09:30:00Z", RECEIVED, 10))).toBe(true);
    expect(value(isWithinDiscountWindow("2026-10-11T09:29:59Z", RECEIVED, 10))).toBe(true);
    expect(value(isWithinDiscountWindow("2026-10-11T09:30:01Z", RECEIVED, 10))).toBe(false);
    expect(code(isWithinDiscountWindow("soon", RECEIVED, 10))).toBe("INVALID_TIME");
    expect(code(isWithinDiscountWindow(RECEIVED, "then", 10))).toBe("INVALID_TIME");
  });
});

describe("amountDue(payAt) from the signed terms", () => {
  const gross = 1_000_000_000n; // 1,000.000000 USDC

  it("2/10 net 30: discounted inside the window, gross after it", () => {
    const inside = value(amountDue({ grossBaseUnits: gross, terms: TWO_TEN_NET_30, invoiceReceivedAt: RECEIVED, payAt: "2026-10-05T00:00:00Z" }));
    expect(inside).toEqual({ amountDue: 980_000_000n, discountValue: 20_000_000n, discountApplied: true, windowEnd: "2026-10-11T09:30:00Z" });
    const atEnd = value(amountDue({ grossBaseUnits: gross, terms: TWO_TEN_NET_30, invoiceReceivedAt: RECEIVED, payAt: "2026-10-11T09:30:00Z" }));
    expect(atEnd.amountDue).toBe(980_000_000n);
    const after = value(amountDue({ grossBaseUnits: gross, terms: TWO_TEN_NET_30, invoiceReceivedAt: RECEIVED, payAt: "2026-10-11T09:30:01Z" }));
    expect(after).toEqual({ amountDue: gross, discountValue: 0n, discountApplied: false, windowEnd: "2026-10-11T09:30:00Z" });
  });

  it("the discount floors in the payee's favour", () => {
    // 999 * 200 / 10000 = 19.98 -> discount 19, due 980
    const r = value(amountDue({ grossBaseUnits: 999n, terms: TWO_TEN_NET_30, invoiceReceivedAt: RECEIVED, payAt: RECEIVED }));
    expect(r.amountDue).toBe(980n);
    expect(r.discountValue).toBe(19n);
  });

  it("no signed terms, or signed terms without early pay: always gross", () => {
    for (const terms of [null, NET_30]) {
      const r = value(amountDue({ grossBaseUnits: gross, terms, invoiceReceivedAt: RECEIVED, payAt: RECEIVED }));
      expect(r).toEqual({ amountDue: gross, discountValue: 0n, discountApplied: false, windowEnd: null });
    }
  });

  it("refuses invalid input instead of guessing", () => {
    const base = { grossBaseUnits: gross, terms: TWO_TEN_NET_30, invoiceReceivedAt: RECEIVED, payAt: RECEIVED };
    expect(code(amountDue({ ...base, grossBaseUnits: -5n }))).toBe("INVALID_AMOUNT");
    expect(code(amountDue({ ...base, invoiceReceivedAt: "yesterday" }))).toBe("INVALID_TIME");
    expect(code(amountDue({ ...base, payAt: "2026-10-05T00:00:00+05:30" }))).toBe("INVALID_TIME");
    // withinDays must be < netDays; discountBps must be in 1..2000 for signed terms (schemas-v1.0)
    expect(code(amountDue({ ...base, terms: { ...TWO_TEN_NET_30, earlyPay: { discountBps: 200, withinDays: 30 } } }))).toBe("INVALID_TERMS");
    expect(code(amountDue({ ...base, terms: { ...TWO_TEN_NET_30, earlyPay: { discountBps: 2001, withinDays: 10 } } }))).toBe("INVALID_TERMS");
    expect(code(amountDue({ ...base, terms: { ...TWO_TEN_NET_30, extra: 1 } as unknown as PaymentTerms }))).toBe("INVALID_TERMS");
  });

  it("refuses a window that would end after 9999-12-31", () => {
    const late = "9999-12-25T00:00:00Z";
    expect(code(amountDue({ grossBaseUnits: gross, terms: TWO_TEN_NET_30, invoiceReceivedAt: late, payAt: late }))).toBe("INVALID_TIME");
  });
});
