// Partial instalments (docs/04 K-04 + K-08; docs/QUESTIONS.md "WP-05 kernel fixes", finding 2), 1,000 runs per property.
// The honest corpus (HU-09) and ATK-14 showed K-04 rejecting a legitimate LATER instalment of a partialAllowed milestone. The
// properties drive random instalment sequences through the FULL pipeline, with the prior decisions the kernel itself produced
// (summarizeEvaluation), and assert:
//   - an instalment that still fits in the signed milestone amount is RELEASED (no K-04 / K-08 finding);
//   - one that does not fit is REJECTed (OVERPAY, plus MILESTONE_ALREADY_PAID once the milestone is covered), never released;
//   - the sum of all RELEASEd instalments never exceeds the milestone amount;
//   - re-submitting an instalment already decided is a REPLAY (no second release);
//   - on a milestone that does NOT allow partial payment any earlier RELEASE rejects (the strict reading is unchanged).
// Earlier decisions are dated more than 7 days back, so the (separate, spec'd) NEAR_DUPLICATE escalation for equal amounts does
// not interfere; it has its own unit tests.
import { describe, expect, it, vi } from "vitest";
import fc from "fast-check";
import { evaluate, summarizeEvaluation } from "../src/index";
import type { DecisionSummary, Evaluation } from "../src/index";
import { H, M1, M2, context, engagement, intent, milestone, policy, summary } from "./helpers";
import { PROPERTY_TIMEOUT_MS, RUNS, eachExtraction } from "./props-common";

vi.setConfig({ testTimeout: PROPERTY_TIMEOUT_MS });

const USDC = 1_000_000n;
const P = policy();

function world(totalUsdc: number, partialAllowed: boolean) {
  const m = milestone(M1, "design", { partialAllowed, amountBaseUnits: (BigInt(totalUsdc) * USDC).toString() });
  return engagement({ milestones: [m, milestone(M2, "build")] });
}

/** The i-th invoice for `usdc` whole USDC against M1: its own document, its own invoice number. */
function instalment(i: number, usdc: number) {
  const hash = H(`instalment document ${String(i)}`);
  const raw = eachExtraction(intent({ docHash: hash }), (x) => {
    x.invoiceNumber = `INV-${String(100 + i)}`;
    x.amount.printed = `${String(usdc)}.00`;
    x.amount.parsedBaseUnits = (BigInt(usdc) * USDC).toString();
    x.lineItems = [];
  });
  return { raw, hash };
}

function evaluateOn(e: ReturnType<typeof world>, i: number, usdc: number, priors: readonly DecisionSummary[]): Evaluation {
  const { raw, hash } = instalment(i, usdc);
  const base = context({ engagement: e, milestone: e.milestones[0] ?? null, priorDecisions: priors });
  return evaluate(raw, { ...base, doc: { ...base.doc, hash } }, P);
}

function decided(e: Evaluation, i: number): DecisionSummary {
  const s = summarizeEvaluation(e, { decisionId: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`, createdAt: `2026-07-${String(10 + i).padStart(2, "0")}T00:00:00Z` });
  if (!s.ok) throw new Error("evaluation could not be summarized");
  return s.value;
}

const codes = (e: Evaluation): string[] => e.reasons.map(String);

// Small milestones and instalments up to half of it (sometimes up to the whole), so sequences regularly fill the milestone exactly and then try again.
const planArb = fc.integer({ min: 2, max: 40 }).chain((total) =>
  fc.record({
    total: fc.constant(total),
    steps: fc.array(fc.oneof({ weight: 4, arbitrary: fc.integer({ min: 1, max: Math.ceil(total / 2) }) }, { weight: 1, arbitrary: fc.integer({ min: 1, max: total }) }), { minLength: 2, maxLength: 8 }),
  }),
);

describe("partial instalments (K-04 + K-08)", () => {
  it("an instalment that fits is released, one that does not is rejected, and the released sum never exceeds the milestone", () => {
    let released = 0;
    let refused = 0;
    let covered = 0;
    fc.assert(
      fc.property(planArb, ({ total, steps }) => {
        const e = world(total, true);
        const priors: DecisionSummary[] = [];
        let sum = 0;
        steps.forEach((usdc, i) => {
          const ev = evaluateOn(e, i, usdc, priors);
          if (sum + usdc <= total) {
            expect(ev.verdict, `${String(usdc)} after ${String(sum)} of ${String(total)}: ${codes(ev).join(",")}`).toBe("RELEASE");
            expect(codes(ev)).not.toContain("MILESTONE_ALREADY_PAID");
            expect(ev.releaseAmountBaseUnits).toBe((BigInt(usdc) * USDC).toString());
            priors.push(decided(ev, i));
            sum += usdc;
            released += 1;
          } else {
            expect(ev.verdict, `${String(usdc)} after ${String(sum)} of ${String(total)}`).toBe("REJECT");
            expect(codes(ev)).toContain("OVERPAY");
            // the milestone-settled finding appears exactly when the earlier releases already cover it
            expect(codes(ev).includes("MILESTONE_ALREADY_PAID")).toBe(sum >= total);
            refused += 1;
            if (sum >= total) covered += 1;
          }
        });
        expect(sum).toBeLessThanOrEqual(total);
        expect(priors.reduce((s, p) => s + (p.amountBaseUnits ?? 0n), 0n)).toBe(BigInt(sum) * USDC);
      }),
      RUNS,
    );
    // not vacuous: the runs contained plenty of each outcome
    expect(released).toBeGreaterThan(300);
    expect(refused).toBeGreaterThan(300);
    expect(covered).toBeGreaterThan(30);
  });

  it("an instalment already decided is a REPLAY, never a second release", () => {
    fc.assert(
      fc.property(fc.integer({ min: 2, max: 200 }), fc.integer({ min: 1, max: 100 }), (total, usdc) => {
        fc.pre(usdc <= total);
        const e = world(total, true);
        const first = evaluateOn(e, 0, usdc, []);
        expect(first.verdict).toBe("RELEASE");
        const again = evaluateOn(e, 0, usdc, [decided(first, 0)]);
        expect(again.verdict).toBe("REPLAY");
        expect(again.replayOf?.intentId).toBe(first.intentId);
      }),
      RUNS,
    );
  });

  it("a milestone that does not allow partial payment rejects ANY earlier release on it, whatever the amount", () => {
    fc.assert(
      fc.property(fc.integer({ min: 2, max: 200 }), fc.integer({ min: 1, max: 200 }), fc.integer({ min: 1, max: 200 }), (total, firstUsdc, secondUsdc) => {
        const e = world(total, false);
        const prior = summary({ verdict: "RELEASE", milestoneId: M1, amountBaseUnits: BigInt(firstUsdc) * USDC, normInvoiceNo: "INV0099", createdAt: "2026-07-10T00:00:00Z" });
        const second = evaluateOn(e, 1, secondUsdc, [prior]);
        expect(second.verdict).toBe("REJECT");
        expect(codes(second)).toContain("MILESTONE_ALREADY_PAID");
      }),
      RUNS,
    );
  });
});
