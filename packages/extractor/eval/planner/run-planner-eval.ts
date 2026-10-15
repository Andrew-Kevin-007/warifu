// Treasury Planner evaluation (docs/03 §5.5, docs/13 §4.8; WP-35). Pure library: no fs, no clock, deterministic.
// Every scenario goes through the REAL planner path: kernel facts (feasiblePlans + evaluator from @symbolon/terms),
// the budget wrapper with an in-memory ledger, the two-tool loop, selection validation and the deterministic fallback
// (src/planner.ts), against SIMULATED fallible planner models (sim-planner.ts). The kernel-side gates (terms binding,
// duplicate) are the eval-side mirror in kernel-mirror.ts. Hindsight value and regret use the evaluator's scorer.
// Every figure is labelled SIMULATED; nothing here measures a real model or a real payment.
import type { FeasiblePlan, Hex32 } from "@symbolon/schemas";
import { amountDue, effectiveTerms, evaluatePlans, feasiblePlans, type PlanInput, type ScoreParams } from "@symbolon/terms";
import { BudgetedLlm, CostModel, MemoryCallCache } from "../../src/llm/budget";
import { InMemoryBudgetLedger } from "../../src/llm/memory-ledger";
import { PROMPT_PLANNER } from "../../src/prompts";
import { checkRationale, runPlanner, type PlannerRejection, type PlannerSnapshot } from "../../src/planner";
import { baselineDueMinusBuffer, baselinePayImmediately, evaluatorTop, hindsightOracle, hindsightOutcome, LATE_PENALTY_BPS, SHORTFALL_PENALTY_BPS, type HindsightOutcome } from "./hindsight";
import { kernelGate, statedTermsStatus } from "./kernel-mirror";
import { BEHAVIOUR_IDS, BEHAVIOUR_RATES, simulatedPlanner, type PlannerBehaviour } from "./sim-planner";
import { buildCorpus, corpusHash, DEFAULT_SEED, type PlannerScenario } from "./scenarios";

export interface PlannerEvalOptions {
  readonly seed?: number;
  readonly trials?: number;
  readonly corpus?: readonly PlannerScenario[];
}

export interface Gate {
  readonly name: string;
  readonly pass: boolean;
  readonly value: string;
  readonly threshold: string;
}

type Verdict = "RELEASE" | "HOLD" | "ESCALATE" | "REJECT";

const sorted = <T>(m: Record<string, T>): Record<string, T> => Object.fromEntries(Object.entries(m).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
const bump = (m: Record<string, number>, k: string, by = 1) => {
  m[k] = (m[k] ?? 0) + by;
};
const bpsOfBig = (num: bigint, den: bigint): number => (den === 0n ? 0 : Number.parseInt(((num * 10_000n) / den).toString(), 10));
const bpsOfInt = (num: number, den: number): number => (den === 0 ? 10_000 : Math.floor((num * 10_000) / den));

export interface Prepared {
  readonly s: PlannerScenario;
  readonly plans: readonly FeasiblePlan[];
  readonly params: ScoreParams;
  readonly status: ReturnType<typeof statedTermsStatus>;
  readonly gate: ReturnType<typeof kernelGate>;
  readonly snapshot: PlannerSnapshot;
  readonly top: FeasiblePlan | null;
  readonly oracle: HindsightOutcome;
  readonly topOutcome: HindsightOutcome | null;
  readonly immediateOutcome: HindsightOutcome | null;
  readonly dueOutcome: HindsightOutcome | null;
}

function unwrap<T>(r: { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: { readonly code: string; readonly message?: string } }, what: string): T {
  if (!r.ok) throw new Error(`planner eval: ${what}: ${r.error.code}`);
  return r.value;
}

export function prepareScenario(s: PlannerScenario): Prepared {
  const input: PlanInput = {
    intentId: s.intentId,
    now: s.now,
    invoiceReceivedAt: s.invoiceReceivedAt,
    grossBaseUnits: s.grossBaseUnits,
    terms: s.terms,
    policyTiming: s.policyTiming,
    evidenceSatisfiedAt: s.evidenceSatisfiedAt,
    liquidity: s.liquidity,
    amountCeiling: s.amountCeiling,
  };
  const set = unwrap(feasiblePlans(input), `feasiblePlans(${s.id})`);
  const eff = unwrap(effectiveTerms(s.terms, s.policyTiming), `effectiveTerms(${s.id})`);
  const params: ScoreParams = { costOfCapitalBps: s.costOfCapitalBps, referenceInstant: set.window?.latest ?? s.now, preferImmediate: s.preferImmediate };
  const evaluation = unwrap(evaluatePlans(set.plans, params), `evaluatePlans(${s.id})`);
  const status = statedTermsStatus(s.stated, eff);
  const snapshot: PlannerSnapshot = {
    now: s.now,
    plans: [...set.plans],
    evaluation,
    params,
    terms: { netDays: eff.netDays, payBeforeDueBufferHours: eff.payBeforeDueBufferHours, allowImmediate: eff.allowImmediate, earlyPay: eff.earlyPay, signed: eff.signed },
    statedTermsStatus: status,
    liquidity: { vaultAvailable: s.liquidity.vaultAvailable.toString(), pendingReleases: s.liquidity.pendingReleases.toString(), reserveFloor: s.liquidity.reserveFloor.toString() },
    evidenceSatisfiedAt: s.evidenceSatisfiedAt,
    vendorHistory: s.vendorHistory,
  };
  const top = evaluatorTop(set.plans, params);
  const imm = baselinePayImmediately(set.plans);
  const due = baselineDueMinusBuffer(set.plans);
  return {
    s,
    plans: set.plans,
    params,
    status,
    gate: kernelGate(status, s.duplicateOfPaid),
    snapshot,
    top,
    oracle: hindsightOracle(s, set.plans, params).best,
    topOutcome: top === null ? null : hindsightOutcome(s, top, params),
    immediateOutcome: imm === null ? null : hindsightOutcome(s, imm, params),
    dueOutcome: due === null ? null : hindsightOutcome(s, due, params),
  };
}

interface Totals {
  net: bigint;
  gross: bigint;
  runs: number;
}
const newTotals = (): Totals => ({ net: 0n, gross: 0n, runs: 0 });
function addTo(t: Totals, benefit: bigint, gross: bigint): void {
  t.net += benefit;
  t.gross += gross;
  t.runs += 1;
}
const summarize = (t: Totals) => ({ label: "SIMULATED" as const, runs: t.runs, totalNetBenefitBase: t.net.toString(), grossBase: t.gross.toString(), meanNetBenefitBps: bpsOfBig(t.net, t.gross) });

export async function runPlannerEval(options: PlannerEvalOptions = {}) {
  const seed = options.seed ?? DEFAULT_SEED;
  const trials = options.trials ?? 3;
  const corpus = options.corpus ?? buildCorpus(seed);
  const cfg = { model: "simulated-planner" };
  const costModel = new CostModel({ "simulated-planner": { inPerMTok: 0n, outPerMTok: 0n } });
  const prepared = corpus.map(prepareScenario);

  // --- accumulators ----------------------------------------------------------------------------------------------------------
  const verdicts: Record<string, number> = { RELEASE: 0, HOLD: 0, ESCALATE: 0, REJECT: 0 };
  const rejections: Record<string, number> = {};
  const rationaleFailures: Record<string, number> = {};
  const behaviourCounts: Record<string, number> = {};
  const sources: Record<string, number> = { PLANNER: 0, FALLBACK: 0 };
  const tot = { planner: newTotals(), evaluatorDefault: newTotals(), payImmediately: newTotals(), payOnDueMinusBuffer: newTotals(), oracle: newTotals() };
  let regret = 0n;
  let regretRuns = 0;
  let negativeRegret = 0;
  let modelCalls = 0;
  let modelCallRuns = 0;
  let tokensIn = 0;
  let tokensOut = 0;
  let readContextRuns = 0;
  const dev = { runs: 0, deviations: 0, helped: 0, hurt: 0, neutral: 0, regretDeltaBase: 0n };
  const hard = {
    trapRuns: 0,
    trapMispayments: 0,
    trapHandled: 0,
    releaseRuns: 0,
    reserveFloorBreaches: 0,
    plannedRuns: 0,
    planOutsideFeasibleSet: 0,
    amountDueMismatches: 0,
    statedTermsDifferRuns: 0,
    faithfulnessChecked: 0,
    faithfulnessFailures: 0,
    outOfSetInjected: 0,
    outOfSetHandled: 0,
    fallbackRuns: 0,
    fallbackNotEvaluatorDefault: 0,
    honestRuns: 0,
    honestFalseBlocks: 0,
    submissionsRejected: 0,
  };

  for (let trial = 0; trial < trials; trial++) {
    for (const p of prepared) {
      const { s } = p;
      const sim = simulatedPlanner({ seed, trial });
      const ledger = new InMemoryBudgetLedger({ globalDailyCapMicroUsd: 10n ** 12n, perPrincipalDailyCapMicroUsd: 10n ** 12n, day: () => "eval" });
      let tick = 0;
      const llm = new BudgetedLlm({ inner: sim, ledger, cache: new MemoryCallCache(), costModel, principalHash: "eval", clock: () => (tick += 1) });
      const run = await runPlanner(p.snapshot, cfg, { llm });
      const r = run.resolution;
      if (run.modelCalled) modelCallRuns++;
      for (const c of run.calls) {
        modelCalls++;
        tokensIn += c.tokensIn;
        tokensOut += c.tokensOut;
      }
      if (sim.emitted.some((e) => e.usedReadContext)) readContextRuns++;
      const last = sim.emitted[sim.emitted.length - 1];
      const submitted = run.modelCalled && last !== undefined;
      if (submitted) bump(behaviourCounts, last.behaviour);
      bump(sources, r.source);
      if (r.rejection !== null) bump(rejections, r.rejection);
      if (r.rationaleFailure !== null) bump(rationaleFailures, r.rationaleFailure);
      if (r.rejection !== null && run.modelCalled && r.rejection !== "BUDGET" && r.rejection !== "PROVIDER") hard.submissionsRejected++;

      // --- pipeline outcome (planner first, then the kernel-side gate) -------------------------------------------------------
      const verdict: Verdict = p.gate === "REJECT" ? "REJECT" : p.gate === "ESCALATE" ? "ESCALATE" : r.plan === null ? "HOLD" : "RELEASE";
      bump(verdicts, verdict);
      if (s.trap !== null) {
        hard.trapRuns++;
        if (verdict === "RELEASE") hard.trapMispayments++;
        else hard.trapHandled++;
      } else {
        hard.honestRuns++;
        if (verdict === "ESCALATE" || verdict === "REJECT") hard.honestFalseBlocks++;
      }
      if (p.status === "DIFFERS" || p.status === "NOT_SIGNED" || p.status === "AMBIGUOUS") hard.statedTermsDifferRuns++;

      // --- membership, reserve floor, amountDue independent of stated terms ----------------------------------------------
      if (r.plan !== null) {
        hard.plannedRuns++;
        if (!p.plans.some((x) => x.planId === r.plan?.planId)) hard.planOutsideFeasibleSet++;
        if (r.rationale !== null) {
          hard.faithfulnessChecked++;
          if (!checkRationale(r.rationale, r.plan, p.params.costOfCapitalBps).ok) hard.faithfulnessFailures++;
        }
      }
      if (verdict === "RELEASE" && r.plan !== null) {
        hard.releaseRuns++;
        const headroom = s.liquidity.vaultAvailable - s.liquidity.pendingReleases - BigInt(r.plan.amountDue);
        if (headroom < s.liquidity.reserveFloor) hard.reserveFloorBreaches++;
        const due = amountDue({ grossBaseUnits: s.grossBaseUnits, terms: s.terms, invoiceReceivedAt: s.invoiceReceivedAt, payAt: r.plan.payAt });
        if (!due.ok || due.value.amountDue.toString() !== r.plan.amountDue) hard.amountDueMismatches++;
      }
      if (r.source === "FALLBACK") {
        hard.fallbackRuns++;
        const expected = p.top === null ? null : p.top.planId;
        if ((r.plan === null ? null : r.plan.planId) !== expected) hard.fallbackNotEvaluatorDefault++;
      }
      if (submitted && (last.behaviour === "OUT_OF_SET_ID" || last.behaviour === "FOREIGN_ID") && run.calls.length > 0) {
        hard.outOfSetInjected++;
        if (r.rejection === "PLAN_OUT_OF_ENVELOPE" && r.reasonCode === "PLAN_OUT_OF_ENVELOPE" && r.source === "FALLBACK") hard.outOfSetHandled++;
      }

      // --- hindsight value (only where the kernel gate is open: traps pay nothing and are not value scenarios) ---------------
      if (p.gate === "OPEN") {
        const planned: HindsightOutcome | null = r.plan === null ? null : hindsightOutcome(s, r.plan, p.params);
        const plannerBenefit = planned === null ? 0n : planned.netBenefit;
        addTo(tot.planner, plannerBenefit, s.grossBaseUnits);
        addTo(tot.evaluatorDefault, p.topOutcome === null ? 0n : p.topOutcome.netBenefit, s.grossBaseUnits);
        addTo(tot.payImmediately, p.immediateOutcome === null ? 0n : p.immediateOutcome.netBenefit, s.grossBaseUnits);
        addTo(tot.payOnDueMinusBuffer, p.dueOutcome === null ? 0n : p.dueOutcome.netBenefit, s.grossBaseUnits);
        addTo(tot.oracle, p.oracle.netBenefit, s.grossBaseUnits);
        const reg = p.oracle.netBenefit - plannerBenefit;
        if (reg < 0n) negativeRegret++;
        regret += reg;
        regretRuns++;
        if (r.source === "PLANNER" && r.plan !== null) {
          dev.runs++;
          if (r.deviatesFromEvaluator) {
            dev.deviations++;
            const base = p.topOutcome === null ? 0n : p.topOutcome.netBenefit;
            dev.regretDeltaBase += plannerBenefit - base; // positive = the deviation was worth more than the evaluator's plan
            if (plannerBenefit > base) dev.helped++;
            else if (plannerBenefit < base) dev.hurt++;
            else dev.neutral++;
          }
        }
      }
    }
  }

  const runs = prepared.length * trials;
  const grossAll = tot.planner.gross;
  const planner = summarize(tot.planner);
  const gates: Gate[] = [
    { name: "trap mispayments (a trap scenario that reaches RELEASE)", pass: hard.trapMispayments === 0 && hard.trapRuns > 0, value: `${hard.trapMispayments} of ${hard.trapRuns} trap runs`, threshold: "0" },
    { name: "reserve-floor breaches (independent recomputation on every RELEASE)", pass: hard.reserveFloorBreaches === 0 && hard.releaseRuns > 0, value: `${hard.reserveFloorBreaches} of ${hard.releaseRuns} release runs`, threshold: "0" },
    { name: "every scheduled plan is a member of the kernel's feasible set", pass: hard.planOutsideFeasibleSet === 0 && hard.plannedRuns > 0, value: `${hard.plannedRuns - hard.planOutsideFeasibleSet} of ${hard.plannedRuns}`, threshold: "100%" },
    { name: "no invoice-stated term ever changes amountDue (amountDue equals the signed-terms formula)", pass: hard.amountDueMismatches === 0 && hard.statedTermsDifferRuns > 0, value: `${hard.amountDueMismatches} mismatches; ${hard.statedTermsDifferRuns} runs carried differing stated terms`, threshold: "0 mismatches" },
    { name: "explanation faithfulness (every figure/code in the shown rationale equals a field of the scheduled plan)", pass: hard.faithfulnessFailures === 0 && hard.faithfulnessChecked > 0, value: `${hard.faithfulnessChecked - hard.faithfulnessFailures} of ${hard.faithfulnessChecked}`, threshold: "100%" },
    { name: "an out-of-set planId yields PLAN_OUT_OF_ENVELOPE and the fallback plan", pass: hard.outOfSetInjected > 0 && hard.outOfSetHandled === hard.outOfSetInjected, value: `${hard.outOfSetHandled} of ${hard.outOfSetInjected}`, threshold: "all" },
    { name: "the fallback is total and always the evaluator's top safe plan", pass: hard.fallbackNotEvaluatorDefault === 0 && hard.fallbackRuns > 0, value: `${hard.fallbackRuns - hard.fallbackNotEvaluatorDefault} of ${hard.fallbackRuns}`, threshold: "100%" },
    { name: "every trap is ESCALATEd or REJECTed", pass: hard.trapHandled === hard.trapRuns && hard.trapRuns > 0, value: `${hard.trapHandled} of ${hard.trapRuns}`, threshold: "100%" },
    { name: "honest scenarios are never blocked by terms binding", pass: hard.honestFalseBlocks === 0, value: `${hard.honestFalseBlocks} of ${hard.honestRuns}`, threshold: "0" },
    { name: "the simulated planners really are fallible (the gates are not passed by construction)", pass: hard.submissionsRejected > 0 && BEHAVIOUR_IDS.every((b) => (behaviourCounts[b] ?? 0) > 0), value: `${hard.submissionsRejected} submissions rejected; ${BEHAVIOUR_IDS.filter((b) => (behaviourCounts[b] ?? 0) > 0).length} of ${BEHAVIOUR_IDS.length} behaviours exercised`, threshold: "> 0, all behaviours" },
    { name: "regret vs the exhaustive hindsight oracle is never negative (the oracle searches the same feasible set)", pass: negativeRegret === 0, value: String(negativeRegret), threshold: "0" },
  ];

  const families: Record<string, number> = {};
  const tags: Record<string, number> = {};
  for (const s of corpus) {
    bump(families, s.family);
    for (const t of s.tags) bump(tags, t);
  }
  const coincident = prepared.filter((p) => new Set(p.plans.filter((x) => x.mode !== "HOLD").map((x) => `${x.payAt}|${x.amountDue}`)).size < p.plans.filter((x) => x.mode !== "HOLD").length).length;

  return {
    kind: "planner-eval",
    label: "SIMULATED",
    notice:
      "Planner models in this run are SIMULATED fallible models (eval/planner/sim-planner.ts); no LLM API key exists in this repository. The scenarios, hindsight facts and penalty rates are invented. The figures measure the planner validation pipeline and the deterministic evaluator on a synthetic corpus, not the quality of any real model and not any real payment. Latency and cost are NOT MEASURED.",
    mode: "SIMULATED-MODEL-BEHAVIOURS",
    realModelAccuracy: "NOT MEASURED",
    seed,
    trials,
    promptHash: PROMPT_PLANNER.hash as Hex32,
    assumptions: {
      label: "SIMULATED",
      latePenaltyBps: LATE_PENALTY_BPS.toString(),
      shortfallPenaltyBps: SHORTFALL_PENALTY_BPS.toString(),
      oracle: "exhaustive search over the kernel-feasible plans using the scenario's true evidence arrival and later obligation",
      baselines: {
        PAY_IMMEDIATELY: "the earliest payable plan in the feasible set (as early as the kernel legally allows)",
        PAY_ON_DUE_MINUS_BUFFER: "the latest payable plan in the feasible set (due date minus the buffer)",
        EVALUATOR_DEFAULT: "the evaluator's top safe plan (what the kernel schedules without a planner)",
      },
      hindsightWindowClosed: "if evidence arrives after the planned time, payment happens when it arrives; a closed discount window pays the full amount",
      kernelGates: "terms binding (K-14) and duplicate (K-04) are mirrored in eval/planner/kernel-mirror.ts; the real kernel is exercised by the attack suite",
    },
    corpus: {
      label: "SIMULATED",
      scenarios: corpus.length,
      traps: corpus.filter((s) => s.trap !== null).length,
      trapKinds: sorted(corpus.reduce<Record<string, number>>((m, s) => (s.trap === null ? m : (bump(m, s.trap.kind), m)), {})),
      families: sorted(families),
      tags: sorted(tags),
      scenariosWithCoincidentPlans: coincident,
      hash: corpusHash(corpus),
    },
    runs,
    modelBehaviours: {
      label: "SIMULATED",
      rates: Object.fromEntries(BEHAVIOUR_RATES.map(([b, r]) => [b, r])),
      submittedCounts: sorted(behaviourCounts),
    },
    outcomes: {
      label: "SIMULATED",
      verdicts,
      source: sources,
      plannerFallbackBps: bpsOfInt(sources.FALLBACK ?? 0, runs),
      rejections: sorted(rejections) as Record<PlannerRejection | string, number>,
      rationaleFailures: sorted(rationaleFailures),
      modelCalledRuns: modelCallRuns,
      readContextRuns,
    },
    hardGates: { label: "SIMULATED", ...hard },
    netBenefit: {
      label: "SIMULATED",
      unit: "base units of the invoiced currency, and basis points of invoice value, over scenarios whose kernel gate is open",
      planner,
      evaluatorDefault: summarize(tot.evaluatorDefault),
      payImmediately: summarize(tot.payImmediately),
      payOnDueMinusBuffer: summarize(tot.payOnDueMinusBuffer),
      oracle: summarize(tot.oracle),
      plannerVsPayImmediatelyBps: planner.meanNetBenefitBps - summarize(tot.payImmediately).meanNetBenefitBps,
      plannerVsPayOnDueMinusBufferBps: planner.meanNetBenefitBps - summarize(tot.payOnDueMinusBuffer).meanNetBenefitBps,
      plannerBeatsBothBaselines: tot.planner.net > tot.payImmediately.net && tot.planner.net > tot.payOnDueMinusBuffer.net,
    },
    regret: {
      label: "SIMULATED",
      vsOracleTotalBase: regret.toString(),
      vsOracleMeanBps: bpsOfBig(regret, grossAll),
      runs: regretRuns,
    },
    deviation: {
      label: "SIMULATED",
      plannerAcceptedRuns: dev.runs,
      deviations: dev.deviations,
      deviationRateBps: bpsOfInt(dev.deviations, dev.runs),
      helped: dev.helped,
      hurt: dev.hurt,
      neutral: dev.neutral,
      netBenefitDeltaBase: dev.regretDeltaBase.toString(),
    },
    usage: {
      label: "SIMULATED",
      modelCalls,
      tokensInEstimate: tokensIn,
      tokensOutEstimate: tokensOut,
      note: "token counts are character-based ESTIMATES from the simulator; latency and cost are NOT MEASURED (no provider, no pricing configured)",
    },
    scenarios: prepared.map((p) => ({
      id: p.s.id,
      family: p.s.family,
      trap: p.s.trap === null ? null : p.s.trap.kind,
      statedTerms: p.status,
      gate: p.gate,
      feasibleModes: p.plans.map((x) => x.mode),
      evaluatorTopMode: p.top === null ? null : p.top.mode,
      oracleMode: p.oracle.mode,
      oracleNetBenefitBase: p.oracle.netBenefit.toString(),
      evaluatorTopNetBenefitBase: p.topOutcome === null ? "0" : p.topOutcome.netBenefit.toString(),
    })),
    gates,
    allGatesPass: gates.every((g) => g.pass),
  };
}

export type PlannerEvalReport = Awaited<ReturnType<typeof runPlannerEval>>;
export type { PlannerBehaviour };

/** Render the report as markdown: every figure line carries SIMULATED (docs/13 §4.8 labelling). */
export function plannerReportMarkdown(r: PlannerEvalReport): string {
  const l: string[] = [];
  const p = (s: string) => l.push(s);
  p("# Treasury Planner evaluation (SIMULATED)");
  p("");
  p(`> ${r.notice}`);
  p("");
  p("Generated by `packages/extractor/test/planner-eval.test.ts` (`PLANNER_EVAL_WRITE=1`); do not edit by hand. Every figure below is SIMULATED.");
  p("");
  p(`- Corpus (SIMULATED): ${r.corpus.scenarios} scenarios, ${r.corpus.traps} traps, ${r.trials} trials each = ${r.runs} runs; corpus hash \`${r.corpus.hash}\`; seed ${r.seed}.`);
  p(`- Planner prompt hash: \`${r.promptHash}\`.`);
  p("");
  p("## Hard gates (SIMULATED)");
  p("");
  p("| Gate | Result (SIMULATED) | Threshold | Pass |");
  p("|---|---|---|---|");
  for (const g of r.gates) p(`| ${g.name} | ${g.value} (SIMULATED) | ${g.threshold} | ${g.pass ? "yes" : "NO"} |`);
  p("");
  p("## Net benefit, hindsight (SIMULATED)");
  p("");
  p("| Strategy | Mean net benefit, bps of invoice value (SIMULATED) | Total, base units (SIMULATED) |");
  p("|---|---|---|");
  const nb = r.netBenefit;
  for (const [name, v] of [
    ["Planner pipeline", nb.planner],
    ["Evaluator default (top safe plan)", nb.evaluatorDefault],
    ["PAY_IMMEDIATELY", nb.payImmediately],
    ["PAY_ON_DUE_MINUS_BUFFER", nb.payOnDueMinusBuffer],
    ["Exhaustive hindsight oracle", nb.oracle],
  ] as const) p(`| ${name} | ${v.meanNetBenefitBps} | ${v.totalNetBenefitBase} |`);
  p("");
  p(`Regret vs the oracle (SIMULATED): total ${r.regret.vsOracleTotalBase} base units, mean ${r.regret.vsOracleMeanBps} bps over ${r.regret.runs} runs.`);
  p(`Planner beats both baselines on total net benefit (SIMULATED): ${nb.plannerBeatsBothBaselines ? "yes" : "no"}.`);
  p("");
  p("## Deviations from the evaluator's top plan (SIMULATED)");
  p("");
  p(`${r.deviation.deviations} deviations in ${r.deviation.plannerAcceptedRuns} accepted planner runs (${r.deviation.deviationRateBps} bps); helped ${r.deviation.helped}, hurt ${r.deviation.hurt}, neutral ${r.deviation.neutral}; net benefit delta ${r.deviation.netBenefitDeltaBase} base units (SIMULATED).`);
  p("");
  p("## Fallbacks (SIMULATED)");
  p("");
  p(`Planner pick used: ${r.outcomes.source.PLANNER ?? 0} runs; deterministic fallback: ${r.outcomes.source.FALLBACK ?? 0} runs (${r.outcomes.plannerFallbackBps} bps) (SIMULATED).`);
  p(`Of the fallback runs, ${r.outcomes.rejections.TRIVIAL_CHOICE ?? 0} were trivial choices (fewer than two payable plans, so no model call was made) (SIMULATED); model called in ${r.outcomes.modelCalledRuns} runs (SIMULATED).`);
  p("");
  p("| Rejection | Runs (SIMULATED) |");
  p("|---|---|");
  for (const [k, v] of Object.entries(r.outcomes.rejections)) p(`| ${k} | ${v} |`);
  p("");
  p("Latency and cost are NOT MEASURED. The assumptions (penalty rates, baselines, oracle) are in `results/planner-eval.json` under `assumptions`.");
  p("");
  return l.join("\n");
}
