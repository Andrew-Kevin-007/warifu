// View model for the /judge body. The lane maps its data into this; the body fetches nothing.
// Types mirror packages/schemas (lbc/1, challenge, attack-matrix/1) structurally: apps/web does not depend on
// @symbolon/schemas, so these are declared locally and kept primitive (strings, integers, booleans, slots).
import type { CellOutcome, Mode, Slot, Validity } from '../../design/types';
import type { HorizonStep } from '../../design/stills/HorizonStepsStill';
import type { SealState } from '../../design/stills/ReceiptSealStill';

export interface JudgeOutcomeRow {
  /** target label, e.g. the baseline name */
  target: string;
  outcome: CellOutcome;
  /** lane-rendered money (MoneyAmount) when the outcome is a loss */
  loss?: Slot;
}

export interface JudgeProps {
  /** LIVE / RECORDED / SIMULATED; the page frame and card tags follow it */
  mode: Mode;
  /** Decorative hero token. Defaults to unknown (hollow): it must not assert a fit nobody checked. */
  heroFit?: 'match' | 'mismatch' | 'unknown';
  card1: {
    /** unknown until the run exists */
    fit: 'mismatch' | 'match' | 'unknown';
    /** K-ids that fired, text from data */
    checkIds: string[];
    outcomes: JudgeOutcomeRow[];
    /** from the data: does the vault simulation revert? null = not simulated */
    vaultReverts: boolean | null;
  };
  card2: {
    receiptHash: string | null;
    sealState: SealState;
    /** `fixture` shows a FIXTURE tag and never says "real" */
    kind: 'fixture' | 'real';
  };
  card3: {
    validity: Validity | null;
    exclusions: { id: string; text: string }[];
    horizons: HorizonStep[];
    alarmed?: { label: string; bp: number | null } | null;
    command: string;
  };
  hrefs?: { run?: string; audit?: string; certificate?: string; challenge?: string; pilot?: string };
  slots: {
    modeBar?: Slot;
    card1Claim?: Slot;
    card1Verdict?: Slot;
    card2ReceiptLink?: Slot;
    card3StatusChip?: Slot;
    card3Headline?: Slot;
    card3WhatIf?: Slot;
    card4Scoreboard?: Slot;
    card4CrossOriginLink?: Slot;
    card5PilotSummary?: Slot;
  };
}
