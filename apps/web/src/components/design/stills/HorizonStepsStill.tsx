import { useId } from 'react';
import type { Validity } from '../types';

export interface HorizonStep {
  /** horizon label from the certificate (1m, 1h, 6h, ...). Text only. */
  label: string;
  /** value/balance as basis points via ratioBp(); null = no ratio (renders a hollow socket) */
  bp: number | null;
  /** the term that binds this horizon: outlined 2 px */
  binding?: boolean;
}

/**
 * The bound at each horizon as a stair of slabs (echoes the hero's stepped clip). Heights are value/balance as
 * basis points, never a number rendered on the canvas. VALID = stipple periwinkle; STALE = contour + dashed;
 * UNVERIFIED (or null) = hollow sockets of equal height: no claim, so no height means anything.
 */
export default function HorizonStepsStill({
  steps,
  alarmed,
  state,
  label,
  className = '',
}: {
  steps: HorizonStep[];
  alarmed?: { label: string; bp: number | null } | null;
  state: Validity | null;
  label?: string;
  className?: string;
}) {
  const uid = useId().replace(/:/g, '');
  const all = alarmed ? [...steps, { label: alarmed.label, bp: alarmed.bp, binding: false }] : steps;
  const n = Math.max(1, all.length);
  const W = 400;
  const H = 230;
  const left = 20;
  const base = 190;
  const maxH = 140;
  const slot = (W - left * 2) / n;
  const w = Math.min(46, slot - 8);
  const hollow = state === null || state === 'UNVERIFIED';
  const stale = state === 'STALE';
  const a11y = label ? { role: 'img' as const, 'aria-label': label } : { 'aria-hidden': true as const };

  return (
    <svg className={`sy-steps ${className}`.trim()} viewBox={`0 0 ${W} ${H}`} width="100%" data-state={state ?? 'none'} focusable="false" {...a11y}>
      <defs>
        <pattern id={`${uid}-d`} width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(-24)">
          <circle cx="1.4" cy="1.4" r="1" fill="#fff" />
          <circle cx="3.9" cy="3.9" r="0.7" fill="#fff" />
        </pattern>
        <linearGradient id={`${uid}-g`} x1="0" y1="0" x2="0.8" y2="1">
          <stop offset="0" stopColor="#fff" stopOpacity="1" />
          <stop offset="0.8" stopColor="#fff" stopOpacity="0" />
        </linearGradient>
        <mask id={`${uid}-m`}>
          <rect width={W} height={H} fill={`url(#${uid}-g)`} />
        </mask>
      </defs>

      {/* ceiling = the balance. Semantic dashed line (1 px, #6E6E6E), never the decorative 0.5 px grey. */}
      <line x1={left - 6} x2={W - left + 6} y1={base - maxH} y2={base - maxH} stroke="#6E6E6E" strokeWidth="1" strokeDasharray="4 3" />
      <text x={W - left + 6} y={base - maxH - 6} textAnchor="end" className="sy-svg-mono">
        {hollow ? 'BALANCE' : 'BALANCE'}
      </text>
      <line x1={left - 6} x2={W - left + 6} y1={base} y2={base} stroke="#000" strokeWidth="1" />

      {all.map((s, i) => {
        const x = left + i * slot + (slot - w) / 2;
        const isAlarm = !!alarmed && i === all.length - 1;
        const h = hollow || s.bp === null ? maxH * 0.55 : Math.max(2, (Math.min(10000, s.bp) / 10000) * maxH);
        const y = base - h;
        const dashed = stale || isAlarm || hollow || s.bp === null;
        return (
          <g key={`${s.label}-${i}`} className="sy-step" data-binding={s.binding ? 'true' : undefined} data-alarm={isAlarm ? 'true' : undefined}>
            {/* pale isometric side to read as a slab, not a bar */}
            {!dashed ? <path d={`M${x + w} ${y} l8 -5 v${h} l-8 5 Z`} fill="#000" /> : null}
            <rect
              x={x}
              y={y}
              width={w}
              height={h}
              fill={dashed ? (hollow || isAlarm ? 'none' : '#fff') : '#9280FC'}
              stroke={dashed ? '#232323' : '#000'}
              strokeWidth={s.binding && !dashed ? 2.5 : 1}
              strokeDasharray={dashed ? '4 3' : undefined}
            />
            {!dashed ? <rect x={x} y={y} width={w} height={h} fill={`url(#${uid}-d)`} mask={`url(#${uid}-m)`} /> : null}
            {s.binding && !dashed ? <rect x={x - 3} y={y - 3} width={w + 6} height={h + 6} fill="none" stroke="#000" strokeWidth="1" /> : null}
            <text x={x + w / 2} y={base + 16} textAnchor="middle" className="sy-svg-mono">
              {s.label}
            </text>
          </g>
        );
      })}
    </svg>
  );
}
