import { useId } from 'react';
import type { Validity } from '../types';

/**
 * The vault's mark of its recomputed bound. A round hanko: intact (VALID), cracked (STALE), blank (UNVERIFIED).
 *
 * Presentational and props-only. The brand name is a prop (never a literal), and the ONE number on the seal is
 * `value`, a string the caller read from the certificate document at render time and formatted with its own
 * money component. The kit never computes, parses or animates it, and it is only drawn for VALID: a cracked or
 * blank seal makes no numeric claim.
 *
 * Colour: ink. A red stamp would collide with the single status red (#B42318 = LOSS / FAIL), so a VALID seal in
 * that colour would read as a failure. The stamp colour is a CSS custom property (--sy-hanko-ink) so the brand
 * owner can decide; the default is the site's signed-black. See report for the open question.
 */
export default function HankoSeal({
  state,
  brandName,
  brandKanji,
  value,
  asOfBlock,
  label,
  className = '',
}: {
  state: Validity;
  brandName: string;
  /** the brand's kanji mark (BRAND.kanji), set above the centre text; omitted when not given */
  brandKanji?: string;
  /** pre-formatted bound string from the certificate, or null. Drawn only when state === 'VALID'. */
  value: string | null;
  /** the "as of block" caption, text from the certificate document */
  asOfBlock: string | null;
  label?: string;
  className?: string;
}) {
  const uid = useId().replace(/:/g, '');
  const intact = state === 'VALID';
  const cracked = state === 'STALE';
  const blank = state === 'UNVERIFIED';
  const word = intact ? 'Loss bound' : cracked ? 'Stale' : 'Not computed';
  const ring = `${brandName.toUpperCase()} · RECOMPUTED BOUND · `;
  const aria =
    label ??
    (intact
      ? `${brandName} seal, intact: the loss bound was recomputed`
      : cracked
        ? `${brandName} seal, cracked: the certificate is stale`
        : `${brandName} seal, blank: not computed`);

  return (
    <svg className={`sy-hanko ${className}`.trim()} data-state={state} viewBox="0 0 240 240" width="100%" role="img" aria-label={aria} focusable="false">
      <defs>
        <path id={`${uid}-ring`} d="M120 120m-86 0a86 86 0 1 1 172 0a86 86 0 1 1 -172 0" />
        {/* worn-stamp texture: sparse white dots knocked out of the ink */}
        <pattern id={`${uid}-wear`} width="7" height="7" patternUnits="userSpaceOnUse" patternTransform="rotate(-21)">
          <circle cx="1.5" cy="1.5" r="0.9" fill="#fff" />
          <circle cx="5" cy="4.6" r="0.55" fill="#fff" />
        </pattern>
        <clipPath id={`${uid}-l`}>
          <path d="M0 0H122V70H112V110H124V160H114V240H0Z" />
        </clipPath>
        <clipPath id={`${uid}-r`}>
          <path d="M240 0H122V70H112V110H124V160H114V240H240Z" />
        </clipPath>
      </defs>

      {blank ? (
        <g fill="none" stroke="#6E6E6E" strokeWidth="1.5">
          <circle cx="120" cy="120" r="110" strokeDasharray="5 4" />
          <circle cx="120" cy="120" r="98" strokeDasharray="2 4" />
        </g>
      ) : (
        <g className={cracked ? 'sy-hanko__cracked' : 'sy-hanko__intact'}>
          {/* two clipped halves, so STALE can part them (the fracture is the same step polyline as the token) */}
          <g clipPath={`url(#${uid}-l)`} className="sy-hanko__half sy-hanko__half--a">
            <HankoFace uid={uid} ring={ring} />
          </g>
          <g clipPath={`url(#${uid}-r)`} className="sy-hanko__half sy-hanko__half--b">
            <HankoFace uid={uid} ring={ring} />
          </g>
          {cracked ? (
            <path d="M122 0V70H112V110H124V160H114V240" fill="none" stroke="#6E6E6E" strokeWidth="1.2" strokeDasharray="3 3" />
          ) : null}
        </g>
      )}

      {/* centre: the one number (VALID only), the word, and the block caption */}
      <g textAnchor="middle" className="sy-hanko__text">
        {brandKanji ? (
          <text x="120" y="94" lang="ja" className="sy-hanko__kanji" fill={blank ? '#6E6E6E' : '#fff'}>
            {brandKanji}
          </text>
        ) : null}
        {intact && value ? (
          <text x="120" y="124" className="sy-hanko__value" fill="#fff">
            {value}
          </text>
        ) : (
          <text x="120" y="124" className={blank ? 'sy-hanko__word sy-hanko__word--blank' : 'sy-hanko__word'} fill={blank ? '#6E6E6E' : '#fff'}>
            {word}
          </text>
        )}
        {intact && value ? (
          <text x="120" y="146" className="sy-hanko__cap" fill="#fff">
            {asOfBlock ? `as of block ${asOfBlock}` : word}
          </text>
        ) : null}
        {cracked ? (
          <text x="120" y="146" className="sy-hanko__cap" fill="#fff">
            recompute to refresh
          </text>
        ) : null}
        {blank ? (
          <text x="120" y="146" className="sy-hanko__cap" fill="#6E6E6E">
            no claim is made
          </text>
        ) : null}
      </g>
    </svg>
  );
}

function HankoFace({ uid, ring }: { uid: string; ring: string }) {
  return (
    <g>
      <circle cx="120" cy="120" r="110" fill="#000" />
      <circle cx="120" cy="120" r="102" fill="none" stroke="#fff" strokeWidth="1.2" />
      <circle cx="120" cy="120" r="64" fill="none" stroke="#fff" strokeWidth="0.8" />
      <text className="sy-hanko__ring" fill="#fff">
        <textPath href={`#${uid}-ring`} startOffset="0" textLength={528} lengthAdjust="spacing">
          {ring}
          {ring}
        </textPath>
      </text>
      <circle cx="120" cy="120" r="110" fill={`url(#${uid}-wear)`} opacity="0.35" />
    </g>
  );
}
