// Typed loader for the committed RECORDED data: results/*.json and replay-data/bundle.json (DEC-016). Server-only.
// Numbers shown on public pages are derived from these files; nothing is typed by hand (INV-18).
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

function repoRoot(): string {
  // next runs with cwd = apps/web in dev/build/start; fall back to cwd when the layout differs.
  const up = resolve(process.cwd(), "..", "..");
  return up;
}

function readJson<T>(rel: string): T | null {
  try {
    return JSON.parse(readFileSync(join(repoRoot(), rel), "utf8")) as T;
  } catch {
    return null;
  }
}

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
  return readJson<Bundle>("replay-data/bundle.json");
}

export function loadAttackMatrix(): AttackMatrix | null {
  return loadBundle()?.attackMatrix ?? readJson<AttackMatrix>("results/attack-matrix.json");
}

export function loadAttackMeta(): Record<string, AttackMetaEntry> {
  return readJson<Record<string, AttackMetaEntry>>("replay-data/attack-meta.json") ?? {};
}

export function loadHonestCorpus(): { summaries?: unknown; targets?: unknown; corpus?: unknown } | null {
  return readJson("results/honest-corpus.json");
}
