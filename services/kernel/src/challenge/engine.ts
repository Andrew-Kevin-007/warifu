// The challenge engine (docs/15 sections 1-2): runs ONE attempt against a FRESH scenario instance and reports what the real
// kernel pipeline decided and what the independent oracle says about any release. It is the in-process "unit mode" target of
// the attack suite (`makeSymbolonUnitTarget`: the real kernel-core `evaluate()`; fixture engagements with placeholder
// signatures; sandbox evidence injected as `fixture:<id>`), so a visitor's attempt is judged by exactly the code the attack
// matrix measures. It never calls the vault, a model or the network: callers add those around it (extraction is the caller's job).
//
//   one-click   a fixture of ATK-01..24 as built by the suite (deterministic, cached by the service)
//   benign      one of the six benign controls (honest invoices that SHOULD pay)
//   freeform    a visitor's plain-text document, already READ by the extractor into the two extractions the kernel compares
//
// Everything that can leave this module is a typed, document-free view: codes, counts, amounts, hashes. The attacker's text is
// never echoed back here; the service stores an excerpt and a hash and the web tier shows it only through <UntrustedText>.
import {
  ATTACK_IDS,
  ATTACK_META,
  BENIGN_CONTROL_IDS,
  CLOCK_START,
  WORLD,
  buildApplicability,
  buildAttack,
  buildHonest,
  freshState,
  makeSymbolonUnitTarget,
  runAttack,
  runHonestItem,
  runSubmit,
  worldMilestone,
} from "@symbolon/attack-suite";
import type { AttackId, AttackResult, ExtractionRun, Holder, HonestFixture, ScenarioId, SubmitStep, UnitObservation } from "@symbolon/attack-suite";
import { untrusted } from "@symbolon/schemas";
import type { ExtractedInvoice } from "@symbolon/schemas";

export const ENGINE_VERSION = "challenge-engine/1" as const;
export const SCENARIO_IDS: readonly ScenarioId[] = ["S-A", "S-B", "S-C"];
export const VERDICTS = ["RELEASE", "HOLD", "ESCALATE", "REJECT", "REPLAY", "NOOP"] as const;
export type EngineAction = (typeof VERDICTS)[number];

export interface ReleaseView {
  readonly amountBaseUnits: string;
  readonly payee: string;
  readonly oracle: { readonly result: "LOSS" | "NO_LOSS"; readonly predicates: readonly string[] };
  readonly lossBaseUnits: string;
}

export interface RunView {
  readonly label: string;
  readonly action: string;
  readonly checksFired: readonly string[];
  readonly reasons: readonly string[];
  readonly release: ReleaseView | null;
}

export interface EngineResult {
  readonly engine: typeof ENGINE_VERSION;
  readonly mode: "UNIT";
  readonly kind: "oneclick" | "benign" | "freeform";
  readonly attackId: AttackId | null;
  readonly benignId: string | null;
  readonly scenarioId: ScenarioId;
  /** The most severe action across the runs: RELEASE > ESCALATE > HOLD > REJECT is NOT the order; see `headline`. */
  readonly action: string;
  readonly checksFired: readonly string[];
  readonly reasons: readonly string[];
  readonly releases: number;
  readonly lossReleases: number;
  readonly lossBaseUnits: string;
  readonly predicates: readonly string[];
  /** LOSS iff the oracle judged any release a loss (or, for signal-scored attacks, a stated criterion failed). */
  readonly oracleResult: "NO_LOSS" | "LOSS";
  /** One-click only: the suite's own outcome class (BLOCKED, ESCALATED, HELD, LOSS, NOT_RUN, N/A, NOOP). */
  readonly outcome: string | null;
  /** Benign only: the correct release amount matched / the benign control was over-blocked. */
  readonly benign: { readonly released: boolean; readonly amountMatches: boolean | null } | null;
  readonly runs: readonly RunView[];
  /** Plain reasons the attempt could not run fully (a NOT_RUN step: vault, reconciler); never counted as blocked or as a loss. */
  readonly notRun: readonly string[];
  readonly steps: number;
}

const SEVERITY: Readonly<Record<string, number>> = { RELEASE: 5, ESCALATE: 4, HOLD: 3, REPLAY: 2, REJECT: 1, NOOP: 0 };
const worst = (actions: readonly string[]): string => [...actions].sort((a, b) => (SEVERITY[b] ?? -1) - (SEVERITY[a] ?? -1))[0] ?? "NOOP";
const uniq = (xs: readonly string[]): string[] => [...new Set(xs)];

let applicabilityRows: ReturnType<typeof buildApplicability>["rows"] | null = null;
function applicabilityFor(attackId: AttackId): { applicable: boolean | null; reason: string } {
  applicabilityRows ??= buildApplicability().rows;
  const row = applicabilityRows.find((r) => r.attackId === attackId && r.target === "symbolon");
  return row === undefined ? { applicable: null, reason: "no applicability row" } : { applicable: row.applicable, reason: row.reason };
}

function viewOfRun(r: AttackResult["steps"][number]["runs"][number]): RunView {
  return {
    label: r.label,
    action: r.action,
    checksFired: [...r.checksFired],
    reasons: [...r.reasons],
    release:
      r.release === null
        ? null
        : { amountBaseUnits: r.release.amountBaseUnits, payee: r.release.payee, oracle: { result: r.release.oracle.result, predicates: [...r.release.oracle.predicates] }, lossBaseUnits: r.release.lossBaseUnits },
  };
}

export interface OneClickInfo {
  readonly attackId: AttackId;
  readonly title: string;
  readonly caption: string;
  readonly errorClass: string;
  readonly kind: string;
  readonly scenarioId: ScenarioId;
  /** false: this attack has no document-level run in unit mode (process / contract / approval faults); it is listed with its reason. */
  readonly runnable: boolean;
  readonly note: string;
}

/** The 24 one-click buttons: caption and title come from the suite's metadata (hypotheses, never results). */
export function oneClickCatalog(): readonly OneClickInfo[] {
  return ATTACK_IDS.map((id) => {
    const m = ATTACK_META[id];
    const f = buildAttack(id);
    const app = applicabilityFor(id);
    const hasSubmit = f.steps.some((s) => s.kind === "submit" || s.kind === "flood" || s.kind === "approval-render");
    const runnable = app.applicable === true && hasSubmit;
    const note = runnable ? "" : app.applicable === true ? "needs the deployed sandbox vault or reconciler (a process or contract step); not run in unit mode" : app.reason;
    return { attackId: id, title: m.title, caption: m.caption, errorClass: m.errorClass, kind: m.kind, scenarioId: f.scenarioId, runnable, note };
  });
}

/** Called once per extraction run with what the kernel saw and decided (the service builds and signs a receipt from it). */
export type Observe = (o: UnitObservation) => void;

export function runOneClick(attackId: AttackId, observe?: Observe): EngineResult {
  const fixture = buildAttack(attackId);
  const target = makeSymbolonUnitTarget(observe);
  const result = runAttack(fixture, target, applicabilityFor(attackId));
  const runs = result.steps.flatMap((s) => s.runs.map(viewOfRun));
  const notRun = result.steps.filter((s) => s.status === "NOT_RUN").map((s) => `${s.stepId}: ${s.reason}`);
  const failedCriteria = result.criteria.failed;
  return {
    engine: ENGINE_VERSION,
    mode: "UNIT",
    kind: "oneclick",
    attackId,
    benignId: null,
    scenarioId: fixture.scenarioId,
    // A fixture reads one document several ways (a faithful read, a fooled read, a legitimate look-alike). The headline is the
    // FIRST run, the primary reading; every run is listed, and `outcome` is the suite's own verdict over all of them.
    action: runs[0]?.action ?? "NOOP",
    checksFired: [...result.checksFired],
    reasons: uniq(runs.flatMap((r) => r.reasons)),
    releases: result.oracle?.releases ?? 0,
    lossReleases: result.oracle?.lossReleases ?? 0,
    lossBaseUnits: result.lossBaseUnits,
    predicates: result.oracle === null ? [] : [...result.oracle.predicates],
    oracleResult: result.outcome === "LOSS" || failedCriteria > 0 ? "LOSS" : "NO_LOSS",
    outcome: result.outcome,
    benign: null,
    runs,
    notRun,
    steps: result.steps.length,
  };
}

export interface BenignInfo {
  readonly id: string;
  readonly caption: string;
  readonly scenarioId: ScenarioId;
}

const benignFixtures = (): HonestFixture[] => buildHonest().filter((h) => BENIGN_CONTROL_IDS.includes(h.id));

export function benignCatalog(): readonly BenignInfo[] {
  return benignFixtures().map((h) => ({ id: h.id, caption: h.caption, scenarioId: h.scenarioId }));
}

export function runBenign(id: string, observe?: Observe): EngineResult | null {
  const h = benignFixtures().find((x) => x.id === id);
  if (h === undefined) return null;
  const target = makeSymbolonUnitTarget(observe);
  const item = runHonestItem({ id: h.id, group: h.group, scenarioId: h.scenarioId, step: h.step, correctAmount: h.correctRelease.amountBaseUnits }, target);
  const lossy = item.oracle === "LOSS" || item.amountMatches === false;
  return {
    engine: ENGINE_VERSION,
    mode: "UNIT",
    kind: "benign",
    attackId: null,
    benignId: id,
    scenarioId: h.scenarioId,
    action: item.action,
    checksFired: [],
    reasons: [],
    releases: item.released ? 1 : 0,
    lossReleases: lossy ? 1 : 0,
    lossBaseUnits: "0",
    predicates: [],
    oracleResult: lossy ? "LOSS" : "NO_LOSS",
    outcome: null,
    benign: { released: item.released, amountMatches: item.amountMatches },
    runs: [{ label: id, action: item.action, checksFired: [], reasons: [], release: null }],
    notRun: [],
    steps: 1,
  };
}

export interface FreeFormInput {
  readonly scenarioId: ScenarioId;
  /** A milestone slug of the scenario (the visitor picks from the fixture's list; they never supply engagement, payee, cap or evidence). */
  readonly milestoneSlug: string;
  /** The visitor's document, plain text, already length/charset-checked by the service. */
  readonly text: string;
  /** The extractor's two readings of `text` (a model output the kernel re-derives from and never trusts, INV-8). */
  readonly a: ExtractedInvoice;
  readonly b: ExtractedInvoice | null;
}

const ANY_VERDICT = ["RELEASE", "HOLD", "ESCALATE", "REJECT", "REPLAY"] as const;

export function scenarioMilestones(scenarioId: ScenarioId): readonly { slug: string; description: string; amountBaseUnits: string }[] {
  return WORLD[scenarioId].milestones.map((m) => ({ slug: m.slug, description: m.description, amountBaseUnits: m.amount.toString() }));
}

export function runFreeForm(input: FreeFormInput, observe?: Observe): EngineResult | null {
  const world = WORLD[input.scenarioId];
  if (!world.milestones.some((m) => m.slug === input.milestoneSlug)) return null;
  worldMilestone(world, input.milestoneSlug); // throws on an unknown slug: the guard above makes that unreachable
  const run: ExtractionRun = { label: "visitor-document", a: input.a, b: input.b, agentRecommendation: null, expect: { verdictIn: [...ANY_VERDICT] } };
  const step: SubmitStep = {
    kind: "submit",
    stepId: "freeform",
    milestoneSlug: input.milestoneSlug,
    doc: { docLabel: "visitor-document", origin: "freeform", mime: "text/plain", text: untrusted(input.text), receivedAt: CLOCK_START },
    context: {},
    runs: [run],
    freshInstance: true,
  };
  const holder: Holder = { states: new Map([[input.scenarioId, freshState(input.scenarioId)]]) };
  const out = runSubmit(holder, input.scenarioId, step, makeSymbolonUnitTarget(observe), "FREEFORM");
  const runs = out.record.runs.map(viewOfRun);
  return {
    engine: ENGINE_VERSION,
    mode: "UNIT",
    kind: "freeform",
    attackId: null,
    benignId: null,
    scenarioId: input.scenarioId,
    action: worst(runs.map((r) => r.action)),
    checksFired: uniq(runs.flatMap((r) => r.checksFired)),
    reasons: uniq(runs.flatMap((r) => r.reasons)),
    releases: out.releases,
    lossReleases: out.lossReleases,
    lossBaseUnits: out.lossMoney.toString(),
    predicates: [...out.predicates],
    oracleResult: out.lossReleases > 0 ? "LOSS" : "NO_LOSS",
    outcome: null,
    benign: null,
    runs,
    notRun: [],
    steps: 1,
  };
}
