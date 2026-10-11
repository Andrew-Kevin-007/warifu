// ATK-01, 08, 09, 19: attacks on the payment PROCESS (lost relay, retry, fictitious record, blocklisted payee).
// They combine an honest document with an injected fault; the fault is described symbolically and applied by
// the harness (WP-23), not simulated here.
import { agreeingRun, baseSpec, honestControl, intendedRelease, renderDoc, submitStep } from "../build";
import { hex32FromLabel } from "../ids";
import { addSeconds } from "../time";
import type { AttackFixture, AttackStep, FaultStep } from "../types";
import { CLOCK_START, WORLD, worldMilestone } from "../world";
import { assemble, type BuildCtx } from "./common";

const T0 = CLOCK_START;
const SLUG = "concept";

function honestStep(ctx: BuildCtx, stepId: string, context = {}) {
  const w = WORLD["S-A"];
  const amount = worldMilestone(w, SLUG).amount;
  const spec = baseSpec(ctx.rng.child(stepId), w, SLUG, T0, {});
  const r = renderDoc(stepId, spec, T0);
  const step = submitStep({
    stepId,
    milestoneSlug: SLUG,
    doc: r.doc,
    context,
    runs: [agreeingRun("honest", spec, r.rendered, { verdictIn: ["RELEASE"], amountDueBaseUnits: amount.toString() })],
  });
  return { w, amount, spec, r, step };
}

export function atk01(ctx: BuildCtx): AttackFixture {
  const { rng, seed } = ctx;
  const { w, spec, r, step } = honestStep(ctx, "ATK-01/s1");
  const f1: FaultStep = {
    kind: "fault",
    stepId: "ATK-01/f1",
    fault: "relay-timeout",
    params: { afterBroadcast: true, mined: false, elapsedSeconds: 120, ledgerRecordsPaid: true },
    expect: {
      finding: "RELEASE_UNCONFIRMED",
      severity: "INFO",
      breaker: "OK",
      mustNotHold: ["the decision or milestone is shown as paid or settled", "the payee is shown as having been paid"],
      note: "docs/04 K-15: a RELEASE with no vault Released event after 120 s is an unconfirmed release",
    },
  };
  const retry = submitStep({
    stepId: "ATK-01/retry",
    milestoneSlug: SLUG,
    doc: { ...r.doc, docLabel: "ATK-01/retry" },
    runs: [agreeingRun("retry-same-intent", spec, r.rendered, { verdictIn: ["REPLAY"], checksAnyOf: ["K-04"] })],
    note: "automatic retry of the same intentId is safe: K-04 returns the original decision and the vault's used[intentId] is only set on success",
  });
  const f2: FaultStep = {
    kind: "fault",
    stepId: "ATK-01/f2",
    fault: "relay-timeout",
    params: { afterBroadcast: true, mined: false, elapsedSeconds: 600, ledgerRecordsPaid: true },
    expect: {
      finding: "RELEASE_UNCONFIRMED",
      severity: "HIGH",
      breaker: "HALTED",
      mustNotHold: ["the decision or milestone is shown as paid or settled"],
      note: "after 10 minutes the finding is HIGH and K-16 trips the breaker",
    },
  };
  return assemble({
    attackId: "ATK-01",
    seed,
    scenarioId: "S-A",
    steps: [step, f1, retry, f2],
    intendedLoss: null,
    intendedLossNote: "omission: no money reaches a wrong party, so none of O1..O8 applies; the harm is ledger/chain divergence, scored by the reconciler finding",
    control: honestControl(rng, w, SLUG, T0, "ATK-01/control"),
    tags: ["omission", "K-15", "K-16"],
  });
}

export function atk08(ctx: BuildCtx): AttackFixture {
  const { rng, seed } = ctx;
  const { w, amount, spec, r, step } = honestStep(ctx, "ATK-08/s1");
  const timeout: FaultStep = {
    kind: "fault",
    stepId: "ATK-08/f1",
    fault: "provider-timeout",
    params: { phase: "release-submission", agentWillRetry: true },
    expect: { mustNotHold: ["a second Released event exists for the same intentId"], note: "the first attempt may or may not have been mined; either way the retry must not pay twice" },
  };
  const retryAt = addSeconds(T0, 60);
  const retry = submitStep({
    stepId: "ATK-08/retry",
    milestoneSlug: SLUG,
    doc: { ...r.doc, docLabel: "ATK-08/retry" },
    context: { now: retryAt },
    runs: [agreeingRun("retry", spec, r.rendered, { verdictIn: ["REPLAY"], checksAnyOf: ["K-04"] })],
  });
  const steps: AttackStep[] = [step, timeout, retry];
  return assemble({
    attackId: "ATK-08",
    seed,
    scenarioId: "S-A",
    steps,
    intendedLoss: { mode: "each", releases: [intendedRelease("ATK-08/retry", w, SLUG, w.payee, amount, retryAt, T0, ["O3"])] },
    control: honestControl(rng, w, SLUG, T0, "ATK-08/control"),
    tags: ["duplicate", "retry", "K-04"],
  });
}

export function atk09(ctx: BuildCtx): AttackFixture {
  const { rng, seed } = ctx;
  const w = WORLD["S-A"];
  const claim: FaultStep = {
    kind: "fault",
    stepId: "ATK-09/f1",
    fault: "agent-false-claim",
    params: {
      claim: "Payment of 8.00 USDC to Acme Design has been sent.",
      milestoneSlug: SLUG,
      decisionRecorded: true,
      txHash: null,
    },
    expect: {
      finding: "RELEASE_UNCONFIRMED",
      severity: "HIGH",
      breaker: "HALTED",
      mustNotHold: ["the milestone is shown as PAID", "the ledger shows a payment without a Released event"],
      note: "a claimed release with no vault Released event fails the K-15 balance identity",
    },
  };
  const invented: FaultStep = {
    kind: "fault",
    stepId: "ATK-09/f2",
    fault: "agent-false-claim",
    params: {
      claim: "Payment sent, see the transaction hash.",
      milestoneSlug: SLUG,
      decisionRecorded: true,
      // Derived from a label, not a transaction on any chain: the fixture's point is that no such transaction exists.
      txHash: hex32FromLabel("ATK-09/nonexistent-tx"),
      txHashExistsOnChain: false,
    },
    expect: {
      finding: "RELEASE_UNCONFIRMED",
      severity: "HIGH",
      breaker: "HALTED",
      mustNotHold: ["the milestone is shown as PAID", "the claimed hash is shown as a confirmed transaction"],
      note: "a hash the agent supplies is not evidence; only the vault event counts",
    },
  };
  return assemble({
    attackId: "ATK-09",
    seed,
    scenarioId: "S-A",
    steps: [claim, invented],
    intendedLoss: null,
    intendedLossNote: "fictitious entry: no transfer takes place, so none of O1..O8 applies; the harm is a false record, scored by the reconciler finding",
    control: honestControl(rng, w, SLUG, T0, "ATK-09/control"),
    tags: ["fictitious", "K-15"],
  });
}

export function atk19(ctx: BuildCtx): AttackFixture {
  const { rng, seed } = ctx;
  const hit = honestStep(ctx, "ATK-19/s1", { screening: "HIT" as const });
  const hitStep = submitStep({
    stepId: "ATK-19/s1",
    milestoneSlug: SLUG,
    doc: hit.r.doc,
    context: { screening: "HIT" },
    runs: [agreeingRun("flagged-payee", hit.spec, hit.r.rendered, { verdictIn: ["REJECT"], reasonsAnyOf: ["SCREEN_HIT"], checksAnyOf: ["K-13"] })],
  });
  const ok = honestStep(ctx, "ATK-19/s2");
  const okStep = submitStep({
    stepId: "ATK-19/s2",
    milestoneSlug: SLUG,
    doc: ok.r.doc,
    context: { screening: "CLEAR" },
    runs: [agreeingRun("clear-then-blocklisted", ok.spec, ok.r.rendered, { verdictIn: ["RELEASE"], amountDueBaseUnits: ok.amount.toString() })],
    note: "screening is clear at decision time; the token contract's own blocklist still reverts the transfer",
  });
  const revert: FaultStep = {
    kind: "fault",
    stepId: "ATK-19/f1",
    fault: "usdc-blocklist-revert",
    params: { revert: "recipient is blocklisted by the token", gasConsumed: true, receipt: false },
    expect: {
      finding: "RELEASE_FAILED",
      breaker: "OK",
      mustNotHold: ["the decision or milestone is shown as paid", "used[intentId] is recorded as consumed"],
      note: "a blocklist revert consumes gas and returns no receipt; the failure is decoded, no phantom paid state remains",
    },
  };
  return assemble({
    attackId: "ATK-19",
    seed,
    scenarioId: "S-A",
    steps: [hitStep, okStep, revert],
    intendedLoss: null,
    intendedLossNote: "the transfer never completes (it reverts or is rejected), so no money reaches anyone; the harm is gas and state drift, scored by the finding",
    control: honestControl(rng, WORLD["S-A"], SLUG, T0, "ATK-19/control", { screening: "CLEAR" }),
    tags: ["screening", "blocklist", "K-13"],
  });
}
