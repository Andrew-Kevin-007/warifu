// Untrusted text (INV-15, INV-23; AGENTS.md §0.8; docs/03 §2 guardrails 7-8).
//
// `Untrusted<string>` is a phantom type: at runtime the value IS a plain string (so it serializes,
// hashes and stores like one), but the type checker treats it as an opaque object. It is therefore
// NOT assignable to `string`, cannot be passed as a React child or to string APIs, and can only leave
// the brand through a named function:
//   - toExcerpt(u)        -> sanitized single-line excerpt (for <UntrustedText>, excerpts, tables);
//   - toLogSafe(u)        -> JSON-escaped, truncated excerpt + length + sha256 (for logs, INV-15);
//   - inspectUntrusted(u) -> the raw string, for PURE parsing/comparison/hashing only (kernel checks,
//                            consensus, delimited LLM data blocks). Never for HTML, URLs, SQL, shell,
//                            logs or instructions. apps/web should never need it.
import * as z from "zod";
import { sha256Utf8 } from "./hash";
import { isWellFormedString } from "./jcs";

declare const UNTRUSTED: unique symbol;

/** Text that originated outside our trust boundary. Runtime representation: the string itself. */
export type Untrusted<T extends string = string> = { readonly [UNTRUSTED]: T };

/** Mark a string as untrusted. This is the only way in; there is no generic way out. */
export function untrusted(s: string): Untrusted<string> {
  if (typeof s !== "string") throw new TypeError("untrusted() expects a string");
  return s as unknown as Untrusted<string>;
}

/** The raw string, for pure parsing, comparison and hashing ONLY (see module comment). */
export function inspectUntrusted(u: Untrusted<string>): string {
  return u as unknown as string;
}

/** Zod schema for untrusted text: a bounded, well-formed string on the wire, `Untrusted<string>` in TS. */
export function untrustedText(max: number): z.ZodType<Untrusted<string>, string> {
  return z
    .string()
    .max(max)
    .refine(isWellFormedString, "string contains a lone UTF-16 surrogate") as unknown as z.ZodType<Untrusted<string>, string>;
}

// ---------------------------------------------------------------------------------------------
// normalizeUntrusted (guardrail 7). Pure string ops; no NFKC (that would change visible content;
// K-11 applies its own NFKC/homoglyph folding on top).

export interface NormalizeCounts {
  /** C0 controls except \t and \n (CR of a CRLF pair is folded, not counted), DEL, C1 controls. */
  readonly control: number;
  /** Zero-width and other invisible format characters. */
  readonly zeroWidth: number;
  /** Bidirectional formatting characters (embeddings, overrides, isolates, marks). */
  readonly bidi: number;
  /** Lone UTF-16 surrogates (not valid Unicode text). */
  readonly invalid: number;
}

export interface NormalizeResult {
  readonly normalized: Untrusted<string>;
  /** Total characters removed = sum of `counts`. Non-zero ⇒ anomaly HIDDEN_CHARS. */
  readonly removedCount: number;
  readonly counts: NormalizeCounts;
}

type Category = keyof NormalizeCounts;

function classify(cp: number): Category | null {
  if (cp <= 0x1f) return cp === 0x09 || cp === 0x0a ? null : "control";
  if (cp >= 0x7f && cp <= 0x9f) return "control";
  // Spec set (docs/03 §2 guardrail 7): U+200B–U+200F, U+202A–U+202E, U+2066–U+2069, U+FEFF.
  if (cp === 0x200b || cp === 0x200c || cp === 0x200d || cp === 0xfeff) return "zeroWidth";
  if (cp === 0x200e || cp === 0x200f) return "bidi";
  if (cp >= 0x202a && cp <= 0x202e) return "bidi";
  if (cp >= 0x2066 && cp <= 0x2069) return "bidi";
  // Extension (same intent, logged in docs/QUESTIONS.md): other invisible characters used to hide
  // text from humans while models still read it.
  if (cp === 0x061c) return "bidi"; // ARABIC LETTER MARK
  if (cp >= 0x2060 && cp <= 0x2064) return "zeroWidth"; // WORD JOINER, invisible operators
  if (cp === 0x00ad || cp === 0x034f || cp === 0x180e) return "zeroWidth"; // SOFT HYPHEN, CGJ, MVS
  if (cp >= 0xe0000 && cp <= 0xe007f) return "zeroWidth"; // TAG characters ("ASCII smuggling")
  return null;
}

/**
 * Strip control, zero-width, bidi and invalid characters from untrusted text and count them.
 * CRLF becomes LF (not counted); a lone CR is a control character. Tabs and newlines are kept.
 */
export function normalizeUntrusted(input: string | Untrusted<string>): NormalizeResult {
  const s = input as unknown as string;
  const counts: Record<Category, number> = { control: 0, zeroWidth: 0, bidi: 0, invalid: 0 };
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    let cp = c;
    let width = 1;
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = i + 1 < s.length ? s.charCodeAt(i + 1) : 0;
      if (next >= 0xdc00 && next <= 0xdfff) {
        cp = (c - 0xd800) * 0x400 + (next - 0xdc00) + 0x10000;
        width = 2;
      } else {
        counts.invalid++;
        continue;
      }
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      counts.invalid++;
      continue;
    }
    if (cp === 0x0d && i + 1 < s.length && s.charCodeAt(i + 1) === 0x0a) {
      continue; // CRLF -> LF: drop the CR, keep the LF on the next iteration
    }
    const cat = classify(cp);
    if (cat !== null) {
      counts[cat]++;
    } else {
      out += width === 2 ? s.slice(i, i + 2) : s.charAt(i);
    }
    i += width - 1;
  }
  const removedCount = counts.control + counts.zeroWidth + counts.bidi + counts.invalid;
  return { normalized: untrusted(out), removedCount, counts };
}

// ---------------------------------------------------------------------------------------------
// Excerpts and log-safe forms

function truncateCodePoints(s: string, max: number): string {
  const cps = Array.from(s);
  if (cps.length <= max) return s;
  if (max <= 0) return "";
  return `${cps.slice(0, max - 1).join("")}…`;
}

/**
 * Sanitized single-line excerpt of untrusted text: normalized (guardrail 7), whitespace collapsed,
 * at most `max` code points (an ellipsis marks truncation). Still render it as a text node.
 */
export function toExcerpt(u: Untrusted<string> | string, max = 240): string {
  const { normalized } = normalizeUntrusted(u);
  const oneLine = inspectUntrusted(normalized).replace(/\s+/g, " ").trim();
  return truncateCodePoints(oneLine, max);
}

/** Log form of untrusted text: escaped, truncated excerpt plus length and sha256 of the original (INV-15). */
export function toLogSafe(u: Untrusted<string> | string, max = 120): string {
  const raw = u as unknown as string;
  const hash = isWellFormedString(raw) ? sha256Utf8(raw) : "n/a(ill-formed)";
  return `${JSON.stringify(toExcerpt(u, max))} (len=${raw.length}, sha256=${hash})`;
}

// ---------------------------------------------------------------------------------------------
// sanitizeLlmText (guardrail 8): strip URLs, markdown links/images, HTML and imperative/urgency
// language from LLM prose before it is stored or shown; length-cap; brand as Untrusted.

export interface SanitizeOptions {
  /** Maximum code points (default 600, the PlanSelection.rationale cap). */
  readonly maxChars?: number;
  /** Optional maximum word count (e.g. 60 for the Advisory (AI) note). */
  readonly maxWords?: number;
}

// Braces, not brackets: a "[removed]" token followed by ":" would be read as a markdown link definition on
// the next pass and delete the rest of the line (found by the idempotence property test).
const LINK_TOKEN = "{link}";
const REMOVED_TOKEN = "{removed}";
const URL_END = "[^\\s<>\"'`)\\]]*";

const HTML_RULES: ReadonlyArray<readonly [RegExp, string]> = [
  [/<!--[\s\S]*?-->/g, " "],
  [/<\/?[a-z!?][^>]*>/gi, " "],
  [/[<>]/g, " "],
];

const MARKDOWN_RULES: ReadonlyArray<readonly [RegExp, string]> = [
  [/!\[([^\]]*)\]\([^)]*\)/g, "$1"], // images
  [/\[([^\]]*)\]\([^)]*\)/g, "$1"], // inline links
  [/\[([^\]]*)\]\[[^\]]*\]/g, "$1"], // reference links
  [/^[ \t]*\[[^\]]+\]:[ \t]*\S+.*$/gm, " "], // link definitions
  [/`+/g, " "],
];

const URL_RULES: ReadonlyArray<readonly [RegExp, string]> = [
  // No \b: "0https://x" has no word boundary before the scheme.
  [new RegExp(`[a-z][a-z0-9+.-]*://${URL_END}`, "gi"), LINK_TOKEN],
  // Script-capable schemes match even when glued to a preceding word (e.g. "t" left over from a removed link).
  [new RegExp(`(?:javascript|vbscript|data):${URL_END}`, "gi"), LINK_TOKEN],
  [new RegExp(`\\b(?:file|blob|mailto|tel|sms|intent):${URL_END}`, "gi"), LINK_TOKEN],
  [new RegExp(`\\bwww\\.${URL_END}`, "gi"), LINK_TOKEN],
  [new RegExp(`\\b[a-z0-9][a-z0-9-]{0,62}(?:\\.[a-z0-9][a-z0-9-]{0,62})*\\.[a-z]{2,24}/${URL_END}`, "gi"), LINK_TOKEN],
];

const IMPERATIVE_RULES: ReadonlyArray<RegExp> = [
  /\b(?:urgent(?:ly)?|immediately|asap|right away|act now|hurry(?: up)?|time[- ]sensitive|final notice|last chance|without delay)\b/gi,
  /\b(?:please\s+)?(?:click|press|tap)\s+(?:here|on\s+[\w-]+|the\s+[\w-]+(?:\s+(?:button|link))?|approve|confirm|sign)\b/gi,
  /\b(?:you\s+(?:must|should|need\s+to|have\s+to)|must\s+be\s+(?:approved|paid|signed|released))\b/gi,
  /\bplease\s+(?:approve|sign|pay|release|confirm|authori[sz]e|transfer|send)\b/gi,
  /\b(?:approve|sign|pay|release|authori[sz]e)\s+(?:it\s+)?(?:now|today|immediately|right\s+away|at\s+once)\b/gi,
  /\b(?:do\s+not|don'?t)\s+(?:verify|check|wait|delay|review|question)\b/gi,
  /\bignore\s+(?:all|any|previous|prior|above|earlier)\b/gi,
  /\balready\s+(?:been\s+)?(?:approved|verified|authori[sz]ed|signed\s+off|confirmed)\b/gi,
  /\btell\s+(?:the\s+)?(?:owner|user|approver|them|him|her)\s+to\b/gi,
];

function sanitizeOnce(s: string, opts: Required<Pick<SanitizeOptions, "maxChars">> & SanitizeOptions): string {
  let t = inspectUntrusted(normalizeUntrusted(s).normalized);
  for (const [re, rep] of HTML_RULES) t = t.replace(re, rep);
  for (const [re, rep] of MARKDOWN_RULES) t = t.replace(re, rep);
  for (const [re, rep] of URL_RULES) t = t.replace(re, rep);
  for (const re of IMPERATIVE_RULES) t = t.replace(re, REMOVED_TOKEN);
  t = t.replace(/\s+/g, " ").trim();
  if (opts.maxWords !== undefined) {
    const words = t.split(" ").filter((w) => w.length > 0);
    if (words.length > opts.maxWords) t = `${words.slice(0, Math.max(0, opts.maxWords)).join(" ")}…`;
  }
  return truncateCodePoints(t, opts.maxChars);
}

/**
 * Sanitize LLM prose for storage/display. Idempotent: sanitizeLlmText(x) is a fixed point.
 * The result is still Untrusted and is rendered only through <UntrustedText>.
 */
export function sanitizeLlmText(input: string | Untrusted<string>, options: SanitizeOptions = {}): Untrusted<string> {
  const opts = { maxChars: options.maxChars ?? 600, ...(options.maxWords === undefined ? {} : { maxWords: options.maxWords }) };
  if (!Number.isInteger(opts.maxChars) || opts.maxChars < 1) throw new RangeError("maxChars must be a positive integer");
  let current = input as unknown as string;
  for (let i = 0; i < 16; i++) {
    const next = sanitizeOnce(current, opts);
    if (next === current) return untrusted(next);
    current = next;
  }
  // Did not converge (pathological input): fail closed to an inert placeholder.
  return untrusted(REMOVED_TOKEN);
}
