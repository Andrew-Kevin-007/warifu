// Build the attack matrix (docs/07 §5): 24 attacks x targets, scored by the oracle, with n, k and a 95 % upper
// bound, the honest-corpus numbers, the oracle/fixture agreement and the provenance. Pure and deterministic:
// the same fixtures and code give the same matrix (the git SHA is passed in, never read here).
import { sha256Utf8 } from "@symbolon/schemas";
import { buildApplicability } from "../applicability";
import type { ApplicabilityRow } from "../applicability";
import { buildFixtureFiles, GENERATOR_VERSION } from "../files";
import { buildHonest } from "../honest";
import { BASE_SEED, buildAllAttacks } from "../registry";
import { summarizeRate, wilson } from "../stats";
import type { RateSummary } from "../stats";
import { TARGET_IDS } from "../types";
import type { AttackFixture, TargetId } from "../types";
import "./b0-prepared"; // runs the vendored arc-escrow route once per fixture read (top-level await)
import { b0Target } from "./b0";
import { b1Target, REFERENCE_VALIDATOR_RULES } from "./b1";
import { b2Target, B2_CONTROLS } from "./b2";
import { agreement } from "./oracle-agreement";
import type { AgreementRow } from "./oracle-agreement";
import { runAttack, runHonestItem } from "./run";
import type { AttackResult, HonestItemResult } from "./results";
import { makeSymbolonUnitTarget } from "./symbolon-unit";
import type { Target } from "./target";

export const HARNESS_VERSION = "attack-harness/1" as const;

/** vendor/arc-escrow/COMMIT (a test keeps this equal to the file). */
export const B0_REVISION = "d5006bc44518db7ee85ad9bc645646c04bf4c090";

export interface TargetSummary {
  readonly id: TargetId;
  readonly label: string;
  readonly status: "run" | "not-built";
  readonly provenance: string;
  readonly unimplementedChecks: readonly string[];
  readonly releasePathAvailable: boolean | null;
}

export interface ClassTotals {
  readonly applicable: number;
  readonly loss: number;
  readonly blocked: number;
  readonly escalated: number;
  readonly held: number;
  readonly noop: number;
  readonly notRun: number;
}

export interface TargetTotals {
  readonly target: TargetId;
  readonly attacks: number;
  readonly applicable: number;
  readonly notApplicable: number;
  readonly oracleScored: ClassTotals;
  readonly signalScored: ClassTotals;
  /** Loss trials: one per extraction run of a submit step. Trials of one fixture are NOT independent. */
  readonly trials: number;
  readonly lossTrials: number;
  readonly lossRate: RateSummary | null;
  readonly lossBaseUnits: string;
  readonly completeAttacks: number;
  readonly controls: { readonly pass: number; readonly overblocked: number; readonly loss: number; readonly notRun: number };
  readonly expectations: { readonly match: number; readonly mismatch: number; readonly inconclusive: number };
}

export interface HonestSummary {
  readonly target: TargetId;
  readonly n: number;
  readonly released: number;
  readonly releasedCorrect: number;
  readonly releasedLoss: number;
  readonly rejected: number;
  readonly escalated: number;
  readonly held: number;
  readonly heldByUnimplementedChecks: number;
  readonly wrongfulReject: { readonly k: number; readonly n: number; readonly wilsonLower: number; readonly wilsonUpper: number };
  readonly items: readonly HonestItemResult[];
}

export interface AttackMatrix {
  readonly schema: "attack-matrix/1";
  readonly mode: "unit";
  readonly harness: typeof HARNESS_VERSION;
  readonly oracleVersion: "oracle-v1";
  readonly provenance: {
    readonly gitSha: string | null;
    readonly seed: string;
    readonly fixtureGenerator: string;
    readonly fixtureManifestSha256: string;
    readonly models: string;
    readonly recordedOutputs: false;
    readonly anvilForkBlock: null;
    readonly b1ValidatorRules: readonly string[];
    readonly b2Controls: readonly string[];
    /** The pinned upstream revision of the vendored B0 path (vendor/arc-escrow/COMMIT). */
    readonly b0Revision: string;
  };
  readonly targets: readonly TargetSummary[];
  readonly applicability: readonly ApplicabilityRow[];
  readonly attacks: readonly AttackResult[];
  readonly totals: readonly TargetTotals[];
  readonly honest: readonly HonestSummary[];
  readonly agreement: {
    readonly rows: number;
    readonly disagreements: number;
    readonly details: readonly AgreementRow[];
    readonly extrasInformational: number;
  };
  readonly holdout: { readonly status: "not-run"; readonly reason: string };
  readonly limitations: readonly string[];
}

const emptyClass = (): { applicable: number; loss: number; blocked: number; escalated: number; held: number; noop: number; notRun: number } => ({
  applicable: 0, loss: 0, blocked: 0, escalated: 0, held: 0, noop: 0, notRun: 0,
});

function totalsFor(target: TargetId, results: readonly AttackResult[]): TargetTotals {
  const mine = results.filter((r) => r.target === target);
  const o = emptyClass();
  const s = emptyClass();
  let trials = 0;
  let lossTrials = 0;
  let money = 0n;
  let complete = 0;
  const controls = { pass: 0, overblocked: 0, loss: 0, notRun: 0 };
  const expectations = { match: 0, mismatch: 0, inconclusive: 0 };
  for (const r of mine) {
    if (r.outcome === "N/A") continue;
    const cls = r.scoring === "oracle" ? o : s;
    cls.applicable += 1;
    switch (r.outcome) {
      case "LOSS": cls.loss += 1; break;
      case "BLOCKED": cls.blocked += 1; break;
      case "ESCALATED": cls.escalated += 1; break;
      case "HELD": cls.held += 1; break;
      case "NOOP": cls.noop += 1; break;
      case "NOT_RUN": cls.notRun += 1; break;
      default: break;
    }
    trials += r.trials;
    lossTrials += r.steps.reduce((n, st) => n + st.runs.filter((x) => x.release?.oracle.result === "LOSS").length, 0);
    money += BigInt(r.lossBaseUnits);
    if (r.complete) complete += 1;
    if (r.control.status === "PASS") controls.pass += 1;
    else if (r.control.status === "OVERBLOCKED") controls.overblocked += 1;
    else if (r.control.status === "LOSS") controls.loss += 1;
    else controls.notRun += 1;
    expectations.match += r.expectations.match;
    expectations.mismatch += r.expectations.mismatch;
    expectations.inconclusive += r.expectations.inconclusive;
  }
  return {
    target,
    attacks: mine.length,
    applicable: o.applicable + s.applicable,
    notApplicable: mine.filter((r) => r.outcome === "N/A").length,
    oracleScored: o,
    signalScored: s,
    trials,
    lossTrials,
    lossRate: summarizeRate(lossTrials, trials),
    lossBaseUnits: money.toString(),
    completeAttacks: complete,
    controls,
    expectations,
  };
}

function honestSummary(target: Target): HonestSummary {
  const fixtures = buildHonest(BASE_SEED);
  const items = fixtures.map((h) => runHonestItem({ id: h.id, group: h.group, scenarioId: h.scenarioId, step: h.step, correctAmount: h.correctRelease.amountBaseUnits }, target));
  const released = items.filter((i) => i.released);
  const rejected = items.filter((i) => i.action === "REJECT").length;
  const w = wilson(rejected, items.length);
  return {
    target: target.id,
    n: items.length,
    released: released.length,
    releasedCorrect: released.filter((i) => i.oracle === "NO_LOSS" && i.amountMatches === true).length,
    releasedLoss: released.filter((i) => i.oracle === "LOSS" || i.amountMatches === false).length,
    rejected,
    escalated: items.filter((i) => i.action === "ESCALATE").length,
    held: items.filter((i) => i.action === "HOLD").length,
    heldByUnimplementedChecks: items.filter((i) => i.heldByUnimplementedChecks).length,
    wrongfulReject: { k: rejected, n: items.length, wilsonLower: w.lower, wilsonUpper: w.upper },
    items,
  };
}

function limitationsFor(unimplemented: readonly string[]): string[] {
  const l: string[] = [];
  if (unimplemented.length > 0) {
    l.push(
      `The Symbolon target runs the kernel-core build as merged: ${unimplemented.join(", ")} are fail-closed placeholders . Every intent ends HOLD, REJECT, ESCALATE or REPLAY; none can be released, so a count of 0 losses is not evidence about the missing checks.`,
    );
  }
  l.push("Engagements are the fixture templates activated with placeholder signatures and a placeholder registration (SIMULATED); no key signed anything and nothing was registered on a vault.");
  l.push("Extraction reads are the fixture generator's REFERENCE reads, not model outputs; no model was called. B1's validator is a deterministic stand-in for an LLM validator (SIMULATED). Nothing in this report is labelled RECORDED because nothing was recorded.");
  l.push("ATK-01, ATK-09, ATK-19, ATK-23 and ATK-24 have no oracle-expressible loss (docs/QUESTIONS WP-22 item 2). Their results are signal-scored or NOT_RUN and are counted separately from oracle-scored attacks.");
  l.push("ATK-17 (contract calls) and the fault steps (reconciler, K-15) need e2e-local; the Symbolon target reports them NOT_RUN with the reason. ATK-22 (digest), ATK-23 (WYSIWYS comparator) and ATK-24 (explainer) run against kernel-core and packages/receipts; whether the web screen really disables Sign is WP-19/SEC-13, not measured here.");
  l.push("Trials are extraction runs of the committed fixtures. Runs of one fixture share a payee, an amount and a document and are not independent, so the upper bounds are optimistic; the hold-out set (WP-36) is the independent evidence.");
  l.push("Decisions accumulate across the steps of a fixture (docs/QUESTIONS WP-22 item 9). K-04 therefore sees earlier steps of the same fixture as near-duplicates, replays or as a milestone already paid (and K-04 rejects a later instalment of a partialAllowed milestone); the later checks the attack was designed for are then not exercised in that run. See docs/QUESTIONS WP-23 (re-baseline).");
  l.push("B0 is the vendored validate-work route of circlefin/arc-escrow EXECUTED with its network edges stubbed (vendor/arc-escrow/VENDOR.md); its model call is a deterministic SIMULATED validator, and arc-escrow validates an image deliverable against agreement tasks, not an invoice, so our documents are mapped onto its job/deliverable API (applicability.json carries the mapping and a reason per row). Where B0 holds by design (payee and amount are fixed at agreement creation) it is reported as measured, not dropped.");
  l.push("B2 is our own 'reasonable hardening' (schema check, allowlist, per-tx and daily caps, exact duplicate-number check) on the B1 pattern; it is not Circle's code and not the only reasonable choice. It is published in src/harness/b2.ts so others can improve it.");
  l.push("B1 pays the face amount of the document and has no terms logic, so it overpays the early-pay discount on honest invoices; that is part of the pattern, and it is reported, not hidden.");
  l.push("Every scenario instance is prefunded with the same 1,000,000 USDC; a transfer above the remaining balance reverts and moves no money, so losses are bounded by it.");
  return l;
}

export function buildMatrix(opts: { gitSha: string | null }): AttackMatrix {
  const fixtures: AttackFixture[] = buildAllAttacks(BASE_SEED);
  const rows = buildApplicability().rows;
  const symbolon = makeSymbolonUnitTarget();
  const runs: Array<{ target: Target; id: TargetId }> = [
    { target: symbolon, id: "symbolon" },
    { target: b0Target, id: "b0" },
    { target: b1Target, id: "b1" },
    { target: b2Target, id: "b2" },
  ];
  const attacks: AttackResult[] = [];
  for (const { target, id } of runs) {
    for (const f of fixtures) {
      const row = rows.find((r) => r.attackId === f.attackId && r.target === id);
      if (row === undefined) throw new RangeError(`applicability.json has no row for ${f.attackId} x ${id}`);
      attacks.push(runAttack(f, target, row));
    }
  }
  const honest = runs.map(({ target }) => honestSummary(target));
  const manifest = buildFixtureFiles().get("MANIFEST.json");
  if (manifest === undefined) throw new RangeError("fixture manifest missing");
  const agreeRows = fixtures.flatMap((f) => agreement(f));
  const unimplemented = symbolon.observedUnimplemented();
  const targets: TargetSummary[] = TARGET_IDS.map((id): TargetSummary => {
    if (id === "symbolon") {
      return { id, label: symbolon.label, status: "run", provenance: symbolon.provenance, unimplementedChecks: unimplemented, releasePathAvailable: unimplemented.length === 0 };
    }
    const t = id === "b0" ? b0Target : id === "b1" ? b1Target : b2Target;
    return { id, label: t.label, status: "run", provenance: t.provenance, unimplementedChecks: [], releasePathAvailable: true };
  });
  return {
    schema: "attack-matrix/1",
    mode: "unit",
    harness: HARNESS_VERSION,
    oracleVersion: "oracle-v1",
    provenance: {
      gitSha: opts.gitSha,
      seed: BASE_SEED,
      fixtureGenerator: GENERATOR_VERSION,
      fixtureManifestSha256: sha256Utf8(manifest),
      models: "none: no model was called (reference extraction reads; the B0/B1/B2 validator is a deterministic SIMULATED stand-in)",
      recordedOutputs: false,
      anvilForkBlock: null,
      b1ValidatorRules: REFERENCE_VALIDATOR_RULES,
      b2Controls: B2_CONTROLS,
      b0Revision: B0_REVISION,
    },
    targets,
    applicability: rows,
    attacks,
    totals: runs.map(({ id }) => totalsFor(id, attacks)),
    honest,
    agreement: {
      rows: agreeRows.length,
      disagreements: agreeRows.filter((r) => r.missing.length > 0).length,
      details: agreeRows.filter((r) => r.missing.length > 0),
      extrasInformational: agreeRows.filter((r) => r.extra.length > 0).length,
    },
    holdout: {
      status: "not-run",
      reason: "the hold-out set is written by ATTACK-ADV outside this repository and run in WP-36 (H1 at G3, H2 at G5); this harness never reads it",
    },
    limitations: limitationsFor(unimplemented),
  };
}

