// Statistics for attack results (docs/07 §3.3 item 4, docs/13 §4.9). These are ratios and probabilities, not
// money, so JS numbers are correct here (INV-10 is about amounts). Every function is pure and deterministic.
//   ruleOfThree(n)            3/n: the usual 95 % upper bound when k = 0 (an approximation, reported as such)
//   clopperPearsonUpper(k,n)  exact one-sided upper bound: the p solving P(X <= k | n, p) = 1 - confidence
//   wilson(k,n)               Wilson score interval (two-sided), used for false-reject rates on benign items
// "0 losses" is always rendered as "0 in n (95 % upper bound <= 3/n)", never as safe or unbreakable.

export const Z_95_TWO_SIDED = 1.959963984540054;

function checkCounts(k: number, n: number): void {
  if (!Number.isInteger(n) || n < 1) throw new RangeError("n must be an integer >= 1");
  if (!Number.isInteger(k) || k < 0 || k > n) throw new RangeError("k must be an integer in [0, n]");
}

/** 3 / n: the 95 % upper bound on a rate after n independent trials with 0 events. */
export function ruleOfThree(n: number): number {
  if (!Number.isInteger(n) || n < 1) throw new RangeError("n must be an integer >= 1");
  return Math.min(1, 3 / n);
}

/** P(X <= k) for X ~ Binomial(n, p), summed in log space so large n does not underflow. */
export function binomialCdf(k: number, n: number, p: number): number {
  if (p <= 0) return 1;
  if (p >= 1) return k >= n ? 1 : 0;
  const lp = Math.log(p);
  const lq = Math.log1p(-p);
  let logChoose = 0; // log C(n, 0)
  const terms: number[] = [];
  for (let i = 0; i <= k; i++) {
    if (i > 0) logChoose += Math.log(n - i + 1) - Math.log(i);
    terms.push(logChoose + i * lp + (n - i) * lq);
  }
  const max = Math.max(...terms);
  return Math.exp(max) * terms.reduce((s, t) => s + Math.exp(t - max), 0);
}

/**
 * Clopper-Pearson one-sided upper confidence bound for a binomial proportion: the p in [0, 1] with
 * P(X <= k | n, p) = 1 - confidence. k = n gives 1. Solved by bisection (monotone in p), 200 halvings.
 */
export function clopperPearsonUpper(k: number, n: number, confidence = 0.95): number {
  checkCounts(k, n);
  if (!(confidence > 0 && confidence < 1)) throw new RangeError("confidence must be in (0, 1)");
  if (k === n) return 1;
  const alpha = 1 - confidence;
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    if (binomialCdf(k, n, mid) > alpha) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

export interface Interval {
  readonly lower: number;
  readonly upper: number;
}

/** Wilson score interval (default z for 95 % two-sided). */
export function wilson(k: number, n: number, z = Z_95_TWO_SIDED): Interval {
  checkCounts(k, n);
  const phat = k / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = (phat + z2 / (2 * n)) / denom;
  const half = (z * Math.sqrt((phat * (1 - phat)) / n + z2 / (4 * n * n))) / denom;
  // Mathematically the lower bound is exactly 0 at k = 0 and the upper exactly 1 at k = n; floating error must not blur that.
  return { lower: k === 0 ? 0 : Math.max(0, centre - half), upper: k === n ? 1 : Math.min(1, centre + half) };
}

export interface RateSummary {
  readonly n: number;
  readonly k: number;
  readonly rate: number;
  /** 95 % upper bound: rule of three when k = 0, Clopper-Pearson otherwise. */
  readonly upper95: number;
  readonly upper95Method: "rule-of-three" | "clopper-pearson";
}

/** The standard summary printed next to every loss count: n, k and the 95 % upper bound. n = 0 has no rate. */
export function summarizeRate(k: number, n: number): RateSummary | null {
  if (n === 0) return null;
  checkCounts(k, n);
  return k === 0
    ? { n, k, rate: 0, upper95: ruleOfThree(n), upper95Method: "rule-of-three" }
    : { n, k, rate: k / n, upper95: clopperPearsonUpper(k, n), upper95Method: "clopper-pearson" };
}
