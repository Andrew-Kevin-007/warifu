// Oracle/fixture agreement (docs/07 §3.3 item 6: "disagreement between oracle and harness is a bug ticket, not a
// rounding error"). Each attack fixture lists the releases a successful attacker is after and the oracle
// predicates that must hold for them (`intendedLoss`). Here the oracle judges those releases in the scenario
// state the fixture builds, and the two are compared. `missing` (listed by the fixture, not reported by the
// oracle) is a DISAGREEMENT; `extra` (reported by the oracle, not listed) is information only: a fixture lists
// the predicates it is about, and a release can break more rules than that.
import { judgeRelease } from "@symbolon/oracle";
import type { OracleRelease } from "@symbolon/oracle";
import type { OraclePredicate } from "@symbolon/schemas";
import { milestoneId, WORLD } from "../world";
import type { AttackFixture, AttackStep, IntendedRelease, ScenarioId, SubmitStep } from "../types";
import { applyPatch, freshState, recordRelease, toOracleInstance } from "./state";
import type { SimRelease, SimState } from "./state";

export interface AgreementRow {
  readonly attackId: string;
  readonly stepId: string;
  readonly intended: readonly OraclePredicate[];
  readonly reported: readonly OraclePredicate[];
  readonly missing: readonly OraclePredicate[];
  readonly extra: readonly OraclePredicate[];
}

/** How an intended release becomes an oracle release (the fixture carries no terms-source field). */
export function intendedToOracleRelease(attackId: string, spec: IntendedRelease, step: AttackStep | null): OracleRelease {
  const world = WORLD[spec.scenarioId];
  return {
    milestoneId: spec.milestoneSlug === null ? null : milestoneId(world, spec.milestoneSlug),
    payee: spec.payee,
    amount: BigInt(spec.amountBaseUnits),
    time: spec.time,
    invoiceReceivedAt: step !== null && step.kind === "submit" ? step.doc.receivedAt : null,
    // every ATK-21 attack is, by construction, a payment whose amount or timing comes from terms on the invoice
    termsBasis: attackId === "ATK-21" ? "invoice-stated" : "signed",
    clockAnchor: null,
    ownerApproved: false,
  };
}

/** The steps of a fixture flattened in execution order (a flood contributes its items as submit steps). */
export function flattenSteps(f: AttackFixture): AttackStep[] {
  return f.steps.flatMap((s): AttackStep[] => (s.kind === "flood" ? s.items.map((i) => i.step) : [s]));
}

function stateFor(scenarioId: ScenarioId): SimState {
  return freshState(scenarioId);
}

/** Arguments of an ATK-17 vault call, resolved into prior releases of a fresh instance. */
function applyVaultArgs(state: SimState, args: Record<string, unknown>): void {
  const pre = Array.isArray(args["preReleases"]) ? (args["preReleases"] as Array<Record<string, unknown>>) : [];
  for (const p of pre) {
    const engagementKey = typeof p["engagement"] === "string" ? (p["engagement"] as ScenarioId) : state.world.scenarioId;
    const world = WORLD[engagementKey];
    const slug = String(p["milestone"]);
    const own = engagementKey === state.world.scenarioId;
    recordRelease(state, {
      milestoneId: own ? milestoneId(world, slug) : null,
      payee: world.payee,
      amount: BigInt(String(p["amountBaseUnits"])),
      time: state.baseNow,
      invoiceReceivedAt: null,
      termsBasis: "signed",
      clockAnchor: null,
      ownerApproved: true,
      stepId: "prior",
      runLabel: "prior",
      milestoneSlug: own ? slug : null,
      invoiceNumber: null,
    });
  }
}

/** An honest earlier step (every run expects a plain RELEASE) pays the legitimate amount; later steps see it as PAID. */
function honestReleaseOf(step: SubmitStep, state: SimState, now: string): SimRelease | null {
  const run = step.runs[0];
  if (step.milestoneSlug === null || run === undefined) return null;
  if (!step.runs.every((r) => r.expect.verdictIn.length === 1 && r.expect.verdictIn[0] === "RELEASE")) return null;
  const ms = state.world.template.milestones.find((m) => m.slug === step.milestoneSlug);
  if (ms === undefined) return null;
  return {
    milestoneId: ms.milestoneId,
    payee: state.world.payee,
    amount: BigInt(run.expect.amountDueBaseUnits ?? ms.amountBaseUnits),
    time: now,
    invoiceReceivedAt: step.doc.receivedAt,
    termsBasis: "signed",
    clockAnchor: null,
    ownerApproved: false,
    stepId: step.stepId,
    runLabel: run.label,
    milestoneSlug: step.milestoneSlug,
    invoiceNumber: null,
  };
}

export function agreement(f: AttackFixture): AgreementRow[] {
  const loss = f.intendedLoss;
  if (loss === null) return [];
  const steps = flattenSteps(f);
  const byStep = new Map<string, IntendedRelease[]>();
  for (const r of loss.releases) byStep.set(r.stepId, [...(byStep.get(r.stepId) ?? []), r]);
  const rows: AgreementRow[] = [];
  const states = new Map<ScenarioId, SimState>();
  for (const step of steps) {
    const intended = byStep.get(step.stepId) ?? [];
    const scenarioId = step.kind === "submit" && step.scenarioId !== undefined ? step.scenarioId : (intended[0]?.scenarioId ?? f.scenarioId);
    let state = states.get(scenarioId);
    if (state === undefined || (step.kind === "vault-call" && step.args["freshInstance"] === true) || (step.kind === "submit" && step.freshInstance === true)) {
      state = stateFor(scenarioId);
      states.set(scenarioId, state);
    }
    let now = state.baseNow;
    if (step.kind === "submit") now = applyPatch(state, step.context).now;
    if (step.kind === "vault-call") applyVaultArgs(state, step.args);
    for (const spec of intended) {
      const slug = spec.milestoneSlug ?? (step.kind === "vault-call" && typeof step.args["milestone"] === "string" && step.args["engagement"] !== "UNREGISTERED" ? step.args["milestone"] : null);
      const release = intendedToOracleRelease(f.attackId, { ...spec, milestoneSlug: slug }, step);
      const reported = judgeRelease(toOracleInstance(state), release).predicates;
      rows.push({
        attackId: f.attackId,
        stepId: spec.stepId,
        intended: spec.predicates,
        reported,
        missing: spec.predicates.filter((p) => !reported.includes(p)),
        extra: reported.filter((p) => !spec.predicates.includes(p)),
      });
      if (loss.mode === "cumulative") recordRelease(state, { ...release, stepId: spec.stepId, runLabel: "intended", milestoneSlug: slug, invoiceNumber: null });
    }
    if (intended.length === 0 && step.kind === "submit") {
      const honest = honestReleaseOf(step, state, now);
      if (honest !== null) recordRelease(state, honest);
    }
  }
  const covered = new Set(rows.map((r) => r.stepId));
  for (const r of loss.releases) {
    if (!covered.has(r.stepId)) rows.push({ attackId: f.attackId, stepId: r.stepId, intended: r.predicates, reported: [], missing: [...r.predicates], extra: [] });
  }
  if (loss.mode === "cumulative") {
    // docs: every listed predicate must be reported on AT LEAST ONE release of the sequence
    const intended = [...new Set(rows.flatMap((r) => r.intended))].sort();
    const reported = [...new Set(rows.flatMap((r) => r.reported))].sort();
    return [
      {
        attackId: f.attackId,
        stepId: `${f.attackId}/*`,
        intended: intended as OraclePredicate[],
        reported: reported as OraclePredicate[],
        missing: intended.filter((p) => !reported.includes(p)) as OraclePredicate[],
        extra: reported.filter((p) => !intended.includes(p)) as OraclePredicate[],
      },
    ];
  }
  return rows;
}
