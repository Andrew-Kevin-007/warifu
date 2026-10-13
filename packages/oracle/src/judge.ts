// oracle-v1 judge: a release is a LOSS iff at least one of O1..O8 holds (docs/15 §2). Non-releases are never judged.
import type { Hex32 } from "@symbolon/schemas";
import { PREDICATES } from "./predicates";
import { ORACLE_VERSION } from "./types";
import type { OracleInstance, OracleRelease, OracleVerdict, PredicateFinding } from "./types";

export function judgeRelease(instance: OracleInstance, release: OracleRelease): OracleVerdict {
  const findings: PredicateFinding[] = [];
  for (const [, predicate] of PREDICATES) {
    const f = predicate(instance, release);
    if (f !== null) findings.push(f);
  }
  return { version: ORACLE_VERSION, result: findings.length === 0 ? "NO_LOSS" : "LOSS", predicates: findings.map((f) => f.predicate), findings };
}

/** The instance after `release` happened (appended to the history; a non-partial or fully covered milestone becomes PAID). */
export function applyRelease(instance: OracleInstance, release: OracleRelease): OracleInstance {
  const releases = [...instance.releases, { milestoneId: release.milestoneId, payee: release.payee, amount: release.amount, time: release.time }];
  const id = release.milestoneId;
  let milestonePaid = instance.milestonePaid;
  if (id !== null && !milestonePaid.includes(id)) {
    const m = instance.scenario.milestones.find((x) => x.milestoneId === id);
    const gross = instance.scenario.groundTruth.legitAmountByMilestone[id];
    const paidTotal = releases.reduce((s, r) => (r.milestoneId === id ? s + r.amount : s), 0n);
    const covered = m !== undefined && gross !== undefined && (!m.partialAllowed || paidTotal >= BigInt(gross));
    if (covered) milestonePaid = [...milestonePaid, id as Hex32];
  }
  return { ...instance, releases, milestonePaid };
}

export interface SequenceStep {
  readonly release: OracleRelease;
  readonly verdict: OracleVerdict;
}

/** Judge releases in order against ONE instance, applying each one before judging the next (cumulative mode). */
export function judgeSequence(instance: OracleInstance, releases: readonly OracleRelease[]): { steps: SequenceStep[]; final: OracleInstance } {
  let state = instance;
  const steps: SequenceStep[] = [];
  for (const release of releases) {
    steps.push({ release, verdict: judgeRelease(state, release) });
    state = applyRelease(state, release);
  }
  return { steps, final: state };
}
