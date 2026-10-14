'use client';

import { useEffect, useRef, type ElementType, type ReactNode } from 'react';

type Role = 'prose' | 'figure' | 'rows' | 'rule';

/**
 * Class-toggle reveal (replaces the framer opacity Reveal on new pages; no inline style is ever emitted).
 * Content is fully visible without JS: the `is-armed` class is added by the effect, only to elements that
 * start below the fold, and `is-in` is added once they intersect. Reduced motion: never armed.
 * One idea per role, never one uniform fade-up: prose = opacity; figure = stipple-resolve scale; rows = hairline then text.
 */
export default function Appear({
  children,
  role = 'prose',
  as,
  className = '',
  threshold = 0.35,
}: {
  children: ReactNode;
  role?: Role;
  as?: ElementType;
  className?: string;
  threshold?: number;
}) {
  const ref = useRef<HTMLElement | null>(null);
  const Tag = (as ?? 'div') as ElementType;

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduce || typeof IntersectionObserver === 'undefined') return;
    const rect = el.getBoundingClientRect();
    if (rect.top < window.innerHeight * 0.92) return; // already on screen: stay visible, no flash
    el.classList.add('is-armed');
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            el.classList.add('is-in');
            io.disconnect();
          }
        }
      },
      { threshold },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [threshold]);

  return (
    <Tag ref={ref} className={`sy-appear sy-appear--${role} ${className}`.trim()}>
      {children}
    </Tag>
  );
}
