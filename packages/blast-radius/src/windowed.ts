// Window-limit bounds for wallets we have no chain state for (Blast Radius Lite, docs/08 §7).
// Same rules as bounds.ts: PURE bigint math, no imports, no clock, fail closed on malformed input.
//
// A third-party spending policy is a set of caps "at most `cap` per window of `lengthSeconds`". Whether the
// window is a rolling one or a calendar bucket is not knowable from the numbers, so both are computed:
//  - rolling (the vault's own semantics): an interval of t seconds is covered by ceil(t / w) windows;
//  - calendar (fixed buckets, worst-case alignment): an interval of t seconds can touch 1 + ceil((t - 1) / w)
//    buckets, which is 2 at t = w. That is the 2x boundary effect: spend the whole cap just before the bucket
//    ends and again just after it restarts.
// With no cap set the term does not exist (unbounded); the balance is then the only limit.
import { BoundsError, MAX_UINT256, ceilDiv } from "./bounds";

export type WindowMode = "rolling" | "calendar";
export interface WindowLimit {
  readonly label: string;
  readonly lengthSeconds: bigint;
  /** Most that may leave per window. Must be > 0 (a cap of 0 is refused as ambiguous: "off" or "nothing"?). */
  readonly cap: bigint;
}
export interface WindowedBound {
  readonly horizonSeconds: bigint;
  readonly value: bigint;
  /** Labels of every term tied for the minimum; "balance" for B; "empty-interval" when t = 0. */
  readonly binding: readonly string[];
}

function assertLimits(B: bigint, limits: readonly WindowLimit[]): void {
  if (typeof B !== "bigint" || B < 0n || B > MAX_UINT256) throw new BoundsError("INVALID_INPUT", "balance must be a bigint in [0, 2^256-1]");
  if (!Array.isArray(limits)) throw new BoundsError("INVALID_INPUT", "limits must be an array");
  for (const l of limits) {
    if (typeof l?.label !== "string" || l.label.length === 0) throw new BoundsError("INVALID_INPUT", "limit needs a label");
    if (typeof l.lengthSeconds !== "bigint" || l.lengthSeconds <= 0n) throw new BoundsError("INVALID_INPUT", `${l.label}: window length must be a positive bigint`);
    if (typeof l.cap !== "bigint" || l.cap <= 0n || l.cap > MAX_UINT256) throw new BoundsError("INVALID_INPUT", `${l.label}: cap must be a bigint in [1, 2^256-1]`);
  }
}

function assertT(t: unknown): asserts t is bigint {
  if (typeof t !== "bigint" || t < 0n) throw new BoundsError("INVALID_HORIZON", "horizon must be a bigint >= 0 seconds");
}

/** Number of windows of length w that a half-open interval of t seconds can touch (worst-case alignment). */
export function windowsCovering(mode: WindowMode, t: bigint, w: bigint): bigint {
  assertT(t);
  if (typeof w !== "bigint" || w <= 0n) throw new BoundsError("INVALID_INPUT", "window length must be a positive bigint");
  if (t === 0n) return 0n;
  if (mode === "rolling") return ceilDiv(t, w);
  if (mode === "calendar") return 1n + ceilDiv(t - 1n, w);
  throw new BoundsError("INVALID_INPUT", "mode must be rolling or calendar");
}

/** L(t) = min( B, cap_i * windowsCovering(mode, t, w_i) for every limit ). */
export function boundWindowed(B: bigint, limits: readonly WindowLimit[], mode: WindowMode, t: bigint): WindowedBound {
  assertLimits(B, limits);
  assertT(t);
  if (t === 0n) return Object.freeze({ horizonSeconds: t, value: 0n, binding: Object.freeze(["empty-interval"]) });
  const terms: [string, bigint][] = [["balance", B]];
  for (const l of limits) terms.push([l.label, l.cap * windowsCovering(mode, t, l.lengthSeconds)]);
  let value = terms[0]![1];
  for (const [, v] of terms) if (v < value) value = v;
  return Object.freeze({ horizonSeconds: t, value, binding: Object.freeze(terms.filter(([, v]) => v === value).map(([k]) => k)) });
}

/** Smallest t >= 1 such that windowsCovering(mode, t, w) >= k (k >= 1). */
function secondsToCover(mode: WindowMode, k: bigint, w: bigint): bigint {
  if (k <= 1n) return 1n;
  return mode === "rolling" ? (k - 1n) * w + 1n : (k - 2n) * w + 2n;
}

/** Largest t with windowsCovering(mode, t, w) <= k (k >= 0). */
function secondsWithin(mode: WindowMode, k: bigint, w: bigint): bigint {
  if (k === 0n) return 0n;
  return mode === "rolling" ? k * w : (k - 1n) * w + 1n;
}

/**
 * Fewest seconds in which the whole balance can leave: min{ t >= 1 : L(t) = B }. 0n when B is already 0.
 * With no limit the balance can leave at once (1 second).
 */
export function drainSeconds(B: bigint, limits: readonly WindowLimit[], mode: WindowMode): bigint {
  assertLimits(B, limits);
  if (B === 0n) return 0n;
  let t = 1n;
  for (const l of limits) {
    const s = secondsToCover(mode, ceilDiv(B, l.cap), l.lengthSeconds);
    if (s > t) t = s;
  }
  return t;
}

/**
 * Longest detection time that keeps the loss at or under `lossTarget`: max{ t : L(t) <= lossTarget }.
 * 'UNBOUNDED_BELOW_TARGET' when the balance itself is at or under the target. 0n when even one second of
 * spending already exceeds it (or there is no window limit at all).
 */
export function maxDetectionWindowed(
  B: bigint,
  limits: readonly WindowLimit[],
  mode: WindowMode,
  lossTarget: bigint,
): bigint | "UNBOUNDED_BELOW_TARGET" {
  assertLimits(B, limits);
  if (typeof lossTarget !== "bigint" || lossTarget < 0n || lossTarget > MAX_UINT256) throw new BoundsError("INVALID_TARGET", "lossTarget must be a bigint in [0, 2^256-1]");
  if (B <= lossTarget) return "UNBOUNDED_BELOW_TARGET";
  let best = 0n;
  for (const l of limits) {
    const s = secondsWithin(mode, lossTarget / l.cap, l.lengthSeconds);
    if (s > best) best = s;
  }
  return best;
}
