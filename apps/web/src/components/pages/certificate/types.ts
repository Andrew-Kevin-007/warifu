// View model for /certificate/[vault] (lbc/1). Money stays in lane slots; the body never parses an amount.
import type { Mode, Slot, Validity } from '../../design/types';

export interface CertHorizonRow {
  label: string;
  /** lane MoneyAmount */
  value: Slot;
  /** value/balance basis points via ratioBp(); drives the stair only */
  bp: number | null;
  /** binding terms (T1 / T2 / T3...) as text */
  binding: string[];
}

export interface CertificateModel {
  mode: Mode;
  /** null = the certificate could not be read at all: rendered UNVERIFIED, no number */
  validity: Validity | null;
  /** validated address, shortened; params are never echoed raw */
  vaultShort: string;
  exclusions: { id: string; text: string }[];
  /** generated headline sentence + numeral (lane ClaimsNumber / MoneyAmount). Never shown when UNVERIFIED. */
  headline: Slot;
  /** lane StatusChip; the kit falls back to a ValidityPill */
  statusChip?: Slot;
  asOf: { block: string; blockHash: string } | null;
  certHash: string | null;
  horizons: CertHorizonRow[];
  alarmed: { label: string; value: Slot; assumes: string[] } | null;
  assumptions: { id: string; text: string }[];
  validation: {
    trials: number;
    violations: number;
    upper95: string;
    tightness: string;
    codeMatch: 'MATCH' | 'NOT_CHECKED' | 'MISMATCH';
  } | null;
  verifyCommand: string;
  /** STALE only: what changed since the certificate was computed */
  staleDiff: { reasons: string[]; before: Slot; after: Slot } | null;
  /** optional lane slot beside the horizon table (HorizonTable) */
  horizonTable?: Slot;
}
