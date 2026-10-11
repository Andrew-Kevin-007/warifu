// Deterministic amount parser: an independent cross-check on the model's `parsedBaseUnits`.
//
// It follows the K-02 grammar (docs/04 section 4, K-02) but is deliberately STRICTER: wherever the extractor and the
// kernel could read one string differently, this parser refuses (`invalid`/`ambiguous`) rather than guess, so
// the kernel escalates (K-02 step 5, AMOUNT_AMBIGUOUS). Concretely it does not NFKC-fold (full-width digits,
// unicode minus signs etc. are refused, not folded), accepts only the K-02 grouping characters (space, NBSP,
// thin space, ASCII apostrophe), accepts a currency token only from the closed, case-sensitive list in
// currency.ts and only as a single prefix or suffix of the whole string, refuses leading zeros, and refuses any
// string in which normalizeUntrusted() would remove a character. The raw `printed` string is never rewritten (it
// stays the verbatim document substring so K-02 can re-parse it).
//
// The pipeline keeps the model's `parsedBaseUnits` only when this parser reproduces it exactly (validate.ts).
// Money is bigint (INV-10): no Number(), no parseFloat, no toFixed. Source is ASCII-only on purpose: special
// characters are written as explicit escapes inside RegExp strings so they are visible in review.
import { normalizeUntrusted } from "@symbolon/schemas";
import { currencyAlternation } from "../currency";

export type AmountInvalidReason =
  | "EMPTY"
  | "HIDDEN_CHARS"
  | "NON_ASCII_DIGITS"
  | "SCIENTIFIC"
  | "NEGATIVE_OR_SIGNED"
  | "UNEXPECTED_CHARACTERS"
  | "BAD_FORMAT"
  | "BAD_GROUPING"
  | "LEADING_ZERO"
  | "TOO_MANY_DECIMALS"
  | "TOO_LONG"
  | "BAD_DECIMALS";

export type AmountParse =
  | {
      readonly kind: "ok";
      readonly baseUnits: bigint;
      /** The separator that carried the fraction ("none" when there is no fraction separator). */
      readonly decimalSeparator: "." | "," | "none";
      /** The currency token printed inside the string (exact, from the closed list), or null. */
      readonly currency: string | null;
    }
  | { readonly kind: "ambiguous"; readonly reason: "LONE_SEPARATOR_THREE_DIGITS"; readonly currency: string | null }
  | { readonly kind: "invalid"; readonly reason: AmountInvalidReason };

// K-02 step 2 grouping set: space, NBSP (U+00A0), thin space (U+2009), ASCII apostrophe.
const GROUPING_CLASS = "[ \\u00a0\\u2009']";
const GROUPING_RE = new RegExp(GROUPING_CLASS, "g");
const HAS_GROUPING_RE = new RegExp(GROUPING_CLASS);
const SPACE_CLASS = "[ \\u00a0\\u2009]";
const EDGE_SPACE_RE = new RegExp(`^${SPACE_CLASS}+|${SPACE_CLASS}+$`, "g");
// Case-SENSITIVE (no "i" flag): "usdc" is not a currency token.
const PREFIX_RE = new RegExp(`^(${currencyAlternation()})${SPACE_CLASS}*`);
const SUFFIX_RE = new RegExp(`${SPACE_CLASS}*(${currencyAlternation()})$`);
// Signs, brackets and unicode minus/dash look-alikes: U+2212, U+2013, U+2014, U+FE63, U+FF0B, U+FF0D.
const SIGN_RE = new RegExp("[-+()\\u2212\\u2013\\u2014\\ufe63\\uff0b\\uff0d]");

/** Maximum digits in a base-unit string (AmountSchema allows 30). */
const MAX_BASE_UNIT_DIGITS = 30;

function validGroups(intPart: string, hasGrouping: boolean): boolean {
  // intPart contains digits and the marker "g" for grouping chars / the grouping separator.
  if (!hasGrouping) return /^[0-9]+$/.test(intPart);
  const [first, ...rest] = intPart.split("g");
  if (first === undefined || !/^[0-9]{1,3}$/.test(first)) return false;
  return rest.every((g) => /^[0-9]{3}$/.test(g));
}

function strip(intPart: string): string {
  return intPart.replace(/g/g, "");
}

function build(intDigits: string, fracDigits: string, decimals: number, sep: "." | "," | "none", currency: string | null): AmountParse {
  if (intDigits.length > 1 && intDigits.startsWith("0")) return { kind: "invalid", reason: "LEADING_ZERO" };
  if (fracDigits.length > decimals) return { kind: "invalid", reason: "TOO_MANY_DECIMALS" };
  const digits = `${intDigits}${fracDigits.padEnd(decimals, "0")}`.replace(/^0+(?=[0-9])/, "");
  if (digits.length > MAX_BASE_UNIT_DIGITS) return { kind: "invalid", reason: "TOO_LONG" };
  return { kind: "ok", baseUnits: BigInt(digits), decimalSeparator: sep, currency };
}

/**
 * Parse a printed amount (a single known currency token as prefix or suffix is allowed) to base units with
 * `decimals` decimals. Never rounds; never guesses. Test vectors (decimals = 6), from docs/04 K-02:
 *   "1,000.00" -> 1000000000 | "1.000,00" -> 1000000000 | "1.000" -> ambiguous | "1,5" -> 1500000 |
 *   "6.000000" -> 6000000 | "6.0000001" -> invalid(TOO_MANY_DECIMALS) | "1 000,50" -> 1000500000 |
 *   "1'000.50" -> 1000500000 | "1e3" -> invalid(SCIENTIFIC) | "$1,000" -> ambiguous.
 */
export function parseAmountPrinted(printed: string, decimals: number): AmountParse {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) return { kind: "invalid", reason: "BAD_DECIMALS" };
  // Guardrail 7 first: if normalization would change the string (zero-width, bidi, control, lone surrogate
  // characters), the kernel and we could read different numbers. Refuse.
  if (normalizeUntrusted(printed).removedCount > 0) return { kind: "invalid", reason: "HIDDEN_CHARS" };
  if (printed.trim().length === 0) return { kind: "invalid", reason: "EMPTY" };
  if (/\p{Nd}/u.test(printed.replace(/[0-9]/g, ""))) return { kind: "invalid", reason: "NON_ASCII_DIGITS" };
  if (/[0-9][eE][+-]?[0-9]/.test(printed)) return { kind: "invalid", reason: "SCIENTIFIC" };

  // Exactly one optional currency token, at one end only.
  let body = printed.replace(EDGE_SPACE_RE, "");
  let currency: string | null = null;
  const prefix = PREFIX_RE.exec(body);
  if (prefix) {
    currency = prefix[1] ?? null;
    body = body.slice(prefix[0].length);
  } else {
    const suffix = SUFFIX_RE.exec(body);
    if (suffix) {
      currency = suffix[1] ?? null;
      body = body.slice(0, suffix.index);
    }
  }
  body = body.replace(EDGE_SPACE_RE, "");
  if (body.length === 0) return { kind: "invalid", reason: "EMPTY" };
  if (SIGN_RE.test(body)) return { kind: "invalid", reason: "NEGATIVE_OR_SIGNED" };

  const hasGrouping = HAS_GROUPING_RE.test(body);
  const marked = body.replace(GROUPING_RE, "g");
  if (!/^[0-9.,g]+$/.test(marked)) return { kind: "invalid", reason: "UNEXPECTED_CHARACTERS" };
  if (/gg/.test(marked) || /^g|g$/.test(marked)) return { kind: "invalid", reason: "BAD_GROUPING" };
  if (!/^[0-9]/.test(marked) || !/[0-9]$/.test(marked)) return { kind: "invalid", reason: "BAD_FORMAT" };

  const dots = (marked.match(/\./g) ?? []).length;
  const commas = (marked.match(/,/g) ?? []).length;

  if (dots === 0 && commas === 0) {
    if (!validGroups(marked, hasGrouping)) return { kind: "invalid", reason: "BAD_GROUPING" };
    return build(strip(marked), "", decimals, "none", currency);
  }

  if (dots > 0 && commas > 0) {
    // The last separator is the decimal, the other is grouping (K-02 step 3).
    const decimalChar = marked.lastIndexOf(".") > marked.lastIndexOf(",") ? "." : ",";
    const groupChar = decimalChar === "." ? "," : ".";
    if ((decimalChar === "." ? dots : commas) !== 1) return { kind: "invalid", reason: "BAD_GROUPING" };
    const at = marked.lastIndexOf(decimalChar);
    const head = marked.slice(0, at).split(groupChar).join("g");
    const tail = marked.slice(at + 1);
    if (!/^[0-9]+$/.test(tail)) return { kind: "invalid", reason: "BAD_FORMAT" };
    if (!validGroups(head, true)) return { kind: "invalid", reason: "BAD_GROUPING" };
    return build(strip(head), tail, decimals, decimalChar, currency);
  }

  const sepChar = dots > 0 ? "." : ",";
  if (dots + commas > 1) {
    // One separator repeated is grouping ("1.000.000"); no fraction.
    const head = marked.split(sepChar).join("g");
    if (!validGroups(head, true)) return { kind: "invalid", reason: "BAD_GROUPING" };
    return build(strip(head), "", decimals, "none", currency);
  }

  const at = marked.indexOf(sepChar);
  const head = marked.slice(0, at);
  const tail = marked.slice(at + 1);
  if (!/^[0-9]+$/.test(tail)) return { kind: "invalid", reason: "BAD_FORMAT" };
  if (!validGroups(head, hasGrouping)) return { kind: "invalid", reason: "BAD_GROUPING" };
  if (tail.length === 3) return { kind: "ambiguous", reason: "LONE_SEPARATOR_THREE_DIGITS", currency };
  return build(strip(head), tail, decimals, sepChar, currency);
}
