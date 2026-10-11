// Deterministic amount parser: an independent cross-check on the model's `parsedBaseUnits`.
//
// It follows the K-02 grammar (docs/04 §4 K-02) but is deliberately STRICTER: wherever the extractor and the
// kernel could read one string differently, this parser refuses (`invalid`/`ambiguous`) rather than guess, so
// the kernel escalates (K-02 step 5, AMOUNT_AMBIGUOUS). Concretely it does not NFKC-fold (full-width digits,
// "−", "＋" etc. are refused, not folded), accepts only the K-02 grouping characters (space, NBSP, thin space,
// ASCII apostrophe), accepts a currency code/symbol only as a single prefix or suffix of the whole string,
// refuses leading zeros, and refuses any string in which normalizeUntrusted() would remove a character.
// The raw `printed` string is never rewritten (it stays the verbatim document substring so K-02 can re-parse it).
//
// The pipeline keeps the model's `parsedBaseUnits` only when this parser reproduces it exactly (validate.ts).
// Money is bigint (INV-10): no Number(), no parseFloat, no toFixed.
import { normalizeUntrusted } from "@symbolon/schemas";

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
    }
  | { readonly kind: "ambiguous"; readonly reason: "LONE_SEPARATOR_THREE_DIGITS" }
  | { readonly kind: "invalid"; readonly reason: AmountInvalidReason };

/** Space, NBSP, thin space, ASCII apostrophe: exactly the K-02 step 2 grouping set. */
const GROUPING_CLASS = "[ \\u00a0\\u2009']";
const GROUPING_RE = new RegExp(GROUPING_CLASS, "g");
const HAS_GROUPING_RE = new RegExp(GROUPING_CLASS);
const EDGE_SPACE_RE = /^[   ]+|[   ]+$/g;
const CURRENCY = String.raw`(?:USDC|USD|US\$|EURC|EUR|GBP|[$€£])`;
const PREFIX_RE = new RegExp(String.raw`^${CURRENCY}[   ]*`, "i");
const SUFFIX_RE = new RegExp(String.raw`[   ]*${CURRENCY}$`, "i");

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

function build(intDigits: string, fracDigits: string, decimals: number, sep: "." | "," | "none"): AmountParse {
  if (intDigits.length > 1 && intDigits.startsWith("0")) return { kind: "invalid", reason: "LEADING_ZERO" };
  if (fracDigits.length > decimals) return { kind: "invalid", reason: "TOO_MANY_DECIMALS" };
  const digits = `${intDigits}${fracDigits.padEnd(decimals, "0")}`.replace(/^0+(?=[0-9])/, "");
  if (digits.length > MAX_BASE_UNIT_DIGITS) return { kind: "invalid", reason: "TOO_LONG" };
  return { kind: "ok", baseUnits: BigInt(digits), decimalSeparator: sep };
}

/**
 * Parse a printed amount (a single currency code/symbol as prefix or suffix is allowed) to base units with
 * `decimals` decimals. Never rounds; never guesses. Test vectors (decimals = 6), from docs/04 K-02:
 *   "1,000.00" -> 1000000000 · "1.000,00" -> 1000000000 · "1.000" -> ambiguous · "1,5" -> 1500000 ·
 *   "6.000000" -> 6000000 · "6.0000001" -> invalid(TOO_MANY_DECIMALS) · "1 000,50" -> 1000500000 ·
 *   "1'000.50" -> 1000500000 · "1e3" -> invalid(SCIENTIFIC) · "$1,000" -> ambiguous.
 */
export function parseAmountPrinted(printed: string, decimals: number): AmountParse {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) return { kind: "invalid", reason: "BAD_DECIMALS" };
  // Guardrail 7 first: if normalization would change the string (zero-width, bidi, control, lone surrogate
  // characters), the kernel and we could read different numbers. Refuse.
  if (normalizeUntrusted(printed).removedCount > 0) return { kind: "invalid", reason: "HIDDEN_CHARS" };
  if (printed.trim().length === 0) return { kind: "invalid", reason: "EMPTY" };
  if (/\p{Nd}/u.test(printed.replace(/[0-9]/g, ""))) return { kind: "invalid", reason: "NON_ASCII_DIGITS" };
  if (/[0-9][eE][+-]?[0-9]/.test(printed)) return { kind: "invalid", reason: "SCIENTIFIC" };

  // Exactly one optional currency code/symbol, at one end only.
  let body = printed.replace(EDGE_SPACE_RE, "");
  const prefix = PREFIX_RE.exec(body);
  if (prefix) body = body.slice(prefix[0].length);
  else {
    const suffix = SUFFIX_RE.exec(body);
    if (suffix) body = body.slice(0, suffix.index);
  }
  body = body.replace(EDGE_SPACE_RE, "");
  if (body.length === 0) return { kind: "invalid", reason: "EMPTY" };
  if (/[-+()−–—﹣＋＋]/.test(body)) return { kind: "invalid", reason: "NEGATIVE_OR_SIGNED" };

  const hasGrouping = HAS_GROUPING_RE.test(body);
  const marked = body.replace(GROUPING_RE, "g");
  if (!/^[0-9.,g]+$/.test(marked)) return { kind: "invalid", reason: "UNEXPECTED_CHARACTERS" };
  if (/gg/.test(marked) || /^g|g$/.test(marked)) return { kind: "invalid", reason: "BAD_GROUPING" };
  if (!/^[0-9]/.test(marked) || !/[0-9]$/.test(marked)) return { kind: "invalid", reason: "BAD_FORMAT" };

  const dots = (marked.match(/\./g) ?? []).length;
  const commas = (marked.match(/,/g) ?? []).length;

  if (dots === 0 && commas === 0) {
    if (!validGroups(marked, hasGrouping)) return { kind: "invalid", reason: "BAD_GROUPING" };
    return build(strip(marked), "", decimals, "none");
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
    return build(strip(head), tail, decimals, decimalChar);
  }

  const sepChar = dots > 0 ? "." : ",";
  if (dots + commas > 1) {
    // One separator repeated is grouping ("1.000.000"); no fraction.
    const head = marked.split(sepChar).join("g");
    if (!validGroups(head, true)) return { kind: "invalid", reason: "BAD_GROUPING" };
    return build(strip(head), "", decimals, "none");
  }

  const at = marked.indexOf(sepChar);
  const head = marked.slice(0, at);
  const tail = marked.slice(at + 1);
  if (!/^[0-9]+$/.test(tail)) return { kind: "invalid", reason: "BAD_FORMAT" };
  if (!validGroups(head, hasGrouping)) return { kind: "invalid", reason: "BAD_GROUPING" };
  if (tail.length === 3) return { kind: "ambiguous", reason: "LONE_SEPARATOR_THREE_DIGITS" };
  return build(strip(head), tail, decimals, sepChar);
}

/** Currency spellings that count as USDC for base-unit parsing (K-07 `treatUsdAsUsdc`; the kernel decides). */
export const DEFAULT_USDC_ALIASES: readonly string[] = ["USDC", "USD", "$", "US$"];

/** Exact (case-insensitive ASCII) match only: no Unicode folding, so look-alike spellings are not accepted. */
export function isAcceptedCurrency(currencyPrinted: string, aliases: readonly string[] = DEFAULT_USDC_ALIASES): boolean {
  const c = currencyPrinted.replace(EDGE_SPACE_RE, "").toUpperCase();
  return aliases.some((a) => a.toUpperCase() === c);
}
