// formatBaseUnits: THE bigint -> display-string formatter (docs/05 §2 ApprovalView.display; INV-10, INV-20).
// packages/chain re-exports it. It never rounds: every base unit that is non-zero is shown.

export interface FormatOptions {
  /** Insert "," between groups of three integer digits (default true). */
  readonly grouping?: boolean;
  /** Minimum fraction digits kept after trimming trailing zeros (default 2, capped at `decimals`). */
  readonly minFractionDigits?: number;
}

const SIGNED_INT_RE = /^(0|-?[1-9][0-9]*)$/;

/** Parse a canonical signed decimal integer string (no "+", no leading zeros, no "-0") to bigint. */
export function parseBaseUnits(units: string): bigint {
  if (units.length > 80 || !SIGNED_INT_RE.test(units)) {
    throw new RangeError(`not a canonical integer string: ${JSON.stringify(units)}`);
  }
  return BigInt(units);
}

/**
 * Format base units with `decimals` decimals, exactly.
 *   formatBaseUnits(5000000n, 6)        === "5.00"
 *   formatBaseUnits("1234567", 6)       === "1.234567"
 *   formatBaseUnits(1000000000000n, 6)  === "1,000,000.00"
 *   formatBaseUnits(7n, 0)              === "7"
 */
export function formatBaseUnits(units: bigint | string, decimals: number, options: FormatOptions = {}): string {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255) {
    throw new RangeError(`decimals must be an integer in [0, 255], got ${String(decimals)}`);
  }
  const grouping = options.grouping ?? true;
  const minFrac = Math.min(options.minFractionDigits ?? 2, decimals);
  if (!Number.isInteger(minFrac) || minFrac < 0) throw new RangeError("minFractionDigits must be a non-negative integer");

  const value = typeof units === "bigint" ? units : parseBaseUnits(units);
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const scale = 10n ** BigInt(decimals);
  const intPart = (abs / scale).toString();
  let frac = decimals === 0 ? "" : (abs % scale).toString().padStart(decimals, "0");
  let end = frac.length;
  while (end > minFrac && frac.charAt(end - 1) === "0") end--;
  frac = frac.slice(0, end);
  const intText = grouping ? intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ",") : intPart;
  return `${negative ? "-" : ""}${intText}${frac.length > 0 ? `.${frac}` : ""}`;
}
