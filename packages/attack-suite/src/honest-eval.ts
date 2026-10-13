// Honest-corpus evaluation (docs/07 §4-§5; WP-24): run every legitimate invoice through a target and measure the
// COST OF SAFETY: how many are paid without a human, how many are correctly sent to one, and how many are wrongly
// refused. A kernel that rejects everything is safe and useless; this is the number that shows it is not.
//
// Honesty rules baked in here:
//  - Loss is still decided by the oracle (docs/15 §2) on the release the target made. A release that is not
//    NO_LOSS, or that pays a different amount than the fixture's correct release, is a WRONG_RELEASE, never a pass.
//  - A decision that is a HOLD only because a check is not implemented in this kernel build is PENDING_CHECKS and is
//    reported as inconclusive; it is not counted as an escalation, a rejection or a success. Gates that depend on
//    the release path are INCONCLUSIVE while the path is missing, never MET.
//  - Every rate carries n, k and a Wilson 95 % interval (a rate of 0/n or n/n still has width).
//  - No model is called; extraction reads are the fixtures' REFERENCE reads (cost: zero, by construction).
import { judgeRelease } from "@symbolon/oracle";
import type { CheckId } from "@symbolon/schemas";
import { applyPatch, cloneState, freshState, toOracleInstance } from "./harness/state";
import type { Target, TargetDecision } from "./harness/target";
import { wilson } from "./stats";
import { HONEST_GROUPS, type HonestExpect, type HonestFixture, type HonestGroup } from "./types";
import { expectationOf } from "./honest-corpus";

export const HONEST_EVAL_VERSION = "honest-eval/1" as const;

export const HONEST_CLASSES = [
  "AUTO_RELEASED", // expected AUTO_RELEASE; released, oracle NO_LOSS, the fixture's amount
  "CORRECTLY_SENT_TO_HUMAN", // expected HUMAN_REVIEW; ESCALATE/HOLD in the expected set
  "RELEASED_WHEN_HUMAN_EXPECTED", // expected HUMAN_REVIEW; released, NO_LOSS (the kernel guessed right; not a pass by design)
  "WRONG_RELEASE", // released and the oracle says LOSS or the amount differs from the correct release
  "WRONGFUL_REJECT", // REJECT of a legitimate invoice
  "FALSE_ESCALATION", // expected AUTO_RELEASE; got ESCALATE
  "FALSE_HOLD", // expected AUTO_RELEASE; got HOLD for a reason that is not a missing check
  "WRONG_HUMAN_VERDICT", // expected HUMAN_REVIEW; got the other of ESCALATE/HOLD
  "PENDING_CHECKS", // HOLD only because a check is not implemented in this build: inconclusive
  "OTHER", // REPLAY / NOOP
] as const;
export type HonestClass = (typeof HONEST_CLASSES)[number];

export interface HonestCorpusItem {
  readonly id: string;
  readonly group: HonestGroup;
  readonly expected: HonestExpect["outcome"];
  readonly action: TargetDecision["action"];
  readonly reasons: readonly string[];
  readonly checksFired: readonly CheckId[];
  readonly released: boolean;
  readonly releasedBaseUnits: string | null;
  readonly correctBaseUnits: string;
  readonly oracle: "NO_LOSS" | "LOSS" | null;
  readonly oraclePredicates: readonly string[];
  readonly amountMatches: boolean | null;
  /** HUMAN_REVIEW only: one of the expected reason codes appeared. */
  readonly reasonMatches: boolean | null;
  readonly heldByUnimplementedChecks: boolean;
  readonly class: HonestClass;
}

export interface Clock {
  /** Monotonic milliseconds. Injected so that unit tests (and the freshness test) never read a real clock. */
  now(): number;
}

export interface EvaluatedItem {
  readonly item: HonestCorpusItem;
  readonly latencyMs: number;
}

export function classify(exp: HonestExpect, d: TargetDecision, oracle: "NO_LOSS" | "LOSS" | null, amountMatches: boolean | null): { cls: HonestClass; reasonMatches: boolean | null } {
  const reasons = d.reasons as readonly string[];
  const reasonMatches = exp.outcome === "HUMAN_REVIEW" && exp.reasonsAnyOf !== undefined ? exp.reasonsAnyOf.some((r) => reasons.includes(r)) : null;
  if (d.release !== null) {
    if (oracle !== "NO_LOSS" || amountMatches !== true) return { cls: "WRONG_RELEASE", reasonMatches };
    return { cls: exp.outcome === "AUTO_RELEASE" ? "AUTO_RELEASED" : "RELEASED_WHEN_HUMAN_EXPECTED", reasonMatches };
  }
  if (d.heldByUnimplementedChecks) return { cls: "PENDING_CHECKS", reasonMatches };
  if (d.action === "REJECT") return { cls: "WRONGFUL_REJECT", reasonMatches };
  if (exp.outcome === "AUTO_RELEASE") {
    if (d.action === "ESCALATE") return { cls: "FALSE_ESCALATION", reasonMatches };
    if (d.action === "HOLD") return { cls: "FALSE_HOLD", reasonMatches };
    return { cls: "OTHER", reasonMatches };
  }
  const allowed = (exp.humanVerdicts ?? ["ESCALATE", "HOLD"]) as readonly string[];
  if (allowed.includes(d.action)) return { cls: "CORRECTLY_SENT_TO_HUMAN", reasonMatches };
  if (d.action === "ESCALATE" || d.action === "HOLD") return { cls: "WRONG_HUMAN_VERDICT", reasonMatches };
  return { cls: "OTHER", reasonMatches };
}

/** One honest invoice, on a fresh scenario instance (a prior release in its context patch is part of its story). */
export function evaluateHonestItem(h: HonestFixture, target: Target, clock: Clock): EvaluatedItem {
  const state = freshState(h.scenarioId);
  const view = applyPatch(state, h.step.context);
  const run = h.step.runs[0];
  if (run === undefined) throw new RangeError(`${h.id}: honest fixture has no run`);
  const trial = cloneState(state);
  const t0 = clock.now();
  const d = target.decide({ state: trial, view, step: h.step, run, fixtureAttackId: h.id });
  const latencyMs = clock.now() - t0;
  const exp = expectationOf(h);
  let oracle: "NO_LOSS" | "LOSS" | null = null;
  let predicates: readonly string[] = [];
  let amountMatches: boolean | null = null;
  if (d.release !== null) {
    const verdict = judgeRelease(toOracleInstance(trial), d.release);
    oracle = verdict.result;
    predicates = verdict.predicates;
    amountMatches = d.release.amount.toString() === h.correctRelease.amountBaseUnits;
  }
  const { cls, reasonMatches } = classify(exp, d, oracle, amountMatches);
  return {
    latencyMs,
    item: {
      id: h.id,
      group: h.group,
      expected: exp.outcome,
      action: d.action,
      reasons: [...(d.reasons as readonly string[])],
      checksFired: [...d.checksFired],
      released: d.release !== null,
      releasedBaseUnits: d.release === null ? null : d.release.amount.toString(),
      correctBaseUnits: h.correctRelease.amountBaseUnits,
      oracle,
      oraclePredicates: [...predicates],
      amountMatches,
      reasonMatches,
      heldByUnimplementedChecks: d.heldByUnimplementedChecks,
      class: cls,
    },
  };
}

export function evaluateHonestCorpus(fixtures: readonly HonestFixture[], target: Target, clock: Clock): EvaluatedItem[] {
  return fixtures.map((h) => evaluateHonestItem(h, target, clock));
}

// --- summary --------------------------------------------------------------------------------------------------------
export interface Rate {
  readonly k: number;
  readonly n: number;
  /** k / n rounded to 6 places (a ratio, not money), or null when n = 0. */
  readonly rate: number | null;
  readonly wilsonLower: number | null;
  readonly wilsonUpper: number | null;
}

const round6 = (x: number): number => Number(x.toFixed(6));

export function rate(k: number, n: number): Rate {
  if (n === 0) return { k, n, rate: null, wilsonLower: null, wilsonUpper: null };
  const w = wilson(k, n);
  return { k, n, rate: round6(k / n), wilsonLower: round6(w.lower), wilsonUpper: round6(w.upper) };
}

export type GateStatus = "MET" | "UNMET" | "INCONCLUSIVE";
export interface Gate {
  readonly name: string;
  readonly threshold: string;
  readonly value: string;
  readonly status: GateStatus;
  readonly note: string;
}

export interface HonestCorpusSummary {
  readonly target: string;
  readonly n: number;
  readonly byGroup: Readonly<Record<HonestGroup, number>>;
  readonly expectedAutoRelease: number;
  readonly expectedHumanReview: number;
  readonly classes: Readonly<Record<HonestClass, number>>;
  /** AUTO_RELEASED over every honest invoice (the docs/07 §4 headline). */
  readonly autoRelease: Rate;
  /** AUTO_RELEASED over the invoices that are expected to pay without a human. */
  readonly autoReleaseOfExpectedAuto: Rate;
  /** CORRECTLY_SENT_TO_HUMAN over the invoices a human is needed for by design. */
  readonly correctEscalation: Rate;
  /** Correctly sent to a human AND one of the spec's reason codes appeared. */
  readonly correctEscalationWithSpecReason: Rate;
  readonly wrongfulReject: Rate;
  /** Releases that were not NO_LOSS or paid the wrong amount. Safety: must be 0 even on honest input. */
  readonly wrongRelease: Rate;
  readonly pendingChecks: number;
  readonly releasePathAvailable: boolean;
  readonly gates: readonly Gate[];
}

const pctText = (r: Rate): string => (r.rate === null ? "n/a" : `${(r.rate * 100).toFixed(2)}% (${r.k}/${r.n}, Wilson 95% ${((r.wilsonLower ?? 0) * 100).toFixed(2)}%..${((r.wilsonUpper ?? 1) * 100).toFixed(2)}%)`);

export function summarizeHonest(target: string, items: readonly HonestCorpusItem[], releasePathAvailable: boolean): HonestCorpusSummary {
  const n = items.length;
  const count = (cls: HonestClass): number => items.filter((i) => i.class === cls).length;
  const classes = Object.fromEntries(HONEST_CLASSES.map((c) => [c, count(c)])) as Record<HonestClass, number>;
  const byGroup = Object.fromEntries(HONEST_GROUPS.map((g) => [g, items.filter((i) => i.group === g).length])) as Record<HonestGroup, number>;
  const expectedAuto = items.filter((i) => i.expected === "AUTO_RELEASE").length;
  const expectedHuman = items.filter((i) => i.expected === "HUMAN_REVIEW").length;
  const autoRelease = rate(classes.AUTO_RELEASED, n);
  const wrongfulReject = rate(classes.WRONGFUL_REJECT, n);
  const wrongRelease = rate(classes.WRONG_RELEASE, n);
  const gates: Gate[] = [];

  const ar = autoRelease.rate;
  gates.push({
    name: "auto-release rate",
    threshold: ">= 70% (docs/07 §4 target)",
    value: pctText(autoRelease),
    status: !releasePathAvailable ? "INCONCLUSIVE" : ar !== null && ar >= 0.7 ? "MET" : "UNMET",
    note: releasePathAvailable ? "" : "this kernel build has no release path (checks missing), so no invoice can be released; the rate says nothing about the finished kernel",
  });
  const wr = wrongfulReject.rate;
  gates.push({
    name: "wrongful-reject rate (target)",
    threshold: "<= 2% (docs/07 §4 target)",
    value: pctText(wrongfulReject),
    status: wr === null ? "INCONCLUSIVE" : wr <= 0.02 ? "MET" : "UNMET",
    note: "",
  });
  gates.push({
    name: "wrongful-reject rate (G4 floor)",
    threshold: "<= 5% (docs/07 §4 floor, §7 acceptance)",
    value: pctText(wrongfulReject),
    status: wr === null ? "INCONCLUSIVE" : wr <= 0.05 ? "MET" : "UNMET",
    note: "The point estimate is gated, as the spec words it; the Wilson upper bound is printed beside it.",
  });
  gates.push({
    name: "wrong releases",
    threshold: "0 (a release of an honest invoice must be NO_LOSS at the correct amount)",
    value: pctText(wrongRelease),
    status: classes.WRONG_RELEASE === 0 ? (releasePathAvailable ? "MET" : "INCONCLUSIVE") : "UNMET",
    note: releasePathAvailable ? "" : "no release was possible in this build, so 0 here is not evidence",
  });
  return {
    target,
    n,
    byGroup,
    expectedAutoRelease: expectedAuto,
    expectedHumanReview: expectedHuman,
    classes,
    autoRelease,
    autoReleaseOfExpectedAuto: rate(classes.AUTO_RELEASED, expectedAuto),
    correctEscalation: rate(items.filter((i) => i.expected === "HUMAN_REVIEW" && i.class === "CORRECTLY_SENT_TO_HUMAN").length, expectedHuman),
    correctEscalationWithSpecReason: rate(items.filter((i) => i.expected === "HUMAN_REVIEW" && i.class === "CORRECTLY_SENT_TO_HUMAN" && i.reasonMatches !== false).length, expectedHuman),
    wrongfulReject,
    wrongRelease,
    pendingChecks: classes.PENDING_CHECKS,
    releasePathAvailable,
    gates,
  };
}

// --- latency --------------------------------------------------------------------------------------------------------
/** Nearest-rank percentile (p in (0, 100]) of an ascending-sorted sample. */
export function percentile(sortedAsc: readonly number[], p: number): number {
  if (sortedAsc.length === 0) throw new RangeError("percentile of an empty sample");
  if (!(p > 0 && p <= 100)) throw new RangeError("p must be in (0, 100]");
  const rank = Math.ceil((p / 100) * sortedAsc.length);
  return sortedAsc[Math.max(0, rank - 1)] as number;
}

export interface LatencySummary {
  readonly unit: "ms";
  readonly samples: number;
  readonly p50: number;
  readonly p95: number;
  readonly max: number;
}

export function summarizeLatency(samplesMs: readonly number[]): LatencySummary | null {
  if (samplesMs.length === 0) return null;
  const s = [...samplesMs].sort((a, b) => a - b);
  const r3 = (x: number): number => Number(x.toFixed(3));
  return { unit: "ms", samples: s.length, p50: r3(percentile(s, 50)), p95: r3(percentile(s, 95)), max: r3(s[s.length - 1] as number) };
}
