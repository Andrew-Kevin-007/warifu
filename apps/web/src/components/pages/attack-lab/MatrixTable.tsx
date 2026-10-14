'use client';

import { useId, useState } from 'react';
import { MiniTag } from '../../design/primitives/Tag';
import { cellGrammar } from '../../design/runtime/states';
import { useLatticeFocus } from '../../design/runtime/LatticeFocus';
import type { MatrixAttack, MatrixCell, MatrixTarget } from './types';

function CellChip({ cell, target }: { cell: MatrixCell | undefined; target: MatrixTarget }) {
  const g = cellGrammar(cell?.outcome ?? null, target.status);
  const word = g.kind === 'notbuilt' ? 'Not built' : g.label;
  return (
    <span className="sy-mx__cell" data-kind={g.kind}>
      <span className="sy-cell sy-cell--sample sy-cell--inline" data-kind={g.kind} data-scoring={cell?.scoring ?? undefined} aria-hidden="true">
        <span className="sy-cell__tile" />
        <span className="sy-cell__cap" />
      </span>
      <span className="sy-mx__word">{word}</span>
      {cell?.loss ? <span className="sy-mx__loss">{cell.loss}</span> : null}
      {cell?.scoring === 'signal' ? <MiniTag tone="dashed">Signal</MiniTag> : null}
    </span>
  );
}

/**
 * The matrix is the page: every attack against every baseline, with every cell worded. Rows expand (grid-rows,
 * no layout shift above the fold) to the checks that fired, the vault simulation and the applicability reason.
 * Focusing or hovering a row locks the lattice column; keyboard users get the same via the row button.
 * N/A rows stay, with their reason, and are excluded from the denominators (the totals strip says so).
 */
export default function MatrixTable({
  attacks,
  targets,
  cells,
  caption,
}: {
  attacks: MatrixAttack[];
  targets: MatrixTarget[];
  cells: MatrixCell[];
  caption: string;
}) {
  const { attackId, setAttackId } = useLatticeFocus();
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const uid = useId();
  const lookup = new Map<string, MatrixCell>();
  for (const c of cells) lookup.set(`${c.targetId}|${c.attackId}`, c);

  return (
    <div className="sy-mx" role="region" aria-label="Attack matrix, scrollable" tabIndex={0}>
      <table className="sy-mx__table">
        <caption className="sy-sr-only">{caption}</caption>
        <thead>
          <tr>
            <th scope="col" className="sy-mx__corner">Attack</th>
            {targets.map((t) => (
              <th key={t.id} scope="col" className="sy-mx__colh" data-status={t.status}>
                <span className="sy-mx__target">{t.label}</span>
                {t.status === 'not-built' ? <span className="sy-mx__nb sy-mono">Not built yet</span> : null}
              </th>
            ))}
          </tr>
        </thead>
        {attacks.map((a, ri) => {
          const isOpen = !!open[a.id];
          const panel = `${uid}-${ri}`;
          return (
            <tbody key={a.id} className="sy-mx__group" data-hot={attackId === a.id ? 'true' : undefined} data-open={isOpen ? 'true' : undefined}>
              <tr
                className="sy-mx__row"
                onMouseEnter={() => setAttackId(a.id)}
                onMouseLeave={() => setAttackId(null)}
                onFocusCapture={() => setAttackId(a.id)}
                onBlurCapture={() => setAttackId(null)}
              >
                <th scope="row" className="sy-mx__rowh">
                  <button
                    type="button"
                    className="sy-mx__toggle"
                    aria-expanded={isOpen}
                    aria-controls={panel}
                    onClick={() => setOpen((o) => ({ ...o, [a.id]: !o[a.id] }))}
                  >
                    <span className="sy-mono sy-mx__id">{a.id}</span>
                    {a.title ? <span className="sy-mx__title">{a.title}</span> : null}
                    <span className="sy-mx__chev" aria-hidden="true" />
                  </button>
                </th>
                {targets.map((t) => (
                  <td key={t.id} className="sy-mx__td">
                    <CellChip cell={lookup.get(`${t.id}|${a.id}`)} target={t} />
                  </td>
                ))}
              </tr>
              <tr id={panel} className="sy-mx__detail" hidden={!isOpen}>
                <td colSpan={targets.length + 1}>
                  <div className="sy-mx__detail-grid">
                    {targets.map((t) => {
                      const c = lookup.get(`${t.id}|${a.id}`);
                      const g = cellGrammar(c?.outcome ?? null, t.status);
                      return (
                        <div key={t.id} className="sy-mx__detail-col">
                          <p className="sy-mono sy-mx__detail-h">{t.label}</p>
                          {t.status === 'not-built' ? (
                            <p className="body-text-xs">Not built yet. {t.provenance ?? ''}</p>
                          ) : (
                            <dl className="sy-mx__dl">
                              <dt>Outcome</dt>
                              <dd>{g.label}</dd>
                              <dt>Checks fired</dt>
                              <dd className="sy-mono">{c && c.checksFired.length > 0 ? c.checksFired.join(', ') : 'none'}</dd>
                              <dt>Vault simulation</dt>
                              <dd>{c?.vaultReverts === true ? 'The release reverts' : c?.vaultReverts === false ? 'The release does not revert' : 'Not simulated'}</dd>
                              {c?.reason ? (
                                <>
                                  <dt>Reason</dt>
                                  <dd>{c.reason}</dd>
                                </>
                              ) : null}
                              {c?.payload ? (
                                <>
                                  <dt>Payload</dt>
                                  <dd className="sy-mx__payload">{c.payload}</dd>
                                </>
                              ) : null}
                            </dl>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </td>
              </tr>
            </tbody>
          );
        })}
      </table>
    </div>
  );
}
