// Fail-closed input handling (AGENTS.md §0.4): anything missing, mistyped or out of range throws BoundsError;
// it never turns into a smaller number.
import { describe, expect, it } from "vitest";
import {
  BoundsError,
  MAX_UINT256,
  assertBoundInputs,
  boundT3c,
  maxDetectionSeconds,
  perDay,
  perReleaseUnapproved,
  timeToEmpty,
} from "../src/bounds";
import type { BoundInputs } from "../src/bounds";

const ok: BoundInputs = { B: 10n, P: 5n, D: 8n, H: 4n, hc: 0n, N: 64n, sumRemaining: 9n };
const bad = (o: Record<string, unknown>): BoundInputs => ({ ...ok, ...o }) as unknown as BoundInputs;

const BAD_INPUTS: readonly [string, BoundInputs][] = [
  ["number instead of bigint", bad({ B: 10 })],
  ["string amount", bad({ D: "8" })],
  ["negative balance", bad({ B: -1n })],
  ["above uint256", bad({ sumRemaining: MAX_UINT256 + 1n })],
  ["undefined field", bad({ hc: undefined })],
  ["null field", bad({ H: null })],
  ["P = 0", bad({ P: 0n })],
  ["D = 0", bad({ D: 0n })],
  ["N = 0", bad({ N: 0n })],
  ["NaN-like number", bad({ N: Number.NaN })],
];

describe("bounds.ts fails closed", () => {
  for (const [name, i] of BAD_INPUTS) {
    it(`rejects ${name} in every entry point`, () => {
      for (const fn of [
        () => assertBoundInputs(i),
        () => boundT3c(i, 60n),
        () => perDay(i),
        () => perReleaseUnapproved(i),
        () => timeToEmpty(i),
        () => maxDetectionSeconds(i, 1n),
      ]) {
        expect(fn).toThrow(BoundsError);
      }
    });
  }

  it("rejects a missing input object entirely", () => {
    expect(() => boundT3c(undefined as unknown as BoundInputs, 60n)).toThrow(BoundsError);
    expect(() => boundT3c(null as unknown as BoundInputs, 60n)).toThrow(BoundsError);
  });

  it("rejects a bad horizon (negative, number, undefined)", () => {
    expect(() => boundT3c(ok, -1n)).toThrow(/INVALID_HORIZON/);
    expect(() => boundT3c(ok, 60 as unknown as bigint)).toThrow(/INVALID_HORIZON/);
    expect(() => boundT3c(ok, undefined as unknown as bigint)).toThrow(/INVALID_HORIZON/);
  });

  it("rejects a bad loss target", () => {
    expect(() => maxDetectionSeconds(ok, -1n)).toThrow(/INVALID_TARGET/);
    expect(() => maxDetectionSeconds(ok, 5 as unknown as bigint)).toThrow(/INVALID_TARGET/);
  });

  it("positive control: the same inputs without the fault are accepted", () => {
    expect(() => assertBoundInputs(ok)).not.toThrow();
    expect(boundT3c(ok, 60n).value).toBe(8n);
  });

  it("accepts the documented zero values (B, H, hc, sumRemaining may be 0)", () => {
    expect(boundT3c({ ...ok, B: 0n, H: 0n, hc: 0n, sumRemaining: 0n }, 60n).value).toBe(0n);
  });
});
