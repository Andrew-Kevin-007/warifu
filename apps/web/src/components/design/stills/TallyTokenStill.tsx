import { useId } from 'react';
import type { TokenPose } from '../types';
import { seamPath, STILL_DISC, tokenPaths } from '../three/fracture';

/**
 * The symbol: a tally token broken in two. Left half = the agent's proposal (stipple periwinkle, advisory),
 * right half = the signed engagement (chrome black). Pose is a data-attribute; CSS moves the halves, so the same
 * markup serves the static Still, the scroll-linked assembly and the reduced-motion seated pose.
 *
 * `hollow` is contour-only: it makes no claim. A decorative token must pass `hollow` unless a checked fit exists.
 * Either give it a data-derived `label` (role=img) or leave it decorative (aria-hidden, adjacent text carries meaning).
 */
export default function TallyTokenStill({
  pose,
  label,
  className = '',
  showSeam = true,
  scanLine = false,
}: {
  pose: TokenPose;
  label?: string;
  className?: string;
  showSeam?: boolean;
  scanLine?: boolean;
}) {
  const uid = useId().replace(/:/g, '');
  const mismatch = pose === 'mismatch';
  const hollow = pose === 'hollow';
  const { left, right } = tokenPaths(mismatch);
  const D = STILL_DISC;
  const a11y = label ? { role: 'img' as const, 'aria-label': label } : { 'aria-hidden': true as const };

  return (
    <svg
      className={`sy-token ${className}`.trim()}
      data-pose={pose}
      viewBox="0 0 360 320"
      width="100%"
      focusable="false"
      {...a11y}
    >
      <defs>
        {/* Stipple: white dots toward the light (top-left), black dots dissolving to solid toward the shadow. */}
        <pattern id={`${uid}-dw`} width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(-24)">
          <circle cx="1.4" cy="1.4" r="1.05" fill="#fff" />
          <circle cx="3.9" cy="3.9" r="0.7" fill="#fff" />
        </pattern>
        <pattern id={`${uid}-db`} width="4.4" height="4.4" patternUnits="userSpaceOnUse" patternTransform="rotate(-24)">
          <circle cx="1.2" cy="1.2" r="1.15" fill="#000" />
          <circle cx="3.4" cy="3.4" r="0.8" fill="#000" />
        </pattern>
        <linearGradient id={`${uid}-gw`} x1="0.05" y1="0.05" x2="0.7" y2="0.75">
          <stop offset="0" stopColor="#fff" stopOpacity="1" />
          <stop offset="0.55" stopColor="#fff" stopOpacity="0.25" />
          <stop offset="1" stopColor="#fff" stopOpacity="0" />
        </linearGradient>
        <linearGradient id={`${uid}-gb`} x1="0.2" y1="0.15" x2="0.95" y2="0.95">
          <stop offset="0.35" stopColor="#fff" stopOpacity="0" />
          <stop offset="0.75" stopColor="#fff" stopOpacity="0.8" />
          <stop offset="1" stopColor="#fff" stopOpacity="1" />
        </linearGradient>
        <mask id={`${uid}-mw`} maskUnits="userSpaceOnUse" x="0" y="0" width="360" height="320">
          <rect width="360" height="320" fill={`url(#${uid}-gw)`} />
        </mask>
        <mask id={`${uid}-mb`} maskUnits="userSpaceOnUse" x="0" y="0" width="360" height="320">
          <rect width="360" height="320" fill={`url(#${uid}-gb)`} />
        </mask>
        <linearGradient id={`${uid}-chrome`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#0b0b0b" />
          <stop offset="0.22" stopColor="#555" />
          <stop offset="0.34" stopColor="#e8e8e8" />
          <stop offset="0.42" stopColor="#2b2b2b" />
          <stop offset="0.66" stopColor="#101010" />
          <stop offset="0.8" stopColor="#6a6a6a" />
          <stop offset="0.88" stopColor="#101010" />
          <stop offset="1" stopColor="#000" />
        </linearGradient>
        <clipPath id={`${uid}-ca`}>
          <path d={left} />
        </clipPath>
        <clipPath id={`${uid}-cb`}>
          <path d={right} />
        </clipPath>
      </defs>

      {/* ground shadow dots, so the object sits on the plate rather than floating */}
      {!hollow ? (
        <ellipse cx={D.cx} cy={D.cy + D.r + 14} rx={D.r * 0.78} ry="7" fill="#000" opacity="0.07" className="sy-token__ground" />
      ) : null}

      {/* proposal half: periwinkle stipple */}
      <g className="sy-half sy-half--a">
        {hollow ? (
          <path d={left} fill="none" stroke="#000" strokeWidth="1" strokeLinejoin="round" />
        ) : (
          <g>
            <path d={left} fill="#9280FC" />
            <g clipPath={`url(#${uid}-ca)`}>
              <rect width="360" height="320" fill={`url(#${uid}-dw)`} mask={`url(#${uid}-mw)`} />
              <rect width="360" height="320" fill={`url(#${uid}-db)`} mask={`url(#${uid}-mb)`} />
            </g>
            <path d={left} fill="none" stroke="#000" strokeWidth="1" strokeLinejoin="round" />
          </g>
        )}
      </g>

      {/* engagement half: chrome black */}
      <g className="sy-half sy-half--b">
        {hollow ? (
          <path d={right} fill="none" stroke="#000" strokeWidth="1" strokeLinejoin="round" />
        ) : (
          <g>
            <path d={right} fill={`url(#${uid}-chrome)`} />
            <g clipPath={`url(#${uid}-cb)`}>
              <rect width="360" height="320" fill={`url(#${uid}-db)`} opacity="0.35" />
            </g>
            <path d={right} fill="none" stroke="#000" strokeWidth="1" strokeLinejoin="round" />
          </g>
        )}
      </g>

      {showSeam && !hollow ? (
        <path d={seamPath()} fill="none" stroke="#000" strokeWidth="1" className="sy-token__seam" />
      ) : null}
      {scanLine ? (
        <path d={seamPath()} fill="none" stroke="#9280FC" strokeWidth="1" className="sy-token__scan" pathLength={100} />
      ) : null}
    </svg>
  );
}
