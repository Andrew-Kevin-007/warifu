// Shared fast-check arbitraries, seeds and mutants for the closed-form property tests.
import * as fc from "fast-check";
import type { BoundInputs } from "../../src/bounds";

/** One fixed seed per file so a failure reproduces; override with BLAST_SEED=<int> to explore. */
export const SEED: number = process.env["BLAST_SEED"] !== undefined ? Number.parseInt(process.env["BLAST_SEED"], 10) : 20_261_012;
export const RUNS = 1000;
export const fcParams = <T = unknown>(offset = 0): fc.Parameters<T> => ({ numRuns: RUNS, seed: SEED + offset });

/** Small values collide often (ties and boundaries); large values exercise magnitude. */
const amount = (min: bigint, max: bigint): fc.Arbitrary<bigint> =>
  fc.oneof({ weight: 3, arbitrary: fc.bigInt({ min, max: min + 24n }) }, { weight: 2, arbitrary: fc.bigInt({ min, max }) });

export const boundInputs: fc.Arbitrary<BoundInputs> = fc.record({
  B: amount(0n, 10n ** 12n),
  P: amount(1n, 10n ** 9n),
  D: amount(1n, 10n ** 12n),
  H: amount(0n, 10n ** 9n),
  hc: fc.oneof({ weight: 2, arbitrary: fc.constant(0n) }, { weight: 3, arbitrary: amount(1n, 10n ** 10n) }),
  N: fc.oneof({ weight: 2, arbitrary: fc.constant(64n) }, { weight: 3, arbitrary: fc.bigInt({ min: 1n, max: 100n }) }),
  sumRemaining: amount(0n, 10n ** 12n),
});

/** Horizons around every boundary the formula has, plus arbitrary ones. */
export const horizon: fc.Arbitrary<bigint> = fc.oneof(
  { weight: 3, arbitrary: fc.bigInt({ min: 0n, max: 3_000_000n }) },
  { weight: 2, arbitrary: fc.constantFrom(0n, 1n, 59n, 60n, 3599n, 3600n, 3601n, 86_399n, 86_400n, 86_401n, 172_800n, 172_801n, 604_800n) },
  { weight: 1, arbitrary: fc.bigInt({ min: 0n, max: 10n ** 12n }) },
);

export function tighten(i: BoundInputs, pick: number, frac: bigint): BoundInputs {
  // frac in [0, 1000]: new value = old * frac / 1000 (never above old), clamped to the validity floor.
  const scale = (v: bigint, floor: bigint): bigint => {
    const x = (v * frac) / 1000n;
    return x < floor ? (v < floor ? v : floor) : x;
  };
  switch (pick % 7) {
    case 0:
      return { ...i, B: scale(i.B, 0n) };
    case 1:
      return { ...i, P: scale(i.P, 1n) };
    case 2:
      return { ...i, D: scale(i.D, 1n) };
    case 3:
      return { ...i, H: scale(i.H, 0n) };
    case 4:
      // hourly cap: disabled (0) is the loosest setting, so enabling it at any positive value is a tightening.
      return { ...i, hc: i.hc === 0n ? 1n + (frac * 10n ** 9n) / 1000n : scale(i.hc, 1n) };
    case 5:
      return { ...i, N: scale(i.N, 1n) };
    default:
      return { ...i, sumRemaining: scale(i.sumRemaining, 0n) };
  }
}

export type BoundFn = (i: BoundInputs, t: bigint) => bigint;
