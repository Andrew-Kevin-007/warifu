// D4 Advisory (AI) note (docs/03 section 6, INV-20, RT-12, ATK-24). OPTIONAL and advisory: the human-facing
// explanation is TEMPLATED by the kernel from structured facts (WP-05). This module only produces an extra short
// note that the UI shows collapsed, labelled "Advisory (AI), not verified", rendered through <UntrustedText>,
// never next to the Approve button.
//
// Defences, in order (every one fails closed: the note is optional, so any doubt means no note):
//   1. the model sees ONLY kernel-derived structured facts (codes, ids, a formatted amount), never document text,
//      so there is no attacker text for it to echo;
//   2. the raw note must be short (<= 60 words, <= 600 chars), must not end with an ellipsis, and must pass
//      sanitizeLlmText UNCHANGED (run once with no cap, compared with the whitespace-folded raw text for exact
//      equality): anything the sanitizer would scrub or truncate means the note is DROPPED, never patched;
//   3. the text must already be in NFKC form (no full-width / compatibility characters, no non-ASCII digits);
//   4. faithfulness: every check id, reason/anomaly code and number in the note must exist in the facts; spelled-out
//      numbers and verdict-like words ("release", "approved", "safe", ...) other than the decision's own are refused;
//   5. (when the document text is available) any run of 5 words shared with the document drops the note (ATK-24);
//   6. any failure (budget, provider, validation) yields no note. Nothing depends on it.
import { inspectUntrusted, REASON_CODES, ANOMALY_CODES, sanitizeLlmText, untrusted, type CheckId, type Decision, type ReasonCode, type Untrusted, type Verdict } from "@symbolon/schemas";
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

export type FaithfulnessFailure = "UNFAITHFUL_CHECK_ID" | "UNFAITHFUL_CODE" | "UNFAITHFUL_NUMBER" | "NUMBER_WORD" | "VERDICT_WORD" | "NON_CANONICAL_TEXT";

export type AdvisoryRejection =
  | "EMPTY"
  | "TOO_LONG"
  | "ENDS_WITH_ELLIPSIS"
  | "SANITIZER_REMOVED_CONTENT"
  | "COPIES_DOCUMENT_TEXT"
  | FaithfulnessFailure;

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

const NUMBER_WORDS = [
  "zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen",
  "fifteen", "sixteen", "seventeen", "eighteen", "nineteen", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty",
  "ninety", "hundred", "thousand", "million", "billion", "trillion", "percent", "half", "double", "twice", "thrice", "dozen", "triple",
];
// A letter run made ONLY of number words ("twentyfive", "onethousand") is a spelled-out number; whole-word match so
// that "money" or "someone" are not flagged.
const NUMBER_WORD_RE = new RegExp(`^(?:${NUMBER_WORDS.join("|")})+$`);

/** Stems of verdict-like words and the verdict that is allowed to use each ("" = never allowed). */
const VERDICT_STEMS: ReadonlyArray<readonly [stem: string, allowedFor: Verdict | ""]> = [
  ["release", "RELEASE"],
  ["escalat", "ESCALATE"],
  ["reject", "REJECT"],
  ["replay", "REPLAY"],
  ["hold", "HOLD"],
  ["approv", ""],
  ["unsafe", ""],
  ["safe", ""],
];

/**
 * Faithfulness check (docs/03 section 6): every check id, code and number mentioned must exist in the facts.
 * The text is NFKC-folded first so full-width / compatibility forms cannot hide a number or id; any non-ASCII digit
 * is refused; spelled-out numbers and verdict-like words other than the decision's own are refused.
 * Also usable on the kernel's templated explanation in the eval.
 */
export function checkFaithfulness(text: string, facts: AdvisoryFacts): { ok: true } | { ok: false; reason: FaithfulnessFailure } {
  const folded = text.normalize("NFKC");
  const bad = (reason: FaithfulnessFailure) => ({ ok: false as const, reason });

  // The scans below run in the DENY direction and are deliberately unanchored (no \b): anything that merely LOOKS like
  // a check id or code is compared by exact equality against the allowed set, so "K-99x" or "XK-06" cannot hide.
  const checkIds = new Set<string>(facts.checks.map((c) => c.id));
  for (const m of folded.matchAll(/[Kk]-\d+/g)) if (!checkIds.has(m[0])) return bad("UNFAITHFUL_CHECK_ID");

  const allowedCodes = new Set<string>([...facts.reasons, ...facts.anomalyCodes, ...facts.checks.flatMap((c) => (c.code === null ? [] : [c.code]))]);
  for (const m of folded.matchAll(/[A-Za-z][A-Za-z0-9]*(?:_[A-Za-z0-9]+)+/g)) if (!allowedCodes.has(m[0])) return bad("UNFAITHFUL_CODE");
  for (const m of folded.matchAll(/[A-Z]{3,}/g)) {
    const word = m[0];
    if (word === facts.verdict || allowedCodes.has(word)) continue;
    if (ALL_CODES.has(word) || /^(?:RELEASE|HOLD|ESCALATE|REJECT|REPLAY)$/.test(word)) return bad("UNFAITHFUL_CODE");
  }

  // Digits: ASCII only, and every numeric token must come from the facts (check ids removed first).
  if (/\p{Nd}/u.test(folded.replace(/[0-9]/g, ""))) return bad("UNFAITHFUL_NUMBER");
  const stripped = folded.replace(/[Kk]-\d+/g, " ");
  const allowedNumbers = new Set<string>();
  if (facts.amountDisplay !== null) {
    allowedNumbers.add(facts.amountDisplay);
    for (const n of facts.amountDisplay.match(/\d[\d,]*(?:\.\d+)?/g) ?? []) allowedNumbers.add(n);
  }
  for (const m of stripped.matchAll(/\d[\d,.]*\d|\d/g)) {
    if (!allowedNumbers.has(m[0].replace(/[.,]+$/, ""))) return bad("UNFAITHFUL_NUMBER");
  }

  // Spelled-out numbers and verdict-like words, per whole letter run (hyphen/space separated), case-insensitive.
  for (const run of folded.toLowerCase().split(/[^\p{L}]+/u)) {
    if (run.length === 0) continue;
    if (NUMBER_WORD_RE.test(run)) return bad("NUMBER_WORD");
    for (const [stem, allowedFor] of VERDICT_STEMS) {
      if (run.startsWith(stem) && allowedFor !== facts.verdict) return bad("VERDICT_WORD");
    }
  }

  if (folded !== text) return bad("NON_CANONICAL_TEXT"); // compatibility forms (full-width, math alphanumerics, ligatures, ...)
  return { ok: true };
}

export interface AdvisoryOptions {
  /** Normalized document text, when available, for the shared-word-run check (ATK-24). */
  readonly sourceText?: Untrusted<string>;
  readonly maxWords?: number;
  readonly maxChars?: number;
  /** Shared consecutive-word run that causes the note to be dropped. Default 5. */
  readonly overlapN?: number;
}

export function validateAdvisoryNote(raw: string, facts: AdvisoryFacts, options: AdvisoryOptions = {}): AdvisoryValidation {
  const maxWords = options.maxWords ?? 60;
  const maxChars = options.maxChars ?? 600;
  const rawFolded = raw.replace(/\s+/g, " ").trim();
  if (rawFolded.length === 0) return { ok: false, reason: "EMPTY" };
  // An ellipsis at the end is how a truncation marker looks; a model could add one to slip past equality checks.
  if (/(?:…|\.\.\.)$/.test(rawFolded)) return { ok: false, reason: "ENDS_WITH_ELLIPSIS" };
  if (Array.from(rawFolded).length > maxChars || rawFolded.split(" ").length > maxWords) return { ok: false, reason: "TOO_LONG" };

  // Sanitize ONCE, with no word cap and a char cap far above the input, and demand exact equality: any scrubbed
  // or truncated content (silent or marked) means the note was not clean to begin with.
  const sanitized = inspectUntrusted(sanitizeLlmText(raw, { maxChars: Array.from(raw).length * 2 + 64 }));
  if (sanitized !== rawFolded) return { ok: false, reason: "SANITIZER_REMOVED_CONTENT" };

  const f = checkFaithfulness(sanitized, facts);
  if (!f.ok) return f;
  if (options.sourceText !== undefined) {
    const n = options.overlapN ?? 5;
    const doc = ngrams(words(inspectUntrusted(options.sourceText)), n);
    const note = words(sanitized);
    for (let i = 0; i + n <= note.length; i++) if (doc.has(note.slice(i, i + n).join(" "))) return { ok: false, reason: "COPIES_DOCUMENT_TEXT" };
  }
  return { ok: true, note: { text: untrusted(sanitized), label: "Advisory (AI), not verified", collapsed: true } };
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
