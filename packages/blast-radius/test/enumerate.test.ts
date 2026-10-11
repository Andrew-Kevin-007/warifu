// The enumeration oracle is itself checked against hand-worked cases, so "bound >= enumeration" cannot pass
// because the oracle is too weak (a zero oracle would make every bound look safe).
import { describe, expect, it } from "vitest";
import { maxExtractable } from "./helpers/enumerate";
import type { EnumConfig } from "./helpers/enumerate";

const cfg = (o: Partial<EnumConfig>): EnumConfig => ({ B: 100, pstar: 2, D: 3, hc: 0, N: 4, R: 100, dayLen: 3, hourLen: 1, ...o });

describe("maxExtractable (hand-worked)", () => {
  // D = 3 per window of 3 steps; a release at step s blocks steps s+1, s+2 and is forgotten at step s+3.
  it("one window: 3", () => expect(maxExtractable(cfg({}), 3)).toBe(3));
  it("t = 4 reaches step 3, which is outside the window of step 0: 6", () => expect(maxExtractable(cfg({}), 4)).toBe(6));
  it("t = 6: still two windows: 6", () => expect(maxExtractable(cfg({}), 6)).toBe(6));
  it("t = 7: three windows: 9", () => expect(maxExtractable(cfg({}), 7)).toBe(9));
  it("empty interval: 0", () => expect(maxExtractable(cfg({}), 0)).toBe(0));
  it("pstar = 0 (every release needs an owner): 0", () => expect(maxExtractable(cfg({ pstar: 0 }), 9)).toBe(0));
  it("balance binds: min(B, R) = 5 over many windows", () => expect(maxExtractable(cfg({ B: 5 }), 9)).toBe(5));
  it("remaining engagements bind", () => expect(maxExtractable(cfg({ R: 4 }), 9)).toBe(4));
  it("ring size binds: N = 1 and pstar = 2 give 2 per window even though D = 100", () =>
    expect(maxExtractable(cfg({ N: 1, D: 100 }), 3)).toBe(2));
  it("hourly cap: hc = 1 with hourLen = 1 allows 1 per step, but the daily D = 3 allows 3 per window of 3 steps", () =>
    expect(maxExtractable(cfg({ hc: 1, D: 3, hourLen: 1 }), 3)).toBe(3));
  it("hourly cap bites: hc = 1, hourLen = 2, dayLen = 4, D = 9: steps 0 and 2 only fit one per 2-step window", () =>
    expect(maxExtractable(cfg({ hc: 1, D: 9, hourLen: 2, dayLen: 4, N: 9 }), 4)).toBe(2));
});
