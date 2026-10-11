// D1 extraction: normalize -> (budgeted) dual-model extraction with two tools each -> post-hoc validation ->
// consensus. Advisory only: the result feeds PaymentIntent.extraction and the kernel re-derives everything (INV-8).
//
// Fail closed (docs/03 section 2): any failure (oversize/empty document, budget denial, provider error, a tool the
// role may not call, schema violation, a value the document does not print) yields `ok:false` and NO intent.
// There is no weaker fallback path. Failures are TYPED VALUES that carry (a) the document-level risk signals
// (hidden characters, injection phrases, address-change language) computed independently of any model, and (b) a
// `disposition`: "ESCALATE" when there is any risk signal or the signals are unavailable, otherwise "HOLD". A
// failure can therefore never silently drop a signal. Non-fatal problems (sink write failed, context provider
// unavailable, ledger write failed) are returned as `warnings`, not swallowed. Dual mode requires BOTH models to
// succeed; single mode exists only when `modelB` is null and then consensus is SINGLE (K-10 escalates it).
import { consensus, untrusted, type ConsensusResult, type ExtractedInvoice, type Hex32 } from "@symbolon/schemas";
import { toCallRecord, type AgentCallRecord, type AgentCallSink } from "./calls";
import { BudgetExhaustedError, type BudgetedLlm } from "./llm/budget";
import { ProviderError, type LlmMessage, type LlmRequest, type LlmRole } from "./llm/types";
import { DEFAULT_MAX_DOCUMENT_BYTES, prepareDocument, type PreparedDocument } from "./prepare";
import { PROMPT_A, PROMPT_B, renderExtractorUserTurn, type PromptSpec } from "./prompts";
import { computeDocSignals, failClosedSignals, hasRiskSignal, type DocSignals } from "./signals";
import { CONTEXT_KINDS, NO_CONTEXT, READ_CONTEXT, ReadContextInputSchema, SUBMIT_EXTRACTION, type ContextProvider } from "./tools";
import { validateExtraction, type Correction, type ValidationFailure } from "./validate";

export interface ExtractorConfig {
  /** Primary model (default in the service: claude-sonnet-5-5; docs/03 section 4). */
  readonly modelA: string;
  /** Secondary model, different prompt; null => single-extraction mode (consensus SINGLE). */
  readonly modelB: string | null;
  /** Token decimals for the document's currency (read from chain/engagement; V-04). */
  readonly decimals: number;
  readonly context?: ContextProvider;
  readonly maxDocumentBytes?: number;
  /** Total model turns per role (read_context rounds + the submission). Default 4. */
  readonly maxTurns?: number;
  readonly maxOutputTokens?: number;
  /** Exact printed currency spellings for which base units may be emitted. Default ["USDC"]; never "$" by default. */
  readonly parseEligibleCurrencies?: readonly string[];
}

export interface ExtractorDeps {
  readonly llm: BudgetedLlm;
  readonly sink?: AgentCallSink;
  /** Test seam: replaces computeDocSignals (default). Whatever it does, a throw is converted to scanError signals. */
  readonly signalsFn?: ((doc: PreparedDocument) => DocSignals) | undefined;
}

export type ExtractionFailureCode =
  | "DOC_TOO_LARGE"
  | "DOC_EMPTY"
  | "BUDGET_EXHAUSTED"
  | "PROVIDER_ERROR"
  | "NO_SUBMISSION"
  | "DISALLOWED_TOOL"
  | "AMBIGUOUS_SUBMISSION"
  | "TOO_MANY_TURNS"
  | "SCHEMA_INVALID"
  | "FIELD_NOT_IN_DOCUMENT"
  | "INTERNAL_ERROR";

/**
 * Failure codes that indicate the MODEL misbehaved (an undeclared tool, two submissions, a value the document does
 * not print, malformed output, no submission, endless reading, an unexpected internal error) rather than the
 * infrastructure failing (budget denial, provider outage). A model that tries an undeclared tool or claims an
 * unprinted value may have been steered by something the scanner missed, so these force ESCALATE even when the
 * document-level signals are clean.
 */
export const MODEL_BEHAVIOUR_CODES: ReadonlySet<ExtractionFailureCode> = new Set<ExtractionFailureCode>([
  "DISALLOWED_TOOL",
  "AMBIGUOUS_SUBMISSION",
  "FIELD_NOT_IN_DOCUMENT",
  "SCHEMA_INVALID",
  "NO_SUBMISSION",
  "TOO_MANY_TURNS",
  "INTERNAL_ERROR",
]);

export interface ModelFlag {
  readonly model: "A" | "B";
  readonly code: ExtractionFailureCode;
  readonly detail?: string;
}

export interface ExtractionFailure {
  readonly code: ExtractionFailureCode;
  /** Which model run failed (absent for document-level failures). */
  readonly model?: "A" | "B";
  /** Short, document-free detail (field names, deny reasons); never model or document text. */
  readonly detail?: string;
  /** Document-level risk signals; null only when the document could not be prepared (oversize). */
  readonly signals: DocSignals | null;
  /** Model-behaviour flags from EVERY failed run (union of A and B), not only the one reported as `code`. */
  readonly modelFlags: readonly ModelFlag[];
  /** What the caller must do with this document: never "proceed". ESCALATE whenever any risk signal or model-behaviour flag exists, or signals are unknown. */
  readonly disposition: "ESCALATE" | "HOLD";
}

export type ExtractionWarningCode = "SINK_WRITE_FAILED" | "CONTEXT_UNAVAILABLE" | "CONTEXT_BAD_REQUEST" | "LEDGER_WRITE_FAILED";
export interface ExtractionWarning {
  readonly code: ExtractionWarningCode;
  readonly model?: "A" | "B";
}

export interface ExtractionOutcome {
  readonly a: ExtractedInvoice;
  readonly b: ExtractedInvoice | null;
  readonly modelA: string;
  readonly modelB: string | null;
  readonly promptHashA: Hex32;
  readonly promptHashB: Hex32 | null;
  readonly consensus: ConsensusResult;
  readonly originalHash: Hex32;
  readonly normalizedHash: Hex32;
  /** Characters removed by normalization (non-zero also yields a HIDDEN_CHARS anomaly in both extractions). */
  readonly removedCount: number;
  readonly signals: DocSignals;
  /** Raw tool inputs exactly as the models returned them (stored in receipt inputs, docs/03 section 4). */
  readonly rawA: unknown;
  readonly rawB: unknown;
  readonly correctionsA: readonly Correction[];
  readonly correctionsB: readonly Correction[];
}

export type ExtractionResult =
  | { readonly ok: true; readonly value: ExtractionOutcome; readonly calls: readonly AgentCallRecord[]; readonly warnings: readonly ExtractionWarning[] }
  | { readonly ok: false; readonly failure: ExtractionFailure; readonly calls: readonly AgentCallRecord[]; readonly warnings: readonly ExtractionWarning[] };

interface RunOk {
  readonly ok: true;
  readonly extraction: ExtractedInvoice;
  readonly raw: unknown;
  readonly corrections: readonly Correction[];
}
type RunFail = { readonly ok: false; readonly code: ExtractionFailureCode; readonly model: "A" | "B"; readonly detail?: string };
type RunResult = RunOk | RunFail;

const MAX_CONTEXT_CHARS = 8192;

function makeFailure(
  code: ExtractionFailureCode,
  signals: DocSignals | null,
  extra: { model?: "A" | "B"; detail?: string; runs?: readonly RunFail[] } = {},
): ExtractionFailure {
  const modelFlags: ModelFlag[] = (extra.runs ?? [])
    .filter((r) => MODEL_BEHAVIOUR_CODES.has(r.code))
    .map((r) => ({ model: r.model, code: r.code, ...(r.detail === undefined ? {} : { detail: r.detail }) }));
  return {
    code,
    ...(extra.model === undefined ? {} : { model: extra.model }),
    ...(extra.detail === undefined ? {} : { detail: extra.detail }),
    signals,
    modelFlags,
    disposition: hasRiskSignal(signals) || modelFlags.length > 0 || MODEL_BEHAVIOUR_CODES.has(code) ? "ESCALATE" : "HOLD",
  };
}

function fromValidation(f: ValidationFailure, which: "A" | "B"): RunFail {
  return f.code === "SCHEMA_INVALID"
    ? { ok: false, code: "SCHEMA_INVALID", model: which, detail: f.paths.join(",") }
    : { ok: false, code: "FIELD_NOT_IN_DOCUMENT", model: which, detail: f.field };
}

async function runModel(
  which: "A" | "B",
  prompt: PromptSpec,
  role: LlmRole,
  model: string,
  doc: PreparedDocument,
  signals: DocSignals,
  cfg: ExtractorConfig,
  deps: ExtractorDeps,
  calls: AgentCallRecord[],
  warnings: ExtractionWarning[],
): Promise<RunResult> {
  const maxTurns = cfg.maxTurns ?? 4;
  const context = cfg.context ?? NO_CONTEXT;
  const messages: LlmMessage[] = [{ role: "user", text: renderExtractorUserTurn(prompt, doc.normalized, cfg.decimals) }];

  for (let turn = 1; turn <= maxTurns; turn++) {
    const lastTurn = turn === maxTurns;
    const request: LlmRequest = {
      role,
      model,
      system: prompt.system,
      messages: [...messages],
      tools: prompt.tools,
      toolChoice: lastTurn ? { type: "tool", name: SUBMIT_EXTRACTION } : { type: "any" },
      maxOutputTokens: cfg.maxOutputTokens ?? 2048,
    };
    let result;
    try {
      result = await deps.llm.call(request);
    } catch (e) {
      // Typed failure value (not swallowed): the caller gets the code and the document signals.
      if (e instanceof BudgetExhaustedError) return { ok: false, code: "BUDGET_EXHAUSTED", model: which, detail: e.reason };
      if (e instanceof ProviderError) return { ok: false, code: "PROVIDER_ERROR", model: which };
      return { ok: false, code: "INTERNAL_ERROR", model: which };
    }
    if (result.ledgerCommitFailed) warnings.push({ code: "LEDGER_WRITE_FAILED", model: which });
    const record = toCallRecord({ role, model, promptHash: prompt.hash, turn, result });
    calls.push(record);
    if (deps.sink) {
      try {
        await deps.sink.record(record);
      } catch {
        warnings.push({ code: "SINK_WRITE_FAILED", model: which }); // observability only; reported, never silent
      }
    }

    const tcs = result.response.toolCalls;
    if (tcs.length === 0) return { ok: false, code: "NO_SUBMISSION", model: which };
    // Guardrail 2: exactly two tools. Anything else fails the run.
    if (tcs.some((c) => c.name !== SUBMIT_EXTRACTION && c.name !== READ_CONTEXT)) {
      await deps.llm.evict(result.cacheKey);
      return { ok: false, code: "DISALLOWED_TOOL", model: which };
    }
    const submits = tcs.filter((c) => c.name === SUBMIT_EXTRACTION);
    if (submits.length > 1 || (submits.length === 1 && tcs.length > 1)) {
      await deps.llm.evict(result.cacheKey);
      return { ok: false, code: "AMBIGUOUS_SUBMISSION", model: which };
    }
    const submit = submits[0];
    if (submit !== undefined) {
      let v;
      try {
        v = validateExtraction(submit.input, doc, { decimals: cfg.decimals, ...(cfg.parseEligibleCurrencies === undefined ? {} : { parseEligibleCurrencies: cfg.parseEligibleCurrencies }) }, signals);
      } catch {
        await deps.llm.evict(result.cacheKey);
        return { ok: false, code: "INTERNAL_ERROR", model: which, detail: "validator threw" }; // typed, escalated via disposition
      }
      if (!v.ok) {
        await deps.llm.evict(result.cacheKey); // do not replay a rejected answer for free
        return fromValidation(v.failure, which);
      }
      return { ok: true, extraction: v.extraction, raw: submit.input, corrections: v.corrections };
    }

    // Only read_context calls: answer them with kernel-sanitized read-only JSON and continue.
    messages.push({ role: "assistant", toolCalls: tcs });
    for (const c of tcs) {
      const parsed = ReadContextInputSchema.safeParse(c.input);
      let text: string;
      if (!parsed.success) {
        warnings.push({ code: "CONTEXT_BAD_REQUEST", model: which });
        text = JSON.stringify({ error: `kind must be one of ${CONTEXT_KINDS.join(", ")}` });
      } else {
        try {
          text = JSON.stringify(await context.read(parsed.data.kind));
        } catch {
          warnings.push({ code: "CONTEXT_UNAVAILABLE", model: which });
          text = JSON.stringify({ error: "context unavailable" });
        }
        if (text.length > MAX_CONTEXT_CHARS) text = JSON.stringify({ truncated: true, head: text.slice(0, MAX_CONTEXT_CHARS) });
      }
      messages.push({ role: "tool_result", callId: c.id, text });
    }
  }
  return { ok: false, code: "TOO_MANY_TURNS", model: which };
}

export async function extractInvoice(rawText: string, cfg: ExtractorConfig, deps: ExtractorDeps): Promise<ExtractionResult> {
  const calls: AgentCallRecord[] = [];
  const warnings: ExtractionWarning[] = [];
  let prepared: ReturnType<typeof prepareDocument>;
  try {
    prepared = prepareDocument(rawText, { maxBytes: cfg.maxDocumentBytes ?? DEFAULT_MAX_DOCUMENT_BYTES });
  } catch {
    // Typed, escalated failure (signals unknown); never an escaping exception.
    return { ok: false, failure: makeFailure("INTERNAL_ERROR", null, { detail: "prepare threw" }), calls, warnings };
  }
  if (!prepared.ok) {
    if (prepared.error.code === "DOC_TOO_LARGE") {
      // Oversize documents are not scanned: signals unavailable => ESCALATE.
      return { ok: false, failure: makeFailure("DOC_TOO_LARGE", null), calls, warnings };
    }
    // Empty after normalization: nothing to scan, but removed invisible characters ARE a signal (HIDDEN_CHARS).
    const e = prepared.error;
    const hidden = e.removedCount > 0;
    const sig: DocSignals = {
      anomalies: hidden
        ? [{ code: "HIDDEN_CHARS", quote: untrusted(`removed ${e.removedCount} characters (control ${e.counts.control}, zero-width ${e.counts.zeroWidth}, bidi ${e.counts.bidi}, invalid ${e.counts.invalid})`) }]
        : [],
      claimsAddressChange: false,
      removedCount: e.removedCount,
      scanError: false,
    };
    return { ok: false, failure: makeFailure("DOC_EMPTY", sig), calls, warnings };
  }
  const doc = prepared.value;
  let signals: DocSignals;
  try {
    signals = (deps.signalsFn ?? computeDocSignals)(doc);
  } catch {
    signals = failClosedSignals(doc.removedCount); // fail closed with scanError, never an escaping exception
  }

  const [ra, rb] = await Promise.all([
    runModel("A", PROMPT_A, "extractor_a", cfg.modelA, doc, signals, cfg, deps, calls, warnings),
    cfg.modelB === null ? Promise.resolve(null) : runModel("B", PROMPT_B, "extractor_b", cfg.modelB, doc, signals, cfg, deps, calls, warnings),
  ]);
  const failedRuns: RunFail[] = [ra, rb].filter((r): r is RunFail => r !== null && !r.ok);
  const failed = failedRuns[0];
  if (failed !== undefined) {
    // Report the first failure's code, but keep the flags of EVERY failed run (A and B), so nothing is lost.
    return {
      ok: false,
      failure: makeFailure(failed.code, signals, { model: failed.model, ...(failed.detail === undefined ? {} : { detail: failed.detail }), runs: failedRuns }),
      calls,
      warnings,
    };
  }
  if (!ra.ok) throw new Error("unreachable");
  const a = ra.extraction;
  const b = rb === null || !rb.ok ? null : rb.extraction;
  return {
    ok: true,
    calls,
    warnings,
    value: {
      a,
      b,
      modelA: cfg.modelA,
      modelB: cfg.modelB,
      promptHashA: PROMPT_A.hash,
      promptHashB: cfg.modelB === null ? null : PROMPT_B.hash,
      consensus: consensus(a, b),
      originalHash: doc.originalHash,
      normalizedHash: doc.normalizedHash,
      removedCount: doc.removedCount,
      signals,
      rawA: ra.raw,
      rawB: rb === null || !rb.ok ? null : rb.raw,
      correctionsA: ra.corrections,
      correctionsB: rb === null || !rb.ok ? [] : rb.corrections,
    },
  };
}
