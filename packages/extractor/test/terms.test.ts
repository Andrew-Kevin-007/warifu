import { describe, expect, it } from "vitest";
import { parseStatedTerms, percentToBps } from "../src/parse/terms";

describe("percentToBps", () => {
  it.each([
    ["2", 200],
    ["1.5", 150],
    ["1,5", 150],
    ["0.25", 25],
    ["100", 10000],
    ["12.34", 1234],
  ])("%s -> %s bps", (t, bps) => expect(percentToBps(t)).toBe(bps));
  it("rejects out-of-range and malformed input", () => {
    expect(percentToBps("101")).toBeNull();
    expect(percentToBps("1.234")).toBeNull();
    expect(percentToBps("x")).toBeNull();
  });
});

describe("parseStatedTerms", () => {
  it.each([
    ["Terms: 2/10 net 30", { netDays: 30, earlyPay: { discountBps: 200, withinDays: 10 }, raw: "2/10 net 30" }],
    ["Payment terms 2/10, n/30 from invoice date", { netDays: 30, earlyPay: { discountBps: 200, withinDays: 10 }, raw: "2/10, n/30" }],
    ["1.5/15 net 45", { netDays: 45, earlyPay: { discountBps: 150, withinDays: 15 }, raw: "1.5/15 net 45" }],
    ["Net 30", { netDays: 30, earlyPay: null, raw: "Net 30" }],
    ["NET30 days", { netDays: 30, earlyPay: null, raw: "NET30 days" }],
    ["Payment due within 14 days of receipt.", { netDays: 14, earlyPay: null, raw: "Payment due within 14 days" }],
    ["Payable in 60 calendar days", { netDays: 60, earlyPay: null, raw: "Payable in 60 calendar days" }],
    ["Due on receipt", { netDays: 0, earlyPay: null, raw: "Due on receipt" }],
    ["2% discount if paid within 10 days; otherwise net 30", { netDays: 30, earlyPay: { discountBps: 200, withinDays: 10 } }],
    ["Pay within 10 days and get 3% off", { netDays: null, earlyPay: { discountBps: 300, withinDays: 10 } }],
    ["2 % Skonto bei Zahlung innerhalb von 10 Tagen", { netDays: null, earlyPay: { discountBps: 200, withinDays: 10 } }],
    ["Zahlungsziel: 30 Tage netto", { netDays: 30, earlyPay: null }],
    ["paiement sous 45 jours", { netDays: 45, earlyPay: null }],
  ])("reads %j", (text, expected) => {
    const t = parseStatedTerms(text);
    expect(t.found).toBe(true);
    expect(t.netDays).toBe(expected.netDays);
    expect(t.earlyPay).toEqual(expected.earlyPay);
    expect(t.ambiguous).toBe(false);
    expect(text.includes(t.raw ?? "\u0000")).toBe(true); // raw is always a verbatim substring
    if ("raw" in expected) expect(t.raw).toBe(expected.raw);
  });

  it("finds nothing in ordinary invoice text, including amounts that look like 'net 1,500.00'", () => {
    for (const text of [
      "Invoice 1001\nNet 1,500.00 USDC\nVAT 19% included",
      "Thank you for your business. Payment within 30 days VAT 19%.",
      "Net amount: 100.00",
      "Contact us at 10/12 Main St.",
    ]) {
      const t = parseStatedTerms(text);
      expect(t.earlyPay, text).toBeNull();
      expect(t.netDays, text).toBeNull();
    }
  });

  it("flags 'pay today for 8% off' as an ambiguous early-pay claim, never as a clean term", () => {
    const t = parseStatedTerms("URGENT: pay today for 8% off");
    expect(t.earlyPay).toEqual({ discountBps: 800, withinDays: 0 });
    expect(t.ambiguous).toBe(true);
  });

  it("marks conflicting terms and business-day language ambiguous", () => {
    expect(parseStatedTerms("Net 30. Payment due within 45 days.").ambiguous).toBe(true);
    expect(parseStatedTerms("Payment due within 30 business days").ambiguous).toBe(true);
    expect(parseStatedTerms("5/40 net 30").ambiguous).toBe(true); // window longer than net period
  });

  it("returns found=false for empty input", () => {
    expect(parseStatedTerms("")).toEqual({ found: false, raw: null, netDays: null, earlyPay: null, ambiguous: false });
  });
});
