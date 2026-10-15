// Treasury Planner (D2; docs/03 §5; WP-35). ADVISORY: nothing here is a release condition (INV-8). The kernel
// enumerates the feasible plans (packages/terms), scores them deterministically, and re-checks whatever the planner
// picked (K-14, again at payAt). This module does three things around the model call:
//
//   1. builds the ONLY input the model sees (kernel-computed facts; never invoice text) and the read-only context;
//   2. validates the model's PlanSelection: a planId that is a member of the kernel's feasible set (and not HOLD),
//      the strict schema (no date, no amount, no extra field), a consistent deviation flag, and a rationale that
//      survives sanitizeLlmText UNCHANGED and quotes only values of the chosen plan (explanation faithfulness);
//   3. ANY failure (malformed, injected, out of set, unfaithful, over budget, provider down, no submission) resolves
//      to the deterministic default: the evaluator's top SAFE plan (the same plan the kernel schedules with
//      plannerFallback=true), or nothing payable when no safe plan exists. Money never waits on the model.
//
// Pure apart from the injected BudgetedLlm (the network edge). Money is bigint/decimal strings; no Number() on amounts.
import {
  FeasiblePlanSchema,
  ISODateTimeSchema,
  AmountSchema,
  PLAN_MODES,
  PlanSelectionSchema,
  hashJcs,
  inspectUntrusted,
  jcs,
  sanitizeLlmText,
  type FeasiblePlan,
  type Hex32,
  type ISODateTime,
  type PlanEvaluation,
  type PlanSelection,
} from "@symbolon/schemas";
import { evaluatePlans, topSafePlan, type ScoreParams } from "@symbolon/terms";
import * as z from "zod";
import { toCallRecord, type AgentCallRecord, type AgentCallSink } from "./calls";
import { BudgetExhaustedError, type BudgetedLlm } from "./llm/budget";
import { ProviderError, type LlmMessage, type LlmRequest } from "./llm/types";
import { PROMPT_PLANNER, renderPlannerUserTurn } from "./prompts";
import { PLANNER_CONTEXT_KINDS, PlannerReadContextInputSchema, READ_CONTEXT, SUBMIT_PLAN_SELECTION, type PlannerContextProvider, type PlannerContextKind } from "./tools";

// --- the kernel-built snapshot the planner sees ------------------------------------------------------------------------

/** How the invoice's own (untrusted) terms compare with the signed terms; a closed enum, never the text. */
export const STATED_TERMS_STATUSES = ["NONE", "MATCH", "DIFFERS", "AMBIGUOUS", "NOT_SIGNED"] as const;
export type StatedTermsStatus = (typeof STATED_TERMS_STATUSES)[number];

const count = z.number().int().min(0).max(1_000_000);

export const PlannerSnapshotSchema = z.strictObject({
  /** kernel clock at planning time */
  now: ISODateTimeSchema,
  plans: z.array(FeasiblePlanSchema).min(1).max(8),
  evaluation: z.strictObject({
    plans: z.array(z.strictObject({ planId: z.string(), netBenefitBase: z.string(), regretBase: z.string() })).max(64),
    topPlanId: z.string(),
    costOfCapitalBps: z.number().int().min(0).max(1_000_000),
  }),
  /** The scoring parameters the kernel used (policy.treasury.costOfCapitalBps, legal latest instant, milestone flag). */
  params: z.strictObject({
    costOfCapitalBps: z.number().int().min(0).max(1_000_000),
    referenceInstant: ISODateTimeSchema,
    preferImmediate: z.boolean(),
  }),
  /** The SIGNED terms in force (or policy defaults); never invoice-stated terms (INV-19). */
  terms: z.strictObject({
    netDays: z.number().int().min(0).max(365),
    payBeforeDueBufferHours: z.number().int().min(0).max(87_600),
    allowImmediate: z.boolean(),
    earlyPay: z.strictObject({ discountBps: z.number().int().min(0).max(10_000), withinDays: z.number().int().min(0).max(3650) }).nullable(),
    signed: z.boolean(),
  }),
  statedTermsStatus: z.enum(STATED_TERMS_STATUSES),
  liquidity: z.strictObject({ vaultAvailable: AmountSchema, pendingReleases: AmountSchema, reserveFloor: AmountSchema }),
  evidenceSatisfiedAt: ISODateTimeSchema.nullable(),
  vendorHistory: z.strictObject({ paidCount: count, disputedCount: count, lateDeliveryCount: count }),
});
export type PlannerSnapshot = z.infer<typeof PlannerSnapshotSchema>;

/** The facts JSON rendered into the user turn: a fixed-key projection of a validated snapshot. */
export function plannerFacts(s: PlannerSnapshot): Record<string, unknown> {
  return {
    now: s.now,
    plans: s.plans,
    evaluation: s.evaluation,
    terms: s.terms,
    statedTermsStatus: s.statedTermsStatus,
    liquidity: s.liquidity,
    evidenceSatisfiedAt: s.evidenceSatisfiedAt,
    vendorHistory: s.vendorHistory,
    costOfCapitalBps: s.params.costOfCapitalBps,
  };
}

/** read_context for the planner: kernel-sanitized, read-only, enum/ISO/decimal-string values only. */
export function plannerContextProvider(s: PlannerSnapshot): PlannerContextProvider {
  const f = plannerFacts(s);
  return {
    read(kind: PlannerContextKind): Promise<unknown> {
      switch (kind) {
        case "plans":
          return Promise.resolve({ plans: f.plans, evaluation: f.evaluation });
        case "terms":
          return Promise.resolve({ terms: f.terms, statedTermsStatus: f.statedTermsStatus });
        case "liquidity":
          return Promise.resolve({ liquidity: f.liquidity });
        case "evidence_status":
          return Promise.resolve({ evidenceSatisfiedAt: f.evidenceSatisfiedAt, now: f.now });
        case "vendor_history":
          return Promise.resolve({ vendorHistory: f.vendorHistory });
        default: {
          const _never: never = kind;
          return Promise.resolve({ error: `unknown kind ${String(_never)}` });
        }
      }
    },
  };
}

// --- plan-set integrity ------------------------------------------------------------------------------------------------

export type PlannerRejection =
  | "PLAN_SET_INVALID"
  | "NO_SUBMISSION"
  | "TRIVIAL_CHOICE"
  | "AMBIGUOUS_SUBMISSION"
  | "DISALLOWED_TOOL"
  | "TOO_MANY_TURNS"
  | "SCHEMA_INVALID"
  | "PLAN_OUT_OF_ENVELOPE"
  | "HOLD_NOT_SELECTABLE"
  | "DEVIATION_FLAG_MISMATCH"
  | "RATIONALE_REJECTED"
  | "BUDGET"
  | "PROVIDER"
  | "INTERNAL_ERROR";

export type PlanSetCheck = { readonly ok: true; readonly evaluation: PlanEvaluation } | { readonly ok: false };

/**
 * The planner never trusts a doctored plan set or evaluation: plans must parse, planIds must be unique, and the
 * evaluation must equal what the deterministic evaluator computes from those plans (so topPlanId cannot be forged).
 */
export function checkPlanSet(plans: readonly FeasiblePlan[], params: ScoreParams, claimed: PlanEvaluation | null): PlanSetCheck {
  if (!Array.isArray(plans) || plans.length === 0 || plans.length > 8) return { ok: false };
  if (!plans.every((p) => FeasiblePlanSchema.safeParse(p).success)) return { ok: false };
  if (new Set(plans.map((p) => p.planId)).size !== plans.length) return { ok: false };
  const ev = evaluatePlans(plans, params);
  if (!ev.ok) return { ok: false };
  if (claimed !== null && jcs(claimed) !== jcs(ev.value)) return { ok: false };
  return { ok: true, evaluation: ev.value };
}

/** The deterministic default: the evaluator's top SAFE plan (what the kernel schedules without a planner), or null. */
export function fallbackPlan(plans: readonly FeasiblePlan[], params: ScoreParams): FeasiblePlan | null {
  const top = topSafePlan(plans, params);
  return top.ok ? top.value : null;
}

// --- rationale: templated, and checked for faithfulness ----------------------------------------------------------------

/**
 * The rationale the planner flow always has available: rendered from the chosen plan's own fields (INV-20 style),
 * so it is faithful by construction. Used for the fallback and by honest simulated models.
 */
export function templateRationale(plan: FeasiblePlan): string {
  const apr = plan.impliedAprBps === null ? "" : ` Implied APR is ${plan.impliedAprBps} bps.`;
  switch (plan.mode) {
    case "TAKE_DISCOUNT":
      return `Plan TAKE_DISCOUNT pays at ${plan.payAt}, inside the discount window that ends ${plan.windowEnd ?? "at the stated close"}. amountDue ${plan.amountDue} after a discountValue of ${plan.discountValue}.${apr} liquidityAfter ${plan.liquidityAfter} keeps the reserve floor.`;
    case "DUE_MINUS_BUFFER":
      return `Plan DUE_MINUS_BUFFER pays at ${plan.payAt}, the latest legal time, so liquidity stays available longest. amountDue ${plan.amountDue}; liquidityAfter ${plan.liquidityAfter}.`;
    case "IMMEDIATE":
      return `Plan IMMEDIATE pays at ${plan.payAt}. amountDue ${plan.amountDue}; liquidityAfter ${plan.liquidityAfter} keeps the reserve floor.`;
    case "AFTER_EVIDENCE":
      return `Plan AFTER_EVIDENCE pays at ${plan.payAt}, once the evidence precondition is met. amountDue ${plan.amountDue}; liquidityAfter ${plan.liquidityAfter}.`;
    case "AFTER_DISPUTE_WINDOW":
      return `Plan AFTER_DISPUTE_WINDOW pays at ${plan.payAt}, after the dispute window closes. amountDue ${plan.amountDue}; liquidityAfter ${plan.liquidityAfter}.`;
    case "HOLD":
      return `Plan HOLD pays nothing at ${plan.payAt}: no payable plan is feasible now.`;
    default: {
      const _never: never = plan.mode;
      return String(_never);
    }
  }
}

export type RationaleFailure = "EMPTY" | "TOO_LONG" | "SANITIZER_REMOVED_CONTENT" | "NON_CANONICAL_TEXT" | "UNFAITHFUL_NUMBER" | "UNFAITHFUL_CODE" | "NUMBER_WORD";

const NUMBER_WORDS = [
  "zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen",
  "fifteen", "sixteen", "seventeen", "eighteen", "nineteen", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty",
  "ninety", "hundred", "thousand", "million", "billion", "percent", "half", "double", "twice", "dozen",
];
const NUMBER_WORD_RE = new RegExp(`^(?:${NUMBER_WORDS.join("|")})+$`, "i");
const MODE_SET: ReadonlySet<string> = new Set<string>(PLAN_MODES);

function rationaleTokens(folded: string): string[] {
  return folded
    .split(/[\s;!?()[\]{}"`]+/)
    .map((t) => t.replace(/^[.,:]+|[.,:]+$/g, ""))
    .filter((t) => t.length > 0);
}

/**
 * Explanation faithfulness (docs/13 §4.8): every figure in the text equals a field of the CHOSEN plan (planId,
 * payAt, windowEnd, amountDue, discountValue, liquidityAfter, impliedAprBps) or the disclosed costOfCapitalBps; every
 * upper-case code is a plan mode; no spelled-out numbers; the text survives the LLM-text sanitizer unchanged and is in
 * NFKC form. Anything else is rejected, never patched.
 */
export function checkRationale(text: string, plan: FeasiblePlan, costOfCapitalBps: number, maxChars = 600): { readonly ok: true; readonly text: string } | { readonly ok: false; readonly reason: RationaleFailure } {
  const bad = (reason: RationaleFailure) => ({ ok: false as const, reason });
  const folded = text.replace(/\s+/g, " ").trim();
  if (folded.length === 0) return bad("EMPTY");
  if (Array.from(folded).length > maxChars) return bad("TOO_LONG");
  const sanitized = inspectUntrusted(sanitizeLlmText(text, { maxChars: Array.from(text).length * 2 + 64 }));
  if (sanitized !== folded) return bad("SANITIZER_REMOVED_CONTENT");
  if (folded.normalize("NFKC") !== folded) return bad("NON_CANONICAL_TEXT");

  const figures = new Set<string>([plan.planId, plan.payAt, plan.amountDue, plan.discountValue, plan.liquidityAfter, String(costOfCapitalBps)]);
  if (plan.windowEnd !== null) figures.add(plan.windowEnd);
  if (plan.impliedAprBps !== null) figures.add(String(plan.impliedAprBps));
  for (const tok of rationaleTokens(folded)) {
    if (/\p{Nd}/u.test(tok)) {
      if (!figures.has(tok)) return bad("UNFAITHFUL_NUMBER");
      continue;
    }
    if (/^[A-Z][A-Z_]{3,}$/.test(tok) && !MODE_SET.has(tok)) return bad("UNFAITHFUL_CODE");
    if (tok.includes("_") && !MODE_SET.has(tok)) return bad("UNFAITHFUL_CODE");
    for (const part of tok.toLowerCase().split(/[^\p{L}]+/u)) if (part.length > 0 && NUMBER_WORD_RE.test(part)) return bad("NUMBER_WORD");
  }
  return { ok: true, text: folded };
}

// --- selection validation ----------------------------------------------------------------------------------------------

export type SelectionValidation =
  | { readonly ok: true; readonly selection: PlanSelection; readonly plan: FeasiblePlan }
  | { readonly ok: false; readonly rejection: PlannerRejection; readonly rationaleFailure?: RationaleFailure };

/**
 * Validate a raw (untrusted) selection against the kernel's feasible set. The only way to return ok is a strictly
 * parsed PlanSelection whose planId is a payable member of `plans`, with a consistent deviation flag and faithful text.
 */
export function validatePlanSelection(raw: unknown, plans: readonly FeasiblePlan[], evaluation: PlanEvaluation): SelectionValidation {
  const parsed = PlanSelectionSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, rejection: "SCHEMA_INVALID" };
  const selection = parsed.data;
  const plan = plans.find((p) => p.planId === selection.planId);
  if (plan === undefined) return { ok: false, rejection: "PLAN_OUT_OF_ENVELOPE" };
  if (plan.mode === "HOLD") return { ok: false, rejection: "HOLD_NOT_SELECTABLE" };
  if (selection.deviatesFromEvaluator !== (selection.planId !== evaluation.topPlanId)) return { ok: false, rejection: "DEVIATION_FLAG_MISMATCH" };
  const r = checkRationale(inspectUntrusted(selection.rationale), plan, evaluation.costOfCapitalBps);
  if (!r.ok) return { ok: false, rejection: "RATIONALE_REJECTED", rationaleFailure: r.reason };
  if (selection.deviationReason !== null) {
    const d = checkRationale(inspectUntrusted(selection.deviationReason), plan, evaluation.costOfCapitalBps);
    if (!d.ok) return { ok: false, rejection: "RATIONALE_REJECTED", rationaleFailure: d.reason };
  }
  return { ok: true, selection, plan };
}

// --- resolution: planner pick or deterministic default ----------------------------------------------------------------

export interface PlannerResolution {
  /** The plan to schedule; null = nothing payable (the kernel holds). Always a member of the feasible set. */
  readonly plan: FeasiblePlan | null;
  readonly planId: Hex32 | null;
  readonly source: "PLANNER" | "FALLBACK";
  /** true when the kernel's own default plan stands in for the planner (kernel `plannerFallback`). */
  readonly plannerFallback: boolean;
  readonly rejection: PlannerRejection | null;
  readonly rationaleFailure: RationaleFailure | null;
  /** PLAN_OUT_OF_ENVELOPE when the selection named a plan outside the feasible set (docs/04 K-14). */
  readonly reasonCode: "PLAN_OUT_OF_ENVELOPE" | null;
  readonly selection: PlanSelection | null;
  /** The rationale to show: the validated model text, or the template of the scheduled plan. */
  readonly rationale: string | null;
  readonly deviatesFromEvaluator: boolean;
  readonly topPlanId: Hex32 | null;
}

export interface ResolveInput {
  readonly plans: readonly FeasiblePlan[];
  readonly params: ScoreParams;
  /** The raw submission (or null when none arrived). Untrusted. */
  readonly raw: unknown;
  /** Why there is no usable submission, when known (budget, provider, ...). */
  readonly absent?: PlannerRejection;
}

function fallbackResolution(plans: readonly FeasiblePlan[], params: ScoreParams, rejection: PlannerRejection | null, rationaleFailure: RationaleFailure | null, topPlanId: Hex32 | null): PlannerResolution {
  const plan = fallbackPlan(plans, params);
  return {
    plan,
    planId: plan === null ? null : plan.planId,
    source: "FALLBACK",
    plannerFallback: true,
    rejection,
    rationaleFailure,
    reasonCode: rejection === "PLAN_OUT_OF_ENVELOPE" ? "PLAN_OUT_OF_ENVELOPE" : null,
    selection: null,
    rationale: plan === null ? null : templateRationale(plan),
    deviatesFromEvaluator: plan !== null && topPlanId !== null && plan.planId !== topPlanId,
    topPlanId,
  };
}

/** Total: never throws, always returns a member of the feasible set (or null = nothing payable). */
export function resolvePlanSelection(input: ResolveInput): PlannerResolution {
  try {
    const set = checkPlanSet(input.plans, input.params, null);
    if (!set.ok) return { ...fallbackResolution([], input.params, "PLAN_SET_INVALID", null, null), plan: null, planId: null, rationale: null };
    const evaluation = set.evaluation;
    if (input.absent !== undefined) return fallbackResolution(input.plans, input.params, input.absent, null, evaluation.topPlanId);
    if (input.raw === null || input.raw === undefined) return fallbackResolution(input.plans, input.params, "NO_SUBMISSION", null, evaluation.topPlanId);
    const v = validatePlanSelection(input.raw, input.plans, evaluation);
    if (!v.ok) return fallbackResolution(input.plans, input.params, v.rejection, v.rationaleFailure ?? null, evaluation.topPlanId);
    return {
      plan: v.plan,
      planId: v.plan.planId,
      source: "PLANNER",
      plannerFallback: false,
      rejection: null,
      rationaleFailure: null,
      reasonCode: null,
      selection: v.selection,
      rationale: inspectUntrusted(v.selection.rationale),
      deviatesFromEvaluator: v.selection.deviatesFromEvaluator,
      topPlanId: evaluation.topPlanId,
    };
  } catch {
    return { ...fallbackResolution([], input.params, "INTERNAL_ERROR", null, null), plan: null, planId: null, rationale: null };
  }
}

// --- the model call ------------------------------------------------------------------------------------------------------

export interface PlannerConfig {
  readonly model: string;
  /** Total model turns (read_context rounds + the submission). Default 3. */
  readonly maxTurns?: number;
  readonly maxOutputTokens?: number;
}

export interface PlannerDeps {
  readonly llm: BudgetedLlm;
  readonly sink?: AgentCallSink;
}

export interface PlannerRun {
  readonly resolution: PlannerResolution;
  readonly calls: readonly AgentCallRecord[];
  /** false when the choice was trivial (at most one payable plan): no model call was made or paid for. */
  readonly modelCalled: boolean;
  readonly promptHash: Hex32;
  /** keccak256(JCS(facts)): the planner input hash recorded next to the receipt's planEvaluationHash. */
  readonly inputHash: Hex32;
}

const MAX_CONTEXT_CHARS = 16_000;

/**
 * Ask the planner to choose, then resolve. NEVER throws and never returns anything outside the feasible set. With
 * fewer than two payable plans there is nothing to choose and no paid call is made.
 */
export async function runPlanner(snapshot: unknown, cfg: PlannerConfig, deps: PlannerDeps): Promise<PlannerRun> {
  const calls: AgentCallRecord[] = [];
  const promptHash = PROMPT_PLANNER.hash;
  const parsed = PlannerSnapshotSchema.safeParse(snapshot);
  const emptyParams: ScoreParams = { costOfCapitalBps: 0, referenceInstant: "1970-01-01T00:00:00Z" as ISODateTime, preferImmediate: false };
  if (!parsed.success) {
    return { resolution: resolvePlanSelection({ plans: [], params: emptyParams, raw: null }), calls, modelCalled: false, promptHash, inputHash: hashJcs({ invalid: true }) };
  }
  const s = parsed.data;
  const params: ScoreParams = s.params;
  const inputHash = hashJcs(plannerFacts(s));
  const set = checkPlanSet(s.plans, params, s.evaluation as PlanEvaluation);
  if (!set.ok) return { resolution: resolvePlanSelection({ plans: [], params, raw: null }), calls, modelCalled: false, promptHash, inputHash };
  const payable = s.plans.filter((p) => p.mode !== "HOLD");
  if (payable.length < 2) {
    // Nothing to choose between: the deterministic default is the answer (and is what the kernel would schedule).
    return { resolution: resolvePlanSelection({ plans: s.plans, params, raw: null, absent: "TRIVIAL_CHOICE" }), calls, modelCalled: false, promptHash, inputHash };
  }

  const context = plannerContextProvider(s);
  const maxTurns = cfg.maxTurns ?? 3;
  const messages: LlmMessage[] = [{ role: "user", text: renderPlannerUserTurn(JSON.stringify(plannerFacts(s))) }];
  const done = (absent: PlannerRejection | undefined, raw: unknown): PlannerRun => ({
    resolution: resolvePlanSelection({ plans: s.plans, params, raw, ...(absent === undefined ? {} : { absent }) }),
    calls,
    modelCalled: true,
    promptHash,
    inputHash,
  });

  for (let turn = 1; turn <= maxTurns; turn++) {
    const request: LlmRequest = {
      role: "planner",
      model: cfg.model,
      system: PROMPT_PLANNER.system,
      messages: [...messages],
      tools: PROMPT_PLANNER.tools,
      toolChoice: turn === maxTurns ? { type: "tool", name: SUBMIT_PLAN_SELECTION } : { type: "any" },
      maxOutputTokens: cfg.maxOutputTokens ?? 1024,
    };
    let result;
    try {
      result = await deps.llm.call(request);
    } catch (e) {
      if (e instanceof BudgetExhaustedError) return done("BUDGET", null);
      if (e instanceof ProviderError) return done("PROVIDER", null);
      return done("INTERNAL_ERROR", null);
    }
    const record = toCallRecord({ role: "planner", model: cfg.model, promptHash, turn, result });
    calls.push(record);
    if (deps.sink) {
      try {
        await deps.sink.record(record);
      } catch {
        // observability only; must never alter the decision
      }
    }
    const tcs = result.response.toolCalls;
    if (tcs.length === 0) return done("NO_SUBMISSION", null);
    if (tcs.some((c) => c.name !== SUBMIT_PLAN_SELECTION && c.name !== READ_CONTEXT)) {
      await deps.llm.evict(result.cacheKey);
      return done("DISALLOWED_TOOL", null);
    }
    const submits = tcs.filter((c) => c.name === SUBMIT_PLAN_SELECTION);
    if (submits.length > 1 || (submits.length === 1 && tcs.length > 1)) {
      await deps.llm.evict(result.cacheKey);
      return done("AMBIGUOUS_SUBMISSION", null);
    }
    const submit = submits[0];
    if (submit !== undefined) {
      const run = done(undefined, submit.input);
      if (run.resolution.source === "FALLBACK") await deps.llm.evict(result.cacheKey); // do not replay a rejected answer for free
      return run;
    }
    messages.push({ role: "assistant", toolCalls: tcs });
    for (const c of tcs) {
      const k = PlannerReadContextInputSchema.safeParse(c.input);
      let text: string;
      if (!k.success) {
        text = JSON.stringify({ error: `kind must be one of ${PLANNER_CONTEXT_KINDS.join(", ")}` });
      } else {
        text = JSON.stringify(await context.read(k.data.kind));
        if (text.length > MAX_CONTEXT_CHARS) text = JSON.stringify({ truncated: true });
      }
      messages.push({ role: "tool_result", callId: c.id, text });
    }
  }
  return done("TOO_MANY_TURNS", null);
}
