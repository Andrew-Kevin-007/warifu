'use client';

import { useEffect, useRef, useState } from 'react';
import { countAt, formatCount, isCount } from '../runtime/format';

/**
 * Count-up for INTEGER COUNTS only (attempts, trials, payments, businesses). Never money, a bound, a rate or a
 * percentage: those are stated, not accumulated. The server render and the final frame are exactly
 * formatCount(value); reduced motion shows the final value at once; 0 is shown as 0 immediately.
 */
export default function CountUp({ value, className = '' }: { value: number; className?: string }) {
  const [shown, setShown] = useState<number>(value);
  const ref = useRef<HTMLSpanElement | null>(null);
  const done = useRef(false);

  useEffect(() => {
    const el = ref.current;
    if (!el || !isCount(value) || value === 0) {
      setShown(value);
      return;
    }
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const rect = el.getBoundingClientRect();
    const offscreenBelow = rect.top > window.innerHeight;
    if (reduce || done.current || typeof IntersectionObserver === 'undefined' || (!offscreenBelow && rect.bottom < 0)) {
      setShown(value);
      return;
    }
    let raf = 0;
    let cancelled = false;
    const run = () => {
      done.current = true;
      const start = performance.now();
      const dur = 700;
      const tick = (now: number) => {
        if (cancelled) return;
        const t = Math.min(1, (now - start) / dur);
        // expo-out settle: fast departure, long landing
        const eased = t >= 1 ? 1 : 1 - Math.pow(2, -10 * t);
        setShown(countAt(0, value, t >= 1 ? 1 : eased));
        if (t < 1) raf = requestAnimationFrame(tick);
      };
      setShown(0);
      raf = requestAnimationFrame(tick);
    };
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          io.disconnect();
          run();
        }
      },
      { threshold: 0.6 },
    );
    io.observe(el);
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      io.disconnect();
    };
  }, [value]);

  return (
    <span ref={ref} className={`sy-num ${className}`.trim()} data-final={formatCount(value)}>
      {formatCount(shown)}
    </span>
  );
}
