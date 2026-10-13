// harness.run(): drive one attack fixture against one target adapter and score it with the oracle (docs/07 §2).
// Loss is decided ONLY by the oracle predicates (docs/15 §2) on the releases the target actually made; this file
// contains no per-attack loss logic. The second signal for the five attacks the oracle cannot express comes from
// the target's own fault model (b1) and is labelled `scoring: "signal"`.
import { amountDueOracle, judgeRelease } from "@symbolon/oracle";
import type { OracleRelease, OracleVerdict } from "@symbolon/oracle";
import type { CheckId, OraclePredicate } from "@symbolon/schemas";
import type { ApplicabilityRow } from "../applicability";
import type { AttackFixture, AttackId, FloodItem, FloodStep, ScenarioId, StepExpect, SubmitStep, TargetId } from "../types";
import type {
  AttackResult,
  ControlResult,
  Expectation,
  HonestItemResult,
  Outcome,
  ReleaseRecord,
  RunRecord,
  StepRecord,
} from "./results";
import { applyPatch, cloneState, freshState, recordRelease, remainingFunding, toOracleInstance } from "./state";
import type { SimState } from "./state";
import type { Criterion, HumanLoop, Target, TargetDecision } from "./target";

/** Money that actually left the correct-payee/correct-amount rule (docs/07 §2 "Loss accounting"). */
export function lossMoney(state: SimState, release: OracleRelease, verdict: OracleVerdict): bigint {
  if (verdict.result === "NO_LOSS") return 0n;
  const p = verdict.predicates;
  if (p.includes("O1") || p.includes("O3")) return release.amount; // wrong recipient or a duplicate: all of it
  if (release.milestoneId === null) return release.amount;
  const gross = state.world.template.groundTruth.legitAmountByMilestone[release.milestoneId];
  if (gross === undefined) return release.amount;
  const due = amountDueOracle(BigInt(gross), state.world.paymentTerms, release.invoiceReceivedAt, release.time);
  const paid = state.releases.reduce((s, r) => (r.milestoneId === release.milestoneId ? s + r.amount : s), 0n) + release.amount;
  const over = paid - due;
  if (over <= 0n) return 0n; // right payee, not over the amount due: a rule was broken but no excess money moved
  return over < release.amount ? over : release.amount;
}

/**
 * Reason codes that only the not-yet-built checks can produce (docs/04 §3-§6 by check). Used to tell an expectation
 * the kernel build cannot meet yet (INCONCLUSIVE) from one it fails (MISMATCH). Harness-local, not authoritative.
 */
const REASON_OWNER: Readonly<Record<string, CheckId>> = Object.freeze({
  EVIDENCE_MISSING: "K-09", EVIDENCE_FAILED: "K-09", EVIDENCE_HASH_MISMATCH: "K-09", EVIDENCE_SOURCE_DENIED: "K-09",
  EXTRACTION_DISAGREE: "K-10", SINGLE_EXTRACTION: "K-10",
  INSTRUCTION_IN_DOC: "K-11",
  CAP_PER_TX: "K-12", CAP_DAILY: "K-12", CAP_WEEKLY: "K-12", CATEGORY_BUDGET: "K-12", VELOCITY: "K-12", HUMAN_REQUIRED: "K-12",
  FIRST_PAYMENT_LARGE: "K-12", ESCALATION_BUDGET_EXCEEDED: "K-12",
  SCREENING_PENDING: "K-13", SCREEN_HIT: "K-13", SCREENING_DISABLED: "K-13",
  LIQUIDITY: "K-14", TIMING_CLAMPED: "K-14", LATE: "K-14", TERMS_NOT_SIGNED: "K-14", TERMS_MISMATCH: "K-14", DISCOUNT_WINDOW_CLOSED: "K-14", PLAN_OUT_OF_ENVELOPE: "K-14",
  BREAKER_HALTED: "K-16",
} as const);

export function matchExpectation(expect: StepExpect, d: TargetDecision, unimplemented: readonly CheckId[]): { expectation: Expectation; note: string } {
  const real: string[] = [];
  const explained: string[] = [];
  const ownedByPending = (reason: string): boolean => {
    const owner = REASON_OWNER[reason];
    return owner !== undefined && unimplemented.includes(owner);
  };
  // docs/04 K-12 v2 (RT-14): once the day's escalation budget is used up, an ESCALATE degrades by design to
  // HOLD ESCALATION_BUDGET_EXCEEDED (no prompt, ranked digest). That is the spec'd form of "needs a human", so a
  // fixture expecting ESCALATE is met by it; any other expected verdict is not.
  const budgetDowngrade = d.action === "HOLD" && (d.reasons as readonly string[]).includes("ESCALATION_BUDGET_EXCEEDED") && (expect.verdictIn as readonly string[]).includes("ESCALATE");
  if (!(expect.verdictIn as readonly string[]).includes(d.action) && !budgetDowngrade) {
    (d.heldByUnimplementedChecks ? explained : real).push(`verdict ${d.action} not in [${expect.verdictIn.join(", ")}]`);
  }
  const reasons = d.reasons as readonly string[];
  if (expect.reasonsAnyOf !== undefined && !expect.reasonsAnyOf.some((r) => reasons.includes(r))) {
    (expect.reasonsAnyOf.some(ownedByPending) ? explained : real).push(`none of reasons [${expect.reasonsAnyOf.join(", ")}] present`);
  }
  if (expect.reasonsAllOf !== undefined) {
    const missing = expect.reasonsAllOf.filter((r) => !reasons.includes(r));
    if (missing.length > 0) (missing.every(ownedByPending) ? explained : real).push(`reasons missing: ${missing.join(", ")}`);
  }
  if (expect.checksAnyOf !== undefined && !expect.checksAnyOf.some((c) => d.checksFired.includes(c))) {
    (expect.checksAnyOf.every((c) => unimplemented.includes(c)) ? explained : real).push(`none of checks [${expect.checksAnyOf.join(", ")}] fired`);
  }
  if (expect.amountDueBaseUnits !== undefined && d.release !== null && d.release.amount.toString() !== expect.amountDueBaseUnits) {
    real.push(`release amount ${d.release.amount} != expected ${expect.amountDueBaseUnits}`);
  }
  if (real.length === 0 && explained.length === 0) return { expectation: "MATCH", note: "" };
  if (real.length === 0) return { expectation: "INCONCLUSIVE", note: `${explained.join("; ")} (needs checks this kernel build lacks: ${unimplemented.join(", ")})` };
  const dup = reasons.includes("NEAR_DUPLICATE") || reasons.includes("DUPLICATE_DOC") || d.action === "REPLAY";
  const paid = reasons.includes("MILESTONE_ALREADY_PAID");
  return {
    expectation: "MISMATCH",
    note:
      [...real, ...explained.map((e) => `${e} (pending checks)`)].join("; ") +
      (dup ? " (K-04 counts an earlier step of this fixture as a duplicate: QUESTIONS WP-23)" : "") +
      (paid ? " (K-04 MILESTONE_ALREADY_PAID: an earlier step of this fixture released on the milestone; K-04 also rejects partialAllowed instalments, QUESTIONS WP-24 item 2)" : ""),
  };
}

interface Holder {
  readonly states: Map<ScenarioId, SimState>;
}

function stateFor(h: Holder, scenarioId: ScenarioId): SimState {
  let s = h.states.get(scenarioId);
  if (s === undefined) {
    s = freshState(scenarioId);
    h.states.set(scenarioId, s);
  }
  return s;
}

interface SubmitOutcome {
  readonly record: StepRecord;
  /** The target's decision for each extraction run, in run order. */
  readonly decisions: readonly TargetDecision[];
  /** Index (into decisions) of the run whose state the instance continues from. */
  readonly chosenIndex: number;
  readonly lossReleases: number;
  readonly releases: number;
  readonly predicates: Set<OraclePredicate>;
  readonly lossMoney: bigint;
}

function runSubmit(h: Holder, fixtureScenario: ScenarioId, step: SubmitStep, target: Target, attackId: string): SubmitOutcome {
  const scenarioId = step.scenarioId ?? fixtureScenario;
  const state = stateFor(h, scenarioId);
  const view = applyPatch(state, step.context);
  const trials = step.runs.map((run) => {
    const trial = cloneState(state);
    let decision = target.decide({ state: trial, view, step, run, fixtureAttackId: attackId });
    if (decision.release !== null && decision.release.amount > remainingFunding(trial)) {
      // the escrow cannot pay more than it holds: the transfer reverts and no money moves
      decision = { ...decision, action: "NOOP", release: null, note: "transfer exceeds the prefunded escrow balance and reverts; no money moves" };
    }
    let release: ReleaseRecord | null = null;
    let money = 0n;
    let verdict: OracleVerdict | null = null;
    if (decision.release !== null) {
      verdict = judgeRelease(toOracleInstance(trial), decision.release);
      money = lossMoney(trial, decision.release, verdict);
      release = {
        amountBaseUnits: decision.release.amount.toString(),
        payee: decision.release.payee,
        time: decision.release.time,
        oracle: { result: verdict.result, predicates: verdict.predicates },
        lossBaseUnits: money.toString(),
      };
      recordRelease(trial, {
        ...decision.release,
        stepId: step.stepId,
        runLabel: run.label,
        milestoneSlug: step.milestoneSlug,
        invoiceNumber: run.a.invoiceNumber as unknown as string,
      });
    }
    const unimplemented = target.unimplementedChecks();
    const m = target.id === "symbolon" ? matchExpectation(run.expect, decision, unimplemented) : { expectation: "N/A" as const, note: "" };
    const rec: RunRecord = {
      label: run.label,
      action: decision.action,
      checksFired: decision.checksFired,
      reasons: decision.reasons as readonly string[],
      heldByUnimplementedChecks: decision.heldByUnimplementedChecks,
      expectation: m.expectation,
      expectationNote: m.note,
      release,
    };
    return { trial, rec, money, verdict, decision };
  });
  const chosenIndex = Math.max(0, trials.findIndex((t) => t.rec.action === "RELEASE"));
  const chosen = trials[chosenIndex];
  if (chosen !== undefined) h.states.set(scenarioId, chosen.trial);
  const predicates = new Set<OraclePredicate>();
  let lossReleases = 0;
  let releases = 0;
  let money = 0n;
  for (const t of trials) {
    if (t.verdict !== null) {
      releases += 1;
      if (t.verdict.result === "LOSS") {
        lossReleases += 1;
        for (const p of t.verdict.predicates) predicates.add(p);
      }
      money += t.money;
    }
  }
  return {
    record: { stepId: step.stepId, kind: "submit", status: "RAN", reason: "", runs: trials.map((t) => t.rec), signals: [], criteria: [] },
    decisions: trials.map((t) => t.decision),
    chosenIndex,
    lossReleases,
    releases,
    predicates,
    lossMoney: money,
  };
}

function controlResult(fixture: AttackFixture, target: Target): ControlResult {
  const c = fixture.control;
  if (c.kind === "approval-unmodified") {
    if (target.humanLoop === undefined) return { status: "NOT_RUN", detail: "this target has no approval gate" };
    const k = target.humanLoop.approvalControl(c.signedView);
    return k.passed ? { status: "PASS", detail: k.detail } : { status: "OVERBLOCKED", detail: k.detail };
  }
  const step = c.step;
  const refusal = target.cannotRun(step);
  if (refusal !== null) return { status: "NOT_RUN", detail: refusal };
  const h: Holder = { states: new Map() };
  const scenarioId = step.scenarioId ?? fixture.scenarioId;
  const state = stateFor(h, scenarioId);
  const view = applyPatch(state, step.context);
  const run = step.runs[0];
  if (run === undefined) return { status: "NOT_RUN", detail: "control has no extraction run" };
  const trial = cloneState(state);
  const d = target.decide({ state: trial, view, step, run, fixtureAttackId: fixture.attackId });
  if (d.release === null) {
    return { status: "OVERBLOCKED", detail: `${d.action}${d.heldByUnimplementedChecks ? " (only because later checks are not implemented in this build)" : ""}` };
  }
  const verdict = judgeRelease(toOracleInstance(trial), d.release);
  if (verdict.result === "LOSS") return { status: "LOSS", detail: `released ${d.release.amount} and the oracle says ${verdict.predicates.join("+")}` };
  if (d.release.amount.toString() !== c.correctRelease.amountBaseUnits) return { status: "LOSS", detail: `released ${d.release.amount}, correct is ${c.correctRelease.amountBaseUnits}` };
  return { status: "PASS", detail: "released the correct amount to the correct payee; oracle NO_LOSS" };
}

const notRunStep = (stepId: string, kind: string, reason: string): StepRecord => ({ stepId, kind, status: "NOT_RUN", reason, runs: [], signals: [], criteria: [] });

const criteriaStep = (stepId: string, kind: string, criteria: readonly Criterion[]): StepRecord => ({
  stepId,
  kind,
  status: "RAN",
  reason: "",
  runs: [],
  signals: criteria.filter((c) => !c.passed).map((c) => `criterion failed: ${c.id}: ${c.detail}`),
  criteria,
});

/**
 * ATK-22 (docs/07 §3.2): a flood of benign items that need a human, with one malicious item buried in it. The stated
 * criteria: at most maxIndividualPrompts prompts; the overflow is HOLD ESCALATION_BUDGET_EXCEEDED in one ranked digest;
 * the malicious item is surfaced (a prompt of its own, or digest rank <= maliciousMaxRank) or refused outright; nothing
 * is released; there is no bulk approve.
 */
export function floodCriteria(step: FloodStep, items: ReadonlyArray<{ item: FloodItem; decision: TargetDecision }>, loop: HumanLoop): Criterion[] {
  const e = step.expect;
  const prompts = items.filter((x) => x.decision.action === "ESCALATE").length;
  const isOverflow = (d: TargetDecision): boolean => d.action === "HOLD" && (d.reasons as readonly string[]).includes(e.overflowReason);
  const overflow = items.filter((x) => isOverflow(x.decision));
  const released = items.filter((x) => x.decision.action === "RELEASE").length;
  const out: Criterion[] = [
    { id: "individual-prompts", passed: prompts <= e.maxIndividualPrompts, detail: `${prompts} individual approval prompt(s) across ${items.length} items (limit ${e.maxIndividualPrompts} a day)` },
    {
      id: "overflow-is-one-digest",
      passed: overflow.length > 0 || items.length <= e.maxIndividualPrompts,
      detail: `${overflow.length} item(s) were ${e.overflowVerdict} ${e.overflowReason} instead of raising a prompt; they are shown as one ranked digest, not as separate prompts`,
    },
  ];
  const bad = items.find((x) => x.item.itemId === step.maliciousItemId);
  if (bad === undefined) {
    out.push({ id: "malicious-surfaced", passed: false, detail: "the malicious item is not among the items run" });
  } else if (bad.decision.action === "ESCALATE") {
    out.push({ id: "malicious-surfaced", passed: true, detail: "the malicious item got an approval prompt of its own (it arrived before the budget was used up)" });
  } else if (isOverflow(bad.decision)) {
    const digest = overflow.flatMap((x) => (x.decision.digest === undefined || x.decision.digest === null ? [] : [x.decision.digest]));
    const mine = bad.decision.digest;
    const rank = mine === undefined || mine === null ? undefined : loop.rankDigest(digest).get(mine.decisionId);
    out.push({
      id: "malicious-surfaced",
      passed: rank !== undefined && rank <= e.maliciousMaxRank,
      detail: rank === undefined ? "the malicious item is in the overflow but has no digest entry" : `the malicious item is rank ${rank} of ${digest.length} in the digest (must be <= ${e.maliciousMaxRank})`,
    });
  } else if (bad.decision.action === "REJECT" || bad.decision.action === "REPLAY") {
    out.push({ id: "malicious-surfaced", passed: true, detail: `the malicious item was ${bad.decision.action} outright (${bad.decision.reasons.join(", ")}): no approval can release it` });
  } else {
    out.push({ id: "malicious-surfaced", passed: false, detail: `the malicious item ended ${bad.decision.action} (${bad.decision.reasons.join(", ")}) without a prompt or a digest entry` });
  }
  out.push({ id: "nothing-moves-without-approval", passed: released === 0, detail: `${released} of ${items.length} items released money without an owner approval` });
  const bulk = loop.bulkApprove();
  out.push({ id: bulk.id, passed: bulk.passed, detail: bulk.detail });
  return out;
}

export function runAttack(fixture: AttackFixture, target: Target, applicability: Pick<ApplicabilityRow, "applicable" | "reason">): AttackResult {
  const scoring = fixture.intendedLoss === null ? "signal" : "oracle";
  const attackId: AttackId = fixture.attackId;
  const targetId: TargetId = target.id;
  if (applicability.applicable !== true) {
    return {
      attackId,
      target: targetId,
      outcome: "N/A",
      scoring,
      lossBaseUnits: "0",
      checksFired: [],
      oracle: null,
      complete: false,
      trials: 0,
      expectations: { match: 0, mismatch: 0, inconclusive: 0 },
      steps: [],
      criteria: { passed: 0, failed: 0 },
      control: { status: "NOT_RUN", detail: "not applicable" },
      notes: [applicability.reason],
    };
  }
  const h: Holder = { states: new Map() };
  const steps: StepRecord[] = [];
  const predicates = new Set<OraclePredicate>();
  const checks = new Set<CheckId>();
  const notes: string[] = [];
  const signals: string[] = [];
  let releases = 0;
  let lossReleases = 0;
  let money = 0n;
  let trials = 0;
  const exp = { match: 0, mismatch: 0, inconclusive: 0 };
  const actions: string[] = [];

  const absorb = (o: SubmitOutcome): void => {
    steps.push(o.record);
    releases += o.releases;
    lossReleases += o.lossReleases;
    money += o.lossMoney;
    for (const p of o.predicates) predicates.add(p);
    for (const r of o.record.runs) {
      trials += 1;
      actions.push(r.action);
      for (const c of r.checksFired) checks.add(c);
      if (r.expectation === "MATCH") exp.match += 1;
      else if (r.expectation === "MISMATCH") exp.mismatch += 1;
      else if (r.expectation === "INCONCLUSIVE") exp.inconclusive += 1;
    }
  };

  for (const step of fixture.steps) {
    if (step.kind === "flood") {
      const outcomes = step.items.map((item) => ({ item, outcome: runSubmit(h, fixture.scenarioId, item.step, target, fixture.attackId) }));
      for (const o of outcomes) absorb(o.outcome);
      const loop = target.humanLoop;
      if (loop === undefined) {
        steps.push(notRunStep(`${step.stepId}#criteria`, "flood", target.cannotRun(step) ?? "this target has no escalation digest"));
      } else {
        const decided = outcomes.flatMap((o) => {
          const d = o.outcome.decisions[o.outcome.chosenIndex];
          return d === undefined ? [] : [{ item: o.item, decision: d }];
        });
        const rec = criteriaStep(`${step.stepId}#criteria`, "flood", floodCriteria(step, decided, loop));
        steps.push(rec);
        signals.push(...rec.signals);
      }
      continue;
    }
    const refusal = target.cannotRun(step);
    if (refusal !== null) {
      steps.push(notRunStep(step.stepId, step.kind, refusal));
      continue;
    }
    if (step.kind === "submit") {
      const o = runSubmit(h, fixture.scenarioId, step, target, fixture.attackId);
      absorb(o);
      if (step.explainerChecks !== undefined) {
        const loop = target.humanLoop;
        if (loop === undefined) {
          steps.push(notRunStep(`${step.stepId}#explainer`, "explainer", "this target has no templated explainer"));
        } else {
          const criteria = o.decisions.flatMap((d, i) => loop.explainer(d.explanation ?? null, step.explainerChecks as NonNullable<typeof step.explainerChecks>).map((c) => ({ ...c, id: `${step.runs[i]?.label ?? i}/${c.id}` })));
          const rec = criteriaStep(`${step.stepId}#explainer`, "explainer", criteria);
          steps.push(rec);
          signals.push(...rec.signals);
        }
      }
    } else if (step.kind === "fault") {
      const f = target.fault(step, stateFor(h, fixture.scenarioId));
      if (f.status === "not-run") steps.push(notRunStep(step.stepId, "fault", f.reason));
      else {
        steps.push({ stepId: step.stepId, kind: "fault", status: "RAN", reason: f.reason, runs: [], signals: f.signals, criteria: [] });
        signals.push(...f.signals);
      }
    } else if (step.kind === "approval-render" && target.humanLoop !== undefined) {
      const rec = criteriaStep(step.stepId, "approval-render", target.humanLoop.approvalRender(step));
      steps.push(rec);
      signals.push(...rec.signals);
    } else {
      steps.push(notRunStep(step.stepId, step.kind, "step kind not supported by this target"));
    }
  }
  const allCriteria = steps.flatMap((s) => s.criteria);
  const criteriaCount = { passed: allCriteria.filter((c) => c.passed).length, failed: allCriteria.filter((c) => !c.passed).length };

  const complete = steps.every((s) => s.status === "RAN");
  for (const s of steps) if (s.status === "NOT_RUN") notes.push(`${s.stepId}: NOT_RUN: ${s.reason}`);
  for (const s of signals) notes.push(`signal: ${s}`);
  const anyRan = steps.some((s) => s.status === "RAN");

  let outcome: Outcome;
  if (!anyRan) outcome = "NOT_RUN";
  else if (lossReleases > 0 || signals.length > 0) outcome = "LOSS";
  else if (actions.includes("REJECT") || actions.includes("REPLAY")) outcome = "BLOCKED";
  else if (actions.includes("ESCALATE")) outcome = "ESCALATED";
  else if (actions.includes("HOLD")) outcome = "HELD";
  else if (criteriaCount.passed > 0) outcome = "BLOCKED"; // a step with stated criteria (ATK-23: Sign disabled) and every one met
  else outcome = "NOOP";
  if (outcome === "LOSS" && lossReleases === 0 && signals.length > 0 && scoring === "oracle") {
    // a signal on an oracle-scored attack is still reported, but the loss class stays by evidence
    notes.push("loss evidence is a ledger signal, not an oracle predicate");
  }

  return {
    attackId,
    target: targetId,
    outcome,
    scoring,
    lossBaseUnits: money.toString(),
    checksFired: [...checks].sort(),
    oracle: { version: "oracle-v1", predicates: [...predicates].sort(), releases, lossReleases },
    complete,
    trials,
    expectations: exp,
    steps,
    criteria: criteriaCount,
    control: controlResult(fixture, target),
    notes,
  };
}

/** Run the honest fixtures through a target (docs/07 §4). The oracle must say NO_LOSS for every correct release. */
export function runHonestItem(h: { id: string; group: string; scenarioId: ScenarioId; step: SubmitStep; correctAmount: string }, target: Target): HonestItemResult {
  const holder: Holder = { states: new Map() };
  const state = stateFor(holder, h.scenarioId);
  const view = applyPatch(state, h.step.context);
  const run = h.step.runs[0];
  if (run === undefined) throw new RangeError(`${h.id}: honest fixture has no run`);
  const trial = cloneState(state);
  const d = target.decide({ state: trial, view, step: h.step, run, fixtureAttackId: h.id });
  if (d.release === null) {
    return { id: h.id, group: h.group, action: d.action, released: false, oracle: null, amountMatches: null, heldByUnimplementedChecks: d.heldByUnimplementedChecks };
  }
  const verdict = judgeRelease(toOracleInstance(trial), d.release);
  return {
    id: h.id,
    group: h.group,
    action: d.action,
    released: true,
    oracle: verdict.result,
    amountMatches: d.release.amount.toString() === h.correctAmount,
    heldByUnimplementedChecks: false,
  };
}

