// @symbolon/blast-radius (owner: BLAST). WP-25: closed-form loss bounds (docs/08 §4, docs/16 §2.2) and the
// Blast Radius Lite audit (docs/08 §7). The simulator (WP-26) and the certificate (WP-34, src/lbc) build on this.
// Numbers are "calculated from on-chain state and empirically tested" with assumptions and exclusions beside
// them (DEC-012); nothing here is a certificate and nothing here claims more than its inputs.
export const PACKAGE_NAME = "@symbolon/blast-radius" as const;

export {
  BoundsError,
  DEFAULT_DETECTION_LATENCY_SECONDS,
  HORIZONS,
  MAX_UINT256,
  SECONDS_PER_DAY,
  SECONDS_PER_HOUR,
  SECONDS_PER_MINUTE,
  UNBOUNDED_BELOW_TARGET,
  VAULT_RING_SIZE,
  assertBoundInputs,
  boundAlarmed,
  boundT3c,
  boundT3cWithWindows,
  boundsAtHorizons,
  ceilDiv,
  maxDetectionSeconds,
  perDay,
  perReleaseUnapproved,
  timeToEmpty,
} from "./bounds";
export type { Bound, BoundInputs, BoundsErrorCode, Term, WindowLengths } from "./bounds";
export { boundWindowed, drainSeconds, maxDetectionWindowed, windowsCovering } from "./windowed";
export type { WindowLimit, WindowMode, WindowedBound } from "./windowed";
