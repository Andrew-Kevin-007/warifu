// P-K04-IDEM, P-K08-EXACT, P-K06-PAYEE, P-INTENT-GROSS and "unbound never releases" (docs/04 §9), 1,000 runs each.
// Properties about RELEASE count their RELEASE cases so that they cannot pass vacuously.
import { describe, expect, it, vi } from "vitest";
import fc from "fast-check";
import { deriveEntityId, epochSecondsFromIso, hashJcs } from "@symbolon/schemas";
import { amountDue } from "@symbolon/terms";
import { evaluate, normalizeInvoiceNumber, summarizeEvaluation } from "../src/index";
import type { KernelContext } from "../src/index";
import { ATTACKER, GROSS, M2, PAYEE, TENANT, TWO_TEN_NET_30, context, engagement, intent, phaseA } from "./helpers";
import { META, PROPERTY_TIMEOUT_MS, RUNS, eachExtraction } from "./props-common";
import { proseArb, scenarioArbV4 as scenarioArb } from "./scenario";
import type { Scenario } from "./scenario";

vi.setConfig({ testTimeout: PROPERTY_TIMEOUT_MS });

describe("P-K04-IDEM: re-evaluating with the result in priorDecisions => REPLAY with the identical decision", () => {
  it("holds whenever the intent parses", () => {
    let replays = 0;
    fc.assert(
      fc.property(scenarioArb, (s0) => {
        const s = { ...s0, ctx: { ...s0.ctx, reevaluation: null } };
        const first = phaseA(s.raw, s.ctx, s.policy);
        fc.pre(first.checks[0]?.status === "PASS" && first.verdict !== "REPLAY" && first.normInvoiceNo !== null);
        const summary = summarizeEvaluation(first, META);
        if (!summary.ok) throw new Error(summary.error.message);
        const ctx = { ...s.ctx, priorDecisions: [...s.ctx.priorDecisions, summary.value] };
        for (const again of [phaseA(s.raw, ctx, s.policy), evaluate(s.raw, ctx, s.policy)]) {
          expect(again.verdict).toBe("REPLAY");
          expect(again.replayOf).toEqual(summary.value);
        }
        replays++;
      }),
      RUNS,
    );
    expect(replays).toBeGreaterThan(500);
  });
});

describe("P-K08-EXACT and P-K06-PAYEE: what a RELEASE implies", () => {
  it("RELEASE => gross = signed milestone amount (or the partial rule) within the cap; release amount = amountDue(payAt); payout = engagement payee", () => {
    let releases = 0;
    fc.assert(
      fc.property(scenarioArb, (s) => {
        const e = phaseA(s.raw, s.ctx, s.policy);
        if (e.verdict !== "RELEASE") return;
        releases++;
        const m = s.engagement.milestones[0];
        if (m === undefined) throw new Error("fixture");
        const milestoneAmount = BigInt(m.amountBaseUnits);
        const gross = BigInt(e.amountBaseUnits ?? "-1");
        if (m.partialAllowed) expect(gross <= milestoneAmount && gross > 0n).toBe(true);
        else expect(gross).toBe(milestoneAmount);
        expect(s.ctx.released.engagementTotal + gross <= BigInt(s.engagement.capBaseUnits)).toBe(true);
        // P-K06-PAYEE: the payout address is the engagement payee and no invoice address disagrees with it
        expect(e.payee).toBe(s.engagement.payee);
        for (const x of [s.raw.extraction.a, s.raw.extraction.b]) {
          if (x !== null && x.payee.walletAddress !== null) expect(x.payee.walletAddress).toBe(s.engagement.payee);
        }
        // the attested amount at a re-evaluation equals an independent amountDue at max(now, payAt)
        const re = s.ctx.reevaluation;
        if (re !== null) {
          const payAt = epochSecondsFromIso(s.ctx.now) >= epochSecondsFromIso(re.payAt) ? s.ctx.now : re.payAt;
          const due = amountDue({ grossBaseUnits: gross, terms: s.engagement.paymentTerms, invoiceReceivedAt: s.ctx.invoiceReceivedAt, payAt });
          if (!due.ok) throw new Error(due.error.message);
          expect(re.releaseAmountBaseUnits).toBe(due.value.amountDue);
          expect(e.releaseAmountBaseUnits).toBe(due.value.amountDue.toString());
        }
      }),
      RUNS,
    );
    expect(releases).toBeGreaterThan(30);
  });
});

describe("P-INTENT-GROSS: intentId is invariant to plan/discount and changes with each preimage field", () => {
  it("plan selection, timing proposal, signed discount terms and the scheduled release amount never change intentId", () => {
    const baseId = phaseA(intent()).intentId;
    const withTerms = engagement({ paymentTerms: TWO_TEN_NET_30 });
    fc.assert(
      fc.property(proseArb, fc.boolean(), fc.bigInt({ min: 0n, max: GROSS * 2n }), (rationale, terms, scheduled) => {
        const i = {
          ...intent(),
          timingProposal: { payAt: "2026-10-07T00:00:00Z", rationale },
          planSelection: { planId: hashJcs(rationale), rationale, factorsConsidered: [], riskFlags: [], deviatesFromEvaluator: false, deviationReason: null },
        };
        const e = terms ? withTerms : engagement();
        const ctx = context({ engagement: e, milestone: e.milestones[0] ?? null, reevaluation: { decisionId: META.decisionId, intentId: baseId, payAt: "2026-10-05T12:00:00Z", releaseAmountBaseUnits: scheduled } });
        expect(phaseA(i, ctx).intentId).toBe(baseId);
      }),
      RUNS,
    );
  });

  it("changes with engagementId, milestoneId, gross and payee", () => {
    const baseId = phaseA(intent()).intentId;
    const other = engagement({ engagementId: deriveEntityId({ tenantId: TENANT, slug: "other-engagement" }) });
    expect(phaseA({ ...intent(), engagementId: other.engagementId }, context({ engagement: other, milestone: other.milestones[0] ?? null })).intentId).not.toBe(baseId);
    expect(phaseA({ ...intent(), milestoneId: M2 }).intentId).not.toBe(baseId);
    const plus = eachExtraction(intent(), (x) => {
      x.amount.printed = "1,000.01";
      x.amount.parsedBaseUnits = "1000010000";
    });
    expect(phaseA(plus).intentId).not.toBe(baseId);
    const otherPayee = engagement({ payee: ATTACKER });
    expect(PAYEE).not.toBe(ATTACKER);
    expect(phaseA(intent(), context({ engagement: otherPayee, milestone: otherPayee.milestones[0] ?? null })).intentId).not.toBe(baseId);
  });

  it("changes with the invoice number exactly when its normalized form changes (renumbering cannot mint a twin)", () => {
    const invoiceNo = fc.string({ minLength: 1, maxLength: 12, unit: fc.constantFrom(..."0Aa1-/ #b".split("")) });
    fc.assert(
      fc.property(invoiceNo, invoiceNo, (n1, n2) => {
        const id = (n: string) => phaseA(eachExtraction(intent(), (x) => (x.invoiceNumber = n))).intentId;
        expect(id(n1) === id(n2)).toBe(normalizeInvoiceNumber(n1) === normalizeInvoiceNumber(n2));
      }),
      RUNS,
    );
  });
});

describe("an unbound intent never releases", () => {
  it("no engagement, no milestone, or no determinable gross => intentIdBound false and verdict != RELEASE", () => {
    const unbind = fc.constantFrom<(s: Scenario) => readonly [unknown, KernelContext]>(
      (s) => [{ ...s.raw, engagementId: null }, s.ctx],
      (s) => [{ ...s.raw, milestoneId: null }, s.ctx],
      (s) => [s.raw, { ...s.ctx, engagement: null }],
      (s) => [
        eachExtraction(s.raw, (x) => {
          x.amount.printed = "1.000";
          x.amount.parsedBaseUnits = null;
        }),
        s.ctx,
      ],
    );
    fc.assert(
      fc.property(scenarioArb, unbind, (s, f) => {
        const [raw, ctx] = f(s);
        const e = phaseA(raw, ctx, s.policy);
        fc.pre(e.verdict !== "REPLAY");
        expect(e.intentIdBound).toBe(false);
        expect(e.verdict).not.toBe("RELEASE");
      }),
      RUNS,
    );
  });
});
