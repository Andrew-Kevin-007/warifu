// State grammar (DESIGN_BRIEF 3.4) as pure maps. Every chip has a word AND a glyph: status is never colour-only.
import type { CellOutcome, Mode, TokenPose, Validity } from '../types';

export type GlyphKind = 'joined' | 'offset' | 'open' | 'frozen' | 'hatch' | 'dot' | 'loss' | 'fixture';

export interface ValidityChipSpec {
  label: string;
  className: string;
  glyph: GlyphKind;
  pose: TokenPose;
}

export function validityChip(status: Validity | 'MISMATCH'): ValidityChipSpec {
  switch (status) {
    case 'VALID':
      return { label: 'Valid', className: 'sy-pill sy-pill--valid', glyph: 'joined', pose: 'seated' };
    case 'STALE':
      return { label: 'Stale', className: 'sy-pill sy-pill--stale', glyph: 'offset', pose: 'mismatch' };
    case 'UNVERIFIED':
      return { label: 'Unverified', className: 'sy-pill sy-pill--unverified', glyph: 'open', pose: 'hollow' };
    case 'MISMATCH':
      return { label: 'Code mismatch', className: 'sy-pill sy-pill--loss', glyph: 'loss', pose: 'mismatch' };
    default: {
      const never: never = status;
      return never;
    }
  }
}

export interface ModeChipSpec {
  label: string;
  className: string;
  glyph: GlyphKind;
  /** recorded things are still: scenes render one frame and stop */
  frozen: boolean;
}

export function modeChip(mode: Mode): ModeChipSpec {
  switch (mode) {
    case 'live':
      return { label: 'Live', className: 'sy-mode sy-mode--live', glyph: 'dot', frozen: false };
    case 'recorded':
      return { label: 'Recorded', className: 'sy-mode sy-mode--recorded', glyph: 'frozen', frozen: true };
    case 'simulated':
      return { label: 'Simulated', className: 'sy-mode sy-mode--simulated', glyph: 'hatch', frozen: true };
    case 'demo':
      return { label: 'Demo', className: 'sy-mode sy-mode--demo', glyph: 'hatch', frozen: true };
    case 'fixture':
      return { label: 'Fixture', className: 'sy-mode sy-mode--demo', glyph: 'fixture', frozen: true };
    default: {
      const never: never = mode;
      return never;
    }
  }
}

/**
 * Nothing is called RECORDED unless a real model call produced it (docs/QUESTIONS 2026-10-12).
 * `recordedOutputs === false` forces SIMULATED; `null`/`undefined` keep the declared mode.
 */
export function provenanceMode(declared: Mode, recordedOutputs: boolean | null | undefined): Mode {
  if (recordedOutputs === false && (declared === 'recorded' || declared === 'live')) return 'simulated';
  return declared;
}

export function tokenPoseFor(status: Validity | null | undefined): TokenPose {
  if (!status) return 'hollow';
  return validityChip(status).pose;
}

export interface CellSpec {
  /** DOM data-outcome value (drives all skins) */
  kind: 'blocked' | 'escalated' | 'held' | 'loss' | 'noop' | 'na' | 'notrun' | 'notbuilt';
  /** Plain word, always rendered next to or inside the cell */
  label: string;
}

export function cellGrammar(outcome: CellOutcome | null, targetStatus: 'run' | 'not-built'): CellSpec {
  if (targetStatus === 'not-built') return { kind: 'notbuilt', label: 'Not built yet' };
  switch (outcome) {
    case 'BLOCKED':
      return { kind: 'blocked', label: 'Blocked' };
    case 'ESCALATED':
      return { kind: 'escalated', label: 'Escalated' };
    case 'HELD':
      return { kind: 'held', label: 'Held' };
    case 'LOSS':
      return { kind: 'loss', label: 'Loss' };
    case 'NOOP':
      return { kind: 'noop', label: 'No effect' };
    case 'N/A':
      return { kind: 'na', label: 'Not applicable' };
    case 'NOT_RUN':
    case null:
      return { kind: 'notrun', label: 'Not run' };
    default: {
      const never: never = outcome;
      return never;
    }
  }
}

/** Is a cell a real result (counts in a denominator)? N/A, not-run and not-built are not. */
export function isScored(kind: CellSpec['kind']): boolean {
  return kind === 'blocked' || kind === 'escalated' || kind === 'held' || kind === 'loss' || kind === 'noop';
}

/** Pose along the home assembly, from the scroll window values (all 0..1). Fit decides if the halves may seat. */
export function assemblyPose(
  fit: 'match' | 'mismatch' | 'unknown',
  w: { approach: number; scan: number; seat: number },
): TokenPose {
  if (fit === 'unknown') return 'hollow';
  if (w.seat > 0) return fit === 'match' ? 'seated' : 'mismatch';
  if (w.scan > 0) return 'scan';
  if (w.approach > 0) return 'approach';
  return 'apart';
}
