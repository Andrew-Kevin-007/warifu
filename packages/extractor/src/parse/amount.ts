// Deterministic amount parser: an independent cross-check on the model's `parsedBaseUnits`.
//
// It mirrors the K-02 algorithm (docs/04 §4 K-02) so that the extractor never emits a confidently wrong
// base-unit value: the pipeline keeps the model's `parsedBaseUnits` only when this parser reproduces it
// exactly, and otherwise nulls it (null/ambiguous is always acceptable; wrong-but-unflagged is the
// unforgivable class, docs/03 §8). The kernel re-derives the value itself (K-02); this is defence in depth.
//
// Money is bigint (INV-10): no Number(), no parseFloat, no toFixed.

export type AmountInvalidReason =
  | "EMPTY"
  | "NON_ASCII_DIGITS"
  | "SCIENTIFIC"
  | "NEGATIVE_OR_SIGNED"
  | "UNEXPECTED_CHARACTERS"
  | "BAD_FORMAT"
  | "BAD_GROUPING"
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

/** Grouping characters: space, NBSP, thin space, narrow NBSP, apostrophes (K-02 step 2). */
const GROUPING_RE = /[    '’ʼ]/g;
const HAS_GROUPING_RE = /[    '’ʼ]/;
const CURRENCY_TOKEN_RE = /(?:US\$|[A-Za-z]{2,6}|[$€£¥₹])/g;

/** Maximum digits in a base-unit string (AmountSchema allows 30). */
const MAX_BASE_UNIT_DIGITS = 30;

function validGroups(intPart: string, hasGrouping: boolean): boolean {
  // intPart contains digits and the marker "g" for grouping chars / the grouping separator.
  if (!hasGrouping) return /^[0-9]+$/.test(intPart);
  const groups = intPart.split("g");
  const [first, ...rest] = groups;
  if (first === undefined || !/^[0-9]{1,3}$/.test(first)) return false;
  return rest.every((g) => /^[0-9]{3}$/.test(g));
}

function strip(intPart: string): string {
  return intPart.replace(/g/g, "");
}

function build(intDigits: string, fracDigits: string, decimals: number, sep: "." | "," | "none"): AmountParse {
  if (fracDigits.length > decimals) return { kind: "invalid", reason: "TOO_MANY_DECIMALS" };
  const intPart = intDigits.replace(/^0+(?=[0-9])/, "");
  const digits = `${intPart}${fracDigits.padEnd(decimals, "0")}`.replace(/^0+(?=[0-9])/, "");
  if (digits.length > MAX_BASE_UNIT_DIGITS) return { kind: "invalid", reason: "TOO_LONG" };
  return { kind: "ok", baseUnits: BigInt(digits), decimalSeparator: sep };
}

/**
 * Parse a printed amount (currency symbol/code allowed) to base units with `decimals` decimals.
 * Never rounds; never guesses. Test vectors (decimals = 6), from docs/04 K-02:
 *   "1,000.00" -> 1000000000 · "1.000,00" -> 1000000000 · "1.000" -> ambiguous · "1,5" -> 1500000 ·
 *   "6.000000" -> 6000000 · "6.0000001" -> invalid(TOO_MANY_DECIMALS) · "1 000,50" -> 1000500000 ·
 *   "1'000.50" -> 1000500000 · "1e3" -> invalid(SCIENTIFIC) · "$1,000" -> ambiguous.
 */
export function parseAmountPrinted(printed: string, decimals: number): AmountParse {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) return { kind: "invalid", reason: "BAD_DECIMALS" };
  const nfkc = printed.normalize("NFKC").trim();
  if (nfkc.length === 0) return { kind: "invalid", reason: "EMPTY" };
  if (/[\p{Nd}]/u.test(nfkc.replace(/[0-9]/g, ""))) return { kind: "invalid", reason: "NON_ASCII_DIGITS" };
  if (/[0-9][eE][+-]?[0-9]/.test(nfkc)) return { kind: "invalid", reason: "SCIENTIFIC" };

  const body = nfkc.replace(CURRENCY_TOKEN_RE, " ").trim();
  if (body.length === 0 || !/[0-9]/.test(body)) return { kind: "invalid", reason: "EMPTY" };
  if (/[-+()−–]/.test(body)) return { kind: "invalid", reason: "NEGATIVE_OR_SIGNED" };
  const hasGrouping = HAS_GROUPING_RE.test(body);
  const marked = body.replace(GROUPING_RE, "g");
  if (!/^[0-9.,g]+$/.test(marked)) return { kind: "invalid", reason: "UNEXPECTED_CHARACTERS" };
  if (/gg/.test(marked) || /^g|g$/.test(marked)) return { kind: "invalid", reason: "BAD_GROUPING" };

  const dots = (marked.match(/\./g) ?? []).length;
  const commas = (marked.match(/,/g) ?? []).length;

  if (dots === 0 && commas === 0) {
    if (!validGroups(marked, hasGrouping)) return { kind: "invalid", reason: "BAD_GROUPING" };
    return build(strip(marked), "", decimals, "none");
  }

  if (dots > 0 && commas > 0) {
    // The last separator is the decimal, the other is grouping (K-02 step 3).
    const lastDot = marked.lastIndexOf(".");
    const lastComma = marked.lastIndexOf(",");
    const decimalChar = lastDot > lastComma ? "." : ",";
    const groupChar = decimalChar === "." ? "," : ".";
    const decimalCount = decimalChar === "." ? dots : commas;
    if (decimalCount !== 1) return { kind: "invalid", reason: "BAD_GROUPING" };
    const at = marked.lastIndexOf(decimalChar);
    const head = marked.slice(0, at).split(groupChar).join("g");
    const tail = marked.slice(at + 1);
    // The group char must appear only before the decimal char.
    if (tail.includes(groupChar) || tail.includes("g") || !/^[0-9]+$/.test(tail)) return { kind: "invalid", reason: "BAD_FORMAT" };
    if (!validGroups(head, true)) return { kind: "invalid", reason: "BAD_GROUPING" };
    return build(strip(head), tail, decimals, decimalChar);
  }

  const sepChar = dots > 0 ? "." : ",";
  const count = dots + commas;
  if (count > 1) {
    // One separator repeated is grouping ("1.000.000"); no fraction.
    const head = marked.split(sepChar).join("g");
    if (!validGroups(head, true)) return { kind: "invalid", reason: "BAD_GROUPING" };
    return build(strip(head), "", decimals, "none");
  }

  const at = marked.indexOf(sepChar);
  const head = marked.slice(0, at);
  const tail = marked.slice(at + 1);
  if (head.length === 0 || tail.length === 0 || !/^[0-9]+$/.test(tail)) return { kind: "invalid", reason: "BAD_FORMAT" };
  if (!validGroups(head, hasGrouping)) return { kind: "invalid", reason: "BAD_GROUPING" };
  if (tail.length === 3) return { kind: "ambiguous", reason: "LONE_SEPARATOR_THREE_DIGITS" };
  return build(strip(head), tail, decimals, sepChar);
}

/** Currency spellings that count as USDC for base-unit parsing (K-07 `treatUsdAsUsdc`; the kernel decides). */
export const DEFAULT_USDC_ALIASES: readonly string[] = ["USDC", "USD", "$", "US$"];

export function isAcceptedCurrency(currencyPrinted: string, aliases: readonly string[] = DEFAULT_USDC_ALIASES): boolean {
  const c = currencyPrinted.normalize("NFKC").trim().toUpperCase();
  return aliases.some((a) => a.toUpperCase() === c);
}
