// View model for /attack-lab, derived from the committed attack-matrix/1 file shape.
import type { CellOutcome, Mode, Slot } from '../../design/types';

export interface MatrixTarget {
  id: string;
  label: string;
  status: 'run' | 'not-built';
  /** one-line provenance text from the file */
  provenance?: string;
}

export interface MatrixAttack {
  id: string;
  /** optional human title from the fixture catalogue; plain text */
  title?: string;
}

export interface MatrixCell {
  attackId: string;
  targetId: string;
  outcome: CellOutcome;
  /** null when not scored (N/A, not run) */
  scoring: 'oracle' | 'signal' | null;
  /** applicability reason for N/A / not-run cells (text from the file) */
  reason?: string;
  checksFired: string[];
  /** lane MoneyAmount for loss base units; omitted when zero */
  loss?: Slot;
  /** vault simulation revert, when known */
  vaultReverts?: boolean | null;
  /** payload: lane UntrustedText slot; never rendered by the kit directly */
  payload?: Slot;
}

export interface ScoreSplit {
  applicable: number;
  loss: number;
  blocked: number;
  escalated: number;
  held: number;
  noop: number;
  notRun: number;
}

export interface TargetTotals {
  targetId: string;
  attacks: number;
  applicable: number;
  notApplicable: number;
  oracle: ScoreSplit;
  signal: ScoreSplit;
  trials: number;
  lossTrials: number;
  /** lane-formatted rate / upper bound: statement text, never counted up */
  lossRate: Slot;
}

export interface AttackLabModel {
  mode: Mode;
  /** file provenance.recordedOutputs; false forces SIMULATED */
  recordedOutputs: boolean | null;
  harness: string;
  oracleVersion: string;
  matrixMode: string;
  targets: MatrixTarget[];
  attacks: MatrixAttack[];
  cells: MatrixCell[];
  totals: TargetTotals[];
  holdout: { status: 'not-run' | 'run'; reason?: string; rootHash?: string; n?: number; k?: number; upperBound?: Slot } | null;
  honest: { targetId: string; n: number; released: number; wrongfulRejects: number; wilsonUpper: Slot }[];
  reproducibility: { gitSha: string | null; seed: string; models: string; manifestHash?: string };
  limitations: string[];
}
