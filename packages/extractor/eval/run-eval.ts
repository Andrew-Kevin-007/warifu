// Eval harness for the extractor pipeline (docs/03 section 8). Pure library: no fs, no clock, deterministic.
// Runs every golden case `trials` times through the REAL pipeline (prepare, prompts, budget wrapper with an
// in-memory ledger, two-tool loop, validation, deterministic cross-checks, signals, consensus) against SIMULATED
// fallible models (sim-model.ts). Every number is labelled SIMULATED; real-model accuracy is NOT MEASURED.
import { inspectUntrusted, jcs, normalizeUntrusted, sha256Utf8 } from "@symbolon/schemas";
import { extractInvoice, type ExtractionResult, type ExtractorConfig } from "../src/extract";
import { BudgetedLlm, CostModel, MemoryCallCache } from "../src/llm/budget";
import { InMemoryBudgetLedger } from "../src/llm/memory-ledger";
import { scanInjection } from "../src/parse/injection";
import { PROMPT_A, PROMPT_B } from "../src/prompts";
import { CORPUS, type GoldenCase } from "./corpus";
import { simulatedModel, type Emitted, type FaultId } from "./sim-model";

export interface EvalOptions {
  readonly seed?: number;
  readonly trials?: number;
  readonly cases?: readonly GoldenCase[];
}

const bps = (num: number, den: number): number => (den === 0 ? 10000 : Math.floor((num * 10000) / den));
const bump = (m: Record<string, number>, k: string) => {
  m[k] = (m[k] ?? 0) + 1;
};
const sorted = <T>(m: Record<string, T>): Record<string, T> => Object.fromEntries(Object.entries(m).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));

export interface Gate {
  readonly name: string;
  readonly pass: boolean;
  readonly value: string;
  readonly threshold: string;
}

export async function runEval(options: EvalOptions = {}) {
  const seed = options.seed ?? 1;
  const trials = options.trials ?? 5;
  const cases = options.cases ?? CORPUS;
  const byId = new Map(cases.map((c) => [c.id, c]));
  const cfg: ExtractorConfig = { modelA: "simulated-model-a", modelB: "simulated-model-b", decimals: 6 };
  const costModel = new CostModel({ "simulated-model-a": { inPerMTok: 0n, outPerMTok: 0n }, "simulated-model-b": { inPerMTok: 0n, outPerMTok: 0n } });

  // --- run the pipeline -------------------------------------------------------------------------------------------------
  const outcomes: Array<{ c: GoldenCase; trial: number; r: ExtractionResult }> = [];
  const allEmitted: Emitted[] = [];
  let calls = 0;
  let tokensIn = 0;
  let tokensOut = 0;
  for (let trial = 0; trial < trials; trial++) {
    for (const c of cases) {
      const sim = simulatedModel({ seed, trial, cases });
      const ledger = new InMemoryBudgetLedger({ globalDailyCapMicroUsd: 10n ** 12n, perPrincipalDailyCapMicroUsd: 10n ** 12n, day: () => "eval" });
      let tick = 0;
      const llm = new BudgetedLlm({ inner: sim, ledger, cache: new MemoryCallCache(), costModel, principalHash: "eval", clock: () => (tick += 1) });
      const r = await extractInvoice(c.text, cfg, { llm });
      outcomes.push({ c, trial, r });
      allEmitted.push(...sim.emitted);
      for (const k of r.calls) {
        calls++;
        tokensIn += k.tokensIn;
        tokensOut += k.tokensOut;
      }
    }
  }

  // --- raw (simulated model) behaviour, before the pipeline -------------------------------------------------------
  const faultCounts: Record<string, number> = {};
  let rawWrongParsed = 0;
  for (const e of allEmitted) {
    for (const f of e.faults) bump(faultCounts, f);
    const expected = byId.get(e.caseId)?.expected.parsedBaseUnits ?? null;
    const p = e.wire.amount.parsedBaseUnits as string | null;
    if (p !== null && p !== expected) rawWrongParsed++;
  }

  // --- pipeline results --------------------------------------------------------------------------------------------------
  let okRuns = 0;
  const failureCodes: Record<string, number> = {};
  const dispositions: Record<string, number> = { ESCALATE: 0, HOLD: 0 };
  let finalWrongParsed = 0;
  let finalParsedChecked = 0;
  let finalParsedNull = 0;
  const acc = { wallet: [0, 0], printed: [0, 0], invoiceNumber: [0, 0], currency: [0, 0], docType: [0, 0] } as Record<string, [number, number]>;
  const consensusCounts: Record<string, number> = { AGREE: 0, DISAGREE: 0, SINGLE: 0 };
  const terms = { expected: 0, exact: 0, mismatchFlaggedAmbiguous: 0, mismatchUnflagged: 0, inventedUnflagged: 0, inventedFlagged: 0 };
  const inj = { runs: 0, flagged: 0, unflagged: 0, followedByModel: 0, followedAndFlagged: 0, failedWithSignals: 0 };
  let nonInjectionOk = 0;

  for (const { c, r } of outcomes) {
    const e = c.expected;
    if (!r.ok) {
      bump(failureCodes, r.failure.code);
      bump(dispositions, r.failure.disposition);
      if (c.injection) {
        inj.runs++;
        const flagged = (r.failure.signals?.anomalies ?? []).some((a) => a.code === "INSTRUCTION_IN_DOC" || a.code === "ADDRESS_CHANGE");
        if (flagged && r.failure.disposition === "ESCALATE") {
          inj.flagged++;
          inj.failedWithSignals++;
        } else inj.unflagged++;
      }
      continue;
    }
    okRuns++;
    bump(consensusCounts, r.value.consensus.status);
    for (const x of r.value.b === null ? [r.value.a] : [r.value.a, r.value.b]) {
      const p = x.amount.parsedBaseUnits;
      finalParsedChecked++;
      if (p === null) finalParsedNull++;
      else if (p !== e.parsedBaseUnits) finalWrongParsed++;
    }
    if (c.injection) {
      inj.runs++;
      const codesA = r.value.a.anomalies.map((a) => a.code);
      const codesB = (r.value.b?.anomalies ?? []).map((a) => a.code);
      const flag = (codes: string[]) => codes.includes("INSTRUCTION_IN_DOC") || codes.includes("ADDRESS_CHANGE");
      const flagged = flag(codesA) && flag(codesB);
      if (flagged) inj.flagged++;
      else inj.unflagged++;
      if (r.value.a.payee.walletAddress !== e.walletAddress) {
        inj.followedByModel++;
        if (flagged) inj.followedAndFlagged++;
      }
    } else {
      nonInjectionOk++;
      const a = r.value.a;
      const tally = (k: string, ok: boolean) => {
        const t = acc[k];
        if (t) {
          t[1]++;
          if (ok) t[0]++;
        }
      };
      tally("wallet", a.payee.walletAddress === e.walletAddress);
      tally("printed", inspectUntrusted(a.amount.printed) === e.printed);
      tally("invoiceNumber", inspectUntrusted(a.invoiceNumber) === e.invoiceNumber);
      tally("currency", inspectUntrusted(a.amount.currencyPrinted) === e.currencyPrinted);
      tally("docType", a.docType === e.docType);
    }
    // stated terms (all cases)
    const st = r.value.a.statedTerms;
    if (e.terms !== null) {
      terms.expected++;
      const exact = st.netDays === e.terms.netDays && jcs(st.earlyPay) === jcs(e.terms.early);
      if (exact) terms.exact++;
      else if (st.ambiguous) terms.mismatchFlaggedAmbiguous++;
      else terms.mismatchUnflagged++;
    } else if (st.netDays !== null || st.earlyPay !== null) {
      if (st.ambiguous) terms.inventedFlagged++;
      else terms.inventedUnflagged++;
    }
  }

  // --- scanner on its own (deterministic, no model involved) ---------------------------------------------------------------
  const scanner = { injectionDocs: 0, flagged: 0, missed: [] as string[], honestDocs: 0, falseInstruction: [] as string[], falseAddressChange: [] as string[] };
  for (const c of cases) {
    // the pipeline scans the normalized text (hidden characters removed), so the standalone scanner check does too
    const codes = new Set(scanInjection(normalizeUntrusted(c.text).normalized).map((x) => x.code));
    if (c.injection) {
      scanner.injectionDocs++;
      if (codes.has("INSTRUCTION_IN_DOC") || codes.has("ADDRESS_CHANGE")) scanner.flagged++;
      else scanner.missed.push(c.id);
    } else {
      scanner.honestDocs++;
      if (codes.has("INSTRUCTION_IN_DOC")) scanner.falseInstruction.push(c.id);
      if (codes.has("ADDRESS_CHANGE") && !c.expected.claimsAddressChange) scanner.falseAddressChange.push(c.id);
    }
  }

  const runs = outcomes.length;
  const termsRecallBps = bps(terms.exact, terms.expected);
  const gates: Gate[] = [
    { name: "parsedBaseUnits never confidently wrong (pipeline output)", pass: finalWrongParsed === 0, value: String(finalWrongParsed), threshold: "0" },
    { name: "payee.walletAddress accuracy (non-injection, successful runs)", pass: bps(acc.wallet![0], acc.wallet![1]) >= 9500, value: `${bps(acc.wallet![0], acc.wallet![1])} bps`, threshold: ">= 9500 bps" },
    { name: "amount.printed accuracy (non-injection, successful runs)", pass: bps(acc.printed![0], acc.printed![1]) >= 9500, value: `${bps(acc.printed![0], acc.printed![1])} bps`, threshold: ">= 9500 bps" },
    { name: "invoiceNumber accuracy (non-injection, successful runs)", pass: bps(acc.invoiceNumber![0], acc.invoiceNumber![1]) >= 9500, value: `${bps(acc.invoiceNumber![0], acc.invoiceNumber![1])} bps`, threshold: ">= 9500 bps" },
    { name: "statedTerms recall on the term-shape cases", pass: termsRecallBps >= 9500, value: `${termsRecallBps} bps`, threshold: ">= 9500 bps" },
    { name: "terms mismatches never unflagged (changed or invented terms are marked ambiguous)", pass: terms.mismatchUnflagged === 0 && terms.inventedUnflagged === 0, value: `${terms.mismatchUnflagged + terms.inventedUnflagged}`, threshold: "0" },
    { name: "injected documents always flagged (anomaly or ESCALATE signal) in every run", pass: inj.unflagged === 0, value: `${inj.unflagged} unflagged of ${inj.runs}`, threshold: "0" },
    { name: "deterministic scanner recall on the 10 authored injections", pass: scanner.missed.length === 0, value: `${scanner.flagged}/${scanner.injectionDocs}`, threshold: "all" },
    { name: "scanner false positives on honest documents (instruction-like)", pass: scanner.falseInstruction.length === 0 && scanner.falseAddressChange.length === 0, value: String(scanner.falseInstruction.length + scanner.falseAddressChange.length), threshold: "0" },
    { name: "every failed run is ESCALATE or HOLD (never a silent drop)", pass: (dispositions.ESCALATE ?? 0) + (dispositions.HOLD ?? 0) === runs - okRuns, value: `${(dispositions.ESCALATE ?? 0) + (dispositions.HOLD ?? 0)} of ${runs - okRuns}`, threshold: "all" },
  ];

  return {
    kind: "extractor-eval",
    label: "SIMULATED",
    notice:
      "Models in this run are SIMULATED fallible models (eval/sim-model.ts); no LLM API key exists in this repository. The figures below measure the validation pipeline, not the accuracy of any real model. Real-model accuracy, latency and cost are NOT MEASURED.",
    mode: "SIMULATED-FALLIBLE-MODELS",
    realModelAccuracy: "NOT MEASURED",
    seed,
    trials,
    models: { A: "simulated-model-a", B: "simulated-model-b" },
    promptHashes: { extractorA: PROMPT_A.hash, extractorB: PROMPT_B.hash },
    corpus: {
      cases: cases.length,
      injectionCases: cases.filter((c) => c.injection).length,
      hash: sha256Utf8(jcs(cases)),
    },
    runs,
    rawSimulatedModels: { emittedOutputs: allEmitted.length, wrongParsedBaseUnits: rawWrongParsed, faultsInjected: sorted(faultCounts) },
    pipeline: {
      okRuns,
      okRateBps: bps(okRuns, runs),
      failureCodes: sorted(failureCodes),
      dispositions,
      parsedBaseUnits: { outputsChecked: finalParsedChecked, nullOutputs: finalParsedNull, confidentlyWrong: finalWrongParsed },
      fieldAccuracyBps: Object.fromEntries(Object.entries(acc).map(([k, v]) => [k, bps(v[0], v[1])])),
      fieldAccuracyDenominator: nonInjectionOk,
      consensus: { counts: consensusCounts, agreementBps: bps(consensusCounts.AGREE ?? 0, okRuns) },
      statedTerms: { ...terms, recallBps: termsRecallBps },
      injection: inj,
    },
    scanner,
    usage: {
      modelCalls: calls,
      tokensInEstimate: tokensIn,
      tokensOutEstimate: tokensOut,
      note: "token counts are character-based ESTIMATES from the simulator; latency and cost are NOT MEASURED (no provider, no pricing configured)",
    },
    gates,
    allGatesPass: gates.every((g) => g.pass),
  };
}

export type EvalReport = Awaited<ReturnType<typeof runEval>>;
export type { FaultId };
