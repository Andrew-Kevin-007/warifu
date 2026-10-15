import type { ReactNode } from 'react';
import type { Mode, Validity } from '../types';
import { modeChip, validityChip } from '../runtime/states';
import Glyph from './Glyph';

/** Rectangular mono tag for a mode (LIVE / RECORDED / SIMULATED / DEMO / FIXTURE). A mode is never a pill. */
export function ModeTag({ mode, className = '' }: { mode: Mode; className?: string }) {
  const c = modeChip(mode);
  return (
    <span className={`${c.className} ${className}`.trim()} data-mode={mode}>
      <Glyph kind={c.glyph} />
      <span>{c.label}</span>
    </span>
  );
}

/** Pill for a validity (VALID / STALE / UNVERIFIED / code MISMATCH). A validity is never a rectangle. */
export function ValidityPill({
  status,
  className = '',
  label,
}: {
  status: Validity | 'MISMATCH';
  className?: string;
  label?: string;
}) {
  const c = validityChip(status);
  return (
    <span className={`${c.className} ${className}`.trim()} data-validity={status}>
      <Glyph kind={c.glyph} />
      <span>{label ?? c.label}</span>
    </span>
  );
}

/** Small neutral label (EXCLUDED, SIGNAL, ORACLE...). Rectangular mono; dashed when it marks something not counted. */
export function MiniTag({
  children,
  tone = 'plain',
  className = '',
}: {
  children: ReactNode;
  tone?: 'plain' | 'dashed' | 'solid' | 'loss';
  className?: string;
}) {
  return <span className={`sy-mini sy-mini--${tone} ${className}`.trim()}>{children}</span>;
}
