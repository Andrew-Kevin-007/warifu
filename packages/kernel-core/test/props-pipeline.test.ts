// Full-pipeline properties (docs/04 §9), 1,000 runs each: P-FAILCLOSED, P-PLAN-SUBSET, what a RELEASE implies end to
// end (P-K06-PAYEE / P-K08-EXACT over every check, amountDue from the signed terms, evidence, breaker, screening), and
// P-SANDBOX-NO-FETCH. RELEASE-implication properties count their RELEASE cases (no vacuous passes).
import { describe, expect, it, vi } from "vitest";
import fc from "fast-check";
import { epochSecondsFromIso, isoFromEpochSeconds, keccak256Utf8, untrusted } from "@symbolon/schemas";
import type { Evidence, EvidenceRequirement, FeasiblePlan } from "@symbolon/schemas";
import type { LoadedPolicy } from "@symbolon/policy";
import { amountDue, feasiblePlans } from "@symbolon/terms";
import { EVALUATION_ORDER, KERNEL_PIPELINE, assessEvidence, evaluate, evidenceCollectionPlan } from "../src/index";
import type { KernelContext } from "../src/index";
import { runPipeline } from "../src/pipeline";
import type { PipelineConfig } from "../src/pipeline";
import { GROSS, M1, M2, RECEIVED, TWO_TEN_NET_30, context, engagement, intent, milestone, ownerAck, policy, single } from "./helpers";
import type { RawIntent } from "./helpers";
import { PROPERTY_TIMEOUT_MS, RUNS } from "./props-common";
import { scenarioArb } from "./scenario";

vi.setConfig({ testTimeout: PROPERTY_TIMEOUT_MS });

const boom = (): never => {
  throw new Error("injected failure");
};

describe("P-FAILCLOSED: an exception in any required check => verdict != RELEASE and KERNEL_ERROR in the reasons", () => {
  const targets = [...KERNEL_PIPELINE.pre.map((p) => p.id), ...KERNEL_PIPELINE.stages.map((s) => s.id), "K-01", "evidence", "schedule"] as const;

  it("over every check (and K-01 and the derived inputs) and random scenarios", () => {
    let ran = 0;
    fc.assert(
      fc.property(scenarioArb, fc.constantFrom(...targets), (s, target) => {
        let config: PipelineConfig = KERNEL_PIPELINE;
        let ctx: KernelContext = s.ctx;
        let p: LoadedPolicy = s.policy;
        if (target === "K-16") config = { ...KERNEL_PIPELINE, pre: [{ id: "K-16", run: boom }] };
        else if (target === "K-01") p = { policyHash: s.policy.policyHash, decimals: s.policy.decimals, amounts: s.policy.amounts, get policy(): never { return boom(); } } as LoadedPolicy;
        else if (target === "evidence") ctx = { ...ctx, evidence: { [Symbol.iterator]: boom } as unknown as Evidence[] };
        else if (target === "schedule") ctx = { ...ctx, reevaluation: null, balances: Object.defineProperty({}, "vaultAvailable", { get: boom }) as KernelContext["balances"] };
        else config = { ...KERNEL_PIPELINE, stages: KERNEL_PIPELINE.stages.map((st) => (st.id === target ? { id: target, run: boom } : st)) };
        const e = runPipeline(config, s.raw, ctx, p);
        const injected = target === "evidence" ? "K-09" : target === "schedule" ? "K-14" : target;
        const result = e.checks.find((c) => c.id === injected);
        if (result === undefined) {
          // a short-circuit before the injected check: K-01 rejected the intent or K-04 replayed a prior decision
          expect(["REJECT", "REPLAY"]).toContain(e.verdict);
          return;
        }
        // A derived input whose consumer stopped before reading it: K-09 without an engagement or a signed milestone; K-14
        // without those or without a determinable amount (it returns before looking at the schedule). Never RELEASE.
        const before = target === "evidence" ? ["NO_ENGAGEMENT", "UNKNOWN_MILESTONE"] : target === "schedule" ? ["NO_ENGAGEMENT", "UNKNOWN_MILESTONE", "AMOUNT_AMBIGUOUS"] : [];
        if (result.status === "FAIL" && before.includes(String(result.code))) {
          expect(e.verdict).not.toBe("RELEASE");
          return;
        }
        ran++;
        expect(e.verdict).not.toBe("RELEASE");
        expect(e.reasons).toContain("KERNEL_ERROR");
      }),
      RUNS,
    );
    expect(ran).toBeGreaterThan(700);
  });

  it("regression (seed -494934716): K-12 throws while the escalation budget is met and K-10 escalates => KERNEL_ERROR still in the reasons", () => {
    // The budget gate re-combines K-12 with ESCALATION_BUDGET_EXCEEDED first; at equal severity (HOLD) the fault must
    // keep the code (verdict.ts faultWinsTie), otherwise KERNEL_ERROR vanished from the reasons (verdict was HOLD).
    const config: PipelineConfig = { ...KERNEL_PIPELINE, stages: KERNEL_PIPELINE.stages.map((st) => (st.id === "K-12" ? { id: "K-12", run: boom } : st)) };
    const ctx = context({ escalations: { today: 8, todayByEngagement: {} } });
    const e = runPipeline(config, single(intent()), ctx, policy());
    expect(e.verdict).toBe("HOLD");
    expect(e.reasons).toEqual(["SINGLE_EXTRACTION", "KERNEL_ERROR"]);
    expect(String(e.checks.find((c) => c.id === "K-12")?.detail)).toContain("ESCALATION_BUDGET_EXCEEDED");
  });

  it("evaluate() itself never throws and never releases on a broken context", () => {
    for (const broken of [null, {}, { ...context(), doc: null }]) {
      const e = evaluate(intent(), broken as unknown as KernelContext, policy());
      expect(e.verdict).not.toBe("RELEASE");
      expect(e.checks.map((c) => c.id)).toEqual(EVALUATION_ORDER);
    }
  });
});

// --- P-PLAN-SUBSET -------------------------------------------------------------------------------------------------

interface PlanWorld {
  readonly raw: RawIntent;
  readonly ctx: KernelContext;
}

const planWorldArb: fc.Arbitrary<PlanWorld> = fc
  .record({
    terms: fc.boolean(),
    nowOffsetHours: fc.integer({ min: 2, max: 30 * 24 }),
    selection: fc.constantFrom("offered", "offered", "random", "proposal", "none"),
    pick: fc.nat(),
    proposalOffsetHours: fc.integer({ min: -48, max: 40 * 24 }),
    liquidity: fc.constantFrom(10_000_000_000n, 1_009_999_999n, 990_000_000n),
    asOfBackHours: fc.constantFrom(0, 0, 1),
  })
  .map((w): PlanWorld => {
    const e = engagement({ paymentTerms: w.terms ? TWO_TEN_NET_30 : null });
    const now = isoFromEpochSeconds(epochSecondsFromIso(RECEIVED) + BigInt(w.nowOffsetHours) * 3600n);
    const asOf = isoFromEpochSeconds(epochSecondsFromIso(now) - BigInt(w.asOfBackHours) * 3600n);
    // evidence collected 2 h before now: fresh, and in hand before the (at most 1 h earlier) offer
    const collected = isoFromEpochSeconds(epochSecondsFromIso(now) - 7200n);
    const ctx = context({
      engagement: e,
      milestone: e.milestones[0] ?? null,
      now,
      evidence: [ownerAck(M1, { collectedAt: collected })],
      balances: { vaultAvailable: w.liquidity, pendingReleases: 0n, obligations14d: 0n },
      planningAsOf: w.asOfBackHours === 0 ? null : asOf,
    });
    let raw: RawIntent = intent();
    if (w.selection === "offered") {
      const offered = evaluate(raw, { ...ctx, now: asOf }, policy()).plans;
      const plan = offered[w.pick % Math.max(offered.length, 1)];
      if (plan !== undefined) raw = { ...raw, planSelection: { planId: plan.planId, rationale: "r", factorsConsidered: [], riskFlags: [], deviatesFromEvaluator: false, deviationReason: null } };
    } else if (w.selection === "random") {
      raw = { ...raw, planSelection: { planId: keccak256Utf8(`not offered ${w.pick}`), rationale: "r", factorsConsidered: [], riskFlags: [], deviatesFromEvaluator: false, deviationReason: null } };
    } else if (w.selection === "proposal") {
      raw = { ...raw, timingProposal: { payAt: isoFromEpochSeconds(epochSecondsFromIso(now) + BigInt(w.proposalOffsetHours) * 3600n), rationale: "r" } };
    }
    return { raw, ctx };
  });

/** The kernel-feasible plans recomputed independently from the context (not from the evaluation). */
function independentPlans(ctx: KernelContext, intentId: `0x${string}`): readonly FeasiblePlan[] {
  const m = ctx.engagement?.milestones[0];
  if (m === undefined || ctx.engagement === null) throw new Error("fixture");
  const satisfiedAt = assessEvidence(m, ctx.engagement.owner, ctx, policy()).satisfiedAt;
  const r = feasiblePlans({
    intentId,
    now: ctx.now,
    invoiceReceivedAt: ctx.invoiceReceivedAt,
    grossBaseUnits: GROSS,
    terms: ctx.engagement.paymentTerms,
    policyTiming: policy().policy.timing,
    evidenceSatisfiedAt: satisfiedAt,
    liquidity: { vaultAvailable: ctx.balances.vaultAvailable, pendingReleases: ctx.balances.pendingReleases, reserveFloor: policy().amounts.reserveFloor },
    amountCeiling: null,
  });
  if (!r.ok) throw new Error(r.error.message);
  return r.value.plans;
}

describe("P-PLAN-SUBSET: a RELEASE with a planner-chosen payAt implies planId is in feasiblePlans(ctx); otherwise plannerFallback", () => {
  it("holds for planner picks (offered, stale, invented), legacy proposals and no planner at all", () => {
    let agent = 0;
    let fallback = 0;
    fc.assert(
      fc.property(planWorldArb, (w) => {
        const e = evaluate(w.raw, w.ctx, policy());
        if (e.verdict !== "RELEASE") return;
        const plans = independentPlans(w.ctx, e.intentId);
        const chosen = plans.find((p) => p.planId === e.planId);
        if (e.timingSource === "AGENT" && !e.plannerFallback) {
          agent++;
          expect(w.raw.planSelection).not.toBeNull();
          expect(chosen).toBeDefined();
        } else {
          fallback++;
          expect(e.plannerFallback).toBe(true);
        }
        // every scheduled RELEASE is a kernel-feasible plan, whatever chose it
        expect(chosen?.payAt).toBe(e.payAt);
        expect(chosen?.amountDue).toBe(e.releaseAmountBaseUnits);
        // without an offer instant, a pick outside the current set is discarded and recorded
        const selected = w.raw.planSelection as { planId: string } | null;
        if (w.ctx.planningAsOf === null && selected !== null && plans.every((p) => p.planId !== selected.planId)) {
          expect(e.plannerFallback).toBe(true);
          expect(e.timingFlags).toContain("PLAN_OUT_OF_ENVELOPE");
        }
      }),
      RUNS,
    );
    expect(agent).toBeGreaterThan(150);
    expect(fallback).toBeGreaterThan(150);
  });
});

// --- what a RELEASE implies, over every check ---------------------------------------------------------------------

describe("RELEASE implications over the full pipeline (P-K06-PAYEE, P-K08-EXACT, terms, evidence, breaker, screening)", () => {
  it("payout = engagement payee; gross = milestone (or partial, or an owner-approved underpayment); release = amountDue(payAt) from the SIGNED terms; evidence satisfied; breaker OK", () => {
    let releases = 0;
    fc.assert(
      fc.property(scenarioArb, (s) => {
        const e = evaluate(s.raw, s.ctx, s.policy);
        if (e.verdict !== "RELEASE") return;
        releases++;
        const m = s.engagement.milestones[0];
        if (m === undefined) throw new Error("fixture");
        expect(e.payee).toBe(s.engagement.payee);
        const gross = BigInt(e.amountBaseUnits ?? "-1");
        const milestoneAmount = BigInt(m.amountBaseUnits);
        expect(gross <= milestoneAmount).toBe(true);
        if (gross < milestoneAmount && !m.partialAllowed) expect(e.resolvedByApproval.map((r) => r.code)).toContain("UNDERPAY_PARTIAL");
        const payAt = e.payAt ?? "";
        const due = amountDue({ grossBaseUnits: gross, terms: s.engagement.paymentTerms, invoiceReceivedAt: s.ctx.invoiceReceivedAt, payAt });
        if (!due.ok) throw new Error(due.error.message);
        expect(e.releaseAmountBaseUnits).toBe(due.value.amountDue.toString());
        expect(epochSecondsFromIso(payAt) >= epochSecondsFromIso(s.ctx.now) || s.ctx.reevaluation !== null).toBe(true);
        expect(assessEvidence(m, s.engagement.owner, s.ctx, s.policy).satisfied).toBe(true);
        expect(s.ctx.breaker.halted).toBe(false);
        expect(s.ctx.screening?.status === "HIT").toBe(false);
        expect(s.ctx.payeeChangePending).toBe(false);
        for (const x of [s.raw.extraction.a, s.raw.extraction.b]) if (x !== null && x.payee.walletAddress !== null) expect(x.payee.walletAddress).toBe(s.engagement.payee);
      }),
      RUNS,
    );
    expect(releases).toBeGreaterThan(30);
  });
});

// --- P-SANDBOX-NO-FETCH ---------------------------------------------------------------------------------------------

const requirementArb: fc.Arbitrary<EvidenceRequirement> = fc.oneof(
  fc.constant<EvidenceRequirement>({ type: "OWNER_ACK" }),
  fc.constantFrom("acme/site", "evil/x").map((repo): EvidenceRequirement => ({ type: "CI_PASS", repo, ref: "a".repeat(40) })),
  fc
    .constantFrom("https://acme.vercel.app/health", "https://169.254.169.254/latest", "https://127.0.0.1/x", "https://localhost/x", "https://evil.example/x", "https://[::1]/x")
    .map((url): EvidenceRequirement => ({ type: "URL_HEALTH", url, expectStatus: 200 })),
  fc.constant<EvidenceRequirement>({ type: "ARTIFACT_HASH", sha256: keccak256Utf8("artifact") }),
);

const NON_FIXTURE_SOURCES = ["eip712:MilestoneAck", "github:actions", "kernel:artifact", "https://acme.vercel.app/health", "https://169.254.169.254/latest", "web-upload"];

describe("P-SANDBOX-NO-FETCH: in the sandbox no collector is ever given a URL, and only matching fixtures are evidence", () => {
  it("the collection plan is fixtures-only; non-fixture evidence => HOLD EVIDENCE_SOURCE_DENIED; never RELEASE without a matching fixture", () => {
    let denied = 0;
    fc.assert(
      fc.property(fc.array(requirementArb, { minLength: 1, maxLength: 4 }), fc.array(fc.nat(), { minLength: 1, maxLength: 6 }), fc.boolean(), (spec, picks, withFixtures) => {
        const m = milestone(M1, "design", { evidenceSpec: spec });
        for (const req of evidenceCollectionPlan(m, "sandbox", policy())) {
          expect(req.kind).toBe("FIXTURE");
          expect("url" in req).toBe(false);
        }
        const e0 = engagement({ milestones: [m, milestone(M2, "build")] });
        const evidence: Evidence[] = picks.map((n, i) => {
          const req = spec[n % spec.length] as EvidenceRequirement;
          const fixture = withFixtures && i === 0;
          return {
            evidenceId: `f0000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
            milestoneId: M1,
            type: req.type,
            collectedBy: "kernel",
            collectedAt: "2026-10-05T11:00:00Z",
            source: fixture ? "fixture:S-A-design-0" : (NON_FIXTURE_SOURCES[n % NON_FIXTURE_SOURCES.length] as string),
            payload: fixture ? { requirement: req } : { url: "https://acme.vercel.app/health", status: 200, sha256: keccak256Utf8("artifact"), conclusion: "success", repo: "acme/site", ref: "a".repeat(40), headSha: "a".repeat(40) },
            payloadHash: keccak256Utf8(`p${i}`),
            result: "PASS",
            details: untrusted("x"),
          };
        });
        const ctx = context({ engagement: e0, milestone: e0.milestones[0] ?? null, profile: "sandbox", evidence });
        const e = evaluate(intent(), ctx, policy());
        const k09 = e.checks.find((c) => c.id === "K-09");
        const fixtureCovers = (req: EvidenceRequirement) => withFixtures && JSON.stringify(spec[(picks[0] as number) % spec.length]) === JSON.stringify(req);
        if (!spec.every(fixtureCovers)) {
          expect(e.verdict).not.toBe("RELEASE");
          expect(k09?.status).toBe("FAIL");
          if (!withFixtures) {
            denied++;
            expect(k09?.code).toBe("EVIDENCE_SOURCE_DENIED");
          }
        }
      }),
      RUNS,
    );
    expect(denied).toBeGreaterThan(300);
  });
});

