// P-DET, P-MONO, P-NO-LLM (docs/04 §9), 1,000 runs each over seeded scenarios built from the real fixtures.
import { describe, expect, it, vi } from "vitest";
import fc from "fast-check";
import { hashJcs } from "@symbolon/schemas";
import { evaluate, toJsonSafe } from "../src/index";
import type { KernelContext } from "../src/index";
import { ATTACKER, CAP, M1, clone, phaseA, summary } from "./helpers";
import { PROPERTY_TIMEOUT_MS, RUNS, canon, eachExtraction, sev } from "./props-common";
import { proseArb, scenarioArb } from "./scenario";
import type { Scenario } from "./scenario";

vi.setConfig({ testTimeout: PROPERTY_TIMEOUT_MS });

describe("P-DET: same input => deep-equal output and byte-identical JCS", () => {
  it("evaluate() twice gives the same canonical output and hash (evaluate runs every implemented check)", () => {
    fc.assert(
      fc.property(scenarioArb, (s) => {
        const a = evaluate(s.raw, s.ctx, s.policy);
        const b = evaluate(clone(s.raw), s.ctx, s.policy);
        expect(canon(b)).toBe(canon(a));
        expect(hashJcs(toJsonSafe(b))).toBe(hashJcs(toJsonSafe(a)));
      }),
      RUNS,
    );
  });
});

describe("P-MONO: adding a failing condition never improves the verdict", () => {
  type Failure = readonly [string, (s: Scenario) => readonly [unknown, KernelContext]];
  const FAILURES: readonly Failure[] = [
    ["invoice address is not the payee", (s) => [eachExtraction(s.raw, (x) => (x.payee.walletAddress = ATTACKER)), s.ctx]],
    ["address change claimed", (s) => [eachExtraction(s.raw, (x) => (x.payee.claimsAddressChange = true)), s.ctx]],
    ["an INVOICE becomes a CREDIT_NOTE", (s) => [eachExtraction(s.raw, (x) => (x.docType = x.docType === "INVOICE" ? "CREDIT_NOTE" : x.docType)), s.ctx]],
    ["currency EUR", (s) => [eachExtraction(s.raw, (x) => (x.amount.currencyPrinted = "EUR")), s.ctx]],
    ["engagement closed", (s) => [s.raw, { ...s.ctx, engagement: { ...s.engagement, status: "CLOSED" } }]],
    ["owner signature missing", (s) => [s.raw, { ...s.ctx, engagement: { ...s.engagement, ownerSig: null } }]],
    ["no on-chain registration", (s) => [s.raw, { ...s.ctx, engagementOnChain: null }]],
    ["payee change pending", (s) => [s.raw, { ...s.ctx, payeeChangePending: true }]],
    ["token decimals 18", (s) => [s.raw, { ...s.ctx, chain: { ...s.ctx.chain, tokenDecimals: 18 } }]],
    ["engagement cap exhausted", (s) => [s.raw, { ...s.ctx, released: { ...s.ctx.released, engagementTotal: CAP } }]],
    [
      "milestone released under another intent",
      (s) => [s.raw, { ...s.ctx, priorDecisions: [...s.ctx.priorDecisions, summary({ decisionId: "9f9f9f9f-0000-4000-8000-000000000009", verdict: "RELEASE", milestoneId: M1, normInvoiceNo: "X" })] }],
    ],
  ];

  it("for every scenario and every added failure: severity(after) >= severity(before), and after is never RELEASE", () => {
    fc.assert(
      fc.property(scenarioArb, fc.constantFrom(...FAILURES), (s, [, add]) => {
        const [raw, ctx] = add(s);
        for (const run of [phaseA, (r: unknown, c: KernelContext, p: typeof s.policy) => evaluate(r, c, p)]) {
          const before = run(s.raw, s.ctx, s.policy);
          const after = run(raw, ctx, s.policy);
          fc.pre(before.verdict !== "REPLAY");
          expect(after.verdict).not.toBe("RELEASE");
          expect(sev(after)).toBeGreaterThanOrEqual(sev(before));
        }
      }),
      RUNS,
    );
  });
});

describe("P-NO-LLM: model confidence, recommendations and prose never change the evaluation", () => {
  // WP-05: the planner's planId and the timing proposal's instant are structured CHOICES the kernel re-checks; the same
  // choice is used on both sides. Everything else the LLM writes (confidence, recommendation, rationale, deviation
  // reason, factors, risk flags, statedTerms.raw) must not change a single byte of the evaluation.
  it("mutating confidence, agentRecommendation, planner/timing prose and flags, and statedTerms.raw leaves evaluate() identical", () => {
    let agentPlans = 0;
    fc.assert(
      fc.property(
        scenarioArb,
        fc.double({ min: 0, max: 1, noNaN: true }),
        fc.double({ min: 0, max: 1, noNaN: true }),
        fc.constantFrom("RELEASE", "HOLD", "ESCALATE"),
        fc.array(proseArb, { maxLength: 3 }),
        proseArb,
        proseArb,
        fc.nat(),
        fc.subarray(["due_date", "discount_window", "implied_apr", "liquidity", "payee_history", "evidence_status", "policy_rule", "delivery_risk"] as const),
        fc.subarray(["DELIVERY_UNCERTAIN", "VENDOR_HISTORY_POOR", "LIQUIDITY_TIGHT", "TERMS_AMBIGUOUS", "OTHER"] as const),
        (s, ca, cb, verdict, reasons, rationale, raw, pick, factors, flags) => {
          const offered = evaluate(s.raw, s.ctx, s.policy).plans;
          const chosen = offered.length > 0 && pick % 3 !== 0 ? offered[pick % offered.length] : undefined;
          const planId = chosen === undefined ? hashJcs(`not a plan ${pick}`) : chosen.planId;
          if (chosen !== undefined && chosen.mode !== "HOLD") agentPlans++;
          const base = {
            ...clone(s.raw),
            planSelection: { planId, rationale: "x", factorsConsidered: [] as string[], riskFlags: [] as string[], deviatesFromEvaluator: false, deviationReason: null as string | null },
            timingProposal: { payAt: "2026-10-06T00:00:00Z", rationale: "x" },
          };
          const m = clone(base);
          m.extraction.a.confidence = ca;
          if (m.extraction.b !== null) m.extraction.b.confidence = cb;
          m.agentRecommendation = { verdict, reasons };
          m.planSelection = { planId, rationale, factorsConsidered: [...factors], riskFlags: [...flags], deviatesFromEvaluator: true, deviationReason: raw };
          m.timingProposal = { payAt: "2026-10-06T00:00:00Z", rationale };
          const mutated = eachExtraction(m, (x) => (x.statedTerms = { ...x.statedTerms, raw }));
          expect(canon(evaluate(mutated, s.ctx, s.policy))).toBe(canon(evaluate(base, s.ctx, s.policy)));
        },
      ),
      RUNS,
    );
    expect(agentPlans, `in-set planner picks: ${agentPlans}`).toBeGreaterThan(100); // typically ~200 of 1,000
  });
});
