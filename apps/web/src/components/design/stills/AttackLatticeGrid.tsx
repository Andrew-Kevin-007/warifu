'use client';

import { useCallback, useRef } from 'react';
import type { CellOutcome } from '../types';
import { cellGrammar, type CellSpec } from '../runtime/states';
import { useLatticeFocus } from '../runtime/LatticeFocus';

export interface LatticeTarget {
  id: string;
  label: string;
  status: 'run' | 'not-built';
}

export interface LatticeCell {
  attackId: string;
  targetId: string;
  outcome: CellOutcome | null;
  scoring?: 'oracle' | 'signal';
  /** why a cell is N/A or not run; shown on focus via the accessible name */
  reason?: string;
}

export interface LatticeModel {
  attackIds: string[];
  targets: LatticeTarget[];
  cells: LatticeCell[];
}

const KIND_ORDER: CellSpec['kind'][] = ['blocked', 'escalated', 'held', 'loss', 'noop', 'na', 'notrun', 'notbuilt'];
const KIND_WORD: Record<CellSpec['kind'], string> = {
  blocked: 'Blocked',
  escalated: 'Escalated',
  held: 'Held',
  loss: 'Loss',
  noop: 'No effect',
  na: 'Not applicable',
  notrun: 'Not run',
  notbuilt: 'Not built yet',
};

/** Legend: every cell kind with its word. The words are always present; colour and shape are the skin. */
export function LatticeLegend({ kinds, className = '' }: { kinds?: CellSpec['kind'][]; className?: string }) {
  return (
    <ul className={`sy-lat-legend ${className}`.trim()} aria-label="Cell legend">
      {(kinds ?? KIND_ORDER).map((k) => (
        <li key={k} className="sy-lat-legend__item">
          <span className="sy-cell sy-cell--sample" data-kind={k} aria-hidden="true">
            <span className="sy-cell__tile" />
            <span className="sy-cell__cap" />
          </span>
          <span className="body-text-xs">{KIND_WORD[k]}</span>
        </li>
      ))}
    </ul>
  );
}

/**
 * The attack lattice as a real DOM grid: rows = targets, columns = attacks. It is the accessible control; a
 * canvas version is only a skin over this. Roving tabindex + arrow keys; hover/focus locks the column.
 * A LOSS cell is always rendered at full strength: never omitted, softened or merged.
 */
export default function AttackLatticeGrid({
  model,
  size = 'full',
  caption,
  className = '',
  interactive = true,
}: {
  model: LatticeModel;
  size?: 'full' | 'compact';
  caption: string;
  className?: string;
  interactive?: boolean;
}) {
  const { attackId, setAttackId } = useLatticeFocus();
  const root = useRef<HTMLTableElement | null>(null);
  const lookup = new Map<string, LatticeCell>();
  for (const c of model.cells) lookup.set(`${c.targetId}|${c.attackId}`, c);

  const onKey = useCallback((e: React.KeyboardEvent<HTMLTableElement>) => {
    const t = e.target as HTMLElement;
    if (!t.matches('button.sy-cell')) return;
    const r = Number(t.dataset.r);
    const c = Number(t.dataset.c);
    let nr = r;
    let nc = c;
    if (e.key === 'ArrowRight') nc = c + 1;
    else if (e.key === 'ArrowLeft') nc = c - 1;
    else if (e.key === 'ArrowDown') nr = r + 1;
    else if (e.key === 'ArrowUp') nr = r - 1;
    else if (e.key === 'Home') nc = 0;
    else if (e.key === 'End') nc = 9999;
    else return;
    e.preventDefault();
    const all = Array.from(root.current?.querySelectorAll<HTMLButtonElement>('button.sy-cell') ?? []);
    const cols = Math.max(...all.map((b) => Number(b.dataset.c))) ;
    nc = Math.min(Math.max(nc, 0), cols);
    const next = all.find((b) => Number(b.dataset.r) === nr && Number(b.dataset.c) === nc);
    if (next) {
      all.forEach((b) => (b.tabIndex = -1));
      next.tabIndex = 0;
      next.focus();
    }
  }, []);

  let firstFocusable = true;

  return (
    <div className={`sy-lattice sy-lattice--${size} ${className}`.trim()}>
      <table ref={root} className="sy-lattice__table" onKeyDown={interactive ? onKey : undefined}>
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr>
            <th scope="col" className="sy-lattice__corner">
              <span className="sr-only">Target</span>
            </th>
            {model.attackIds.map((id) => (
              <th key={id} scope="col" className="sy-lattice__colh" data-hot={attackId === id ? 'true' : undefined}>
                <span className="sy-mono sy-lattice__id">{id.replace(/^ATK-/, '')}</span>
                <span className="sr-only">{id}</span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {model.targets.map((t, ri) => (
            <tr key={t.id} data-status={t.status}>
              <th scope="row" className="sy-lattice__rowh">
                <span className="sy-lattice__target">{t.label}</span>
                {t.status === 'not-built' ? <span className="sy-lattice__nb"> Not built yet</span> : null}
              </th>
              {model.attackIds.map((aid, ci) => {
                const cell = lookup.get(`${t.id}|${aid}`);
                const spec = cellGrammar(cell?.outcome ?? null, t.status);
                const scored = cell?.scoring === 'signal' ? ', signal-scored' : '';
                const reason = cell?.reason && (spec.kind === 'na' || spec.kind === 'notrun') ? `. ${cell.reason}` : '';
                const name = `${aid}, ${t.label}: ${spec.label}${scored}${reason}`;
                const hot = attackId === aid ? 'true' : undefined;
                if (!interactive || t.status === 'not-built') {
                  return (
                    <td key={aid} className="sy-lattice__td" data-hot={hot}>
                      <span className="sy-cell" data-kind={spec.kind} data-scoring={cell?.scoring} role="img" aria-label={name}>
                        <span className="sy-cell__tile" />
                        <span className="sy-cell__cap" />
                      </span>
                    </td>
                  );
                }
                const tab = firstFocusable ? 0 : -1;
                firstFocusable = false;
                return (
                  <td key={aid} className="sy-lattice__td" data-hot={hot}>
                    <button
                      type="button"
                      className="sy-cell"
                      data-kind={spec.kind}
                      data-scoring={cell?.scoring}
                      data-r={ri}
                      data-c={ci}
                      tabIndex={tab}
                      aria-label={name}
                      title={name}
                      onMouseEnter={() => setAttackId(aid)}
                      onMouseLeave={() => setAttackId(null)}
                      onFocus={() => setAttackId(aid)}
                      onBlur={() => setAttackId(null)}
                    >
                      <span className="sy-cell__tile" />
                      <span className="sy-cell__cap" />
                    </button>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
