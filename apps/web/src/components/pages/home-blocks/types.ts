// View models for the `/` data blocks. Nothing is hand-typed: numbers arrive as props or slots.
import type { Mode, Slot } from '../../design/types';
import type { LatticeModel } from '../../design/stills/AttackLatticeGrid';

export interface AssemblyProps {
  /** Defaults to unknown: halves stay hollow and nothing seats. Pass `match` only for a recorded RELEASE. */
  fit?: 'match' | 'mismatch' | 'unknown';
  checks?: { id: string; status: 'pass' | 'fail' | 'held' }[];
  receiptHash?: string | null;
}

export interface MatrixBlockTarget {
  id: string;
  label: string;
  status: 'run' | 'not-built';
  /** applicable cells this target lost, integer (from the file's totals) */
  loss: number;
  applicable: number;
}

export interface AttackMatrixBlockProps {
  mode: Mode;
  recordedOutputs: boolean | null;
  lattice: LatticeModel;
  targets: MatrixBlockTarget[];
  href?: string;
}

export interface PilotStatsBlockProps {
  mode: Mode;
  businesses: number;
  payments: number;
  /** lane MoneyAmount per network; never blended */
  testnetValue: Slot;
  mainnetValue: Slot;
  baselineLine?: string;
  href?: string;
}
