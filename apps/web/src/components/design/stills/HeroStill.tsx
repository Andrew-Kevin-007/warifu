// Challenge-origin `/` hero: no canvas, no <video>, no gsap lean, no physics figures. One specimen plate.
// The figure is one of Kevin's own stipple objects; the cloud is his footer asset.

export default function HeroStill({ className = '' }: { className?: string }) {
  return (
    <div className={`sy-hero-still ${className}`.trim()} aria-hidden="true">
      <img className="sy-hero-still__cloud" src="/media/footer-cta-bg.bef33713.png" alt="" width={1408} height={521} loading="eager" decoding="async" />
      <img className="sy-hero-still__figure" src="/media/figure-main-search.590a6d8f.png" alt="" width={660} height={660} loading="eager" decoding="async" />
      <svg className="sy-hero-still__grid" viewBox="0 0 600 300" preserveAspectRatio="none" focusable="false">
        <path d="M0.25 299.75V0.25M599.75 299.75V0.25M0 299.75H600" stroke="#CCCCCC" strokeWidth="0.5" strokeDasharray="4 2" fill="none" vectorEffect="non-scaling-stroke" />
        <circle cx="3" cy="299" r="3" fill="#fff" stroke="#CCCCCC" strokeWidth="0.5" />
        <circle cx="597" cy="299" r="3" fill="#fff" stroke="#CCCCCC" strokeWidth="0.5" />
      </svg>
    </div>
  );
}
