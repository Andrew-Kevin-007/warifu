// feasiblePlans(): the kernel-feasible payment plans for one intent (docs/04 K-14, docs/03 §5.3-§5.4, INV-19).
// Pure: no clock (now is an argument), no I/O, bigint money. The planner (LLM) may only pick a planId from this
// set; it can never supply a date or an amount (guardrail 9).
//
// Legal window (all instants in UTC seconds):
//   terms            = the SIGNED engagement terms; null => policy defaults (defaultNetDays, policy buffer, no discount)
//   dueDate          = invoiceReceivedAt + netDays                      (kernel-recorded receipt time, never the invoice date)
//   disputeWindowEnd = max(invoiceReceivedAt, evidenceSatisfiedAt) + disputeWindowHours
//   legalEarliest    = max(now, evidenceSatisfiedAt, disputeWindowEnd)
//   legalLatest      = dueDate - payBeforeDueBufferHours, or legalEarliest when that has passed (LATE)
//   discount window  = (.., invoiceReceivedAt + withinDays]  (inclusive); safe end = windowEnd - windowSafetyMarginMinutes
// Plans (every payAt lies in [legalEarliest, legalLatest]):
//   TAKE_DISCOUNT        payAt = min(safe end, legalLatest), only if >= legalEarliest (the last safe instant in the window)
//   DUE_MINUS_BUFFER     payAt = legalLatest
//   IMMEDIATE            payAt = now, only if immediate payment is allowed and legalEarliest = now
//   AFTER_EVIDENCE       payAt = evidenceSatisfiedAt, only if that is in the future and binds legalEarliest
//   AFTER_DISPUTE_WINDOW payAt = disputeWindowEnd, only if the dispute window binds legalEarliest
//   HOLD                 only when no payable plan is feasible: payAt = now, nothing is paid (amountDue "0")
// A payable plan is feasible only if the reserve floor holds after paying (vaultAvailable - pendingReleases -
// amountDue >= reserveFloor) and amountDue is within the optional authority ceiling. amountDue comes from the same
// formula as amountDue() (amountDueCore) on the signed terms, so it always equals what K-08 expects at payAt.
//
// Readings fixed here (docs/QUESTIONS.md "WP-05"): with signed terms, netDays and the buffer come from the terms
// only (INV-19); immediate payment needs BOTH the signed terms and policy.timing to allow it (the owner's own
// policy can only restrict its agent); the dispute window starts once both the invoice and the evidence are in.
import { FeasiblePlanSchema, PLAN_MODES, PaymentTermsSchema, derivePlanId, epochSecondsFromIso, isIsoDateTime, isoFromEpochSeconds } from "@symbolon/schemas";
import type { FeasiblePlan, Hex32, ISODateTime, PaymentTerms, PlanMode } from "@symbolon/schemas";
import { err, ok } from "./result";
import type { TermsResult } from "./result";
import { SECONDS_PER_DAY, amountDueCore, impliedAprCore } from "./terms";

/** policy.timing (docs/04 §7), as the planner and the kernel read it. */
export interface PolicyTiming {
  readonly defaultNetDays: number;
  readonly payBeforeDueBufferHours: number;
  readonly allowImmediate: boolean;
  readonly disputeWindowHours: number;
  readonly windowSafetyMarginMinutes: number;
}

export interface PlanLiquidity {
  readonly vaultAvailable: bigint;
  readonly pendingReleases: bigint;
  readonly reserveFloor: bigint;
}

export interface PlanInput {
  /** The GROSS-amount intentId (planId = keccak256(JCS({intentId, mode, payAt}))). */
  readonly intentId: Hex32;
  readonly now: ISODateTime;
  /** Kernel-recorded receipt time of the invoice; the due date and the discount clock start here (INV-19). */
  readonly invoiceReceivedAt: ISODateTime;
  readonly grossBaseUnits: bigint;
  /** SIGNED engagement terms (inside termsHash); null => policy defaults and no discount. Never invoice terms. */
  readonly terms: PaymentTerms | null;
  readonly policyTiming: PolicyTiming;
  /** When the evidence precondition is (or is projected to be) satisfied; null => not satisfied, only HOLD. */
  readonly evidenceSatisfiedAt: ISODateTime | null;
  readonly liquidity: PlanLiquidity;
  /** Largest release amount the authority caps allow; null => no ceiling (the kernel gates the gross in K-12). */
  readonly amountCeiling: bigint | null;
}

/** Why a plan mode is not in the set. */
export type PlanExclusion = "EVIDENCE_NOT_SATISFIED" | "NOT_ALLOWED" | "NOT_APPLICABLE" | "OUTSIDE_WINDOW" | "RESERVE_FLOOR" | "AMOUNT_CEILING";

export interface EffectiveTerms {
  readonly netDays: number;
  readonly payBeforeDueBufferHours: number;
  readonly allowImmediate: boolean;
  readonly earlyPay: { readonly discountBps: number; readonly withinDays: number } | null;
  /** true when the values come from signed terms, false when from policy defaults. */
  readonly signed: boolean;
}

export interface LegalWindow {
  readonly earliest: ISODateTime;
  readonly latest: ISODateTime;
  /** The due date minus the buffer has passed: latest = earliest. */
  readonly late: boolean;
  readonly dueDate: ISODateTime;
  readonly disputeWindowEnd: ISODateTime;
  /** End of the discount window (inclusive), or null without a signed early-pay discount. */
  readonly windowEnd: ISODateTime | null;
}

export interface PlanSet {
  /** In PLAN_MODES order; planIds are unique. */
  readonly plans: readonly FeasiblePlan[];
  /** null when the evidence precondition is not satisfied. */
  readonly window: LegalWindow | null;
  readonly excluded: ReadonlyArray<{ readonly mode: PlanMode; readonly reason: PlanExclusion }>;
  readonly terms: EffectiveTerms;
}

const SECONDS_PER_HOUR = 3_600n;
const SECONDS_PER_MINUTE = 60n;
/** 9999-12-31T23:59:59Z: the last instant an ISODateTime can spell. */
const MAX_EPOCH_SECONDS = 253402300799n;
const MAX_AMOUNT = 10n ** 30n - 1n; // FeasiblePlan.amountDue is a K-01 amount (<= 30 digits)
const HEX32 = /^0x[0-9a-f]{64}$/;

function isSafeIntIn(n: number, lo: number, hi: number): boolean {
  return Number.isSafeInteger(n) && n >= lo && n <= hi;
}

function epoch(iso: ISODateTime, what: string): TermsResult<bigint> {
  if (typeof iso !== "string" || !isIsoDateTime(iso)) return err("INVALID_TIME", `${what} must be a canonical ISODateTime`);
  return ok(epochSecondsFromIso(iso));
}

const maxOf = (...xs: bigint[]): bigint => xs.reduce((a, b) => (b > a ? b : a));
const minOf = (a: bigint, b: bigint): bigint => (a < b ? a : b);

function checkNonNegative(v: bigint, what: string): TermsResult<bigint> {
  if (typeof v !== "bigint" || v < 0n) return err("INVALID_AMOUNT", `${what} must be a non-negative bigint`);
  return ok(v);
}

function checkTiming(t: PolicyTiming): TermsResult<PolicyTiming> {
  if (
    typeof t !== "object" ||
    t === null ||
    !isSafeIntIn(t.defaultNetDays, 0, 365) ||
    !isSafeIntIn(t.payBeforeDueBufferHours, 0, 87_600) ||
    !isSafeIntIn(t.disputeWindowHours, 0, 87_600) ||
    !isSafeIntIn(t.windowSafetyMarginMinutes, 0, 525_600) ||
    typeof t.allowImmediate !== "boolean"
  ) {
    return err("INVALID_DAYS", "policy timing values are out of range (docs/04 §7)");
  }
  return ok(t);
}

/** The terms the kernel applies: the signed terms, or the policy defaults (no discount). */
export function effectiveTerms(terms: PaymentTerms | null, timing: PolicyTiming): TermsResult<EffectiveTerms> {
  const t = checkTiming(timing);
  if (!t.ok) return t;
  if (terms === null) {
    return ok({ netDays: timing.defaultNetDays, payBeforeDueBufferHours: timing.payBeforeDueBufferHours, allowImmediate: timing.allowImmediate, earlyPay: null, signed: false });
  }
  const parsed = PaymentTermsSchema.safeParse(terms);
  if (!parsed.success) return err("INVALID_TERMS", "payment terms do not satisfy PaymentTermsSchema");
  const p = parsed.data;
  return ok({
    netDays: p.netDays,
    payBeforeDueBufferHours: p.payBeforeDueBufferHours,
    allowImmediate: p.allowImmediate && timing.allowImmediate,
    earlyPay: p.earlyPay === null ? null : { discountBps: p.earlyPay.discountBps, withinDays: p.earlyPay.withinDays },
    signed: true,
  });
}

interface Validated {
  readonly R: bigint;
  readonly N: bigint;
  readonly gross: bigint;
  readonly terms: EffectiveTerms;
}

function validate(input: PlanInput): TermsResult<Validated> {
  if (typeof input.intentId !== "string" || !HEX32.test(input.intentId)) return err("INVALID_AMOUNT", "intentId must be a lowercase 0x-prefixed 32-byte hex string");
  const now = epoch(input.now, "now");
  if (!now.ok) return now;
  const received = epoch(input.invoiceReceivedAt, "invoiceReceivedAt");
  if (!received.ok) return received;
  if (received.value > now.value) return err("INVALID_TIME", "invoiceReceivedAt is after now");
  const gross = checkNonNegative(input.grossBaseUnits, "grossBaseUnits");
  if (!gross.ok) return gross;
  if (gross.value > MAX_AMOUNT) return err("INVALID_AMOUNT", "grossBaseUnits exceeds 30 digits");
  const liq = input.liquidity;
  const amounts: ReadonlyArray<readonly [bigint, string]> = [
    [liq.vaultAvailable, "vaultAvailable"],
    [liq.pendingReleases, "pendingReleases"],
    [liq.reserveFloor, "reserveFloor"],
    ...(input.amountCeiling === null ? [] : [[input.amountCeiling, "amountCeiling"] as const]),
  ];
  for (const [v, what] of amounts) {
    const c = checkNonNegative(v, what);
    if (!c.ok) return c;
  }
  const eff = effectiveTerms(input.terms, input.policyTiming);
  if (!eff.ok) return eff;
  return ok({ R: received.value, N: now.value, gross: gross.value, terms: eff.value });
}

interface Candidate {
  readonly mode: PlanMode;
  readonly payAt: bigint | null;
  readonly reason: PlanExclusion;
}

/** Enumerate the feasible plans (see the module comment). Never throws: invalid input is a TermsResult error. */
export function feasiblePlans(input: PlanInput): TermsResult<PlanSet> {
  const v = validate(input);
  if (!v.ok) return v;
  const { R, N, gross, terms } = v.value;
  const timing = input.policyTiming;
  const liq = input.liquidity;
  const early = terms.earlyPay;

  const due = R + BigInt(terms.netDays) * SECONDS_PER_DAY;
  // withinDays < netDays (PaymentTermsSchema), so the discount window ends before the due date.
  const windowEndSec = early === null ? null : R + BigInt(early.withinDays) * SECONDS_PER_DAY;
  let E: bigint | null = null;
  if (input.evidenceSatisfiedAt !== null) {
    const evidence = epoch(input.evidenceSatisfiedAt, "evidenceSatisfiedAt");
    if (!evidence.ok) return evidence;
    E = evidence.value;
  }
  const disputeEnd = E === null ? R : maxOf(R, E) + BigInt(timing.disputeWindowHours) * SECONDS_PER_HOUR;
  const earliest = E === null ? N : maxOf(N, E, disputeEnd);
  // One range check covers every instant converted below: each is <= max(due, earliest).
  if (maxOf(due, earliest) > MAX_EPOCH_SECONDS) return err("INVALID_TIME", "a derived instant is after 9999-12-31T23:59:59Z");
  const windowEnd = windowEndSec === null ? null : isoFromEpochSeconds(windowEndSec);
  const available = liq.vaultAvailable - liq.pendingReleases;
  const hold = (): FeasiblePlan | null => buildPlan(input.intentId, "HOLD", N, 0n, 0n, null, available, available >= liq.reserveFloor, windowEnd);

  if (E === null) {
    const plan = hold();
    if (plan === null) return err("INVALID_AMOUNT", "plan does not satisfy FeasiblePlanSchema");
    const excluded = PLAN_MODES.filter((m) => m !== "HOLD").map((mode) => ({ mode, reason: "EVIDENCE_NOT_SATISFIED" as const }));
    return ok({ plans: [plan], window: null, excluded, terms });
  }

  const latestRaw = due - BigInt(terms.payBeforeDueBufferHours) * SECONDS_PER_HOUR;
  const late = latestRaw < earliest;
  const latest = late ? earliest : latestRaw;
  const legal: LegalWindow = {
    earliest: isoFromEpochSeconds(earliest),
    latest: isoFromEpochSeconds(latest),
    late,
    dueDate: isoFromEpochSeconds(due),
    disputeWindowEnd: isoFromEpochSeconds(disputeEnd),
    windowEnd,
  };

  const candidates: Candidate[] = [];
  if (windowEndSec === null) {
    candidates.push({ mode: "TAKE_DISCOUNT", payAt: null, reason: "NOT_APPLICABLE" });
  } else {
    // The last instant inside the discount window minus the safety margin, within the legal window.
    const t = minOf(windowEndSec - BigInt(timing.windowSafetyMarginMinutes) * SECONDS_PER_MINUTE, latest);
    candidates.push({ mode: "TAKE_DISCOUNT", payAt: t < earliest ? null : t, reason: "OUTSIDE_WINDOW" });
  }
  candidates.push({ mode: "DUE_MINUS_BUFFER", payAt: latest, reason: "NOT_APPLICABLE" });
  if (!terms.allowImmediate) candidates.push({ mode: "IMMEDIATE", payAt: null, reason: "NOT_ALLOWED" });
  else candidates.push({ mode: "IMMEDIATE", payAt: earliest === N ? N : null, reason: "OUTSIDE_WINDOW" });
  candidates.push({ mode: "AFTER_EVIDENCE", payAt: E > N && earliest === E ? E : null, reason: "NOT_APPLICABLE" });
  candidates.push({ mode: "AFTER_DISPUTE_WINDOW", payAt: disputeEnd > maxOf(N, E) ? disputeEnd : null, reason: "NOT_APPLICABLE" });

  const apr = early === null ? null : impliedAprCore(BigInt(early.discountBps), BigInt(terms.netDays), BigInt(early.withinDays));
  const plans: FeasiblePlan[] = [];
  const excluded: Array<{ mode: PlanMode; reason: PlanExclusion }> = [];
  for (const c of candidates) {
    if (c.payAt === null) {
      excluded.push({ mode: c.mode, reason: c.reason });
      continue;
    }
    const d = amountDueCore(gross, early, R, c.payAt);
    const after = available - d.amountDue;
    if (after < liq.reserveFloor) {
      excluded.push({ mode: c.mode, reason: "RESERVE_FLOOR" });
    } else if (input.amountCeiling !== null && d.amountDue > input.amountCeiling) {
      excluded.push({ mode: c.mode, reason: "AMOUNT_CEILING" });
    } else {
      const plan = buildPlan(input.intentId, c.mode, c.payAt, d.amountDue, d.discountValue, d.discountApplied ? apr : null, after, true, windowEnd);
      if (plan === null) return err("INVALID_AMOUNT", "plan does not satisfy FeasiblePlanSchema");
      plans.push(plan);
    }
  }
  if (plans.length === 0) {
    const plan = hold();
    if (plan === null) return err("INVALID_AMOUNT", "plan does not satisfy FeasiblePlanSchema");
    plans.push(plan);
  } else {
    excluded.push({ mode: "HOLD", reason: "NOT_APPLICABLE" });
  }
  // Candidates are pushed in PLAN_MODES order and HOLD (last in PLAN_MODES) is appended last.
  return ok({ plans, window: legal, excluded, terms });
}

/** A FeasiblePlan, or null when the values do not satisfy FeasiblePlanSchema (e.g. a liquidity beyond 78 digits). */
function buildPlan(
  intentId: Hex32,
  mode: PlanMode,
  payAt: bigint,
  due: bigint,
  discount: bigint,
  apr: bigint | null,
  liquidityAfter: bigint,
  reserveFloorOk: boolean,
  windowEnd: ISODateTime | null,
): FeasiblePlan | null {
  const payAtIso = isoFromEpochSeconds(payAt);
  const plan = {
    planId: derivePlanId({ intentId, mode, payAt: payAtIso }),
    mode,
    payAt: payAtIso,
    amountDue: due.toString(),
    discountValue: discount.toString(),
    // bigint -> JSON number through its decimal text (the purity lint bans Number()). With discountBps <= 2000
    // and netDays - withinDays >= 1 the APR is at most 912,500 bps, far below 2^53.
    impliedAprBps: apr === null ? null : parseInt(apr.toString(), 10),
    liquidityAfter: liquidityAfter.toString(),
    reserveFloorOk,
    windowEnd,
  };
  const parsed = FeasiblePlanSchema.safeParse(plan);
  return parsed.success ? parsed.data : null;
}
