// Money = bigint base units + declared decimals (INV-10). No JS number, no float, no rounding unless a
// caller names it. Display formatting for approvals is formatBaseUnits from @symbolon/schemas (re-exported).
//
// Arc note (AGENTS.md section 3): native USDC gas has 18 decimals, the ERC-20 interface has 6 (V-04, read it
// on-chain). No 18-decimal native value leaks above this package: convert with convertDecimals(..., "exact")
// at the edge, which refuses to drop digits.
import { ChainError } from "./errors";

export { formatBaseUnits, parseBaseUnits, type FormatOptions } from "@symbolon/schemas";

/** Highest decimals this package accepts. ERC-20 `decimals()` is uint8, but nothing real exceeds 36. */
export const MAX_DECIMALS = 36;
export const MAX_UINT256 = (1n << 256n) - 1n;
/** Arc: native USDC (gas) decimals. The ERC-20 interface differs; never mix them. */
export const NATIVE_GAS_DECIMALS = 18;

/** Longest amount string we parse (a uint256 has 78 digits; 36 fraction digits + point + slack). */
const MAX_AMOUNT_TEXT_LENGTH = 120;
const AMOUNT_RE = /^(0|[1-9][0-9]*)(?:\.([0-9]+))?$/;

export interface Money {
  readonly units: bigint;
  readonly decimals: number;
}

export type Rounding = "exact" | "floor" | "ceil";

export function isValidDecimals(decimals: unknown): decimals is number {
  return typeof decimals === "number" && Number.isInteger(decimals) && decimals >= 0 && decimals <= MAX_DECIMALS;
}

export function assertDecimals(decimals: unknown): asserts decimals is number {
  if (!isValidDecimals(decimals)) {
    throw new ChainError("INVALID_DECIMALS", `decimals must be an integer in [0, ${MAX_DECIMALS}], got ${describe(decimals)}`);
  }
}

function assertUnits(units: unknown): asserts units is bigint {
  if (typeof units !== "bigint" || units < 0n || units > MAX_UINT256) {
    throw new ChainError("INVALID_AMOUNT", `units must be a bigint in [0, 2^256-1], got ${describe(units)}`);
  }
}

function describe(v: unknown): string {
  if (typeof v === "bigint") return `${v.toString()}n`;
  if (typeof v === "string") return JSON.stringify(v.length > 40 ? `${v.slice(0, 40)}...` : v);
  return typeof v === "number" ? String(v) : typeof v;
}

/** Construct a validated Money. Never accepts a JS number as the amount. */
export function money(units: bigint, decimals: number): Money {
  assertDecimals(decimals);
  assertUnits(units);
  return Object.freeze({ units, decimals });
}

/**
 * Parse a canonical decimal string to base units: `toBaseUnits("1.5", 6) === 1500000n`.
 * Accepted: digits with an optional fraction. Rejected: sign, exponent, whitespace, separators, ".5", "5.",
 * leading zeros ("01"), and a fraction with non-zero digits beyond `decimals` (PRECISION_LOSS). Excess
 * trailing zeros are fine ("1.50" at 1 decimal) because no value is lost. Result must fit uint256.
 */
export function toBaseUnits(text: string, decimals: number): bigint {
  assertDecimals(decimals);
  if (typeof text !== "string" || text.length === 0 || text.length > MAX_AMOUNT_TEXT_LENGTH) {
    throw new ChainError("INVALID_AMOUNT", `amount text must be a non-empty string of at most ${MAX_AMOUNT_TEXT_LENGTH} chars`);
  }
  const m = AMOUNT_RE.exec(text);
  if (m === null) {
    throw new ChainError("INVALID_AMOUNT", `not a canonical decimal amount: ${describe(text)}`);
  }
  const whole = m[1] ?? "";
  const fraction = m[2] ?? "";
  const kept = fraction.slice(0, decimals);
  const excess = fraction.slice(decimals);
  if (/[1-9]/.test(excess)) {
    throw new ChainError("PRECISION_LOSS", `${describe(text)} has more than ${decimals} significant fraction digits`);
  }
  const units = BigInt(whole + kept.padEnd(decimals, "0"));
  if (units > MAX_UINT256) {
    throw new ChainError("OVERFLOW", `${describe(text)} does not fit uint256 at ${decimals} decimals`);
  }
  return units;
}

/** toBaseUnits, returning Money. */
export function parseMoney(text: string, decimals: number): Money {
  return money(toBaseUnits(text, decimals), decimals);
}

/**
 * Exact inverse of toBaseUnits, minimal spelling: `formatUnits(1500000n, 6) === "1.5"`, `(5000000n, 6) === "5"`,
 * `(1n, 6) === "0.000001"`. No grouping, no padding, never rounds. For approval screens use formatBaseUnits.
 */
export function formatUnits(units: bigint, decimals: number): string {
  assertDecimals(decimals);
  assertUnits(units);
  if (decimals === 0) return units.toString();
  const digits = units.toString().padStart(decimals + 1, "0");
  const whole = digits.slice(0, digits.length - decimals);
  const fraction = digits.slice(digits.length - decimals).replace(/0+$/, "");
  return fraction.length === 0 ? whole : `${whole}.${fraction}`;
}

export function formatMoney(m: Money): string {
  return formatUnits(m.units, m.decimals);
}

function sameDecimals(a: Money, b: Money): void {
  if (a.decimals !== b.decimals) {
    throw new ChainError("DECIMALS_MISMATCH", `cannot combine ${a.decimals}-decimal and ${b.decimals}-decimal amounts`);
  }
}

export function addMoney(a: Money, b: Money): Money {
  sameDecimals(a, b);
  const sum = a.units + b.units;
  if (sum > MAX_UINT256) throw new ChainError("OVERFLOW", "sum exceeds uint256");
  return money(sum, a.decimals);
}

export function subMoney(a: Money, b: Money): Money {
  sameDecimals(a, b);
  if (b.units > a.units) throw new ChainError("UNDERFLOW", "difference would be negative");
  return money(a.units - b.units, a.decimals);
}

/** -1 | 0 | 1. Refuses to compare amounts with different decimals. */
export function compareMoney(a: Money, b: Money): -1 | 0 | 1 {
  sameDecimals(a, b);
  return a.units < b.units ? -1 : a.units > b.units ? 1 : 0;
}

export function equalsMoney(a: Money, b: Money): boolean {
  return a.decimals === b.decimals && a.units === b.units;
}

/**
 * Re-express an amount at other decimals (the 6 <-> 18 bridge). Scaling up is always exact. Scaling down
 * needs `rounding`: "exact" (default) throws PRECISION_LOSS if the remainder is non-zero; "floor" and "ceil"
 * are explicit opt-ins for display and never for authorising a payment.
 */
export function convertDecimals(m: Money, toDecimals: number, rounding: Rounding = "exact"): Money {
  assertDecimals(toDecimals);
  assertDecimals(m.decimals);
  assertUnits(m.units);
  if (toDecimals === m.decimals) return money(m.units, toDecimals);
  if (toDecimals > m.decimals) {
    const scaled = m.units * 10n ** BigInt(toDecimals - m.decimals);
    if (scaled > MAX_UINT256) throw new ChainError("OVERFLOW", `scaling to ${toDecimals} decimals exceeds uint256`);
    return money(scaled, toDecimals);
  }
  const divisor = 10n ** BigInt(m.decimals - toDecimals);
  const quotient = m.units / divisor;
  const remainder = m.units % divisor;
  if (remainder === 0n) return money(quotient, toDecimals);
  switch (rounding) {
    case "exact":
      throw new ChainError("PRECISION_LOSS", `${m.units.toString()} at ${m.decimals} decimals is not representable at ${toDecimals}`);
    case "floor":
      return money(quotient, toDecimals);
    case "ceil":
      return money(quotient + 1n, toDecimals);
    default: {
      const unreachable: never = rounding;
      throw new ChainError("INVALID_AMOUNT", `unknown rounding mode ${String(unreachable)}`);
    }
  }
}
