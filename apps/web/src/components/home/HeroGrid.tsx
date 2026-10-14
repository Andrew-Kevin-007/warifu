'use client';

import { useEffect } from 'react';
import HeroGridSvg from '@/components/home/HeroGridSvg';

// The grid squares blink away at random when the page settles and drop out while the figure is hovered.
export default function HeroGrid({ isHovered, hideSquares }: { isHovered: boolean; hideSquares: boolean }) {
  useEffect(() => {
    const squares = document.querySelectorAll('.grid-square');
    const hideOnHover = document.querySelectorAll('.hide-on-hover');
    const timers: ReturnType<typeof setTimeout>[] = [];

    squares.forEach((el) => {
      timers.push(
        setTimeout(() => {
          if (hideSquares) {
            el.classList.add('opacity-0');
            el.classList.remove('opacity-100');
          } else {
            el.classList.remove('opacity-0');
            el.classList.add('opacity-100');
          }
        }, 0.5 * Math.random() * 1000),
      );
    });
    hideOnHover.forEach((el) => {
      if (isHovered) el.classList.add('hide-square');
      else el.classList.remove('hide-square');
    });
    return () => timers.forEach(clearTimeout);
  }, [hideSquares, isHovered]);

  return (
    <div className="hero__grid absolute left-1/2 top-[76px] z-2 -translate-x-1/2">
      <div className="hero__grid-wrapper mx-auto max-w-[1350px]">
        <HeroGridSvg />
      </div>
    </div>
  );
}
