import type { ComponentType, ElementType, ReactNode } from 'react';
import Link from 'next/link';
import Appear from './Appear';

/** Section divider: a 0.5 px dashed hairline with one orthogonal 8 px step (the fracture). Draws left to right. */
export function FractureRule({ className = '', vertical = false }: { className?: string; vertical?: boolean }) {
  return (
    <div className={`sy-rule${vertical ? ' sy-rule--v' : ''} ${className}`.trim()} role="presentation" aria-hidden="true">
      <Appear role="rule" className="sy-rule__draw">
        <svg viewBox="0 0 1000 12" preserveAspectRatio="none" width="100%" height="12" focusable="false">
          <path
            d="M0 2H488V10H1000"
            fill="none"
            stroke="#CCCCCC"
            strokeWidth="0.5"
            strokeDasharray="4 2"
            vectorEffect="non-scaling-stroke"
          />
          <circle cx="488" cy="2" r="3" fill="#fff" stroke="#CCCCCC" strokeWidth="0.5" />
          <circle cx="488" cy="10" r="3" fill="#fff" stroke="#CCCCCC" strokeWidth="0.5" />
        </svg>
      </Appear>
    </div>
  );
}

/** Dashed hairline rectangle with white nodes at the corners: the container for figures and cards. */
export function NodeFrame({
  children,
  className = '',
  as,
  tone = 'light',
}: {
  children: ReactNode;
  className?: string;
  as?: ElementType;
  tone?: 'light' | 'black';
}) {
  const Tag = (as ?? 'div') as unknown as ComponentType<Record<string, unknown>>;
  return (
    <Tag className={`sy-frame sy-frame--${tone} ${className}`.trim()}>
      <span className="sy-node sy-node--tl" aria-hidden="true" />
      <span className="sy-node sy-node--tr" aria-hidden="true" />
      <span className="sy-node sy-node--bl" aria-hidden="true" />
      <span className="sy-node sy-node--br" aria-hidden="true" />
      {children}
    </Tag>
  );
}

/**
 * At most one per page: a heading word rendered twice (the second copy comes from a pseudo-element) and clipped
 * by complementary stepped polygons, closing from 3 px apart over 700 ms. The real text node stays intact, so
 * selecting or copying returns the word once. Reduced motion: rendered closed.
 */
export function FractureWord({ children }: { children: string }) {
  return (
    <span className="sy-fw" data-text={children}>
      <span className="sy-fw__t">{children}</span>
    </span>
  );
}

export function Eyebrow({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <p className={`sy-eyebrow body-text-s ${className}`.trim()}>{children}</p>;
}

/** Figure with a structural caption: FIG. nn (assigned by code order, never a metric) / label. */
export function Plate({
  fig,
  caption,
  children,
  tag,
  className = '',
}: {
  fig?: number;
  caption: string;
  children: ReactNode;
  tag?: ReactNode;
  className?: string;
}) {
  return (
    <figure className={`sy-plate ${className}`.trim()}>
      <div className="sy-plate__body">{children}</div>
      <figcaption className="sy-plate__cap">
        <span className="sy-mono">
          {fig === undefined ? '' : `FIG. ${String(fig).padStart(2, '0')} / `}
          {caption}
        </span>
        {tag}
      </figcaption>
    </figure>
  );
}

/** Rows: hairline draws first, then the cell text. Mirrors the site's positions list without its compiled classes. */
export function PositionsList({
  items,
  className = '',
  tone = 'light',
}: {
  items: { id?: string; title: ReactNode; meta?: ReactNode; tags?: ReactNode }[];
  className?: string;
  tone?: 'light' | 'black';
}) {
  return (
    <ul className={`sy-rows sy-rows--${tone} ${className}`.trim()}>
      {items.map((it, i) => (
        <li key={it.id ?? i} className="sy-rows__item">
          <Appear role="rows" className="sy-rows__inner">
            <div className="sy-rows__head">
              {it.id ? <span className="sy-mono sy-rows__id">{it.id}</span> : null}
              <span className="sy-rows__title">{it.title}</span>
              {it.tags ? <span className="sy-rows__tags">{it.tags}</span> : null}
            </div>
            {it.meta ? <div className="sy-rows__meta">{it.meta}</div> : null}
          </Appear>
        </li>
      ))}
    </ul>
  );
}

/** A statistic: label above, numeral (a slot the lane/Body fills), caption below. `hollow` outlines the numeral. */
export function Stat({
  label,
  children,
  caption,
  hollow = false,
  tag,
  className = '',
}: {
  label: ReactNode;
  children: ReactNode;
  caption?: ReactNode;
  hollow?: boolean;
  tag?: ReactNode;
  className?: string;
}) {
  return (
    <div className={`sy-stat${hollow ? ' is-hollow' : ''} ${className}`.trim()}>
      <div className="sy-stat__label">
        <span>{label}</span>
        {tag}
      </div>
      <div className="sy-stat__num heading-h1">{children}</div>
      {caption ? <div className="sy-stat__cap body-text-xs">{caption}</div> : null}
    </div>
  );
}

/** Existing engineered-button markup (as in the footer CTA), kept byte-compatible so the site's CSS styles it. */
export function LinkButton({
  href,
  children,
  size = 'm',
  className = '',
}: {
  href: string;
  children: ReactNode;
  size?: 'xs' | 's' | 'm' | 'l';
  className?: string;
}) {
  return (
    <span className={`button-primary-${size}__wrapper ${className}`.trim()}>
      <Link href={href} className={`button-primary-${size}`}>
        <span className="block">{children}</span>
      </Link>
    </span>
  );
}
