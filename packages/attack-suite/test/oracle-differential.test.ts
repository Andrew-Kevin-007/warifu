// The oracle has its own amountDue (it may not import packages/terms). This differential test, on the attack-suite
// side where both packages may be imported, shows the two implementations agree; a disagreement would mean either
// the judge or the kernel under test misreads docs/04 K-08, and would be a bug ticket (docs/07 §3.3 item 6).
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { amountDueOracle } from "@symbolon/oracle";
import { isoFromEpochSeconds } from "@symbolon/schemas";
import type { PaymentTerms } from "@symbolon/schemas";
import { amountDue } from "@symbolon/terms";

const T0 = 1_788_000_000n;

describe("oracle amountDue vs packages/terms amountDue", () => {
  it("agree on random terms, amounts and instants, including the window edge", () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 1n, max: 10n ** 15n }),
        fc.integer({ min: 1, max: 2000 }),
        fc.integer({ min: 1, max: 60 }),
        fc.integer({ min: -2, max: 70 }),
        fc.constantFrom(-1n, 0n, 1n),
        (gross, bps, within, offsetDays, edgeSeconds) => {
          const terms: PaymentTerms = { netDays: 90, earlyPay: { discountBps: bps, withinDays: within }, payBeforeDueBufferHours: 0, allowImmediate: true };
          const received = isoFromEpochSeconds(T0);
          const payAt = isoFromEpochSeconds(T0 + BigInt(offsetDays) * 86_400n + (offsetDays === within ? edgeSeconds : 0n));
          const theirs = amountDue({ grossBaseUnits: gross, terms, invoiceReceivedAt: received, payAt });
          expect(theirs.ok).toBe(true);
          if (theirs.ok) expect(amountDueOracle(gross, terms, received, payAt)).toBe(theirs.value.amountDue);
        },
      ),
      { numRuns: 500 },
    );
  });

  it("agree when there are no signed early-pay terms", () => {
    const terms: PaymentTerms = { netDays: 30, earlyPay: null, payBeforeDueBufferHours: 0, allowImmediate: true };
    const received = isoFromEpochSeconds(T0);
    const payAt = isoFromEpochSeconds(T0 + 86_400n);
    const theirs = amountDue({ grossBaseUnits: 123_456_789n, terms, invoiceReceivedAt: received, payAt });
    expect(theirs.ok && theirs.value.amountDue).toBe(123_456_789n);
    expect(amountDueOracle(123_456_789n, terms, received, payAt)).toBe(123_456_789n);
  });
});
