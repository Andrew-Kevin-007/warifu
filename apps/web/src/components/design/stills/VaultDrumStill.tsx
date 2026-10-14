import { useId } from 'react';

export interface DrumCap {
  /** Cap as a basis-point ratio of the balance (0..10000), computed by ratioBp(); never a raw amount. */
  bp: number | null;
  label: string;
}

/**
 * The bounded container: a hollow drum seen from above with up to three concentric cap rings (per transaction,
 * daily, hourly). Arc length = cap/balance. A null ratio draws that ring hollow (no claim). The open top shows a
 * periwinkle core (the balance).
 */
export default function VaultDrumStill({
  caps,
  label,
  className = '',
  hollow = false,
}: {
  caps: DrumCap[];
  label?: string;
  className?: string;
  hollow?: boolean;
}) {
  const uid = useId().replace(/:/g, '');
  const cx = 110;
  const cy = 96;
  const radii = [88, 74, 60];
  const a11y = label ? { role: 'img' as const, 'aria-label': label } : { 'aria-hidden': true as const };
  return (
    <svg className={`sy-drum ${className}`.trim()} viewBox="0 0 220 200" width="100%" focusable="false" data-hollow={hollow} {...a11y}>
      <defs>
        <linearGradient id={`${uid}-w`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#555" />
          <stop offset="0.3" stopColor="#e6e6e6" />
          <stop offset="0.45" stopColor="#222" />
          <stop offset="1" stopColor="#000" />
        </linearGradient>
      </defs>
      {/* drum wall (side) */}
      <path d="M22 96v26c0 20 40 32 88 32s88-12 88-32V96" fill={hollow ? 'none' : `url(#${uid}-w)`} stroke="#000" strokeWidth="1" />
      {/* open top */}
      <ellipse cx={cx} cy={cy} rx="88" ry="30" fill="#fff" stroke="#000" strokeWidth="1" />
      <ellipse cx={cx} cy={cy} rx="62" ry="20" fill={hollow ? 'none' : '#9280FC'} stroke="#000" strokeWidth="1" />
      {!hollow ? <ellipse cx="96" cy="92" rx="26" ry="6" fill="#fff" opacity="0.55" /> : null}
      {/* cap rings */}
      {caps.slice(0, 3).map((c, i) => {
        const r = radii[i];
        const ry = r * 0.34;
        const bp = c.bp === null ? null : Math.max(0, Math.min(10000, c.bp));
        return (
          <g key={i}>
            <ellipse cx={cx} cy={cy} rx={r - i * 0} ry={ry} fill="none" stroke="#CCCCCC" strokeWidth="0.5" strokeDasharray="4 2" />
            {bp === null ? (
              <ellipse cx={cx} cy={cy} rx={r} ry={ry} fill="none" stroke="#6E6E6E" strokeWidth="1" strokeDasharray="2 3" />
            ) : (
              <ellipse
                cx={cx}
                cy={cy}
                rx={r}
                ry={ry}
                fill="none"
                stroke="#000"
                strokeWidth="3.5"
                pathLength={10000}
                strokeDasharray={`${bp} ${10000 - bp}`}
                className="sy-drum__cap"
              />
            )}
          </g>
        );
      })}
    </svg>
  );
}
