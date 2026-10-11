// P-TERMS-IGNORE-INVOICE, P-TERMS-WINDOW (kernel level) and P-NO-BINARY (docs/04 §9), 1,000 runs each.
import { describe, expect, it, vi } from "vitest";
import fc from "fast-check";
import { epochSecondsFromIso, isoFromEpochSeconds } from "@symbolon/schemas";
import { evaluate } from "../src/index";
import type { KernelContext } from "../src/index";
import { DOC_TEXT, GROSS, START, context, engagement, intent, phaseA, policy, withDoc } from "./helpers";
import type { RawIntent } from "./helpers";
import { META, PROPERTY_TIMEOUT_MS, RUNS, eachExtraction } from "./props-common";
import { proseArb, scenarioArb } from "./scenario";

vi.setConfig({ testTimeout: PROPERTY_TIMEOUT_MS });

describe("P-TERMS-IGNORE-INVOICE: invoice-stated terms never change amountDue, payAt or the release amount", () => {
  const stated = fc.record({
    raw: fc.option(proseArb, { nil: null }),
    netDays: fc.option(fc.integer({ min: 0, max: 3650 }), { nil: null }),
    earlyPay: fc.option(fc.record({ discountBps: fc.integer({ min: 0, max: 10_000 }), withinDays: fc.integer({ min: 0, max: 3650 }) }), { nil: null }),
    ambiguous: fc.boolean(),
  });

  it("they may only add ESCALATE findings (none in WP-04; K-14 compares them in WP-05)", () => {
    fc.assert(
      fc.property(scenarioArb, stated, (s, terms) => {
        const mutated = eachExtraction(s.raw, (x) => (x.statedTerms = terms));
        const before = evaluate(s.raw, s.ctx, s.policy);
        const after = evaluate(mutated, s.ctx, s.policy);
        expect(after.releaseAmountBaseUnits).toBe(before.releaseAmountBaseUnits);
        expect(after.payAt).toBe(before.payAt);
        expect(after.amountBaseUnits).toBe(before.amountBaseUnits);
        expect(after.intentId).toBe(before.intentId);
        expect(after.checks.length).toBe(before.checks.length);
        after.checks.forEach((c, i) => {
          const b = before.checks[i];
          const same = JSON.stringify(c) === JSON.stringify(b);
          expect(same || (b?.status === "PASS" && c.status === "FAIL" && c.onFail === "ESCALATE")).toBe(true);
        });
      }),
      RUNS,
    );
  });
});

describe("P-TERMS-WINDOW at the kernel: the discounted release passes K-08 iff payAt <= invoiceReceivedAt + withinDays (±1 s)", () => {
  it("holds for random windows, discounts and receipt times", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 29 }),
        fc.bigInt({ min: 0n, max: 4n * 86_400n }),
        fc.constantFrom(-1n, 0n, 1n),
        fc.integer({ min: 1, max: 2000 }),
        (withinDays, receivedOffset, delta, bps) => {
          const e = engagement({ paymentTerms: { netDays: 30, earlyPay: { discountBps: bps, withinDays }, payBeforeDueBufferHours: 24, allowImmediate: true } });
          const receivedSec = epochSecondsFromIso(START) + receivedOffset;
          const nowSec = receivedSec + BigInt(withinDays) * 86_400n + delta;
          const base: KernelContext = {
            ...context({ engagement: e, milestone: e.milestones[0] ?? null }),
            now: isoFromEpochSeconds(nowSec),
            invoiceReceivedAt: isoFromEpochSeconds(receivedSec),
          };
          const id = phaseA(intent(), base).intentId;
          // independent oracle: the discount is floor(gross * bps / 10000)
          const discounted = GROSS - (GROSS * BigInt(bps)) / 10_000n;
          const k08 = (amount: bigint) => {
            const c = phaseA(intent(), { ...base, reevaluation: { decisionId: META.decisionId, intentId: id, payAt: base.now, releaseAmountBaseUnits: amount } }).checks.find((x) => x.id === "K-08");
            return c?.status === "PASS" ? "PASS" : c?.code;
          };
          expect(k08(discounted)).toBe(delta <= 0n ? "PASS" : "UNDERPAY_PARTIAL");
          expect(k08(GROSS)).toBe(delta <= 0n ? "OVERPAY" : "PASS");
        },
      ),
      RUNS,
    );
  });
});

describe("P-NO-BINARY: a binary-looking or oversize payload => REJECT SCHEMA_INVALID before K-02", () => {
  type Setter = (i: RawIntent, v: (old: string) => string) => RawIntent;
  const FIELDS: ReadonlyArray<readonly [string, Setter]> = [
    ["invoiceNumber", (i, v) => eachExtraction(i, (x) => (x.invoiceNumber = v(x.invoiceNumber)))],
    ["payee.legalName", (i, v) => eachExtraction(i, (x) => (x.payee.legalName = v("Acme Design")))],
    ["amount.currencyPrinted", (i, v) => eachExtraction(i, (x) => (x.amount.currencyPrinted = v(x.amount.currencyPrinted)))],
    ["lineItems[0].description", (i, v) => eachExtraction(i, (x) => (x.lineItems = [{ description: v("Website design"), amountPrinted: "1,000.00" }]))],
    ["anomalies[0].quote", (i, v) => eachExtraction(i, (x) => (x.anomalies = [{ code: "OTHER", quote: v("note") }]))],
    ["statedTerms.raw", (i, v) => eachExtraction(i, (x) => (x.statedTerms = { ...x.statedTerms, raw: v("net 30") }))],
    ["references.poNumber", (i, v) => eachExtraction(i, (x) => (x.references = { ...x.references, poNumber: v("PO-7") }))],
    ["timingProposal.rationale", (i, v) => ({ ...i, timingProposal: { payAt: "2026-10-06T00:00:00Z", rationale: v("pay on due date") } })],
    ["agentRecommendation.reasons[0]", (i, v) => ({ ...i, agentRecommendation: { verdict: "RELEASE", reasons: [v("looks fine")] } })],
  ];
  const payload = fc.oneof(
    fc
      .record({ at: fc.nat(), ch: fc.constantFrom("\u0000", "\u0001", "\u0008", "\u000b", "\u001b", "\u007f", "\u0085", "\u009f") })
      .map(({ at, ch }) => (old: string) => `${old.slice(0, at % (old.length + 1))}${ch}${old.slice(at % (old.length + 1))}`),
    fc.constant((old: string) => `${old} data:application/octet-stream;base64,AAAA`),
    fc.integer({ min: 512, max: 700 }).map((n) => (old: string) => `${old}${"QUJD".repeat(Math.ceil(n / 4)).slice(0, n)}`),
    fc.constant((old: string) => `${old}���`),
    fc.constant((old: string) => `${old}${"x".repeat(2001)}`),
  );

  it("in any intent string field: K-01 rejects and nothing downstream runs", () => {
    fc.assert(
      fc.property(fc.constantFrom(...FIELDS), payload, ([, set], v) => {
        const raw = set(intent(), v);
        expect(phaseA(raw).checks.map((c) => [c.id, c.status, c.code])).toEqual([["K-01", "FAIL", "SCHEMA_INVALID"]]);
        const e = evaluate(raw, context(), policy());
        expect(e.checks.map((c) => c.id)).toEqual(["K-16", "K-01"]);
        expect(e.verdict).toBe("REJECT");
      }),
      RUNS,
    );
  });

  it("in the kernel-stored document text", () => {
    const p = policy({ limits: { maxDocChars: 2000 } });
    fc.assert(
      fc.property(payload, (v) => {
        const e = phaseA(intent(), withDoc(context(), v(DOC_TEXT)), p);
        expect(e.checks.map((c) => [c.id, c.code])).toEqual([["K-01", "SCHEMA_INVALID"]]);
      }),
      RUNS,
    );
  });
});
