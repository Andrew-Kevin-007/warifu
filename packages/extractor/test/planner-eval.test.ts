// The Treasury Planner eval as a release gate (docs/13 §4.8; WP-35): runs the SIMULATED scenario corpus through the
// real planner path, asserts the hard gates, and checks the committed results are fresh.
//   refresh:  PLANNER_EVAL_WRITE=1 pnpm exec vitest run packages/extractor/test/planner-eval.test.ts
// Deterministic (seeded, no clock), so freshness is an exact comparison of canonical JSON.
import { jcs } from "@symbolon/schemas";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { plannerReportMarkdown, runPlannerEval, type PlannerEvalReport } from "../eval/planner/run-planner-eval";
import { buildCorpus } from "../eval/planner/scenarios";

const JSON_PATH = new URL("../../../results/planner-eval.json", import.meta.url);
const MD_PATH = new URL("../../../results/planner-eval.md", import.meta.url);

describe("planner corpus", () => {
  const corpus = buildCorpus();
  it("has at least 120 scenarios with unique ids, including every trap class and edge family", () => {
    expect(corpus.length).toBeGreaterThanOrEqual(120);
    expect(new Set(corpus.map((s) => s.id)).size).toBe(corpus.length);
    const kinds = new Set(corpus.flatMap((s) => (s.trap === null ? [] : [s.trap.kind])));
    for (const k of ["STATED_SWEETER", "STATED_SMALLER_SIGNED", "STATED_NET_DAYS", "STATED_AMBIGUOUS", "TERMS_NOT_SIGNED", "DUPLICATE_SWEETER", "INJECTED_URGENCY"]) expect(kinds.has(k as never), k).toBe(true);
    const families = new Set(corpus.map((s) => s.family));
    for (const f of ["window-edge", "trap", "cap-conflict", "late", "liquidity", "coincident", "evidence", "generated"]) expect(families.has(f), f).toBe(true);
    expect(corpus.filter((s) => s.tags.includes("delta--1s")).length).toBeGreaterThan(0);
    expect(corpus.filter((s) => s.tags.includes("delta-1s")).length).toBeGreaterThan(0);
  });

  it("is reproducible from the seed and changes with it", () => {
    expect(jcs(buildCorpus(35).map((s) => s.id))).toBe(jcs(corpus.map((s) => s.id)));
    expect(buildCorpus(36).map((s) => s.tags.join("|")).join()).not.toBe(corpus.map((s) => s.tags.join("|")).join());
  });
});

describe("planner eval (SIMULATED models)", () => {
  let report: PlannerEvalReport;
  it("runs", async () => {
    report = await runPlannerEval();
    expect(report.runs).toBe(report.corpus.scenarios * report.trials);
  }, 120_000);

  it("is labelled SIMULATED everywhere and claims no real-model quality", () => {
    expect(report.label).toBe("SIMULATED");
    expect(report.realModelAccuracy).toBe("NOT MEASURED");
    for (const section of [report.corpus, report.modelBehaviours, report.outcomes, report.hardGates, report.netBenefit, report.regret, report.deviation, report.usage]) {
      expect(section.label).toBe("SIMULATED");
    }
    for (const section of [report.netBenefit.planner, report.netBenefit.oracle, report.netBenefit.payImmediately]) expect(section.label).toBe("SIMULATED");
    const text = JSON.stringify(report);
    expect(text).not.toMatch(/\b(proven|provably|guaranteed|audited|unhackable|unbreakable|risk-free)\b/i);
    expect(text).not.toMatch(/\b(realized|realised|saved|savings)\b/i);
    const md = plannerReportMarkdown(report);
    expect(md).not.toMatch(/\b(realized|realised|saved|savings)\b/i);
    // every table row and figure line in the markdown carries the label
    for (const line of md.split("\n").filter((x) => /^\|.*\d/.test(x) && !x.startsWith("|---"))) expect(line, line).toMatch(/SIMULATED|^\| (Planner pipeline|Evaluator default|PAY_|Exhaustive|[A-Z_]+ )/);
  });

  it("the simulated planners really are fallible (the gates are not passed by construction)", () => {
    expect(report.outcomes.source.FALLBACK ?? 0).toBeGreaterThan(0);
    expect(report.outcomes.source.PLANNER ?? 0).toBeGreaterThan(0);
    for (const code of ["PLAN_OUT_OF_ENVELOPE", "SCHEMA_INVALID", "RATIONALE_REJECTED", "DEVIATION_FLAG_MISMATCH", "DISALLOWED_TOOL", "NO_SUBMISSION", "PROVIDER"]) {
      expect(report.outcomes.rejections[code] ?? 0, code).toBeGreaterThan(0);
    }
    for (const f of ["SANITIZER_REMOVED_CONTENT", "UNFAITHFUL_NUMBER"]) expect(report.outcomes.rationaleFailures[f] ?? 0, f).toBeGreaterThan(0);
  });

  it("hard gates (docs/13 §4.8): every gate passes", () => {
    for (const g of report.gates) expect(g.pass, `${g.name}: ${g.value} (${g.threshold})`).toBe(true);
    expect(report.allGatesPass).toBe(true);
    expect(report.hardGates.trapMispayments).toBe(0);
    expect(report.hardGates.reserveFloorBreaches).toBe(0);
    expect(report.hardGates.planOutsideFeasibleSet).toBe(0);
    expect(report.hardGates.amountDueMismatches).toBe(0);
    expect(report.hardGates.faithfulnessFailures).toBe(0);
  });

  it("every trap is escalated or rejected and honest scenarios still pay", () => {
    expect(report.outcomes.verdicts.RELEASE ?? 0).toBeGreaterThan(0);
    expect(report.hardGates.trapHandled).toBe(report.hardGates.trapRuns);
    expect(report.corpus.traps).toBeGreaterThanOrEqual(20);
  });

  it("reports regret vs the oracle and the deviation record (soft metrics are reported, not gated)", () => {
    expect(BigInt(report.regret.vsOracleTotalBase)).toBeGreaterThanOrEqual(0n);
    expect(report.deviation.deviations).toBe(report.deviation.helped + report.deviation.hurt + report.deviation.neutral);
    expect(typeof report.netBenefit.plannerBeatsBothBaselines).toBe("boolean");
  });

  it("the oracle dominates every strategy (it searches the same feasible set with hindsight)", () => {
    const o = BigInt(report.netBenefit.oracle.totalNetBenefitBase);
    for (const k of ["planner", "evaluatorDefault", "payImmediately", "payOnDueMinusBuffer"] as const) {
      expect(BigInt(report.netBenefit[k].totalNetBenefitBase), k).toBeLessThanOrEqual(o);
    }
  });

  it("the committed result files are fresh (or PLANNER_EVAL_WRITE=1 refreshes them)", () => {
    const json = `${JSON.stringify(JSON.parse(jcs(report)), null, 2)}\n`;
    const md = plannerReportMarkdown(report);
    if (process.env.PLANNER_EVAL_WRITE === "1") {
      writeFileSync(JSON_PATH, json);
      writeFileSync(MD_PATH, md);
    }
    expect(existsSync(JSON_PATH), "run with PLANNER_EVAL_WRITE=1 to create results/planner-eval.json").toBe(true);
    expect(jcs(JSON.parse(readFileSync(JSON_PATH, "utf8")) as unknown)).toBe(jcs(report));
    expect(readFileSync(MD_PATH, "utf8")).toBe(md);
  });
});
