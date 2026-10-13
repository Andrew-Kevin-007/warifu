// Scenario-instance state for the harness (docs/15 §2: "every attempt runs on a fresh scenario instance").
// A SimState is what the world looks like to a target at the moment it decides: the scenario clock, milestone
// statuses, the releases already made, the evidence the kernel would have collected, and the symbolic facts a
// fixture's ContextPatch can set (docs/QUESTIONS WP-22 item 9: a patch is applied ONCE, before its step; what it
// creates persists for the later steps of the same fixture in the same instance).
//
// Semantics fixed here (and logged in docs/QUESTIONS.md "WP-23"):
//   - `now`: a step-local override of the scenario clock; it does not persist to the next step.
//   - `engagement: "none"`: step-local.
//   - milestoneStatus, priorReleases, evidencePlan, categoryMonthSpent, screening, payeeChangePending,
//     escalationsToday, breakerHalted: persist until another patch changes them.
//   - several extraction runs of one step are ALTERNATIVE reads of the same document: each is evaluated on its
//     own copy of the pre-step state; the state after the step is the copy of the first run that released money,
//     or of the first run when none did.
import type { Address, EvidenceFixture, Hex32, ISODateTime, Milestone } from "@symbolon/schemas";

type MilestoneStatus = Milestone["status"];
import type { OracleInstance, OracleLimits, OracleRelease } from "@symbolon/oracle";
import { milestoneId, evidenceFixturesFor, CLOCK_START, WORLD } from "../world";
import type { WorldScenario } from "../world";
import type { ContextPatch, EvidencePlan, ScenarioId } from "../types";
import { POLICY_OVERRIDES, usdc } from "../world";

/** Monthly category budgets of the sandbox policy (docs/04 §7 defaults: design 150, dev 300, tools 100). */
export const SANDBOX_CATEGORY_BUDGETS: Readonly<Record<string, bigint>> = Object.freeze({ design: usdc(150), dev: usdc(300), tools: usdc(100) });

/** The prefunded escrow/vault balance of every scenario instance: 1,000,000 USDC (docs/07 §3.2 "prefunded vaults"). A transfer above the remaining balance reverts. */
export const FUNDING_BASE_UNITS = usdc(1_000_000);

export function remainingFunding(state: SimState): bigint {
  return FUNDING_BASE_UNITS - state.releases.reduce((s, r) => s + r.amount, 0n);
}

/** "25.000000" -> 25_000_000n (6 decimals; the scenarios' policy strings are always this shape). */
export function decimalToBaseUnits(s: string): bigint {
  const m = /^(\d+)(?:\.(\d{1,6}))?$/.exec(s);
  if (m === null) throw new RangeError(`not a USDC decimal string: ${s}`);
  return BigInt(m[1] as string) * 1_000_000n + BigInt((m[2] ?? "").padEnd(6, "0") || "0");
}

export function limitsFor(): OracleLimits {
  const caps = POLICY_OVERRIDES.caps;
  const vel = POLICY_OVERRIDES.velocity;
  if (caps?.perTxHardCap === undefined || caps.dailyCap === undefined || caps.weeklyCap === undefined || caps.humanApprovalAbove === undefined) {
    throw new RangeError("scenario policy overrides lack caps");
  }
  if (vel?.maxReleasesPerDay === undefined || vel.maxReleasesPerPayeePerDay === undefined || vel.maxAmountPerPayeePerDay === undefined) {
    throw new RangeError("scenario policy overrides lack velocity limits");
  }
  return {
    perTxCap: decimalToBaseUnits(caps.perTxHardCap),
    dailyCap: decimalToBaseUnits(caps.dailyCap),
    weeklyCap: decimalToBaseUnits(caps.weeklyCap),
    humanApprovalAbove: decimalToBaseUnits(caps.humanApprovalAbove),
    maxReleasesPerDay: vel.maxReleasesPerDay,
    maxReleasesPerPayeePerDay: vel.maxReleasesPerPayeePerDay,
    maxAmountPerPayeePerDay: decimalToBaseUnits(vel.maxAmountPerPayeePerDay),
    categoryBudgets: SANDBOX_CATEGORY_BUDGETS,
  };
}

/** An oracle release plus the bookkeeping the harness needs (not seen by the oracle). */
export interface SimRelease extends OracleRelease {
  readonly stepId: string;
  readonly runLabel: string;
  readonly milestoneSlug: string | null;
  readonly invoiceNumber: string | null;
}

export type Screening = "CLEAR" | "HIT" | "UNKNOWN";

export interface SimState {
  readonly world: WorldScenario;
  readonly limits: OracleLimits;
  readonly baseNow: ISODateTime;
  readonly milestoneStatus: Map<string, MilestoneStatus>;
  releases: SimRelease[];
  readonly categoryBaseline: Map<string, bigint>;
  evidencePlan: EvidencePlan;
  screening: Screening | null;
  payeeChangePending: boolean;
  escalationsToday: number;
  breakerHalted: boolean;
  vaultPaused: boolean;
  /** Free space for a target to remember things between steps (cloned with the state). */
  memory: Record<string, unknown>;
}

export function freshState(scenarioId: ScenarioId): SimState {
  const world = WORLD[scenarioId];
  return {
    world,
    limits: limitsFor(),
    baseNow: CLOCK_START,
    milestoneStatus: new Map(world.template.milestones.map((m) => [m.slug, m.status])),
    releases: [],
    categoryBaseline: new Map(),
    evidencePlan: "all-pass",
    screening: null,
    payeeChangePending: false,
    escalationsToday: 0,
    breakerHalted: false,
    vaultPaused: false,
    memory: {},
  };
}

export function cloneState(s: SimState): SimState {
  return {
    world: s.world,
    limits: s.limits,
    baseNow: s.baseNow,
    milestoneStatus: new Map(s.milestoneStatus),
    releases: [...s.releases],
    categoryBaseline: new Map(s.categoryBaseline),
    evidencePlan: s.evidencePlan,
    screening: s.screening,
    payeeChangePending: s.payeeChangePending,
    escalationsToday: s.escalationsToday,
    breakerHalted: s.breakerHalted,
    vaultPaused: s.vaultPaused,
    memory: structuredClone(s.memory),
  };
}

/** What a step sees on top of the persistent state. */
export interface StepView {
  readonly now: ISODateTime;
  readonly noEngagement: boolean;
}

/** Apply a fixture context patch (docs/QUESTIONS WP-22 item 9) and return the step-local view. */
export function applyPatch(state: SimState, patch: ContextPatch): StepView {
  if (patch.milestoneStatus !== undefined) {
    for (const [slug, status] of Object.entries(patch.milestoneStatus)) state.milestoneStatus.set(slug, status);
  }
  if (patch.priorReleases !== undefined) {
    for (const p of patch.priorReleases) {
      state.releases.push({
        milestoneId: milestoneId(state.world, p.milestoneSlug),
        payee: p.payee,
        amount: BigInt(p.amountBaseUnits),
        time: p.at,
        invoiceReceivedAt: p.at,
        termsBasis: "signed",
        clockAnchor: null,
        ownerApproved: true,
        stepId: "prior",
        runLabel: "prior",
        milestoneSlug: p.milestoneSlug,
        invoiceNumber: p.invoiceNumber,
      });
    }
  }
  if (patch.evidencePlan !== undefined) state.evidencePlan = patch.evidencePlan;
  if (patch.categoryMonthSpent !== undefined) {
    for (const [cat, v] of Object.entries(patch.categoryMonthSpent)) state.categoryBaseline.set(cat, BigInt(v));
  }
  if (patch.screening !== undefined) state.screening = patch.screening;
  if (patch.payeeChangePending !== undefined) state.payeeChangePending = patch.payeeChangePending;
  if (patch.escalationsToday !== undefined) state.escalationsToday = patch.escalationsToday;
  if (patch.breakerHalted !== undefined) state.breakerHalted = patch.breakerHalted;
  return { now: patch.now ?? state.baseNow, noEngagement: patch.engagement === "none" };
}

export function evidenceVisible(state: SimState): EvidenceFixture[] {
  return evidenceFixturesFor(state.world, state.evidencePlan);
}

/** The oracle's view of the instance (docs/15 §2). */
export function toOracleInstance(state: SimState): OracleInstance {
  const paid: Hex32[] = [];
  for (const [slug, status] of state.milestoneStatus) if (status === "PAID") paid.push(milestoneId(state.world, slug));
  return {
    scenario: state.world.template,
    limits: state.limits,
    releases: state.releases.map((r) => ({ milestoneId: r.milestoneId, payee: r.payee, amount: r.amount, time: r.time })),
    milestonePaid: paid,
    categorySpentBaseline: Object.fromEntries(state.categoryBaseline),
    evidence: evidenceVisible(state),
    breakerHalted: state.breakerHalted,
    vaultPaused: state.vaultPaused,
  };
}

/** Record a release in the state; a non-partial (or fully covered) milestone becomes PAID. */
export function recordRelease(state: SimState, release: SimRelease): void {
  state.releases.push(release);
  if (release.milestoneSlug === null) return;
  const ms = state.world.template.milestones.find((m) => m.slug === release.milestoneSlug);
  if (ms === undefined) return;
  const paidTotal = state.releases.reduce((s, r) => (r.milestoneSlug === release.milestoneSlug ? s + r.amount : s), 0n);
  if (!ms.partialAllowed || paidTotal >= BigInt(ms.amountBaseUnits)) state.milestoneStatus.set(release.milestoneSlug, "PAID");
}

export function addressEq(a: Address, b: Address): boolean {
  return a.toLowerCase() === b.toLowerCase();
}
