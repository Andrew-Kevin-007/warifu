// The tiny discrete world used to compare the closed form with the exhaustive enumeration. Shared by the
// property tests and by the results campaign so both always exercise the same space.
import * as fc from "fast-check";
import { boundT3cWithWindows } from "../../src/bounds";
import type { BoundInputs } from "../../src/bounds";
import { maxExtractable } from "./enumerate";

export const tiny = fc.record({
  B: fc.integer({ min: 0, max: 14 }),
  P: fc.integer({ min: 1, max: 4 }),
  H: fc.integer({ min: 0, max: 5 }),
  D: fc.integer({ min: 1, max: 9 }),
  hc: fc.oneof(fc.constant(0), fc.integer({ min: 1, max: 6 })),
  N: fc.integer({ min: 1, max: 4 }),
  R: fc.integer({ min: 0, max: 14 }),
  dayLen: fc.integer({ min: 2, max: 4 }),
  hourLen: fc.integer({ min: 1, max: 4 }),
  t: fc.integer({ min: 0, max: 11 }),
});
export type Tiny = typeof tiny extends fc.Arbitrary<infer T> ? T : never;

export const toInputs = (c: Tiny): BoundInputs => ({
  B: BigInt(c.B),
  P: BigInt(c.P),
  D: BigInt(c.D),
  H: BigInt(c.H),
  hc: BigInt(c.hc),
  N: BigInt(c.N),
  sumRemaining: BigInt(c.R),
});
/** The enumerator's hourly window must fit inside its daily history. */
export const valid = (c: Tiny): boolean => c.hourLen <= c.dayLen;
export const enumerated = (c: Tiny): number =>
  maxExtractable({ B: c.B, pstar: Math.min(c.P, c.H), D: c.D, hc: c.hc, N: c.N, R: c.R, dayLen: c.dayLen, hourLen: c.hourLen }, c.t);

export type WindowedImpl = (i: BoundInputs, t: bigint, day: bigint, hour: bigint) => bigint;
export const realWindowed: WindowedImpl = (i, t, day, hour) =>
  boundT3cWithWindows(i, t, { daySeconds: day, hourSeconds: hour }).value;
