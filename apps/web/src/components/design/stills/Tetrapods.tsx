// Tetrapod Stills: Kevin's own raster tetrapods, arranged as a breakwater row. No physics, no canvas, no wasm.
// A breakwater piece absorbs a wave rather than refusing it: that is "bounded loss".

const PERI = '/media/figure-main-ai-console.c850f2f4.png';
const GRAY = '/media/figure-main-ai-console-gray.7e22a8bf.png';

/** Challenge hero + blast radius Still: three staggered pieces; `wave` draws the periwinkle swell behind them. */
export function TetrapodStill({
  count = 3,
  wave = true,
  className = '',
}: {
  count?: 3 | 5;
  wave?: boolean;
  className?: string;
}) {
  const items = Array.from({ length: count }, (_, i) => i);
  return (
    <div className={`sy-tetra ${className}`.trim()} aria-hidden="true">
      {wave ? (
        <svg className="sy-tetra__wave" viewBox="0 0 600 120" preserveAspectRatio="none" focusable="false">
          <path d="M0 80C60 40 120 110 190 70S320 20 400 64 540 100 600 50V120H0Z" fill="#9280FC" opacity="0.9" />
          <path d="M0 80C60 40 120 110 190 70S320 20 400 64 540 100 600 50" fill="none" stroke="#000" strokeWidth="1" vectorEffect="non-scaling-stroke" />
        </svg>
      ) : null}
      <div className="sy-tetra__row">
        {items.map((i) => (
          <img key={i} className={`sy-tetra__piece sy-tetra__piece--${i % 3}`} src={PERI} alt="" width={240} height={240} loading="lazy" decoding="async" />
        ))}
      </div>
    </div>
  );
}

/** Profile-gated replacement for the footer's r3f + physics figures (no wasm, no canvas). Chrome/greyscale on black. */
export function FooterTetrapodsStill({ className = '' }: { className?: string }) {
  return (
    <div className={`sy-tetra sy-tetra--black ${className}`.trim()} aria-hidden="true">
      <div className="sy-tetra__row">
        {[0, 1, 2].map((i) => (
          <img key={i} className={`sy-tetra__piece sy-tetra__piece--${i}`} src={GRAY} alt="" width={240} height={240} loading="lazy" decoding="async" />
        ))}
      </div>
    </div>
  );
}
