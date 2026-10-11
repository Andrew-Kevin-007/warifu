// Closed-form loss bounds (docs/08 §4, docs/16 §2.2). THE single implementation (INV-18): the CLI, the API,
// the UI what-if sliders, the T3 simulator oracle and the property tests all call this file.
//
// PURE: bigint math only. No Date, no randomness, no I/O, no env, no imports (guarded by test/purity.test.ts).
// Money is bigint base units (INV-10); time is bigint seconds. Anything missing or malformed throws
// BoundsError: a bound is never silently replaced by a smaller number (AGENTS.md §0.4, fail closed).
//
// Semantics are fixed once in docs/16 §2.2 and are not re-litigated here:
//  - horizon t means ANY half-open interval [T, T+t), T >= T0, while the configuration is unchanged;
//  - sumRemaining has no `start` filter (a later-starting engagement could fall inside a later interval);
//  - the vault's rolling window excludes a release exactly 24 h old, so an interval of t seconds is covered by
//    ceil(t / 86400) daily windows (and ceil(t / 3600) hourly windows).

export const SECONDS_PER_MINUTE = 60n;
export const SECONDS_PER_HOUR = 3600n;
export const SECONDS_PER_DAY = 86_400n;
export const MAX_UINT256 = (1n << 256n) - 1n;
/** docs/06 A.3 `RING_SIZE`: at most 64 releases per rolling 24 h. */
export const VAULT_RING_SIZE = 64n;
/** docs/16 §2.2: 60 s poll + pause transaction + finality margin. Published parameter, not a measurement. */
export const DEFAULT_DETECTION_LATENCY_SECONDS = 300n;

export interface BoundInputs {
  readonly B: bigint; // vault balance
  readonly P: bigint; // perTxCap
  readonly D: bigint; // dailyCap (exact rolling 24 h)
  readonly H: bigint; // humanThreshold (amounts above it need an owner signature the attacker lacks)
  readonly hc: bigint; // hourlyCap; 0 = disabled
  readonly N: bigint; // RING_SIZE = 64
  /** Σ (cap_i − released_i) over engagements with active && end >= blockTimestamp (no `start` filter). */
  readonly sumRemaining: bigint;
}

export type Term = "balance" | "daily" | "engagements" | "hourly";
export interface Bound {
  readonly horizonSeconds: bigint;
  readonly value: bigint;
  /** All terms tied for the minimum, in the order balance, daily, engagements, hourly. Never empty. */
  readonly binding: readonly Term[];
}

export const UNBOUNDED_BELOW_TARGET = "UNBOUNDED_BELOW_TARGET" as const;

/** docs/16 §2.2: horizons reported on a certificate. */
export const HORIZONS: readonly { readonly label: "1m" | "1h" | "6h" | "24h" | "48h" | "7d"; readonly seconds: bigint }[] =
  Object.freeze([
    { label: "1m", seconds: 60n },
    { label: "1h", seconds: 3600n },
    { label: "6h", seconds: 21_600n },
    { label: "24h", seconds: 86_400n },
    { label: "48h", seconds: 172_800n },
    { label: "7d", seconds: 604_800n },
  ]);

export type BoundsErrorCode = "INVALID_INPUT" | "INVALID_HORIZON" | "INVALID_TARGET";
export class BoundsError extends Error {
  readonly code: BoundsErrorCode;
  constructor(code: BoundsErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = "BoundsError";
    this.code = code;
  }
}

function isUint256(v: unknown): v is bigint {
  return typeof v === "bigint" && v >= 0n && v <= MAX_UINT256;
}

function describe(v: unknown): string {
  if (typeof v === "bigint") return `${v.toString()}n`;
  return typeof v;
}

/**
 * Fail-closed validation. Mirrors the vault constructor where it matters: P, D > 0 and N >= 1 (a zero there is
 * not a vault we know, and returning 0 for it would be a smaller number than any honest reading). B, H, hc and
 * sumRemaining may be 0 (H = 0 means every release needs an owner signature; hc = 0 means disabled).
 */
export function assertBoundInputs(i: BoundInputs): void {
  if (typeof i !== "object" || i === null) throw new BoundsError("INVALID_INPUT", "inputs must be an object");
  for (const k of ["B", "P", "D", "H", "hc", "N", "sumRemaining"] as const) {
    if (!isUint256(i[k])) throw new BoundsError("INVALID_INPUT", `${k} must be a bigint in [0, 2^256-1], got ${describe(i[k])}`);
  }
  if (i.P === 0n) throw new BoundsError("INVALID_INPUT", "P (perTxCap) must be > 0");
  if (i.D === 0n) throw new BoundsError("INVALID_INPUT", "D (dailyCap) must be > 0");
  if (i.N === 0n) throw new BoundsError("INVALID_INPUT", "N (RING_SIZE) must be >= 1");
}

function assertHorizon(t: unknown): asserts t is bigint {
  if (typeof t !== "bigint" || t < 0n) throw new BoundsError("INVALID_HORIZON", `horizon must be a bigint >= 0 seconds, got ${describe(t)}`);
}

export function ceilDiv(a: bigint, b: bigint): bigint {
  if (b <= 0n || a < 0n) throw new BoundsError("INVALID_INPUT", "ceilDiv needs a >= 0 and b > 0");
  return (a + b - 1n) / b;
}

function min2(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}

/** p* = min(P, H): the largest release that needs no owner approval. */
export function perReleaseUnapproved(i: BoundInputs): bigint {
  assertBoundInputs(i);
  return min2(i.P, i.H);
}

/** d* = min(D, N * p*): the most that can leave in one rolling 24 h without an owner signature. */
export function perDay(i: BoundInputs): bigint {
  assertBoundInputs(i);
  return min2(i.D, i.N * min2(i.P, i.H));
}

export interface WindowLengths {
  readonly daySeconds: bigint;
  readonly hourSeconds: bigint;
}
const VAULT_WINDOWS: WindowLengths = Object.freeze({ daySeconds: SECONDS_PER_DAY, hourSeconds: SECONDS_PER_HOUR });

/**
 * The same formula with the two window lengths as parameters. The vault's windows are 86400 s and 3600 s
 * (boundT3c); the parameter exists so the property tests can enumerate tiny windows exhaustively against an
 * independent brute force. Not a second implementation: boundT3c is this function with the vault's constants.
 */
export function boundT3cWithWindows(i: BoundInputs, t: bigint, w: WindowLengths): Bound {
  assertBoundInputs(i);
  assertHorizon(t);
  if (typeof w.daySeconds !== "bigint" || typeof w.hourSeconds !== "bigint" || w.daySeconds <= 0n || w.hourSeconds <= 0n) {
    throw new BoundsError("INVALID_INPUT", "window lengths must be positive bigints");
  }
  const terms: [Term, bigint][] = [
    ["balance", i.B],
    ["daily", min2(i.D, i.N * min2(i.P, i.H)) * ceilDiv(t, w.daySeconds)],
    ["engagements", i.sumRemaining],
  ];
  if (i.hc > 0n) terms.push(["hourly", i.hc * ceilDiv(t, w.hourSeconds)]);
  let value = terms[0]![1];
  for (const [, v] of terms) if (v < value) value = v;
  const binding = terms.filter(([, v]) => v === value).map(([k]) => k);
  return Object.freeze({ horizonSeconds: t, value, binding: Object.freeze(binding) });
}

/**
 * L_T3c(t) = min( B, d* * ceil(t/86400), sumRemaining, hc > 0 ? hc * ceil(t/3600) : +inf ).
 * T3 (stolen signer, honest payees) is owner-exposed value; T3c (colluding payee) is attacker-extractable; the
 * number is the same (docs/08 §4). Says nothing about availability (docs/16 §6).
 */
export function boundT3c(i: BoundInputs, t: bigint): Bound {
  return boundT3cWithWindows(i, t, VAULT_WINDOWS);
}

/** The six certificate horizons (docs/16 §2.2), in order. */
export function boundsAtHorizons(i: BoundInputs): readonly (Bound & { readonly label: string })[] {
  return Object.freeze(HORIZONS.map((h) => Object.freeze({ label: h.label, ...boundT3c(i, h.seconds) })));
}

/** The "alarmed" variant: boundT3c at the published detection latency, under assumption A-MON. */
export function boundAlarmed(i: BoundInputs, detectionLatencySeconds: bigint = DEFAULT_DETECTION_LATENCY_SECONDS): Bound {
  return boundT3c(i, detectionLatencySeconds);
}

/**
 * Number of 24 h windows needed to drain min(B, sumRemaining) at d* per window: ceil(min(B, ΣR) / d*).
 * `days` is a window count (the fastest case, ignoring the hourly cap, so it errs on the short side).
 * d* = 0 (every release needs an owner signature) => days null: nothing can leave without the owner.
 * `limitedBy` names the smaller of balance and engagements (ties: balance); 'daily' when d* = 0.
 */
export function timeToEmpty(i: BoundInputs): { days: bigint | null; limitedBy: Term } {
  assertBoundInputs(i);
  const d = min2(i.D, i.N * min2(i.P, i.H));
  const limitedBy: Term = i.B <= i.sumRemaining ? "balance" : "engagements";
  if (d === 0n) return { days: null, limitedBy: "daily" };
  return { days: ceilDiv(min2(i.B, i.sumRemaining), d), limitedBy };
}

/**
 * h = max{ t : L_T3c(t) <= lossTarget }, the longest time you may take to detect and pause while keeping the
 * loss at or under the target. L is a non-decreasing step function, so the inverse is exact:
 *  - 'UNBOUNDED_BELOW_TARGET' when L never exceeds the target (min(B, ΣR) <= target, or d* = 0);
 *  - otherwise max( 86400 * floor(Z / d*), hc > 0 ? 3600 * floor(Z / hc) : 0 ) (a min is <= Z iff a term is).
 * 0n means even an immediate release already exceeds the target (L(1) > Z).
 */
export function maxDetectionSeconds(i: BoundInputs, lossTarget: bigint): bigint | typeof UNBOUNDED_BELOW_TARGET {
  assertBoundInputs(i);
  if (!isUint256(lossTarget)) throw new BoundsError("INVALID_TARGET", `lossTarget must be a bigint in [0, 2^256-1], got ${describe(lossTarget)}`);
  const d = min2(i.D, i.N * min2(i.P, i.H));
  const cap = min2(i.B, i.sumRemaining);
  if (d === 0n || cap <= lossTarget) return UNBOUNDED_BELOW_TARGET;
  const byDay = SECONDS_PER_DAY * (lossTarget / d);
  const byHour = i.hc > 0n ? SECONDS_PER_HOUR * (lossTarget / i.hc) : 0n;
  return byDay > byHour ? byDay : byHour;
}
