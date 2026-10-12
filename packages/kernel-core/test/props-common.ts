// Shared bits for the property-test files (not a test file). The properties are split over three files so that
// vitest runs them in parallel; each property still runs 1,000 times (docs/13 §1).
import { jcs } from "@symbolon/schemas";
import { severity, toJsonSafe } from "../src/index";
import type { Evaluation } from "../src/index";
import { clone } from "./helpers";
import type { RawExtraction, RawIntent } from "./helpers";

export const RUNS = { numRuns: 1000 };
/** 1,000 full evaluations take seconds; give each property room on a loaded machine (the default is 20 s per test). */
export const PROPERTY_TIMEOUT_MS = 180_000;
export const META = { decisionId: "5e6f7a8b-9c0d-4e1f-a2b3-c4d5e6f7a8b9", createdAt: "2026-10-05T12:00:01Z" };

/** Apply `f` to extraction A and (if present) B, on a copy. */
export function eachExtraction(i: RawIntent, f: (x: RawExtraction) => void): RawIntent {
  const out = clone(i);
  f(out.extraction.a);
  if (out.extraction.b !== null) f(out.extraction.b);
  return out;
}

/** Canonical JSON text: equality of canon() is deep equality for these JSON-safe values, and cheap at 1,000 runs. */
export const canon = (e: Evaluation): string => jcs(toJsonSafe(e));

export const sev = (e: Evaluation): number => (e.verdict === "REPLAY" ? -1 : severity(e.verdict));
