'use client';

import type { ChallengeTile } from './types';

/** Tiny two-half glyph: halves that do not fit (an attack) or halves that do (a benign control that should pay). */
function TileGlyph({ fits }: { fits: boolean }) {
  return (
    <svg className="sy-tile__glyph" viewBox="0 0 40 28" width="40" height="28" aria-hidden="true" focusable="false">
      {fits ? (
        <g>
          <path d="M20 3a11 11 0 0 0 0 22h0V3Z" fill="#9280FC" stroke="#000" strokeWidth="1" />
          <path d="M20 3a11 11 0 0 1 0 22V3Z" fill="#000" stroke="#000" strokeWidth="1" />
        </g>
      ) : (
        <g>
          <path d="M17 3a11 11 0 0 0 0 22h0V3Z" fill="#9280FC" stroke="#000" strokeWidth="1" transform="translate(-2 -1)" />
          <path d="M23 3a11 11 0 0 1 0 22V3Z" fill="#000" stroke="#000" strokeWidth="1" transform="translate(2 1.5) rotate(3 23 14)" />
        </g>
      )}
    </svg>
  );
}

/**
 * Attack tiles (halves that will not fit) or benign controls (halves that fit). At a glance the grid reads
 * "things that should be refused" against "things that should pay". Each tile is a >= 44 px target; selection
 * is reported to the lane via `onSelect`. The kit performs no network call and keeps no state.
 */
export default function AttackTileGrid({
  tiles,
  kind,
  activeId,
  disabledIds = [],
  onSelect,
  label,
}: {
  tiles: ChallengeTile[];
  kind: 'attack' | 'benign';
  activeId?: string | null;
  disabledIds?: string[];
  onSelect?: (id: string) => void;
  label: string;
}) {
  return (
    <ul className={`sy-tiles sy-tiles--${kind}`} aria-label={label}>
      {tiles.map((t) => {
        const disabled = disabledIds.includes(t.id) || !onSelect;
        const active = activeId === t.id;
        return (
          <li key={t.id}>
            <button
              type="button"
              className="sy-tile"
              data-kind={kind}
              data-active={active ? 'true' : undefined}
              disabled={disabled}
              aria-pressed={active}
              onClick={() => onSelect?.(t.id)}
            >
              <TileGlyph fits={kind === 'benign'} />
              <span className="sy-mono sy-tile__id">{t.id}</span>
              <span className="sy-tile__cap">{t.caption}</span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
