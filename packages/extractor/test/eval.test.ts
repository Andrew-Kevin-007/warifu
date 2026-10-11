// The extractor eval as a release gate (docs/03 section 8): runs the golden corpus through the real pipeline against
// SIMULATED fallible models, asserts the hard gates, and checks the committed result file is fresh.
//   refresh:  EVAL_WRITE=1 pnpm exec vitest run packages/extractor/test/eval.test.ts
// The report is deterministic (seeded, no clock), so freshness is an exact comparison of canonical JSON.
import { jcs } from "@symbolon/schemas";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CORPUS, INJECTION_CASES } from "../eval/corpus";
import { runEval, type EvalReport } from "../eval/run-eval";

const RESULT_PATH = new URL("../eval/results/extractor-eval.json", import.meta.url);

describe("golden corpus", () => {
  it("has at least 40 documents including 10 adversarial injections, with unique ids", () => {
    expect(CORPUS.length).toBeGreaterThanOrEqual(40);
    expect(INJECTION_CASES.length).toBe(10);
    expect(new Set(CORPUS.map((c) => c.id)).size).toBe(CORPUS.length);
  });

  it("covers the required shapes: EU/US formats, currencies, credit notes, scans, non-English, missing fields, footer wallet, address changes, term shapes", () => {
    const tags = new Set(CORPUS.flatMap((c) => c.tags));
    for (const t of ["format", "eu", "currency", "doctype", "scan", "lang", "layout", "address-change", "terms", "injection", "ambiguous", "precision"]) expect(tags.has(t), t).toBe(true);
    const printed = new Set(CORPUS.map((c) => c.expected.printed));
    for (const p of ["1,000.00", "1.000,00", "1 000,50", "1,000", "6.000000"]) expect(printed.has(p), p).toBe(true);
    expect(CORPUS.some((c) => c.expected.docType === "CREDIT_NOTE")).toBe(true);
    expect(CORPUS.some((c) => c.expected.invoiceNumber === "")).toBe(true);
    expect(CORPUS.some((c) => c.expected.walletAddress === null)).toBe(true);
  });

  it("every expected value is printed in its document (the corpus does not contradict itself)", () => {
    for (const c of CORPUS) {
      expect(c.text.includes(c.expected.printed), `${c.id} printed`).toBe(true);
      if (c.expected.walletAddress !== null) expect(c.text.includes(c.expected.walletAddress), `${c.id} wallet`).toBe(true);
      if (c.expected.invoiceNumber !== "") expect(c.text.includes(c.expected.invoiceNumber), `${c.id} invoice no`).toBe(true);
      if (c.expected.terms !== null) expect(c.text.includes(c.expected.terms.text), `${c.id} terms`).toBe(true);
    }
  });
});

describe("extractor eval (SIMULATED models)", () => {
  let report: EvalReport;
  it("runs", async () => {
    report = await runEval();
    expect(report.runs).toBe(CORPUS.length * report.trials);
  }, 120_000);

  it("is labelled SIMULATED and does not claim real-model accuracy", () => {
    expect(report.label).toBe("SIMULATED");
    expect(report.realModelAccuracy).toBe("NOT MEASURED");
    expect(report.notice).toMatch(/SIMULATED/);
    expect(JSON.stringify(report)).not.toMatch(/\b(proven|guaranteed|audited|unhackable|risk-free)\b/i);
  });

  it("the simulated models really are fallible (the gates are not passed by construction)", () => {
    expect(report.rawSimulatedModels.wrongParsedBaseUnits).toBeGreaterThan(20);
    const f = report.rawSimulatedModels.faultsInjected;
    for (const id of ["SCALE_UP_1000", "GUESS_AMBIGUOUS", "HALLUCINATE_ADDRESS", "OMIT_ANOMALIES", "FOLLOW_INJECTION", "WRONG_NET_DAYS", "UNDECLARED_TOOL"]) {
      expect(f[id] ?? 0, id).toBeGreaterThan(0);
    }
    expect(report.pipeline.okRuns).toBeLessThan(report.runs); // some runs are rejected by the validators
  });

  it("hard gates (docs/03 section 8): every gate passes", () => {
    for (const g of report.gates) expect(g.pass, `${g.name}: ${g.value} (${g.threshold})`).toBe(true);
    expect(report.allGatesPass).toBe(true);
  });

  it("parsedBaseUnits is never confidently wrong although the simulated models were", () => {
    expect(report.rawSimulatedModels.wrongParsedBaseUnits).toBeGreaterThan(0);
    expect(report.pipeline.parsedBaseUnits.confidentlyWrong).toBe(0);
  });

  it("the committed result file is fresh (or EVAL_WRITE=1 refreshes it)", () => {
    if (process.env.EVAL_WRITE === "1") {
      writeFileSync(RESULT_PATH, `${JSON.stringify(JSON.parse(jcs(report)), null, 2)}\n`);
    }
    expect(existsSync(RESULT_PATH), "run with EVAL_WRITE=1 to create eval/results/extractor-eval.json").toBe(true);
    const committed = JSON.parse(readFileSync(RESULT_PATH, "utf8")) as unknown;
    expect(jcs(committed)).toBe(jcs(report));
  });
});
