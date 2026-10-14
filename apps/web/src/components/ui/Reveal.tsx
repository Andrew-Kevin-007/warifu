'use client';

import { motion } from 'framer-motion';
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';

type Props = {
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
  duration?: number;
  delay?: number;
  threshold?: number;
};

// Fade-in on first intersection, same behaviour as the original scroll reveal.
export default function Reveal({
  children,
  className = '',
  style,
  duration = 0.5,
  delay = 0,
  threshold = 0.5,
}: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [inView, setInView] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setInView(true);
          io.disconnect();
        }
      },
      { threshold },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [threshold]);

  return (
    <motion.div
      ref={ref}
      initial={{ opacity: 0 }}
      animate={{ opacity: inView ? 1 : 0 }}
      transition={{ duration, ease: 'easeOut', delay }}
      className={`${inView ? 'in-view ' : ''}${className}`}
      style={style}
    >
      {children}
    </motion.div>
  );
}
