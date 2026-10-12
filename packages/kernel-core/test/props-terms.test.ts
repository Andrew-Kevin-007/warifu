// P-TERMS-IGNORE-INVOICE, the K-14 terms-binding classification, P-TERMS-WINDOW (kernel level) and P-NO-BINARY
// (docs/04 §9, docs/13 §4.1 K-14), 1,000 runs each.
import { describe, expect, it, vi } from "vitest";
import fc from "fast-check";
import { epochSecondsFromIso, isoFromEpochSeconds, jcs } from "@symbolon/schemas";
import type { PaymentTerms } from "@symbolon/schemas";
import { evaluate } from "../src/index";
import type { KernelContext } from "../src/index";
import { issuesOf } from "../src/verdict";
import { DOC_TEXT, GROSS, START, context, engagement, intent, phaseA, policy, single, withDoc } from "./helpers";
import type { RawIntent } from "./helpers";
import { META, PROPERTY_TIMEOUT_MS, RUNS, eachExtraction, issueKeys, sev } from "./props-common";
import { proseArb, scenarioArb } from "./scenario";

vi.setConfig({ testTimeout: PROPERTY_TIMEOUT_MS });

describe("P-TERMS-IGNORE-INVOICE: invoice-stated terms never change amountDue, payAt or the release amount", () => {
  const stated = fc.record({
    raw: fc.option(proseArb, { nil: null }),
    netDays: fc.option(fc.integer({ min: 0, max: 3650 }), { nil: null }),
    earlyPay: fc.option(fc.record({ discountBps: fc.integer({ min: 0, max: 10_000 }), withinDays: fc.integer({ min: 0, max: 3650 }) }), { nil: null }),
    ambiguous: fc.boolean(),
  });

  it("they never change the amounts, the schedule or the plan set; they may only add ESCALATE TERMS_* findings (WP-05 K-14)", () => {
    let added = 0;
    fc.assert(
      fc.property(scenarioArb, stated, (s, terms) => {
        const mutated = eachExtraction(s.raw, (x) => (x.statedTerms = terms));
        // the escalation budget legitimately turns new escalations into holds; P-ESC-BUDGET covers that separately
        const ctx = { ...s.ctx, escalations: { today: 0, todayByEngagement: {} } };
        const before = evaluate(s.raw, ctx, s.policy);
        const after = evaluate(mutated, ctx, s.policy);
        expect(after.releaseAmountBaseUnits).toBe(before.releaseAmountBaseUnits);
        expect(after.payAt).toBe(before.payAt);
        expect(after.amountBaseUnits).toBe(before.amountBaseUnits);
        expect(after.intentId).toBe(before.intentId);
        expect(after.planId).toBe(before.planId);
        expect(jcs(after.plans)).toBe(jcs(before.plans));
        expect(after.checks.map((c) => c.id)).toEqual(before.checks.map((c) => c.id));
        expect(sev(after)).toBeGreaterThanOrEqual(sev(before));
        after.checks.forEach((c, i) => {
          const was = issueKeys(before.checks[i] as (typeof before.checks)[number]);
          const now = issueKeys(c);
          for (const k of was) expect(now).toContain(k);
          const extra = now.filter((k) => !was.includes(k));
          for (const k of extra) expect(["ESCALATE:TERMS_NOT_SIGNED", "ESCALATE:TERMS_MISMATCH"]).toContain(k);
          added += extra.length;
        });
      }),
      RUNS,
    );
    expect(added).toBeGreaterThan(300);
  });
});

describe("K-14 terms binding (INV-19, RT-15): the TERMS_* findings equal an independent reading of docs/04 K-14", () => {
  // Signed terms (or none) and invoice-stated terms are generated so that equal, off-by-one and absent values all occur.
  const signedArb = fc.option(
    fc
      .record({ netDays: fc.integer({ min: 0, max: 365 }), early: fc.option(fc.record({ discountBps: fc.integer({ min: 1, max: 2000 }), withinDays: fc.integer({ min: 1, max: 364 }) }), { nil: null }), buffer: fc.integer({ min: 0, max: 72 }), allowImmediate: fc.boolean() })
      .map(({ netDays, early, buffer, allowImmediate }): PaymentTerms => ({
        netDays: early === null ? netDays : Math.max(netDays, early.withinDays + 1),
        earlyPay: early,
        payBeforeDueBufferHours: buffer,
        allowImmediate,
      })),
    { nil: null },
  );
  const near = (n: number) => fc.constantFrom(n, n, n - 1, n + 1).map((x) => Math.max(0, x));
  const statedFor = (signed: PaymentTerms | null) =>
    fc.record({
      raw: fc.option(fc.constant("2/10 net 30"), { nil: null }),
      netDays: fc.option(fc.oneof(near(signed === null ? 30 : signed.netDays), fc.integer({ min: 0, max: 3650 })), { nil: null }),
      earlyPay: fc.option(
        signed !== null && signed.earlyPay !== null
          ? fc.record({ discountBps: near(signed.earlyPay.discountBps), withinDays: near(signed.earlyPay.withinDays) })
          : fc.record({ discountBps: fc.integer({ min: 0, max: 10_000 }), withinDays: fc.integer({ min: 0, max: 3650 }) }),
        { nil: null },
      ),
      ambiguous: fc.boolean(),
    });

  /** docs/04 K-14, read independently of src/checks/k14-timing.ts. */
  function expected(signed: PaymentTerms | null, s: { raw: string | null; netDays: number | null; earlyPay: { discountBps: number; withinDays: number } | null; ambiguous: boolean }): string[] {
    const netDays = signed === null ? policy().policy.timing.defaultNetDays : signed.netDays;
    const early = signed === null ? null : signed.earlyPay;
    const codes = new Set<string>();
    if (s.earlyPay !== null && early === null) codes.add("TERMS_NOT_SIGNED");
    if (s.earlyPay !== null && early !== null && (s.earlyPay.discountBps !== early.discountBps || s.earlyPay.withinDays !== early.withinDays)) codes.add("TERMS_MISMATCH");
    if (s.netDays !== null && s.netDays !== netDays) codes.add("TERMS_MISMATCH");
    if (s.ambiguous && !(s.raw === null && s.netDays === null && s.earlyPay === null)) codes.add("TERMS_MISMATCH");
    return [...codes].sort();
  }

  it("TERMS_NOT_SIGNED / TERMS_MISMATCH exactly when the stated terms differ (either direction) or are ambiguous; never a change in amount or schedule", () => {
    const seen = { notSigned: 0, mismatch: 0, clean: 0 };
    fc.assert(
      fc.property(
        signedArb.chain((signed) => fc.tuple(fc.constant(signed), statedFor(signed), fc.boolean())),
        ([signed, stated, singleExtraction]) => {
          const e = engagement({ paymentTerms: signed });
          const ctx = context({ engagement: e, milestone: e.milestones[0] ?? null });
          const plain = singleExtraction ? single(intent()) : intent();
          const before = evaluate(plain, ctx, policy());
          const after = evaluate(eachExtraction(plain, (x) => (x.statedTerms = stated)), ctx, policy());
          const k14 = after.checks.find((c) => c.id === "K-14");
          if (k14 === undefined) throw new Error("no K-14");
          const got = [...new Set(issuesOf(k14).map((i) => i.code).filter((c) => c === "TERMS_NOT_SIGNED" || c === "TERMS_MISMATCH"))].sort();
          const want = expected(signed, stated);
          expect(got).toEqual(want);
          for (const i of issuesOf(k14)) if (i.code === "TERMS_NOT_SIGNED" || i.code === "TERMS_MISMATCH") expect(i.onFail).toBe("ESCALATE");
          if (want.includes("TERMS_NOT_SIGNED")) seen.notSigned++;
          if (want.includes("TERMS_MISMATCH")) seen.mismatch++;
          if (want.length === 0) seen.clean++;
          // compared, never adopted: the money and the schedule are the same as with no stated terms at all
          expect([after.releaseAmountBaseUnits, after.payAt, after.planId, jcs(after.plans)]).toEqual([before.releaseAmountBaseUnits, before.payAt, before.planId, jcs(before.plans)]);
        },
      ),
      RUNS,
    );
    // Measured on two runs: about 260 not signed, 890 mismatch, 50-60 clean (both kinds can occur in one run).
    expect(seen.notSigned).toBeGreaterThan(100);
    expect(seen.mismatch).toBeGreaterThan(400);
    expect(seen.clean).toBeGreaterThan(15);
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
