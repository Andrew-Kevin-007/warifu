// D4 Advisory (AI) note (docs/03 §6, INV-20, RT-12, ATK-24). OPTIONAL and advisory: the human-facing explanation
// is TEMPLATED by the kernel from structured facts (WP-05). This module only produces an extra short note that the
// UI shows collapsed, labelled "Advisory (AI), not verified", rendered through <UntrustedText>, never next to the
// Approve button.
//
// Defences, in order:
//   1. the model sees ONLY kernel-derived structured facts (codes, ids, a formatted amount), never document text,
//      so there is no attacker text for it to echo;
//   2. the output goes through sanitizeLlmText (URLs, markdown, HTML, imperative/urgency language) with a 60-word cap;
//      if sanitizing had to remove anything the note is DROPPED, not patched;
//   3. faithfulness: every check id, reason/anomaly code and number in the note must exist in the facts;
//   4. (when the document text is available) any run of 5 words shared with the document drops the note (ATK-24);
//   5. any failure (budget, provider, validation) yields no note. Nothing depends on it.
import { inspectUntrusted, REASON_CODES, ANOMALY_CODES, sanitizeLlmText, type CheckId, type Decision, type ReasonCode, type Untrusted, type Verdict } from "@symbolon/schemas";
import { toCallRecord, type AgentCallRecord } from "./calls";
import type { BudgetedLlm } from "./llm/budget";
import { PROMPT_ADVISORY, renderAdvisoryUserTurn } from "./prompts";
import { AdvisoryNoteInputSchema, SUBMIT_ADVISORY_NOTE } from "./tools";

/** Everything the model (and the faithfulness check) may rely on. Enums and a formatted amount only. */
export interface AdvisoryFacts {
  readonly verdict: Verdict;
  readonly checks: ReadonlyArray<{ readonly id: CheckId; readonly status: "PASS" | "FAIL" | "SKIP"; readonly code: ReasonCode | null }>;
  readonly reasons: readonly ReasonCode[];
  /** Amount rendered by the kernel's Money formatter, e.g. "1,000.00"; null when unknown. */
  readonly amountDisplay: string | null;
  /** Anomaly CODES only (never quotes). */
  readonly anomalyCodes: readonly string[];
}

export function buildAdvisoryFacts(
  decision: Pick<Decision, "verdict" | "checks" | "reasons">,
  extras: { readonly amountDisplay: string | null; readonly anomalyCodes: readonly string[] },
): AdvisoryFacts {
  return {
    verdict: decision.verdict,
    checks: decision.checks.map((c) => ({ id: c.id, status: c.status, code: c.code })),
    reasons: decision.reasons,
    amountDisplay: extras.amountDisplay,
    anomalyCodes: [...new Set(extras.anomalyCodes)],
  };
}

export type AdvisoryRejection = "EMPTY" | "SANITIZER_REMOVED_CONTENT" | "UNFAITHFUL_CHECK_ID" | "UNFAITHFUL_CODE" | "UNFAITHFUL_NUMBER" | "COPIES_DOCUMENT_TEXT";

export interface AdvisoryNote {
  readonly text: Untrusted<string>;
  readonly label: "Advisory (AI), not verified";
  /** The UI must render it collapsed and away from the Approve action (INV-20). */
  readonly collapsed: true;
}

export type AdvisoryValidation = { readonly ok: true; readonly note: AdvisoryNote } | { readonly ok: false; readonly reason: AdvisoryRejection };

const ALL_CODES: ReadonlySet<string> = new Set<string>([...REASON_CODES, ...ANOMALY_CODES]);

/** Words of the folded text (lowercase, letters/digits only) for n-gram comparison. */
function words(s: string): string[] {
  return s.normalize("NFKC").toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 0);
}

function ngrams(ws: readonly string[], n: number): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i + n <= ws.length; i++) out.add(ws.slice(i, i + n).join(" "));
  return out;
}

/**
 * Faithfulness check (docs/03 §6): every check id, code and number mentioned must exist in the facts.
 * Also usable on the kernel's templated explanation in the eval.
 */
export function checkFaithfulness(text: string, facts: AdvisoryFacts): { ok: true } | { ok: false; reason: "UNFAITHFUL_CHECK_ID" | "UNFAITHFUL_CODE" | "UNFAITHFUL_NUMBER" } {
  const checkIds = new Set<string>(facts.checks.map((c) => c.id));
  for (const m of text.matchAll(/\bK-\d{1,2}\b/g)) if (!checkIds.has(m[0])) return { ok: false, reason: "UNFAITHFUL_CHECK_ID" };

  const allowedCodes = new Set<string>([...facts.reasons, ...facts.anomalyCodes, ...facts.checks.flatMap((c) => (c.code === null ? [] : [c.code]))]);
  for (const m of text.matchAll(/\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b|\b(?:RELEASE|HOLD|ESCALATE|REJECT|REPLAY)\b/g)) {
    const tok = m[0];
    if (tok === facts.verdict) continue;
    if (ALL_CODES.has(tok) || tok.includes("_")) {
      if (!allowedCodes.has(tok)) return { ok: false, reason: "UNFAITHFUL_CODE" };
    } else {
      return { ok: false, reason: "UNFAITHFUL_CODE" }; // a verdict word that is not this decision's verdict
    }
  }

  // Numbers: after removing check ids, every numeric token must appear in the amount display or be a check number.
  const stripped = text.replace(/\bK-\d{1,2}\b/g, " ");
  const allowedNumbers = new Set<string>();
  if (facts.amountDisplay !== null) {
    allowedNumbers.add(facts.amountDisplay);
    for (const n of facts.amountDisplay.match(/\d[\d,]*(?:\.\d+)?/g) ?? []) allowedNumbers.add(n);
  }
  for (const m of stripped.matchAll(/\d[\d,.]*\d|\d/g)) {
    const tok = m[0].replace(/[.,]+$/, "");
    if (!allowedNumbers.has(tok)) return { ok: false, reason: "UNFAITHFUL_NUMBER" };
  }
  return { ok: true };
}

export interface AdvisoryOptions {
  /** Normalized document text, when available, for the shared-word-run check (ATK-24). */
  readonly sourceText?: Untrusted<string>;
  readonly maxWords?: number;
  /** Shared consecutive-word run that causes the note to be dropped. Default 5. */
  readonly overlapN?: number;
}

export function validateAdvisoryNote(raw: string, facts: AdvisoryFacts, options: AdvisoryOptions = {}): AdvisoryValidation {
  const maxWords = options.maxWords ?? 60;
  const sanitized = inspectUntrusted(sanitizeLlmText(raw, { maxChars: 600, maxWords }));
  if (sanitized.length === 0) return { ok: false, reason: "EMPTY" };
  // If the sanitizer had to scrub anything (links, imperatives, HTML), the note was not clean to begin with: drop it.
  const rawFolded = raw.replace(/\s+/g, " ").trim();
  const truncated = sanitized.endsWith("…");
  if (/\{removed\}|\{link\}/.test(sanitized)) return { ok: false, reason: "SANITIZER_REMOVED_CONTENT" };
  if (!truncated && sanitized !== rawFolded) return { ok: false, reason: "SANITIZER_REMOVED_CONTENT" };
  const f = checkFaithfulness(sanitized, facts);
  if (!f.ok) return f;
  if (options.sourceText !== undefined) {
    const n = options.overlapN ?? 5;
    const doc = ngrams(words(inspectUntrusted(options.sourceText)), n);
    const note = words(sanitized);
    for (let i = 0; i + n <= note.length; i++) if (doc.has(note.slice(i, i + n).join(" "))) return { ok: false, reason: "COPIES_DOCUMENT_TEXT" };
  }
  return { ok: true, note: { text: sanitizeLlmText(sanitized, { maxChars: 600, maxWords }), label: "Advisory (AI), not verified", collapsed: true } };
}

export interface AdvisoryResult {
  readonly note: AdvisoryNote | null;
  /** Why there is no note (absent when there is one). Never contains model text. */
  readonly omitted?: AdvisoryRejection | "BUDGET" | "PROVIDER" | "NO_SUBMISSION";
  readonly calls: readonly AgentCallRecord[];
}

/** Ask the advisory model for a note. Never throws; returns note=null on any problem. */
export async function generateAdvisoryNote(
  facts: AdvisoryFacts,
  cfg: { readonly model: string; readonly maxOutputTokens?: number },
  deps: { readonly llm: BudgetedLlm },
  options: AdvisoryOptions = {},
): Promise<AdvisoryResult> {
  try {
    const result = await deps.llm.call({
      role: "advisory",
      model: cfg.model,
      system: PROMPT_ADVISORY.system,
      messages: [{ role: "user", text: renderAdvisoryUserTurn(JSON.stringify(facts)) }],
      tools: PROMPT_ADVISORY.tools,
      toolChoice: { type: "tool", name: SUBMIT_ADVISORY_NOTE },
      maxOutputTokens: cfg.maxOutputTokens ?? 256,
    });
    const record = toCallRecord({ role: "advisory", model: cfg.model, promptHash: PROMPT_ADVISORY.hash, turn: 1, result });
    const call = result.response.toolCalls.find((c) => c.name === SUBMIT_ADVISORY_NOTE);
    const parsed = call === undefined ? null : AdvisoryNoteInputSchema.safeParse(call.input);
    if (parsed === null || !parsed.success) {
      await deps.llm.evict(result.cacheKey);
      return { note: null, omitted: "NO_SUBMISSION", calls: [record] };
    }
    const v = validateAdvisoryNote(parsed.data.note, facts, options);
    if (!v.ok) {
      await deps.llm.evict(result.cacheKey);
      return { note: null, omitted: v.reason, calls: [record] };
    }
    return { note: v.note, calls: [record] };
  } catch (e) {
    const name = e instanceof Error ? e.name : "";
    return { note: null, omitted: name === "BudgetExhaustedError" ? "BUDGET" : "PROVIDER", calls: [] };
  }
}
