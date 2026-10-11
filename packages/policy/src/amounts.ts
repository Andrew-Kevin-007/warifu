// Policy amounts: whole-unit decimal strings ("100.000000") <-> bigint base units (INV-10).
// No floats anywhere: the string is split on "." and each part goes through BigInt.
// Rounding is refused: a fraction longer than `decimals` is an error, even if the extra digits are zeros.
import { MAX_UINT256, formatBaseUnits } from "@symbolon/schemas";
import { fail } from "./errors";

/** Same grammar as `DecimalAmountSchema` in packages/schemas (frozen at schemas-v1.0). */
const DECIMAL_AMOUNT_RE = /^(0|[1-9][0-9]{0,29})(?:\.([0-9]{1,36}))?$/;

function checkDecimals(decimals: number, path: string): bigint {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255) {
    fail("POLICY_INVALID", path, `decimals must be an integer in [0, 255], got ${String(decimals)}`);
  }
  return BigInt(decimals);
}

/**
 * Convert a policy amount string to base units with `decimals` decimals.
 *   parsePolicyAmount("100.000000", 6) === 100000000n
 *   parsePolicyAmount("0.5", 6)        === 500000n
 *   parsePolicyAmount("1.0000001", 6)  -> PolicyError POLICY_INVALID (would need rounding)
 * Result is always in [0, 2^256 - 1] (the vault compares against uint256 immutables).
 */
export function parsePolicyAmount(amount: string, decimals: number, path = "$"): bigint {
  const d = checkDecimals(decimals, path);
  const m = typeof amount === "string" ? DECIMAL_AMOUNT_RE.exec(amount) : null;
  if (m === null) fail("POLICY_INVALID", path, "expected a decimal amount string such as \"100.000000\"");
  const intPart = m[1] as string;
  const frac = m[2] ?? "";
  if (BigInt(frac.length) > d) {
    fail(
      "POLICY_INVALID",
      path,
      `amount has ${frac.length} fraction digits but currency.decimals is ${decimals}; rounding is refused`,
    );
  }
  const units = BigInt(intPart) * 10n ** d + (frac.length === 0 ? 0n : BigInt(frac) * 10n ** (d - BigInt(frac.length)));
  if (units > MAX_UINT256) fail("POLICY_INVALID", path, "amount exceeds uint256 base units");
  return units;
}

/**
 * The one spelling of an amount inside a hashed policy: exactly `decimals` fraction digits, no grouping
 * ("100.000000" for 6 decimals, "100" for 0). Value-preserving: parsePolicyAmount(format(u, d), d) === u.
 */
export function formatPolicyAmount(units: bigint, decimals: number): string {
  checkDecimals(decimals, "$");
  if (units < 0n || units > MAX_UINT256) fail("POLICY_INVALID", "$", "amount out of range [0, 2^256 - 1]");
  return formatBaseUnits(units, decimals, { grouping: false, minFractionDigits: decimals });
}
