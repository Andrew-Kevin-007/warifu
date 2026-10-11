// Exact small-case enumeration: the independent oracle for "the closed form is never below what an attacker can
// actually extract". It does NOT call bounds.ts. It models the vault's release rules on a tiny discrete clock
// (docs/06 A.4 steps 8-10, 12) and maximises the total extracted inside the half-open interval [0, t).
//
// Model (all values are tiny non-negative integers, JS numbers are fine here because nothing is money):
//  - time is integer steps 0 .. t-1; any number of releases may land in one step (several txs in one block);
//  - a release of amount a at step s needs, counting only releases at steps in (s-dayLen, s] (the vault's
//    rolling window excludes a release exactly dayLen old, `t > now - 1d`):
//      a <= pstar (= min(perTxCap, humanThreshold): above it an owner signature is needed),
//      daySum + a <= D, dayCount < N, hourSum + a <= hc when hc > 0 (steps in (s-hourLen, s]),
//      total + a <= min(B, R)  (balance and the pooled remaining engagement capacity);
//  - constraints only look backwards in time, so per step only (sum, count) matter, and for a given sum the
//    smallest count ceil(sum / pstar) dominates (the count limit is the only thing a larger count affects).
export interface EnumConfig {
  readonly B: number;
  readonly pstar: number; // min(P, H)
  readonly D: number;
  readonly hc: number; // 0 = off
  readonly N: number;
  readonly R: number; // sumRemaining
  readonly dayLen: number;
  readonly hourLen: number;
}

export function maxExtractable(c: EnumConfig, t: number): number {
  const budget = Math.min(c.B, c.R);
  if (t <= 0 || c.pstar <= 0 || budget <= 0) return 0;
  const memo = new Map<string, number>();

  // hist holds the last (dayLen - 1) steps, most recent last, as [sum, count] pairs.
  const go = (step: number, hist: readonly (readonly [number, number])[], total: number): number => {
    if (step >= t) return 0;
    const key = `${step}|${hist.map((h) => `${h[0]}:${h[1]}`).join(",")}|${total}`;
    const hit = memo.get(key);
    if (hit !== undefined) return hit;

    const daySumPrev = hist.reduce((a, h) => a + h[0], 0);
    const dayCntPrev = hist.reduce((a, h) => a + h[1], 0);
    const hourHist = hist.slice(Math.max(0, hist.length - (c.hourLen - 1)));
    const hourSumPrev = c.hourLen > 1 ? hourHist.reduce((a, h) => a + h[0], 0) : 0;

    let best = 0;
    const maxSum = Math.min(c.D - daySumPrev, budget - total, c.hc > 0 ? c.hc - hourSumPrev : Infinity, c.N * c.pstar);
    for (let sum = 0; sum <= maxSum; sum++) {
      const cnt = sum === 0 ? 0 : Math.ceil(sum / c.pstar);
      if (dayCntPrev + cnt > c.N) continue;
      const nextHist = [...hist, [sum, cnt] as const];
      while (nextHist.length > Math.max(0, c.dayLen - 1)) nextHist.shift();
      const v = sum + go(step + 1, nextHist, total + sum);
      if (v > best) best = v;
    }
    memo.set(key, best);
    return best;
  };

  return go(0, [], 0);
}
