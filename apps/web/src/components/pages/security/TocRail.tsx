'use client';

import { useEffect, useState } from 'react';

/**
 * Table of contents. Desktop: a sticky left rail with a node marker on the section in view (IntersectionObserver).
 * Mobile: collapses into a <details> at the top. Plain anchors: keyboard and no-JS work without any script.
 */
export default function TocRail({ items }: { items: { id: string; title: string }[] }) {
  const [current, setCurrent] = useState<string | null>(items[0]?.id ?? null);

  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined') return;
    const els = items.map((i) => document.getElementById(i.id)).filter((e): e is HTMLElement => !!e);
    if (els.length === 0) return;
    const io = new IntersectionObserver(
      (entries) => {
        const visible = entries.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (visible[0]) setCurrent(visible[0].target.id);
      },
      { rootMargin: '-10% 0px -70% 0px', threshold: 0 },
    );
    els.forEach((e) => io.observe(e));
    return () => io.disconnect();
  }, [items]);

  const list = (
    <ol className="sy-toc__list">
      {items.map((i) => (
        <li key={i.id} className="sy-toc__item" data-current={current === i.id ? 'true' : undefined}>
          <span className="sy-toc__node" aria-hidden="true" />
          <a href={`#${i.id}`} aria-current={current === i.id ? 'location' : undefined}>
            {i.title}
          </a>
        </li>
      ))}
    </ol>
  );

  return (
    <nav className="sy-toc" aria-label="On this page">
      <details className="sy-toc__m">
        <summary>On this page</summary>
        {list}
      </details>
      <div className="sy-toc__d">
        <p className="sy-mono sy-toc__h">On this page</p>
        {list}
      </div>
    </nav>
  );
}
