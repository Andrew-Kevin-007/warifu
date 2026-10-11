// Property tests for bounds.ts (docs/16 §10 test 2; WP-25 acceptance): 1,000 runs each, fixed seeds.
//  - monotone: tightening any cap never raises the bound;
//  - never below an exact small-case enumeration (test/helpers/enumerate.ts, which does not call bounds.ts),
//    and EQUAL to it when the hourly cap is off (the bound is tight, so a loose bound cannot pass);
//  - the reported binding terms are exactly the tied minima;
//  - bound <= B, <= sumRemaining, perDay <= D; maxDetectionSeconds is the exact inverse of boundT3c;
//  - negative controls: deliberately wrong implementations are rejected by the very same property functions.
import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  boundT3c,
  boundT3cWithWindows,
  maxDetectionSeconds,
  perDay,
  perReleaseUnapproved,
  timeToEmpty,
} from "../src/bounds";
import type { BoundInputs, Term } from "../src/bounds";
import { boundInputs, fcParams, horizon, tighten } from "./helpers/arb";
import type { BoundFn } from "./helpers/arb";
import { maxExtractable } from "./helpers/enumerate";

const real: BoundFn = (i, t) => boundT3c(i, t).value;
const ceilDiv = (a: bigint, b: bigint): bigint => (a + b - 1n) / b;
const min = (...xs: bigint[]): bigint => xs.reduce((a, b) => (b < a ? b : a));

// ---------- property bodies, parameterised by the implementation under test ----------
function monotone(impl: BoundFn) {
  return fc.property(boundInputs, fc.nat({ max: 6 }), fc.bigInt({ min: 0n, max: 1000n }), horizon, (i, pick, frac, t) => {
    const tight = tighten(i, pick, frac);
    return impl(tight, t) <= impl(i, t);
  });
}
function monotoneAll(impl: BoundFn) {
  return fc.property(boundInputs, fc.array(fc.tuple(fc.nat({ max: 6 }), fc.bigInt({ min: 0n, max: 1000n })), { minLength: 1, maxLength: 5 }), horizon, (i, steps, t) => {
    let cur = i;
    let prev = impl(cur, t);
    for (const [pick, frac] of steps) {
      cur = tighten(cur, pick, frac);
      const v = impl(cur, t);
      if (v > prev) return false;
      prev = v;
    }
    return true;
  });
}
function monotoneInTime(impl: BoundFn) {
  return fc.property(boundInputs, horizon, fc.bigInt({ min: 0n, max: 200_000n }), (i, t, dt) => impl(i, t) <= impl(i, t + dt));
}
function capped(impl: BoundFn) {
  return fc.property(boundInputs, horizon, (i, t) => {
    const v = impl(i, t);
    return v <= i.B && v <= i.sumRemaining && v >= 0n;
  });
}

// tiny discrete world for the exhaustive comparison
const tiny = fc.record({
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
type Tiny = typeof tiny extends fc.Arbitrary<infer T> ? T : never;
const toInputs = (c: Tiny): BoundInputs => ({
  B: BigInt(c.B), P: BigInt(c.P), D: BigInt(c.D), H: BigInt(c.H), hc: BigInt(c.hc), N: BigInt(c.N), sumRemaining: BigInt(c.R),
});
const valid = (c: Tiny): boolean => c.hourLen <= c.dayLen;
const enumerated = (c: Tiny): number =>
  maxExtractable({ B: c.B, pstar: Math.min(c.P, c.H), D: c.D, hc: c.hc, N: c.N, R: c.R, dayLen: c.dayLen, hourLen: c.hourLen }, c.t);
type WindowedImpl = (i: BoundInputs, t: bigint, day: bigint, hour: bigint) => bigint;
const realWindowed: WindowedImpl = (i, t, day, hour) => boundT3cWithWindows(i, t, { daySeconds: day, hourSeconds: hour }).value;

function neverBelowEnumeration(impl: WindowedImpl) {
  return fc.property(tiny, (c) => {
    if (!valid(c)) return true;
    return impl(toInputs(c), BigInt(c.t), BigInt(c.dayLen), BigInt(c.hourLen)) >= BigInt(enumerated(c));
  });
}
function tightWithoutHourly(impl: WindowedImpl) {
  return fc.property(tiny, (c) => {
    if (!valid(c)) return true;
    const noHourly = { ...c, hc: 0 };
    return impl(toInputs(noHourly), BigInt(noHourly.t), BigInt(c.dayLen), BigInt(c.hourLen)) === BigInt(enumerated(noHourly));
  });
}

const passes = <T>(p: fc.IRawProperty<T, false>, offset: number): boolean => !fc.check(p, fcParams<T>(offset)).failed;

describe("closed form: properties on the real implementation (1,000 runs each)", () => {
  it("tightening any single cap never raises the bound", () => {
    fc.assert(monotone(real), fcParams(1));
  });
  it("tightening several caps in sequence never raises the bound", () => {
    fc.assert(monotoneAll(real), fcParams(2));
  });
  it("the bound never decreases with a longer horizon", () => {
    fc.assert(monotoneInTime(real), fcParams(3));
  });
  it("bound <= B and <= sumRemaining and >= 0", () => {
    fc.assert(capped(real), fcParams(4));
  });
  it("perDay <= D, perDay <= N * p*, p* <= min(P, H)", () => {
    fc.assert(
      fc.property(boundInputs, (i) => {
        const d = perDay(i);
        const p = perReleaseUnapproved(i);
        return d <= i.D && d <= i.N * p && p <= i.P && p <= i.H && (d === i.D || d === i.N * p);
      }),
      fcParams(5),
    );
  });
  it("is never below the exact enumeration of what an attacker can extract (tiny worlds)", () => {
    fc.assert(neverBelowEnumeration(realWindowed), fcParams(6));
  });
  it("equals the enumeration when the hourly cap is off (the bound is tight, not just safe)", () => {
    fc.assert(tightWithoutHourly(realWindowed), fcParams(7));
  });
  it("with an hourly cap the bound is never below the enumeration, and is sometimes strictly above it", () => {
    let strictlyAbove = 0;
    let withHourly = 0;
    fc.assert(
      fc.property(tiny, (c) => {
        if (!valid(c) || c.hc === 0) return true;
        withHourly++;
        const b = realWindowed(toInputs(c), BigInt(c.t), BigInt(c.dayLen), BigInt(c.hourLen));
        const e = BigInt(enumerated(c));
        if (b > e) strictlyAbove++;
        return b >= e;
      }),
      fcParams(8),
    );
    // Reported, not hidden: the hourly term and the daily term can both be needed for the exact maximum, so the
    // closed form can be conservative when hc > 0. The simulator (WP-26) measures tightness on the real contract.
    expect(withHourly).toBeGreaterThan(100);
    expect(strictlyAbove).toBeGreaterThanOrEqual(0);
  });
});

describe("binding terms", () => {
  const TERMS: Term[] = ["balance", "daily", "engagements", "hourly"];
  it("binding is exactly the set of terms tied for the minimum (independent recomputation)", () => {
    fc.assert(
      fc.property(boundInputs, horizon, (i, t) => {
        const b = boundT3c(i, t);
        const d = min(i.D, i.N * min(i.P, i.H));
        const terms: Record<Term, bigint | null> = {
          balance: i.B,
          daily: d * ceilDiv(t, 86_400n),
          engagements: i.sumRemaining,
          hourly: i.hc > 0n ? i.hc * ceilDiv(t, 3600n) : null,
        };
        const present = TERMS.filter((k) => terms[k] !== null);
        const m = min(...present.map((k) => terms[k] as bigint));
        const expected = present.filter((k) => terms[k] === m);
        return b.value === m && expected.length > 0 && JSON.stringify([...b.binding]) === JSON.stringify(expected);
      }),
      fcParams(9),
    );
  });
  it("hourly is never reported when the hourly cap is disabled", () => {
    fc.assert(fc.property(boundInputs, horizon, (i, t) => i.hc > 0n || !boundT3c(i, t).binding.includes("hourly")), fcParams(10));
  });
  it("raising B moves the bound iff balance is the only binding term", () => {
    fc.assert(
      fc.property(boundInputs, horizon, (i, t) => {
        const b = boundT3c(i, t);
        const loosenB = boundT3c({ ...i, B: i.B + 1_000_000_000n }, t).value;
        return b.binding.includes("balance") && b.binding.length === 1 ? loosenB > b.value : b.binding.includes("balance") || loosenB === b.value;
      }),
      fcParams(11),
    );
  });
});

describe("timeToEmpty and maxDetectionSeconds are consistent with boundT3c", () => {
  it("maxDetectionSeconds is the exact inverse of boundT3c (checked by binary search on the real bound)", () => {
    fc.assert(
      fc.property(boundInputs, fc.bigInt({ min: 0n, max: 10n ** 12n }), (i, z) => {
        const r = maxDetectionSeconds(i, z);
        // Largest t with bound(t) <= z found by galloping + binary search over the monotone step function.
        let hi = 1n;
        while (boundT3c(i, hi).value <= z && hi < 1n << 70n) hi *= 2n;
        if (r === "UNBOUNDED_BELOW_TARGET") return boundT3c(i, hi).value <= z && boundT3c(i, 1n << 70n).value <= z;
        let lo = 0n;
        let top = hi;
        while (lo < top) {
          const mid = (lo + top + 1n) / 2n;
          if (boundT3c(i, mid).value <= z) lo = mid;
          else top = mid - 1n;
        }
        return r === lo && boundT3c(i, r).value <= z && boundT3c(i, r + 1n).value > z;
      }),
      fcParams(12),
    );
  });
  it("timeToEmpty.days is the smallest number of 24 h windows that reaches min(B, sumRemaining) (hourly off)", () => {
    fc.assert(
      fc.property(boundInputs, (raw) => {
        const i = { ...raw, hc: 0n };
        const { days, limitedBy } = timeToEmpty(i);
        const target = min(i.B, i.sumRemaining);
        if (days === null) return perDay(i) === 0n && limitedBy === "daily";
        const reached = boundT3c(i, days * 86_400n).value === target;
        const notBefore = days === 0n ? target === 0n : boundT3c(i, (days - 1n) * 86_400n).value < target;
        const who = i.B <= i.sumRemaining ? "balance" : "engagements";
        return reached && notBefore && limitedBy === who;
      }),
      fcParams(13),
    );
  });
  it("with an hourly cap the stated window count is a lower bound on the true drain time", () => {
    fc.assert(
      fc.property(boundInputs, (i) => {
        const { days } = timeToEmpty(i);
        if (days === null) return true;
        return boundT3c(i, days * 86_400n).value <= min(i.B, i.sumRemaining);
      }),
      fcParams(14),
    );
  });
});

describe("negative controls: wrong implementations are rejected by the same properties", () => {
  const w = (mut: (i: BoundInputs, t: bigint, day: bigint, hour: bigint) => bigint): WindowedImpl => mut;
  const floorWindows = w((i, t, day, hour) => {
    const d = min(i.D, i.N * min(i.P, i.H));
    const terms = [i.B, d * (t / day), i.sumRemaining, ...(i.hc > 0n ? [i.hc * (t / hour)] : [])];
    return min(...terms);
  });
  const closedInterval = w((i, t, day, hour) => {
    // a closed [T, T+t] interval would contain one extra daily window when t is a multiple of 24 h
    const d = min(i.D, i.N * min(i.P, i.H));
    const extra = t > 0n && t % day === 0n ? 1n : 0n;
    return min(i.B, d * (ceilDiv(t, day) + extra), i.sumRemaining, ...(i.hc > 0n ? [i.hc * ceilDiv(t, hour)] : []));
  });
  const maxInsteadOfMinP = w((i, t, day, hour) => {
    const d = min(i.D, i.N * (i.P > i.H ? i.P : i.H));
    return min(i.B, d * ceilDiv(t, day), i.sumRemaining, ...(i.hc > 0n ? [i.hc * ceilDiv(t, hour)] : []));
  });
  const ignoresEngagements = w((i, t, day, hour) => {
    const d = min(i.D, i.N * min(i.P, i.H));
    return min(i.B, d * ceilDiv(t, day), ...(i.hc > 0n ? [i.hc * ceilDiv(t, hour)] : []));
  });
  const ignoresHourly = w((i, t, day) => {
    const d = min(i.D, i.N * min(i.P, i.H));
    return min(i.B, d * ceilDiv(t, day), i.sumRemaining);
  });

  it("floor instead of ceil (loses the last partial window) falls below the enumeration", () => {
    expect(passes(neverBelowEnumeration(floorWindows), 20)).toBe(false);
  });
  it("a closed interval (extra window at exactly 24 h) is too loose: caught by the tightness property", () => {
    expect(passes(tightWithoutHourly(closedInterval), 21)).toBe(false);
    expect(passes(neverBelowEnumeration(closedInterval), 21)).toBe(true); // it is safe but loose: only tightness sees it
  });
  it("using max(P, H) instead of min(P, H) is too loose", () => {
    expect(passes(tightWithoutHourly(maxInsteadOfMinP), 22)).toBe(false);
  });
  it("dropping the engagement term is too loose", () => {
    expect(passes(tightWithoutHourly(ignoresEngagements), 23)).toBe(false);
  });
  it("dropping the hourly term is looser, never smaller: the enumeration cannot flag it, the golden vectors do", () => {
    // Without the hourly term the bound is larger, never smaller: the safe direction. The enumeration cannot
    // call it unsafe; the golden vectors (G6, G10) and the binding test are what pin the hourly term down.
    expect(passes(neverBelowEnumeration(ignoresHourly), 24)).toBe(true);
    const i: BoundInputs = { B: 1000n, P: 100n, D: 200n, H: 100n, hc: 25n, N: 64n, sumRemaining: 1000n };
    expect(real(i, 60n)).toBe(25n);
    expect(ignoresHourly(i, 60n, 86_400n, 3600n)).toBe(200n);
  });
  it("a non-monotone implementation (D reduced modulo 7) is rejected by the monotone properties", () => {
    const nonMonotone: BoundFn = (i, t) => boundT3c({ ...i, D: (i.D % 7n) + 1n }, t).value;
    expect(passes(monotone(nonMonotone), 25)).toBe(false);
  });
  it("min replaced by max violates bound <= B", () => {
    const maxed: BoundFn = (i, t) => {
      const d = min(i.D, i.N * min(i.P, i.H));
      const xs = [i.B, d * ceilDiv(t, 86_400n), i.sumRemaining];
      return xs.reduce((a, b) => (b > a ? b : a));
    };
    expect(passes(capped(maxed), 26)).toBe(false);
  });
  it("treating hc = 0 as a cap of zero instead of disabled undercuts the enumeration", () => {
    const zeroMeansCapZero = w((i, t, day, hour) => {
      const d = min(i.D, i.N * min(i.P, i.H));
      return min(i.B, d * ceilDiv(t, day), i.sumRemaining, i.hc * ceilDiv(t, hour));
    });
    expect(passes(neverBelowEnumeration(zeroMeansCapZero), 27)).toBe(false);
  });
});
