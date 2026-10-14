// Typed loader for the committed RECORDED data: results/*.json and replay-data/bundle.json (DEC-016). Server-only.
// Numbers shown on public pages are derived from these files; nothing is typed by hand (INV-18).
// Static JSON imports: resolved at build time, so the deployment carries the data and no runtime file tracing is needed.
import bundleJson from "../../../../replay-data/bundle.json";
import attackMetaJson from "../../../../replay-data/attack-meta.json";
import attackMatrixJson from "../../../../results/attack-matrix.json";
import honestJson from "../../../../results/honest-corpus.json";
import blastJson from "../../../../packages/blast-radius/results/blast-closed-form.json";

export interface TargetTotals {
  target: string;
  attacks: number;
  applicable: number;
  notApplicable: number;
  trials: number;
  lossTrials: number;
  lossBaseUnits: string;
  lossRate: { n: number; k: number; rate: number; upper95: number; upper95Method: string };
  oracleScored: { applicable: number; loss: number; blocked: number; escalated: number; held: number; noop: number; notRun: number };
  signalScored: { applicable: number; loss: number; blocked: number; escalated: number; held: number; noop: number; notRun: number };
  controls: { pass: number; overblocked: number; loss: number; notRun: number };
}

export interface AttackRow {
  attackId: string;
  target: string;
  outcome: string;
  scoring: string;
  lossBaseUnits: string;
  checksFired: string[];
  trials: number;
  complete: boolean;
  criteria: unknown;
  notes: string[];
}

export interface AttackMatrix {
  schema: string;
  mode: string;
  harness: string;
  oracleVersion: string;
  provenance: { gitSha: string | null; models: string; recordedOutputs: boolean };
  targets: { id: string; label: string; status: string; provenance: string }[];
  applicability: { attackId: string; target: string; applicable: boolean | null; reason: string }[];
  attacks: AttackRow[];
  totals: TargetTotals[];
  honest: { target: string; n: number; released: number; releasedCorrect: number; releasedLoss: number; rejected: number; escalated: number; held: number; wrongfulReject: { k: number; n: number; wilsonUpper: number } }[];
  agreement: { rows: number; disagreements: number };
  holdout: { status: string; reason?: string };
  limitations: string[];
}

export interface AttackMetaEntry {
  title: string;
  errorClass: string;
  caption: string;
  naiveHypothesis: string;
  symbolonDefence: string;
  onChainBackstop: string;
  kind: string;
}

export interface Bundle {
  version: 1;
  builtAt: string;
  gitSha: string;
  bundleHash: string;
  harnessVersions: Record<string, string>;
  attackMatrix: AttackMatrix;
  attempts: unknown[];
  receipts: unknown[];
  certificate: unknown | null;
}

export function loadBundle(): Bundle | null {
  return bundleJson as unknown as Bundle;
}

export function loadAttackMatrix(): AttackMatrix | null {
  return loadBundle()?.attackMatrix ?? (attackMatrixJson as unknown as AttackMatrix);
}

export function loadAttackMeta(): Record<string, AttackMetaEntry> {
  return attackMetaJson as unknown as Record<string, AttackMetaEntry>;
}

export function loadHonestCorpus(): { summaries?: unknown; targets?: unknown; corpus?: unknown } | null {
  return honestJson as unknown as { summaries?: unknown; targets?: unknown; corpus?: unknown };
}

export interface BlastClosedForm {
  wording: string;
  limits: string[];
  campaign: { runs: number; executedCases: number; violations: number; tightnessCases: number; tightnessMismatches: number };
}

export function loadBlastClosedForm(): BlastClosedForm {
  return blastJson as unknown as BlastClosedForm;
}
