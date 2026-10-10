// Primitive types and their Zod schemas (docs/05 §1).
//
// Canonical forms are enforced, because everything here ends up inside a JCS hash and one value must
// have exactly one spelling:
// - Hex32 / hex bytes: lowercase, 0x-prefixed (what keccak256/sha256 helpers emit);
// - Address: EIP-55 checksummed, exactly (K-01);
// - ISODateTime: RFC 3339 UTC with whole seconds, `YYYY-MM-DDTHH:MM:SSZ` (contracts and terms math are
//   second-granular; use isoFromEpochSeconds/epochSecondsFromIso, never Date#toISOString);
// - decimal integer strings: no sign, no leading zeros, no whitespace.
// This module is pure: no clock, no randomness, no I/O (it is imported by kernel-core and terms).
import { getAddress } from "viem";
import * as z from "zod";
import { isWellFormedString } from "./jcs";

export type Hex32 = `0x${string}`;
export type HexBytes = `0x${string}`;
export type Address = `0x${string}`;
export type UUID = string;
export type ISODateTime = string;
export type ISODate = string;
/** Decimal integer string of token base units; bigint-backed in code (INV-10). */
export type BaseUnits = string;

export const MAX_UINT64 = (1n << 64n) - 1n;
export const MAX_UINT256 = (1n << 256n) - 1n;

// ---------------------------------------------------------------------------------------------
// Hex, addresses, ids

export const Hex32Schema = z
  .string()
  .regex(/^0x[0-9a-f]{64}$/, "expected lowercase 0x-prefixed 32-byte hex") as unknown as z.ZodType<Hex32, string>;

/** Signatures and other byte strings: lowercase hex, whole bytes, at most 4 KiB. */
export const HexBytesSchema = z
  .string()
  .max(2 + 8192)
  .regex(/^0x(?:[0-9a-f]{2})*$/, "expected lowercase 0x-prefixed hex bytes") as unknown as z.ZodType<HexBytes, string>;

export function isChecksumAddress(s: string): boolean {
  if (!/^0x[0-9a-fA-F]{40}$/.test(s)) return false;
  try {
    return getAddress(s) === s;
  } catch {
    return false;
  }
}

export const AddressSchema = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/, "expected a 20-byte 0x address")
  .refine(isChecksumAddress, "address must be EIP-55 checksummed") as unknown as z.ZodType<Address, string>;

export const UUIDSchema = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/, "expected a lowercase RFC 9562 UUID");

/** Short git object id or full sha (lowercase). */
export const GitShaSchema = z.string().regex(/^[0-9a-f]{7,40}$/, "expected a lowercase git sha");

// ---------------------------------------------------------------------------------------------
// Integers as decimal strings

const UINT_RE = /^(0|[1-9][0-9]*)$/;

export function isCanonicalUint(s: string, max: bigint): boolean {
  if (s.length > 78 || !UINT_RE.test(s)) return false;
  return BigInt(s) <= max;
}

/** Any uint256 as a canonical decimal string (chain reads, certificate limits, nonces). */
export const Uint256StringSchema = z
  .string()
  .max(78)
  .regex(UINT_RE, "expected a canonical decimal integer string")
  .refine((s) => isCanonicalUint(s, MAX_UINT256), "exceeds uint256");

export const Uint64StringSchema = z
  .string()
  .max(20)
  .regex(UINT_RE, "expected a canonical decimal integer string")
  .refine((s) => isCanonicalUint(s, MAX_UINT64), "exceeds uint64");

/** Token base units, uint256 range. Used where values come from chain state (certificates, stats). */
export const BaseUnitsSchema = Uint256StringSchema;

/** K-01 amount bound for the intent path: `^(0|[1-9][0-9]{0,29})$` (docs/04 K-01). */
export const AmountSchema = z.string().regex(/^(0|[1-9][0-9]{0,29})$/, "expected an integer base-unit string (<= 30 digits)");

/** A strictly positive K-01 amount (milestones; docs/05 §3 `amount_base_units > 0`). */
export const PositiveAmountSchema = AmountSchema.refine((s) => s !== "0", "amount must be > 0");

/** Signed base units (projections that can go negative, e.g. liquidity after a payment, net benefit). */
export const SignedBaseUnitsSchema = z
  .string()
  .regex(/^(0|-?[1-9][0-9]{0,77})$/, "expected a canonical signed integer string (no -0)");

/** Whole-unit decimal amounts as written in policy.yaml (e.g. "100.000000"). Never floats. */
export const DecimalAmountSchema = z.string().regex(/^(0|[1-9][0-9]{0,29})(\.[0-9]{1,36})?$/, "expected a decimal amount string");

/** Non-money ratios reported as decimal strings (e.g. LBC `upper95`, `tightness`). */
export const DecimalStringSchema = z.string().regex(/^(0|[1-9][0-9]{0,20})(\.[0-9]{1,20})?$/, "expected a non-negative decimal string");

export const BpsSchema = z.number().int().min(0).max(10_000);

/** JSON-safe non-negative integer (JCS convention: numbers only where integral and < 2^53). */
export const SafeUintSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

/** Token decimals as stored on chain (uint8). */
export const DecimalsSchema = z.number().int().min(0).max(255);

export const ChainIdSchema = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);

// ---------------------------------------------------------------------------------------------
// Text

/** Plain (trusted-origin) text: bounded, well-formed UTF-16. Free text in the intent path is <= 2,000 chars (K-01). */
export function text(max: number) {
  return z.string().max(max).refine(isWellFormedString, "string contains a lone UTF-16 surrogate");
}

export const MAX_FREE_TEXT = 2000;

// ---------------------------------------------------------------------------------------------
// Time (pure calendar math; no Date)

const ISO_DATETIME_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})Z$/;
const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const MIN_YEAR = 1970;
const MAX_YEAR = 9999;

function isLeap(y: number): boolean {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

function daysInMonth(y: number, m: number): number {
  const days = [31, isLeap(y) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return days[m - 1] ?? 0;
}

function validYmd(y: number, m: number, d: number): boolean {
  return y >= MIN_YEAR && y <= MAX_YEAR && m >= 1 && m <= 12 && d >= 1 && d <= daysInMonth(y, m);
}

// Howard Hinnant's days_from_civil / civil_from_days (proleptic Gregorian, valid for y >= 0).
function daysFromCivil(y0: number, m: number, d: number): number {
  const y = m <= 2 ? y0 - 1 : y0;
  const era = Math.floor(y / 400);
  const yoe = y - era * 400;
  const doy = Math.floor((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

function civilFromDays(z0: number): [number, number, number] {
  const z1 = z0 + 719468;
  const era = Math.floor(z1 / 146097);
  const doe = z1 - era * 146097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const m = mp < 10 ? mp + 3 : mp - 9;
  const y = yoe + era * 400 + (m <= 2 ? 1 : 0);
  return [y, m, d];
}

export function isIsoDateTime(s: string): boolean {
  const m = ISO_DATETIME_RE.exec(s);
  if (!m) return false;
  const [y, mo, d, h, mi, se] = m.slice(1).map((x) => parseInt(x, 10)) as [number, number, number, number, number, number];
  return validYmd(y, mo, d) && h <= 23 && mi <= 59 && se <= 59;
}

export function isIsoDate(s: string): boolean {
  const m = ISO_DATE_RE.exec(s);
  if (!m) return false;
  const [y, mo, d] = m.slice(1).map((x) => parseInt(x, 10)) as [number, number, number];
  return validYmd(y, mo, d);
}

/** Seconds since the Unix epoch for a canonical ISODateTime. Throws on anything else. */
export function epochSecondsFromIso(iso: string): bigint {
  const m = ISO_DATETIME_RE.exec(iso);
  if (!m || !isIsoDateTime(iso)) throw new RangeError(`not a canonical ISODateTime: ${JSON.stringify(iso)}`);
  const [y, mo, d, h, mi, se] = m.slice(1).map((x) => parseInt(x, 10)) as [number, number, number, number, number, number];
  return BigInt(daysFromCivil(y, mo, d)) * 86400n + BigInt(h * 3600 + mi * 60 + se);
}

const MAX_EPOCH_SECONDS = 253402300799n; // 9999-12-31T23:59:59Z

/** Canonical ISODateTime (`YYYY-MM-DDTHH:MM:SSZ`) for epoch seconds in [0, 253402300799]. */
export function isoFromEpochSeconds(seconds: bigint): ISODateTime {
  if (seconds < 0n || seconds > MAX_EPOCH_SECONDS) throw new RangeError(`epoch seconds out of range: ${seconds}`);
  const days = seconds / 86400n;
  const rem = Number(seconds % 86400n);
  const [y, m, d] = civilFromDays(Number(days));
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${pad(y, 4)}-${pad(m)}-${pad(d)}T${pad(Math.floor(rem / 3600))}:${pad(Math.floor((rem % 3600) / 60))}:${pad(rem % 60)}Z`;
}

export const ISODateTimeSchema = z
  .string()
  .regex(ISO_DATETIME_RE, "expected RFC 3339 UTC with whole seconds: YYYY-MM-DDTHH:MM:SSZ")
  .refine(isIsoDateTime, "invalid calendar date/time");

export const ISODateSchema = z
  .string()
  .regex(ISO_DATE_RE, "expected YYYY-MM-DD")
  .refine(isIsoDate, "invalid calendar date");
