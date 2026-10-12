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
  it("mutating confidence, agentRecommendation, planSelection/timingProposal rationale and statedTerms.raw leaves evaluate() identical", () => {
    fc.assert(
      fc.property(
        scenarioArb,
        fc.double({ min: 0, max: 1, noNaN: true }),
        fc.double({ min: 0, max: 1, noNaN: true }),
        fc.constantFrom("RELEASE", "HOLD", "ESCALATE"),
        fc.array(proseArb, { maxLength: 3 }),
        proseArb,
        proseArb,
        (s, ca, cb, verdict, reasons, rationale, raw) => {
          const m = clone(s.raw);
          m.extraction.a.confidence = ca;
          if (m.extraction.b !== null) m.extraction.b.confidence = cb;
          m.agentRecommendation = { verdict, reasons };
          m.planSelection = { planId: hashJcs(rationale), rationale, factorsConsidered: ["due_date"], riskFlags: [], deviatesFromEvaluator: false, deviationReason: null };
          m.timingProposal = { payAt: "2026-10-06T00:00:00Z", rationale };
          const mutated = eachExtraction(m, (x) => (x.statedTerms = { ...x.statedTerms, raw }));
          const before = { ...clone(s.raw), timingProposal: { payAt: "2026-10-06T00:00:00Z", rationale: "x" } };
          expect(canon(evaluate(mutated, s.ctx, s.policy))).toBe(canon(evaluate(before, s.ctx, s.policy)));
        },
      ),
      RUNS,
    );
  });
});
