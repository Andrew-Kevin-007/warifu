// Locale-style printing of base-unit amounts, as invoices print them (bigint only; INV-10).
// Used to build invoice text whose printed total is an EXACT substring of the document, and to build
// the deliberately ambiguous prints for ATK-04/05. `classifyPrinted` mirrors the K-02 separator rules
// (docs/04 §4 K-02 step 3) so the reference extraction can say what a careful reader would conclude.
import type { DECIMAL_SEPARATOR_GUESSES } from "@symbolon/schemas";

type DecimalSeparatorGuess = (typeof DECIMAL_SEPARATOR_GUESSES)[number];

export const NUMBER_STYLES = ["us", "eu", "swiss", "plain", "plain-comma", "fr", "si"] as const;
export type NumberStyle = (typeof NUMBER_STYLES)[number];

const SEPARATORS: Record<NumberStyle, { group: string; decimal: string }> = {
  us: { group: ",", decimal: "." },
  eu: { group: ".", decimal: "," },
  swiss: { group: "'", decimal: "." },
  plain: { group: "", decimal: "." },
  "plain-comma": { group: "", decimal: "," },
  fr: { group: " ", decimal: "," }, // NBSP
  si: { group: " ", decimal: "." }, // narrow NBSP (thin space)
};

export function separatorsOf(style: NumberStyle): { group: string; decimal: string } {
  return SEPARATORS[style];
}

export interface PrintOptions {
  /** Fraction digits to print (default: 2, or more if the amount needs them). Capped at `decimals`. */
  readonly fractionDigits?: number;
}

/** Print `units` (base units, `decimals` decimals) in a locale style. Never rounds. */
export function printAmount(units: bigint, decimals: number, style: NumberStyle, options: PrintOptions = {}): string {
  if (units < 0n) throw new RangeError("printAmount expects a non-negative amount");
  const sep = SEPARATORS[style];
  const scale = 10n ** BigInt(decimals);
  const whole = units / scale;
  const fracRaw = decimals === 0 ? "" : (units % scale).toString().padStart(decimals, "0");
  // Fewest digits that keep every non-zero digit, but at least `fractionDigits` (default 2).
  let needed = fracRaw.length;
  while (needed > 0 && fracRaw.charAt(needed - 1) === "0") needed--;
  const want = Math.min(decimals, Math.max(options.fractionDigits ?? 2, needed));
  const frac = fracRaw.slice(0, want).padEnd(want, "0");
  const wholeText = sep.group === "" ? whole.toString() : whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, sep.group);
  return frac.length > 0 ? `${wholeText}${sep.decimal}${frac}` : wholeText;
}

/** What a careful reader concludes about the decimal separator of a printed amount (K-02 rules). */
export function classifyPrinted(printed: string): DecimalSeparatorGuess {
  const body = printed.replace(/[^0-9.,]/g, "");
  const dots = (body.match(/\./g) ?? []).length;
  const commas = (body.match(/,/g) ?? []).length;
  if (dots === 0 && commas === 0) return "none";
  if (dots > 0 && commas > 0) return body.lastIndexOf(".") > body.lastIndexOf(",") ? "." : ",";
  const ch = dots > 0 ? "." : ",";
  const count = dots > 0 ? dots : commas;
  if (count > 1) return "none"; // repeated: grouping only, no fraction
  const after = body.length - body.lastIndexOf(ch) - 1;
  return after === 3 ? "ambiguous" : ch;
}

/**
 * Independent reference parser for the prints this module produces (the style is known, so no guessing).
 * Tests use it to prove that printAmount is lossless; it is NOT the kernel's parseMoney.
 */
export function parsePrinted(printed: string, decimals: number, style: NumberStyle): bigint {
  const sep = SEPARATORS[style];
  const noGroup = sep.group === "" ? printed : printed.split(sep.group).join("");
  const [wholeText = "0", fracText = ""] = noGroup.split(sep.decimal);
  if (!/^[0-9]+$/.test(wholeText) || (fracText !== "" && !/^[0-9]+$/.test(fracText)) || fracText.length > decimals) {
    throw new RangeError(`cannot parse ${JSON.stringify(printed)} as ${style}`);
  }
  return BigInt(wholeText) * 10n ** BigInt(decimals) + BigInt(fracText.padEnd(decimals, "0") || "0");
}
