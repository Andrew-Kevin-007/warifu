// K-16 CIRCUIT_BREAKER — the pure state logic (docs/04 K-16; WP-05). The service owns the state row
// (breaker_state), calls vault.pause() through the guardian key when this logic says HALTED, and feeds the
// pre-check (checks/k16-breaker.ts) with ctx.breaker. State: OK | HALTED.
//   trip on: a HIGH reconciliation finding; an unknown release (a Released event with no decision); a screening
//   HIT on a payee that was already paid; more than 5 kernel exceptions within the last 10 minutes (inclusive).
//   unfreeze: owner-only and with a recorded reason; the owner signature is verified by the service (ownerSigned).
// A trip while HALTED keeps the original reason and time. Nothing here reads a clock: `now` is an argument.
import { epochSecondsFromIso, isIsoDateTime } from "@symbolon/schemas";
import type { Address, ISODateTime } from "@symbolon/schemas";
import { err, ok } from "./result";
import type { Result } from "./result";

export type BreakerSignal =
  | { readonly kind: "RECONCILIATION_FINDING"; readonly severity: "LOW" | "MEDIUM" | "HIGH"; readonly at: ISODateTime }
  | { readonly kind: "UNKNOWN_RELEASE"; readonly at: ISODateTime }
  | { readonly kind: "SCREEN_HIT_PAID_PAYEE"; readonly at: ISODateTime }
  | { readonly kind: "KERNEL_EXCEPTION"; readonly at: ISODateTime };

export type TripReason = "HIGH_RECONCILIATION_FINDING" | "UNKNOWN_RELEASE" | "SCREEN_HIT_PAID_PAYEE" | "KERNEL_EXCEPTION_RATE";

/** More than this many kernel exceptions in the window trips the breaker ("> 5 in 10 min"). */
export const KERNEL_EXCEPTION_LIMIT = 5;
export const KERNEL_EXCEPTION_WINDOW_SECONDS = 600n;

export interface BreakerTrip {
  readonly trip: boolean;
  /** In a fixed order, without duplicates. */
  readonly reasons: readonly TripReason[];
}

/** Should the breaker trip, given the unresolved signals the service has? Malformed input trips it (fail closed). */
export function breakerTrip(signals: readonly BreakerSignal[], now: ISODateTime): Result<BreakerTrip> {
  if (typeof now !== "string" || !isIsoDateTime(now)) return err("CONTEXT_INVALID", "now must be a canonical ISODateTime");
  const t = epochSecondsFromIso(now);
  const reasons = new Set<TripReason>();
  let exceptions = 0;
  for (const s of signals) {
    if (typeof s !== "object" || s === null || typeof s.at !== "string" || !isIsoDateTime(s.at)) return err("CONTEXT_INVALID", "malformed breaker signal");
    if (s.kind === "RECONCILIATION_FINDING") {
      if (s.severity === "HIGH") reasons.add("HIGH_RECONCILIATION_FINDING");
    } else if (s.kind === "UNKNOWN_RELEASE") {
      reasons.add("UNKNOWN_RELEASE");
    } else if (s.kind === "SCREEN_HIT_PAID_PAYEE") {
      reasons.add("SCREEN_HIT_PAID_PAYEE");
    } else {
      const age = t - epochSecondsFromIso(s.at);
      if (age >= 0n && age <= KERNEL_EXCEPTION_WINDOW_SECONDS) exceptions++;
    }
  }
  if (exceptions > KERNEL_EXCEPTION_LIMIT) reasons.add("KERNEL_EXCEPTION_RATE");
  const order: readonly TripReason[] = ["HIGH_RECONCILIATION_FINDING", "UNKNOWN_RELEASE", "SCREEN_HIT_PAID_PAYEE", "KERNEL_EXCEPTION_RATE"];
  const list = order.filter((r) => reasons.has(r));
  return ok({ trip: list.length > 0, reasons: list });
}

export interface BreakerRecord {
  readonly halted: boolean;
  readonly reason: string | null;
  readonly since: ISODateTime | null;
  readonly resolvedBy: Address | null;
}

export type BreakerEvent =
  | { readonly kind: "TRIP"; readonly reason: string; readonly at: ISODateTime }
  | { readonly kind: "UNFREEZE"; readonly ownerSigned: boolean; readonly by: Address; readonly reason: string; readonly at: ISODateTime };

/** The next breaker state. Unfreeze needs a verified owner signature and a non-empty reason; it is refused otherwise. */
export function nextBreakerState(state: BreakerRecord, event: BreakerEvent): Result<BreakerRecord> {
  if (typeof event.at !== "string" || !isIsoDateTime(event.at)) return err("CONTEXT_INVALID", "event time must be a canonical ISODateTime");
  if (event.kind === "TRIP") {
    if (state.halted) return ok(state);
    return ok({ halted: true, reason: event.reason.trim() === "" ? "unspecified" : event.reason, since: event.at, resolvedBy: null });
  }
  if (!state.halted) return err("CONTEXT_INVALID", "the breaker is not halted");
  if (event.ownerSigned !== true) return err("CONTEXT_INVALID", "unfreeze requires the owner's verified signature");
  if (typeof event.reason !== "string" || event.reason.trim() === "") return err("CONTEXT_INVALID", "unfreeze requires a recorded reason");
  return ok({ halted: false, reason: null, since: null, resolvedBy: event.by });
}
