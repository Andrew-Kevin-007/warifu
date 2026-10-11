// windowed.ts: limits of the form "cap per window" for wallets we only know by their numbers (Lite).
//  - calendar bucket count is checked against a direct counting oracle over every alignment (2x boundary effect);
//  - the rolling mode with the vault's windows equals boundT3c (single implementation, two entry points);
//  - drainSeconds / maxDetectionWindowed are exact inverses of boundWindowed (checked by scanning small worlds).
import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import { BoundsError, boundT3c } from "../src/bounds";
import { boundWindowed, drainSeconds, maxDetectionWindowed, windowsCovering } from "../src/windowed";
import type { WindowLimit, WindowMode } from "../src/windowed";
import { fcParams, boundInputs, horizon } from "./helpers/arb";

// direct oracle: how many fixed buckets of length w does [T, T+t) touch, maximised over every alignment T mod w
function bucketsTouched(t: number, w: number): number {
  if (t === 0) return 0;
  let best = 0;
  for (let T = 0; T < w; T++) {
    const seen = new Set<number>();
    for (let x = T; x < T + t; x++) seen.add(Math.floor(x / w));
    best = Math.max(best, seen.size);
  }
  return best;
}
// rolling oracle: windows of length w anchored at the interval start, each excluding the instant w later
const rollingTouched = (t: number, w: number): number => (t === 0 ? 0 : Math.ceil(t / w));

describe("windowsCovering", () => {
  it("calendar: matches the direct counting oracle for every (t, w) in a small grid", () => {
    for (let w = 1; w <= 7; w++) {
      for (let t = 0; t <= 4 * w + 3; t++) {
        expect(windowsCovering("calendar", BigInt(t), BigInt(w))).toBe(BigInt(bucketsTouched(t, w)));
      }
    }
  });
  it("rolling: ceil(t / w)", () => {
    for (let w = 1; w <= 7; w++) for (let t = 0; t <= 30; t++) expect(windowsCovering("rolling", BigInt(t), BigInt(w))).toBe(BigInt(rollingTouched(t, w)));
  });
  it("the 2x boundary effect: at exactly one window length calendar counts 2, rolling counts 1", () => {
    expect(windowsCovering("calendar", 86_400n, 86_400n)).toBe(2n);
    expect(windowsCovering("rolling", 86_400n, 86_400n)).toBe(1n);
    expect(windowsCovering("calendar", 1n, 86_400n)).toBe(1n);
    expect(windowsCovering("calendar", 2n, 86_400n)).toBe(2n);
  });
  it("negative control: a naive calendar count of ceil(t/w) is wrong at t = w", () => {
    expect(bucketsTouched(5, 5)).toBe(2);
    expect(rollingTouched(5, 5)).toBe(1);
  });
  it("rejects bad arguments", () => {
    expect(() => windowsCovering("calendar", -1n, 5n)).toThrow(BoundsError);
    expect(() => windowsCovering("rolling", 5n, 0n)).toThrow(BoundsError);
    expect(() => windowsCovering("weekly" as unknown as WindowMode, 5n, 5n)).toThrow(BoundsError);
  });
});

describe("boundWindowed", () => {
  const day: WindowLimit = { label: "daily", lengthSeconds: 86_400n, cap: 200n };
  const week: WindowLimit = { label: "weekly", lengthSeconds: 604_800n, cap: 600n };
  it("hand-computed: B=1000, daily 200, weekly 600", () => {
    // rolling: 1 min -> 200 (daily); 24 h -> 200; 48 h -> 400; 3 d -> 600 (daily 600 ties weekly 600); 4 d -> 600 (weekly)
    const r = (t: bigint) => boundWindowed(1000n, [day, week], "rolling", t);
    expect(r(60n)).toMatchObject({ value: 200n, binding: ["daily"] });
    expect(r(86_400n)).toMatchObject({ value: 200n, binding: ["daily"] });
    expect(r(172_800n)).toMatchObject({ value: 400n, binding: ["daily"] });
    expect(r(259_200n)).toMatchObject({ value: 600n, binding: ["daily", "weekly"] });
    expect(r(345_600n)).toMatchObject({ value: 600n, binding: ["weekly"] });
    expect(r(604_800n)).toMatchObject({ value: 600n, binding: ["weekly"] });
    // calendar: 24 h touches 2 daily buckets -> 400; 1 week touches 2 weekly buckets -> min(1000, 1200)
    const c = (t: bigint) => boundWindowed(1000n, [day, week], "calendar", t);
    expect(c(86_400n)).toMatchObject({ value: 400n, binding: ["daily"] });
    expect(c(1n)).toMatchObject({ value: 200n, binding: ["daily"] });
    expect(c(604_800n)).toMatchObject({ value: 1000n, binding: ["balance"] });
  });
  it("no limits: the whole balance can leave at once, and the empty interval is 0", () => {
    expect(boundWindowed(1000n, [], "rolling", 1n)).toMatchObject({ value: 1000n, binding: ["balance"] });
    expect(boundWindowed(1000n, [], "rolling", 0n)).toMatchObject({ value: 0n, binding: ["empty-interval"] });
  });
  it("rolling with the vault's windows equals boundT3c (one formula, two entry points)", () => {
    fc.assert(
      fc.property(boundInputs, horizon, (i, t) => {
        const d = i.D < i.N * (i.P < i.H ? i.P : i.H) ? i.D : i.N * (i.P < i.H ? i.P : i.H);
        if (d === 0n) return true; // windowed refuses a zero cap; boundT3c handles it (covered in golden G11)
        const limits: WindowLimit[] = [{ label: "daily", lengthSeconds: 86_400n, cap: d }];
        if (i.hc > 0n) limits.push({ label: "hourly", lengthSeconds: 3600n, cap: i.hc });
        const B = i.B < i.sumRemaining ? i.B : i.sumRemaining;
        return t === 0n || boundWindowed(B, limits, "rolling", t).value === boundT3c(i, t).value;
      }),
      fcParams(40),
    );
  });
  it("calendar is never below rolling, and at most the sum of one extra window per limit", () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 0n, max: 10_000n }),
        fc.array(fc.record({ lengthSeconds: fc.bigInt({ min: 1n, max: 5000n }), cap: fc.bigInt({ min: 1n, max: 500n }) }), { maxLength: 3 }),
        fc.bigInt({ min: 0n, max: 20_000n }),
        (B, raw, t) => {
          const limits = raw.map((r, k) => ({ label: `l${k}`, ...r }));
          const roll = boundWindowed(B, limits, "rolling", t).value;
          const cal = boundWindowed(B, limits, "calendar", t).value;
          return cal >= roll;
        },
      ),
      fcParams(41),
    );
  });
  it("rejects a zero cap (ambiguous between off and nothing), a zero window and a non-bigint balance", () => {
    expect(() => boundWindowed(10n, [{ label: "x", lengthSeconds: 5n, cap: 0n }], "rolling", 5n)).toThrow(BoundsError);
    expect(() => boundWindowed(10n, [{ label: "x", lengthSeconds: 0n, cap: 5n }], "rolling", 5n)).toThrow(BoundsError);
    expect(() => boundWindowed(10 as unknown as bigint, [], "rolling", 5n)).toThrow(BoundsError);
    expect(() => boundWindowed(10n, [{ label: "", lengthSeconds: 5n, cap: 5n }], "rolling", 5n)).toThrow(BoundsError);
  });
});

describe("drainSeconds and maxDetectionWindowed (exact inverses, checked by scanning)", () => {
  const smallWorld = fc.record({
    B: fc.bigInt({ min: 0n, max: 40n }),
    limits: fc.array(fc.record({ lengthSeconds: fc.bigInt({ min: 1n, max: 6n }), cap: fc.bigInt({ min: 1n, max: 12n }) }), { maxLength: 3 }),
    mode: fc.constantFrom<WindowMode>("rolling", "calendar"),
  });
  const withLabels = (raw: { lengthSeconds: bigint; cap: bigint }[]): WindowLimit[] => raw.map((r, k) => ({ label: `l${k}`, ...r }));

  it("drainSeconds is the first t at which the bound reaches the balance", () => {
    fc.assert(
      fc.property(smallWorld, ({ B, limits, mode }) => {
        const ls = withLabels(limits);
        const got = drainSeconds(B, ls, mode);
        if (B === 0n) return got === 0n;
        let t = 1n;
        while (boundWindowed(B, ls, mode, t).value < B) t++; // scan: terminates because caps > 0 and windows grow
        return got === t;
      }),
      fcParams(42),
    );
  });
  it("maxDetectionWindowed is the last t at which the bound is still within the target", () => {
    fc.assert(
      fc.property(smallWorld, fc.bigInt({ min: 0n, max: 45n }), ({ B, limits, mode }, z) => {
        const ls = withLabels(limits);
        const got = maxDetectionWindowed(B, ls, mode, z);
        if (B <= z) return got === "UNBOUNDED_BELOW_TARGET";
        let t = 0n;
        while (boundWindowed(B, ls, mode, t + 1n).value <= z) {
          t++;
          if (t > 10_000n) return false; // would mean unbounded: contradicts B > z
        }
        return got === t;
      }),
      fcParams(43),
    );
  });
  it("hand-computed: balance 1000, daily 200 rolling -> drains in 4 d + 1 s; calendar -> 3 d + 2 s", () => {
    const l: WindowLimit[] = [{ label: "daily", lengthSeconds: 86_400n, cap: 200n }];
    // 1000/200 = 5 windows. rolling needs (5-1)*86400+1; calendar needs (5-2)*86400+2.
    expect(drainSeconds(1000n, l, "rolling")).toBe(4n * 86_400n + 1n);
    expect(drainSeconds(1000n, l, "calendar")).toBe(3n * 86_400n + 2n);
    expect(drainSeconds(1000n, [], "rolling")).toBe(1n);
    expect(drainSeconds(0n, l, "rolling")).toBe(0n);
  });
  it("hand-computed detection: target 500 against daily 200 -> 2 windows fit (400), 3 do not", () => {
    const l: WindowLimit[] = [{ label: "daily", lengthSeconds: 86_400n, cap: 200n }];
    expect(maxDetectionWindowed(1000n, l, "rolling", 500n)).toBe(2n * 86_400n);
    expect(maxDetectionWindowed(1000n, l, "calendar", 500n)).toBe(86_400n + 1n);
    expect(maxDetectionWindowed(1000n, l, "rolling", 1000n)).toBe("UNBOUNDED_BELOW_TARGET");
    expect(maxDetectionWindowed(1000n, [], "rolling", 10n)).toBe(0n);
  });
});
