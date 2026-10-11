// Property tests for @symbolon/terms (docs/04 §9 P-TERMS-WINDOW; docs/13 §4.1). 1,000 runs each.
// The oracles are the defining inequalities (floor, window bound), not a re-run of the same formula.
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { isoFromEpochSeconds } from "@symbolon/schemas";
import type { PaymentTerms } from "@symbolon/schemas";
import { amountDue, discountValue, impliedAprBps } from "../src/index";
import type { TermsResult } from "../src/index";

const RUNS = { numRuns: 1000 };

function value<T>(r: TermsResult<T>): T {
  if (!r.ok) throw new Error(`expected ok, got ${r.error.code}`);
  return r.value;
}

// Receipt instants between 2020 and 2090 (seconds), so receipt + 365 days stays far from year 9999.
const receivedSec = fc.bigInt({ min: 1_577_836_800n, max: 3_786_912_000n });
const gross = fc.bigInt({ min: 0n, max: 10n ** 30n });
const signedTerms = fc
  .record({
    netDays: fc.integer({ min: 2, max: 365 }),
    discountBps: fc.integer({ min: 1, max: 2000 }),
    withinFrac: fc.integer({ min: 0, max: 1_000_000 }),
  })
  .map(({ netDays, discountBps, withinFrac }): PaymentTerms => {
    const withinDays = 1 + (withinFrac % (netDays - 1)); // 1 <= withinDays < netDays
    return { netDays, earlyPay: { discountBps, withinDays }, payBeforeDueBufferHours: 24, allowImmediate: true };
  });

describe("P-TERMS-WINDOW", () => {
  it("discount applies iff payAt <= invoiceReceivedAt + withinDays*86400, tested at the boundary and ±1 s", () => {
    fc.assert(
      fc.property(gross, signedTerms, receivedSec, fc.constantFrom(-1n, 0n, 1n), (g, terms, rec, delta) => {
        const within = BigInt(terms.earlyPay?.withinDays ?? 0);
        const boundary = rec + within * 86_400n;
        const r = value(
          amountDue({ grossBaseUnits: g, terms, invoiceReceivedAt: isoFromEpochSeconds(rec), payAt: isoFromEpochSeconds(boundary + delta) }),
        );
        expect(r.discountApplied).toBe(delta <= 0n);
        expect(r.windowEnd).toBe(isoFromEpochSeconds(boundary));
        if (delta > 0n) {
          expect(r.amountDue).toBe(g);
          expect(r.discountValue).toBe(0n);
        }
      }),
      RUNS,
    );
  });

  it("0 <= amountDue <= gross and amountDue + discountValue = gross, at any payAt", () => {
    fc.assert(
      fc.property(gross, signedTerms, receivedSec, fc.bigInt({ min: 0n, max: 400n * 86_400n }), (g, terms, rec, offset) => {
        const r = value(
          amountDue({ grossBaseUnits: g, terms, invoiceReceivedAt: isoFromEpochSeconds(rec), payAt: isoFromEpochSeconds(rec + offset) }),
        );
        expect(r.amountDue >= 0n && r.amountDue <= g).toBe(true);
        expect(r.amountDue + r.discountValue).toBe(g);
      }),
      RUNS,
    );
  });

  it("paying later is never cheaper (amountDue is non-decreasing in payAt)", () => {
    fc.assert(
      fc.property(gross, signedTerms, receivedSec, fc.bigInt({ min: 0n, max: 400n * 86_400n }), fc.bigInt({ min: 0n, max: 400n * 86_400n }), (g, terms, rec, a, b) => {
        const [early, late] = a <= b ? [a, b] : [b, a];
        const at = (o: bigint) =>
          value(amountDue({ grossBaseUnits: g, terms, invoiceReceivedAt: isoFromEpochSeconds(rec), payAt: isoFromEpochSeconds(rec + o) })).amountDue;
        expect(at(early) <= at(late)).toBe(true);
      }),
      RUNS,
    );
  });
});

describe("discountValue is exactly the floor", () => {
  it("d * 10000 <= gross * bps < (d + 1) * 10000", () => {
    fc.assert(
      fc.property(gross, fc.integer({ min: 0, max: 10_000 }), (g, bps) => {
        const d = value(discountValue(g, bps));
        const product = g * BigInt(bps);
        expect(d * 10_000n <= product).toBe(true);
        expect(product < (d + 1n) * 10_000n).toBe(true);
      }),
      RUNS,
    );
  });
});

describe("impliedAprBps is exactly the floor of the docs/03 §5.2 ratio", () => {
  it("apr * den <= num < (apr + 1) * den, and more discount never lowers the APR", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 9_998 }), fc.integer({ min: 0, max: 3_649 }), fc.integer({ min: 1, max: 3_650 }), (bps, within, span) => {
        const net = Math.min(within + span, 3_650);
        fc.pre(net > within);
        const apr = value(impliedAprBps({ discountBps: bps, withinDays: within, netDays: net }));
        const num = BigInt(bps) * 365n * 10_000n;
        const den = (10_000n - BigInt(bps)) * BigInt(net - within);
        expect(apr * den <= num).toBe(true);
        expect(num < (apr + 1n) * den).toBe(true);
        const more = value(impliedAprBps({ discountBps: bps + 1, withinDays: within, netDays: net }));
        expect(more >= apr).toBe(true);
      }),
      RUNS,
    );
  });
});
