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
import { inspectUntrusted, REASON_CODES, ANOMALY_CODES, CHECK_IDS, VERDICTS, sanitizeLlmText, untrusted, type CheckId, type Decision, type ReasonCode, type Untrusted, type Verdict } from "@symbolon/schemas";
import { toCallRecord, type AgentCallRecord } from "./calls";
import type { BudgetedLlm } from "./llm/budget";
import { PROMPT_ADVISORY, renderAdvisoryUserTurn } from "./prompts";
import { ADVISORY_VOCABULARY, VERDICT_FORMS } from "./advisory-vocab";
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

const REASON_SET: ReadonlySet<string> = new Set<string>(REASON_CODES);
const ANOMALY_SET: ReadonlySet<string> = new Set<string>(ANOMALY_CODES);
const CHECK_ID_SET: ReadonlySet<string> = new Set<string>(CHECK_IDS);
const VERDICT_SET: ReadonlySet<string> = new Set<string>(VERDICTS);
/** A kernel-formatted amount: digits with "," groups and an optional fraction (formatBaseUnits output). */
const KERNEL_AMOUNT_RE = /^(?:0|[1-9][0-9]{0,2}(?:,[0-9]{3})*|[1-9][0-9]*)(?:\.[0-9]{1,36})?$/;

/**
 * Build the ONLY input the advisory model ever sees. "No attacker input reaches the advisory model" is enforced
 * here, in code: every field is filtered against a closed kernel enum (REASON_CODES, ANOMALY_CODES, CHECK_IDS,
 * VERDICTS) or a strict amount format, and anything else is DROPPED, so a quote, a payee name or any
 * attacker-controlled string passed by mistake cannot reach the prompt.
 */
export function buildAdvisoryFacts(
  decision: Pick<Decision, "verdict" | "checks" | "reasons">,
  extras: { readonly amountDisplay: string | null; readonly anomalyCodes: readonly string[] },
): AdvisoryFacts {
  const verdict = VERDICT_SET.has(decision.verdict) ? decision.verdict : "HOLD"; // unknown verdict: the most conservative one
  return {
    verdict,
    checks: decision.checks
      .filter((c) => CHECK_ID_SET.has(c.id))
      .map((c) => ({ id: c.id, status: c.status, code: c.code !== null && REASON_SET.has(c.code) ? c.code : null })),
    reasons: decision.reasons.filter((r) => REASON_SET.has(r)),
    amountDisplay: extras.amountDisplay !== null && KERNEL_AMOUNT_RE.test(extras.amountDisplay) ? extras.amountDisplay : null,
    anomalyCodes: [...new Set(extras.anomalyCodes.filter((a) => ANOMALY_SET.has(a)))],
  };
}

export type FaithfulnessFailure = "UNFAITHFUL_CHECK_ID" | "UNFAITHFUL_CODE" | "UNFAITHFUL_NUMBER" | "NUMBER_WORD" | "VERDICT_WORD" | "OUT_OF_VOCABULARY" | "NON_CANONICAL_TEXT";

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
// that "money" or "someone" are not flagged by THIS check (they are still refused by the vocabulary).
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
 * ONE tokenizer for every check (SEC review: separate regex scans can split the same text differently). The
 * NFKC-folded note is split on whitespace and on delimiter punctuation (; : ! ? ( ) [ ] { } " `), then leading and
 * trailing "." and "," are trimmed from each token (sentence punctuation). Nothing else is split: "1.000,00",
 * "5k", "K-06x", "fifty-fifty", "doesn't", "50%" and "PAYEE_MISMATCH" each stay ONE token and are judged whole.
 */
export function tokenizeNote(folded: string): string[] {
  return folded
    .split(/[\s;:!?()[\]{}"`]+/)
    .map((t) => t.replace(/^[.,]+|[.,]+$/g, ""))
    .filter((t) => t.length > 0);
}

const WORD_TOKEN_RE = /^\p{L}+(?:-\p{L}+)*$/u;

export interface FaithfulnessOptions {
  /**
   * true (default, the advisory note): every word must be in the closed vocabulary or an exact fact token.
   * false (the kernel's templated explanation in the eval): only check ids, codes and numbers are enforced.
   */
  readonly strictVocabulary?: boolean;
}

/**
 * Faithfulness + allowlist check (docs/03 section 6). The text is NFKC-folded and tokenized once; each token is
 * classified exactly one way:
 *   * check id "K-nn" (exactly): must be a check id of this decision;
 *   * any other token containing "K-<digit>": rejected (UNFAITHFUL_CHECK_ID);
 *   * any token containing a digit: allowed only if it equals facts.amountDisplay exactly (digits glued to letters,
 *     other separators, signs, percent, non-ASCII digits all reject: UNFAITHFUL_NUMBER);
 *   * token with "_": must be exactly an allowed reason/anomaly code (UNFAITHFUL_CODE);
 *   * UPPER-CASE code or verdict word that is not this decision's: UNFAITHFUL_CODE;
 *   * word tokens (letters, optionally hyphenated): each part must be in ADVISORY_VOCABULARY, in the words of the
 *     decision's own codes, or in the decision's own verdict forms; spelled-out numbers and other verdict-like
 *     words get their specific rejection first (NUMBER_WORD, VERDICT_WORD), everything else is OUT_OF_VOCABULARY.
 * If every token passes but folding changed the text, the note used compatibility forms: NON_CANONICAL_TEXT.
 */
export function checkFaithfulness(text: string, facts: AdvisoryFacts, options: FaithfulnessOptions = {}): { ok: true } | { ok: false; reason: FaithfulnessFailure } {
  const strict = options.strictVocabulary !== false;
  const folded = text.normalize("NFKC");
  const bad = (reason: FaithfulnessFailure) => ({ ok: false as const, reason });

  const checkIds = new Set<string>(facts.checks.map((c) => c.id));
  const allowedCodes = new Set<string>([...facts.reasons, ...facts.anomalyCodes, ...facts.checks.flatMap((c) => (c.code === null ? [] : [c.code]))]);
  const allowedWords = new Set<string>(VERDICT_FORMS[facts.verdict]);
  for (const code of allowedCodes) for (const part of code.toLowerCase().split("_")) allowedWords.add(part);

  for (const tok of tokenizeNote(folded)) {
    if (/^[Kk]-[0-9]+$/.test(tok)) {
      if (!checkIds.has(tok)) return bad("UNFAITHFUL_CHECK_ID");
      continue;
    }
    if (/[Kk]-[0-9]/.test(tok)) return bad("UNFAITHFUL_CHECK_ID");
    if (/\p{Nd}/u.test(tok)) {
      if (facts.amountDisplay !== null && tok === facts.amountDisplay) continue;
      return bad("UNFAITHFUL_NUMBER");
    }
    if (tok.includes("_")) {
      if (!allowedCodes.has(tok)) return bad("UNFAITHFUL_CODE");
      continue;
    }
    if (/^[A-Z]{3,}$/.test(tok) && tok !== facts.verdict && !allowedCodes.has(tok)) {
      if (ALL_CODES.has(tok) || /^(?:RELEASE|HOLD|ESCALATE|REJECT|REPLAY)$/.test(tok)) return bad("UNFAITHFUL_CODE");
    }
    if (!strict) continue;
    if (!WORD_TOKEN_RE.test(tok)) return bad("OUT_OF_VOCABULARY"); // %, +, -, &, apostrophes, mixed scripts, symbols
    for (const part of tok.toLowerCase().split("-")) {
      if (NUMBER_WORD_RE.test(part)) return bad("NUMBER_WORD");
      for (const [stem, allowedFor] of VERDICT_STEMS) if (part.startsWith(stem) && allowedFor !== facts.verdict) return bad("VERDICT_WORD");
      if (!ADVISORY_VOCABULARY.has(part) && !allowedWords.has(part)) return bad("OUT_OF_VOCABULARY");
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
