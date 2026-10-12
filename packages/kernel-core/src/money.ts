// parseMoney (docs/04 K-02): the kernel's own reading of a printed amount. It never rounds and never guesses:
// the result is an exact base-unit value, AMBIGUOUS (ESCALATE), or a REJECT code. Property P-K02-ROUNDTRIP:
// a correctly formatted value parses to itself or to AMBIGUOUS, never to a different value.
//
// Algorithm (docs/04 K-02 steps 1-4) with these fail-closed refinements (docs/QUESTIONS.md "WP-04"):
//   - Step 1 rejects every Unicode number character except ASCII and full-width digits BEFORE NFKC, so
//     superscripts, circled or mathematical digits ("¹", "①", "𝟏") cannot be folded into ASCII by NFKC.
//   - Step 2 removes currency only from a closed list at either end (one ISO-style code USDC/USD/EUR, "US$", or
//     one currency symbol \p{Sc}). The extractor's currencyHint is NOT used for stripping: an attacker-chosen
//     hint such as "M" or "k" would otherwise turn "1.5M" into 1.5.
//   - Anything that is not digits plus the recognised separators (a sign, a letter, "1..0", a leading or trailing
//     separator, two kinds of grouping, an invalid grouping shape, a leading zero) is AMBIGUOUS (MALFORMED).
//   - Grouping shape: first group 1-3 digits then groups of 3 (1,234,567), or Indian lakh grouping with commas
//     only (12,34,567: groups of 2, last group 3).
//   - The "decimalSeparatorGuess agrees and K-08 matches" exemption for "1.000" is not applied (it would make the
//     kernel trust the extractor); "1.000" is always AMBIGUOUS for the total. `convention` exists only for line
//     items, which never decide an amount (K-02 step 6 compares their sum).

export type MoneyRejectCode = "NON_ASCII_DIGITS" | "SCIENTIFIC" | "REFUSE_ROUND";
export type AmbiguityReason = "LONE_SEPARATOR_THREE_DIGITS" | "MALFORMED";
export type DecimalSeparator = "." | ",";

export type MoneyParse =
  | { readonly kind: "EXACT"; readonly baseUnits: bigint; readonly decimalSeparator: DecimalSeparator | null }
  | { readonly kind: "AMBIGUOUS"; readonly reason: AmbiguityReason }
  | { readonly kind: "REJECT"; readonly code: MoneyRejectCode };

export interface ParseMoneyOptions {
  /** Resolves ONLY the lone-separator-followed-by-3-digits case (line items, using the total's separator). */
  readonly convention?: DecimalSeparator;
}

const MALFORMED: MoneyParse = { kind: "AMBIGUOUS", reason: "MALFORMED" };
const LONE_THREE: MoneyParse = { kind: "AMBIGUOUS", reason: "LONE_SEPARATOR_THREE_DIGITS" };

const ANY_NUMBER_CHAR = /\p{N}/u;
const ALLOWED_DIGIT = /^[0-9０-９]$/u;
const SCIENTIFIC = /[0-9]\s*[eE]\s*[+-]?\s*[0-9]/;
const CURRENCY_LEFT = /^(?:US\$|USDC|USD|EUR|\p{Sc})\s*/iu;
const CURRENCY_RIGHT = /\s*(?:US\$|USDC|USD|EUR|\p{Sc})$/iu;
/** After currency removal: starts and ends with a digit; only digits, '.', ',', space and apostrophes inside. */
const NUMERIC_BODY = /^[0-9](?:[0-9.,' ’]*[0-9])?$/u;
const ADJACENT_SEPARATORS = /[^0-9]{2}/;
const SPACE_LIKE = [" ", "'", "’"] as const;

function count(s: string, ch: string): number {
  return s.split(ch).length - 1;
}

/**
 * Validate the integer part's grouping with separator `g` (or none) and return its digits, or null.
 * Callers guarantee `intPart` is non-empty, starts and ends with a digit and contains only digits and `g`
 * (NUMERIC_BODY + ADJACENT_SEPARATORS + the separator analysis), so every group is a non-empty digit run.
 */
function integerDigits(intPart: string, g: string | null): string | null {
  const groups = g === null ? [intPart] : intPart.split(g);
  const digits = groups.join("");
  if (digits.length > 1 && digits.startsWith("0")) return null;
  if (groups.length === 1) return digits;
  const [first, ...rest] = groups as [string, ...string[]];
  const western = /^[0-9]{1,3}$/.test(first) && rest.every((x) => x.length === 3);
  const last = rest[rest.length - 1] as string;
  const middle = rest.slice(0, -1);
  // Lakh grouping is accepted only with commas (en-IN); "1.00.000" stays MALFORMED.
  const indian = g === "," && /^[0-9]{1,2}$/.test(first) && last.length === 3 && middle.every((x) => x.length === 2);
  return western || indian ? digits : null;
}

function exact(intDigits: string, frac: string, decimals: number, sep: DecimalSeparator | null): MoneyParse {
  if (frac.length > decimals) return { kind: "REJECT", code: "REFUSE_ROUND" };
  const scale = 10n ** BigInt(decimals);
  const fracUnits = frac.length === 0 ? 0n : BigInt(frac) * 10n ** BigInt(decimals - frac.length);
  return { kind: "EXACT", baseUnits: BigInt(intDigits) * scale + fracUnits, decimalSeparator: sep };
}

/**
 * parseMoney(printed, currencyHint, declaredDecimals) per docs/04 K-02.
 * `_currencyHint` is accepted for the spec signature only (see the module comment for why it is not used).
 */
export function parseMoney(printed: string, _currencyHint: string | null, declaredDecimals: number, options: ParseMoneyOptions = {}): MoneyParse {
  if (typeof printed !== "string" || printed.length > 256) return MALFORMED;
  if (!Number.isSafeInteger(declaredDecimals) || declaredDecimals < 0 || declaredDecimals > 255) return MALFORMED;

  // Step 1: reject non-ASCII digits (before NFKC, see module comment) and scientific notation.
  for (const ch of printed) {
    if (ANY_NUMBER_CHAR.test(ch) && !ALLOWED_DIGIT.test(ch)) return { kind: "REJECT", code: "NON_ASCII_DIGITS" };
  }
  const nfkc = printed.normalize("NFKC");
  if (SCIENTIFIC.test(nfkc)) return { kind: "REJECT", code: "SCIENTIFIC" };

  // Step 2: remove one currency token at each end; NFKC already turned NBSP / thin / narrow spaces into U+0020.
  const body = nfkc.trim().replace(CURRENCY_LEFT, "").replace(CURRENCY_RIGHT, "").trim();
  if (!NUMERIC_BODY.test(body) || ADJACENT_SEPARATORS.test(body)) return MALFORMED;

  // Step 3: identify separators.
  const spaceKinds = SPACE_LIKE.filter((c) => body.includes(c));
  if (spaceKinds.length > 1) return MALFORMED;
  const space = spaceKinds[0] ?? null;
  const dots = count(body, ".");
  const commas = count(body, ",");

  if (dots > 0 && commas > 0) {
    if (space !== null) return MALFORMED;
    const dec: DecimalSeparator = body.lastIndexOf(".") > body.lastIndexOf(",") ? "." : ",";
    const grp = dec === "." ? "," : ".";
    if (count(body, dec) !== 1) return MALFORMED;
    // `dec` occurs once and is the later of the two, so every grouping separator precedes it.
    const at = body.indexOf(dec);
    const intDigits = integerDigits(body.slice(0, at), grp);
    return intDigits === null ? MALFORMED : exact(intDigits, body.slice(at + 1), declaredDecimals, dec);
  }

  if (dots + commas === 0) {
    const intDigits = integerDigits(body, space);
    return intDigits === null ? MALFORMED : exact(intDigits, "", declaredDecimals, null);
  }

  const sep: DecimalSeparator = dots > 0 ? "." : ",";
  if (dots + commas > 1) {
    // One separator repeated: grouping ("1.000.000"); mixing it with space/apostrophe grouping is malformed.
    if (space !== null) return MALFORMED;
    const intDigits = integerDigits(body, sep);
    return intDigits === null ? MALFORMED : exact(intDigits, "", declaredDecimals, null);
  }

  // One separator, once.
  const at = body.indexOf(sep);
  if (space !== null && body.lastIndexOf(space) > at) return MALFORMED;
  const after = body.slice(at + 1);
  if (after.length === 3) {
    if (options.convention === undefined) return LONE_THREE;
    if (options.convention !== sep) {
      if (space !== null) return MALFORMED;
      const intDigits = integerDigits(body, sep);
      return intDigits === null ? MALFORMED : exact(intDigits, "", declaredDecimals, null);
    }
  }
  const intDigits = integerDigits(body.slice(0, at), space);
  return intDigits === null ? MALFORMED : exact(intDigits, after, declaredDecimals, sep);
}
