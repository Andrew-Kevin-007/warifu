import { useId } from 'react';
import { sealBytes, sealTicks } from '../runtime/seal';

export type SealState = 'sealed' | 'hollow' | 'failed';

/**
 * The receipt seal: a thin chrome disc with 32 radial ticks, tick length = the byte of the 32-byte hash.
 * `state` is REQUIRED and has no default: a seal looks complete only when the caller says every step passed.
 * No hash (or a malformed one) always renders hollow, whatever `state` says.
 */
export default function ReceiptSealStill({
  hash,
  state,
  label,
  className = '',
  stamp = false,
}: {
  hash: string | null | undefined;
  state: SealState;
  label?: string;
  className?: string;
  stamp?: boolean;
}) {
  const uid = useId().replace(/:/g, '');
  const bytes = sealBytes(hash);
  const effective: SealState = bytes === null ? 'hollow' : state;
  const cx = 100;
  const cy = 100;
  const ticks = bytes ? sealTicks(bytes, cx, cy, 58) : [];
  const a11y = label ? { role: 'img' as const, 'aria-label': label } : { 'aria-hidden': true as const };

  return (
    <svg
      className={`sy-seal${stamp ? ' sy-seal--stamp' : ''} ${className}`.trim()}
      data-state={effective}
      viewBox="0 0 200 200"
      width="100%"
      focusable="false"
      {...a11y}
    >
      <defs>
        <radialGradient id={`${uid}-c`} cx="0.35" cy="0.3" r="0.9">
          <stop offset="0" stopColor="#6e6e6e" />
          <stop offset="0.25" stopColor="#d9d9d9" />
          <stop offset="0.4" stopColor="#262626" />
          <stop offset="0.75" stopColor="#0b0b0b" />
          <stop offset="1" stopColor="#000" />
        </radialGradient>
      </defs>
      {effective === 'hollow' ? (
        <g fill="none" stroke="#000" strokeWidth="1">
          <circle cx={cx} cy={cy} r="56" />
          <circle cx={cx} cy={cy} r="38" strokeDasharray="3 3" stroke="#6E6E6E" />
        </g>
      ) : (
        <g>
          <circle cx={cx} cy={cy} r="56" fill={`url(#${uid}-c)`} stroke="#000" strokeWidth="1" />
          <circle cx={cx} cy={cy} r="42" fill="none" stroke="#fff" strokeWidth="0.75" opacity="0.7" />
          <g stroke="#000" strokeWidth="1.6" strokeLinecap="butt" className="sy-seal__ticks">
            {ticks.map((t, i) => (
              <line key={i} x1={t.x1} y1={t.y1} x2={t.x2} y2={t.y2} />
            ))}
          </g>
          {effective === 'failed' ? (
            <path d="M100 38V62h-8v20h10v20h-10v18h8v24" fill="none" stroke="#B42318" strokeWidth="3" />
          ) : null}
        </g>
      )}
    </svg>
  );
}
