// Golden vectors with HAND-COMPUTED bounds (docs/16 §10 test 1). Every expected number below was worked out on
// paper from docs/08 §4 / docs/16 §2.2, not produced by running bounds.ts. Units: 1_000_000n = 1 USDC (6 dp).
import { describe, expect, it } from "vitest";
import {
  boundAlarmed,
  boundT3c,
  boundsAtHorizons,
  maxDetectionSeconds,
  perDay,
  perReleaseUnapproved,
  timeToEmpty,
} from "../src/bounds";
import type { BoundInputs, Term } from "../src/bounds";

const M = 1_000_000n;
const base: BoundInputs = { B: 200n * M, P: 100n * M, D: 200n * M, H: 50n * M, hc: 0n, N: 64n, sumRemaining: 150n * M };
const inp = (o: Partial<BoundInputs>): BoundInputs => ({ ...base, ...o });

interface Row {
  readonly name: string;
  readonly i: BoundInputs;
  readonly pstar: bigint;
  readonly dstar: bigint;
  readonly at: readonly (readonly [bigint, bigint, readonly Term[]])[]; // [t seconds, value, binding]
}

const ROWS: readonly Row[] = [
  {
    // p* = min(100, 50) = 50; d* = min(200, 64*50 = 3200) = 200. ΣR = 150 is the smallest term at every horizon.
    name: "G1 docs/16 sample: engagements bind everywhere",
    i: base,
    pstar: 50n * M,
    dstar: 200n * M,
    at: [
      [60n, 150n * M, ["engagements"]],
      [86_400n, 150n * M, ["engagements"]],
      [172_800n, 150n * M, ["engagements"]],
      [604_800n, 150n * M, ["engagements"]],
    ],
  },
  {
    // ΣR = 1000. 1 window: min(200, 200, 1000) = 200 with balance and daily tied; 2 windows: daily = 400 > B.
    name: "G2 balance and daily tied, then balance alone",
    i: inp({ sumRemaining: 1000n * M }),
    pstar: 50n * M,
    dstar: 200n * M,
    at: [
      [60n, 200n * M, ["balance", "daily"]],
      [86_401n, 200n * M, ["balance"]],
    ],
  },
  {
    // B = ΣR = 1000, H = 150 > P = 100 so p* = P = 100; d* = min(200, 6400) = 200.
    // 7 d = 7 windows = 1400 > 1000, so balance and engagements tie.
    name: "G3 H > P, daily binds then balance and engagements tie",
    i: inp({ B: 1000n * M, sumRemaining: 1000n * M, H: 150n * M }),
    pstar: 100n * M,
    dstar: 200n * M,
    at: [
      [60n, 200n * M, ["daily"]],
      [86_400n, 200n * M, ["daily"]],
      [86_401n, 400n * M, ["daily"]],
      [172_800n, 400n * M, ["daily"]],
      [172_801n, 600n * M, ["daily"]],
      [604_800n, 1000n * M, ["balance", "engagements"]],
    ],
  },
  {
    // N*p* < D: N = 4, P = 100, H = 500 so p* = 100, N p* = 400 < D = 1000, d* = 400.
    name: "G4 N*p* < D (ring size binds the daily volume)",
    i: inp({ B: 10_000n * M, sumRemaining: 10_000n * M, N: 4n, P: 100n * M, H: 500n * M, D: 1000n * M }),
    pstar: 100n * M,
    dstar: 400n * M,
    at: [
      [1n, 400n * M, ["daily"]],
      [259_200n, 1200n * M, ["daily"]], // 3 days exactly = 3 windows
    ],
  },
  {
    // H < P: p* = 30. N = 10 gives N p* = 300 < D = 1000, so d* = 300.
    name: "G5 H < P (approval threshold binds the per-release amount)",
    i: inp({ B: 10_000n * M, sumRemaining: 10_000n * M, N: 10n, P: 100n * M, H: 30n * M, D: 1000n * M }),
    pstar: 30n * M,
    dstar: 300n * M,
    at: [[86_400n, 300n * M, ["daily"]]],
  },
  {
    // hc = 25. 1 min / 1 h: 25 (hourly). 3601 s: 2 hourly windows = 50. 6 h: 150 < 200 (hourly).
    // 8 h: hourly 8*25 = 200 = daily 200 (tie). 24 h: hourly 600, daily 200 binds.
    name: "G6 hourly cap bites below 24 h",
    i: inp({ B: 1000n * M, sumRemaining: 1000n * M, H: 100n * M, hc: 25n * M }),
    pstar: 100n * M,
    dstar: 200n * M,
    at: [
      [60n, 25n * M, ["hourly"]],
      [3600n, 25n * M, ["hourly"]],
      [3601n, 50n * M, ["hourly"]],
      [21_600n, 150n * M, ["hourly"]],
      [28_800n, 200n * M, ["daily", "hourly"]],
      [86_400n, 200n * M, ["daily"]],
    ],
  },
  {
    // B = 50 < d* = 200: the balance is the binding term at every horizon.
    name: "G7 B < d*",
    i: inp({ B: 50n * M, sumRemaining: 400n * M }),
    pstar: 50n * M,
    dstar: 200n * M,
    at: [
      [60n, 50n * M, ["balance"]],
      [604_800n, 50n * M, ["balance"]],
    ],
  },
  {
    // No engagements: nothing is entitled, so the bound (and every release) is capped at 0 by the engagement term.
    name: "G8 zero engagements",
    i: inp({ sumRemaining: 0n }),
    pstar: 50n * M,
    dstar: 200n * M,
    at: [
      [60n, 0n, ["engagements"]],
      [604_800n, 0n, ["engagements"]],
    ],
  },
  {
    // Boundary 24 h - 1 s / 24 h / 24 h + 1 s: 1, 1 and 2 windows (a closed interval would give 2 at 24 h).
    name: "G9 daily horizon boundaries (d* = 100, plenty of balance)",
    i: inp({ B: 10_000n * M, sumRemaining: 10_000n * M, P: 100n * M, H: 100n * M, D: 100n * M }),
    pstar: 100n * M,
    dstar: 100n * M,
    at: [
      [86_399n, 100n * M, ["daily"]],
      [86_400n, 100n * M, ["daily"]],
      [86_401n, 200n * M, ["daily"]],
    ],
  },
  {
    // Hourly boundaries 1 h - 1 s / 1 h / 1 h + 1 s with hc = 10, D large: 1, 1, 2 hourly windows.
    name: "G10 hourly horizon boundaries",
    i: inp({ B: 10_000n * M, sumRemaining: 10_000n * M, P: 100n * M, H: 100n * M, D: 5000n * M, hc: 10n * M }),
    pstar: 100n * M,
    dstar: 5000n * M,
    at: [
      [3599n, 10n * M, ["hourly"]],
      [3600n, 10n * M, ["hourly"]],
      [3601n, 20n * M, ["hourly"]],
    ],
  },
  {
    // H = 0: every release needs an owner signature, so p* = 0 and d* = 0. Nothing leaves without the owner.
    name: "G11 H = 0",
    i: inp({ H: 0n }),
    pstar: 0n,
    dstar: 0n,
    at: [
      [60n, 0n, ["daily"]],
      [604_800n, 0n, ["daily"]],
    ],
  },
  {
    // t = 0 is the empty interval [T, T): 0 windows, bound 0 (daily term).
    name: "G12 empty interval",
    i: base,
    pstar: 50n * M,
    dstar: 200n * M,
    at: [[0n, 0n, ["daily"]]],
  },
  {
    // N = 1, P = H = 10, D = 100: d* = min(100, 1*10) = 10.
    name: "G13 single-slot ring",
    i: inp({ B: 1000n * M, sumRemaining: 1000n * M, N: 1n, P: 10n * M, H: 10n * M, D: 100n * M }),
    pstar: 10n * M,
    dstar: 10n * M,
    at: [
      [86_400n, 10n * M, ["daily"]],
      [259_201n, 40n * M, ["daily"]],
    ],
  },
  {
    // Far beyond JS number range: 2^200 balance, d* = 2^100; 7 windows = 7 * 2^100.
    name: "G14 values beyond 2^53 stay exact",
    i: { B: 1n << 200n, P: 1n << 100n, D: 1n << 100n, H: 1n << 100n, hc: 0n, N: 64n, sumRemaining: 1n << 200n },
    pstar: 1n << 100n,
    dstar: 1n << 100n,
    at: [[604_800n, 7n << 100n, ["daily"]]],
  },
];

describe("golden vectors (hand-computed)", () => {
  for (const row of ROWS) {
    it(row.name, () => {
      expect(perReleaseUnapproved(row.i)).toBe(row.pstar);
      expect(perDay(row.i)).toBe(row.dstar);
      for (const [t, value, binding] of row.at) {
        const b = boundT3c(row.i, t);
        expect({ t, value: b.value, binding: [...b.binding] }).toEqual({ t, value, binding });
        expect(b.horizonSeconds).toBe(t);
      }
    });
  }

  it("covers at least 12 distinct configurations", () => {
    expect(ROWS.length).toBeGreaterThanOrEqual(12);
  });

  it("certificate horizons for G1 are the six documented labels", () => {
    const h = boundsAtHorizons(base);
    expect(h.map((x) => x.label)).toEqual(["1m", "1h", "6h", "24h", "48h", "7d"]);
    expect(h.map((x) => x.horizonSeconds)).toEqual([60n, 3600n, 21_600n, 86_400n, 172_800n, 604_800n]);
    expect(h.every((x) => x.value === 150n * M)).toBe(true);
  });

  it("alarmed variant uses the published 300 s latency (G1: ΣR binds) and honours an explicit 60 s", () => {
    expect(boundAlarmed(base).value).toBe(150n * M);
    expect(boundAlarmed(base).horizonSeconds).toBe(300n);
    // G6: 60 s alarm => one hourly window => 25
    const g6 = inp({ B: 1000n * M, sumRemaining: 1000n * M, H: 100n * M, hc: 25n * M });
    expect(boundAlarmed(g6, 60n).value).toBe(25n * M);
  });

  describe("timeToEmpty (hand-computed)", () => {
    it("G1: min(B,ΣR) = 150 / d* 200 -> 1 window, limited by engagements", () => {
      expect(timeToEmpty(base)).toEqual({ days: 1n, limitedBy: "engagements" });
    });
    it("G3: 1000 / 200 = 5 windows; tie between balance and engagements reports balance", () => {
      expect(timeToEmpty(inp({ B: 1000n * M, sumRemaining: 1000n * M, H: 150n * M }))).toEqual({ days: 5n, limitedBy: "balance" });
    });
    it("G4: 10000 / 400 = 25 windows", () => {
      expect(timeToEmpty(inp({ B: 10_000n * M, sumRemaining: 10_000n * M, N: 4n, P: 100n * M, H: 500n * M, D: 1000n * M }))).toEqual({
        days: 25n,
        limitedBy: "balance",
      });
    });
    it("rounds up: 250 / 100 = 3 windows", () => {
      expect(timeToEmpty(inp({ B: 250n * M, sumRemaining: 250n * M, P: 100n * M, H: 100n * M, D: 100n * M }))).toEqual({
        days: 3n,
        limitedBy: "balance",
      });
    });
    it("G11: d* = 0 -> null days, limited by daily (nothing leaves without the owner)", () => {
      expect(timeToEmpty(inp({ H: 0n }))).toEqual({ days: null, limitedBy: "daily" });
    });
    it("G8: nothing remaining -> 0 windows, limited by engagements", () => {
      expect(timeToEmpty(inp({ sumRemaining: 0n }))).toEqual({ days: 0n, limitedBy: "engagements" });
    });
  });

  describe("maxDetectionSeconds (hand-computed)", () => {
    const g3 = inp({ B: 1000n * M, sumRemaining: 1000n * M, H: 150n * M });
    it("G3, target 300: one 24 h window (200) fits, two (400) do not -> 86400 s", () => {
      expect(maxDetectionSeconds(g3, 300n * M)).toBe(86_400n);
    });
    it("G3, target 199.999999: even one window (200) exceeds it -> 0 s", () => {
      expect(maxDetectionSeconds(g3, 199_999_999n)).toBe(0n);
    });
    it("G3, target 999.999999: 4 windows (800) fit, 5 (1000) do not -> 345600 s", () => {
      expect(maxDetectionSeconds(g3, 999_999_999n)).toBe(345_600n);
    });
    it("G3, target 1000: min(B,ΣR) = 1000 <= target, so the loss can never exceed it", () => {
      expect(maxDetectionSeconds(g3, 1000n * M)).toBe("UNBOUNDED_BELOW_TARGET");
    });
    it("G6, target 100: hourly cap allows 4 h (100) vs daily 0 -> 14400 s", () => {
      expect(maxDetectionSeconds(inp({ B: 1000n * M, sumRemaining: 1000n * M, H: 100n * M, hc: 25n * M }), 100n * M)).toBe(14_400n);
    });
    it("G11: d* = 0 -> nothing can leave without the owner -> unbounded below any target", () => {
      expect(maxDetectionSeconds(inp({ H: 0n }), 0n)).toBe("UNBOUNDED_BELOW_TARGET");
    });
  });
});
