// D1 extraction: normalize -> (budgeted) dual-model extraction with two tools each -> post-hoc validation ->
// consensus. Advisory only: the result feeds PaymentIntent.extraction and the kernel re-derives everything (INV-8).
//
// Fail closed (docs/03 §2): any failure (oversize/empty document, budget denial, provider error, a tool the role
// may not call, schema violation, a value the document does not print) yields `ok:false` and NO intent. There is
// no weaker fallback path. Dual mode requires BOTH models to succeed; single mode exists only when `modelB` is
// null and then the result is consensus SINGLE, which K-10 escalates unless policy allows it.
import { consensus, type ConsensusResult, type ExtractedInvoice, type Hex32 } from "@symbolon/schemas";
import { toCallRecord, type AgentCallRecord, type AgentCallSink } from "./calls";
import { BudgetExhaustedError, type BudgetedLlm } from "./llm/budget";
import { ProviderError, type LlmMessage, type LlmRequest, type LlmRole } from "./llm/types";
import { DEFAULT_MAX_DOCUMENT_BYTES, prepareDocument, type PreparedDocument } from "./prepare";
import { PROMPT_A, PROMPT_B, renderExtractorUserTurn, type PromptSpec } from "./prompts";
import { CONTEXT_KINDS, NO_CONTEXT, READ_CONTEXT, ReadContextInputSchema, SUBMIT_EXTRACTION, type ContextProvider } from "./tools";
import { validateExtraction, type Correction, type ValidationFailure } from "./validate";

export interface ExtractorConfig {
  /** Primary model (default in the service: claude-sonnet-5-5; docs/03 §4). */
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
  readonly usdcAliases?: readonly string[];
}

export interface ExtractorDeps {
  readonly llm: BudgetedLlm;
  readonly sink?: AgentCallSink;
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

export interface ExtractionFailure {
  readonly code: ExtractionFailureCode;
  /** Which model run failed (absent for document-level failures). */
  readonly model?: "A" | "B";
  /** Short, document-free detail (field names, deny reasons); never model or document text. */
  readonly detail?: string;
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
  /** Raw tool inputs exactly as the models returned them (stored in receipt inputs, docs/03 §4). */
  readonly rawA: unknown;
  readonly rawB: unknown;
  readonly correctionsA: readonly Correction[];
  readonly correctionsB: readonly Correction[];
}

export type ExtractionResult =
  | { readonly ok: true; readonly value: ExtractionOutcome; readonly calls: readonly AgentCallRecord[] }
  | { readonly ok: false; readonly failure: ExtractionFailure; readonly calls: readonly AgentCallRecord[] };

interface RunOk {
  readonly ok: true;
  readonly extraction: ExtractedInvoice;
  readonly raw: unknown;
  readonly corrections: readonly Correction[];
}
type RunResult = RunOk | { readonly ok: false; readonly failure: ExtractionFailure };

const MAX_CONTEXT_CHARS = 8192;

function failureFromValidation(f: ValidationFailure, which: "A" | "B"): ExtractionFailure {
  return f.code === "SCHEMA_INVALID"
    ? { code: "SCHEMA_INVALID", model: which, detail: f.paths.join(",") }
    : { code: "FIELD_NOT_IN_DOCUMENT", model: which, detail: f.field };
}

async function runModel(
  which: "A" | "B",
  prompt: PromptSpec,
  role: LlmRole,
  model: string,
  doc: PreparedDocument,
  cfg: ExtractorConfig,
  deps: ExtractorDeps,
  calls: AgentCallRecord[],
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
      if (e instanceof BudgetExhaustedError) return { ok: false, failure: { code: "BUDGET_EXHAUSTED", model: which, detail: e.reason } };
      if (e instanceof ProviderError) return { ok: false, failure: { code: "PROVIDER_ERROR", model: which } };
      return { ok: false, failure: { code: "INTERNAL_ERROR", model: which } };
    }
    const record = toCallRecord({ role, model, promptHash: prompt.hash, turn, result });
    calls.push(record);
    if (deps.sink) await deps.sink.record(record).catch(() => undefined); // best effort

    const tcs = result.response.toolCalls;
    if (tcs.length === 0) return { ok: false, failure: { code: "NO_SUBMISSION", model: which } };
    // Guardrail 2: exactly two tools. Anything else fails the run.
    if (tcs.some((c) => c.name !== SUBMIT_EXTRACTION && c.name !== READ_CONTEXT)) {
      await deps.llm.evict(result.cacheKey);
      return { ok: false, failure: { code: "DISALLOWED_TOOL", model: which } };
    }
    const submits = tcs.filter((c) => c.name === SUBMIT_EXTRACTION);
    if (submits.length > 1 || (submits.length === 1 && tcs.length > 1)) {
      await deps.llm.evict(result.cacheKey);
      return { ok: false, failure: { code: "AMBIGUOUS_SUBMISSION", model: which } };
    }
    const submit = submits[0];
    if (submit !== undefined) {
      const v = validateExtraction(submit.input, doc, { decimals: cfg.decimals, ...(cfg.usdcAliases === undefined ? {} : { usdcAliases: cfg.usdcAliases }) });
      if (!v.ok) {
        await deps.llm.evict(result.cacheKey); // do not replay a rejected answer for free
        return { ok: false, failure: failureFromValidation(v.failure, which) };
      }
      return { ok: true, extraction: v.extraction, raw: submit.input, corrections: v.corrections };
    }

    // Only read_context calls: answer them with kernel-sanitized read-only JSON and continue.
    messages.push({ role: "assistant", toolCalls: tcs });
    for (const c of tcs) {
      const parsed = ReadContextInputSchema.safeParse(c.input);
      let text: string;
      if (!parsed.success) {
        text = JSON.stringify({ error: `kind must be one of ${CONTEXT_KINDS.join(", ")}` });
      } else {
        try {
          text = JSON.stringify(await context.read(parsed.data.kind));
        } catch {
          text = JSON.stringify({ error: "context unavailable" });
        }
        if (text.length > MAX_CONTEXT_CHARS) text = JSON.stringify({ truncated: true, head: text.slice(0, MAX_CONTEXT_CHARS) });
      }
      messages.push({ role: "tool_result", callId: c.id, text });
    }
  }
  return { ok: false, failure: { code: "TOO_MANY_TURNS", model: which } };
}

export async function extractInvoice(rawText: string, cfg: ExtractorConfig, deps: ExtractorDeps): Promise<ExtractionResult> {
  const calls: AgentCallRecord[] = [];
  const prepared = prepareDocument(rawText, { maxBytes: cfg.maxDocumentBytes ?? DEFAULT_MAX_DOCUMENT_BYTES });
  if (!prepared.ok) return { ok: false, failure: { code: prepared.error.code }, calls };
  const doc = prepared.value;

  const [ra, rb] = await Promise.all([
    runModel("A", PROMPT_A, "extractor_a", cfg.modelA, doc, cfg, deps, calls),
    cfg.modelB === null ? Promise.resolve(null) : runModel("B", PROMPT_B, "extractor_b", cfg.modelB, doc, cfg, deps, calls),
  ]);
  if (!ra.ok) return { ok: false, failure: ra.failure, calls };
  if (rb !== null && !rb.ok) return { ok: false, failure: rb.failure, calls };

  const a = ra.extraction;
  const b = rb === null ? null : rb.extraction;
  return {
    ok: true,
    calls,
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
      rawA: ra.raw,
      rawB: rb === null ? null : rb.raw,
      correctionsA: ra.corrections,
      correctionsB: rb === null ? [] : rb.corrections,
    },
  };
}
