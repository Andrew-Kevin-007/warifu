import type { ReactNode } from 'react';
import SiteShell from '@/components/SiteShell';

export function PageFrame({ eyebrow, title, lede, children }: { eyebrow?: string; title: string; lede?: ReactNode; children: ReactNode }) {
  return (
    <SiteShell>
      <main className="sy-page relative z-5">
        <div className="sy-wrap">
          {eyebrow ? <p className="body-text-s sy-eyebrow">{eyebrow}</p> : null}
          <h1 className="heading-h3">{title}</h1>
          {lede ? <p className="body-text-m sy-lede">{lede}</p> : null}
          {children}
        </div>
      </main>
    </SiteShell>
  );
}

export function Section({ title, children, id }: { title: string; children: ReactNode; id?: string }) {
  return (
    <section className="sy-section" id={id}>
      <h2 className="heading-h5">{title}</h2>
      {children}
    </section>
  );
}

export type ChipTone = 'pass' | 'fail' | 'warn' | 'muted' | 'plain';
export function Chip({ tone = 'plain', children }: { tone?: ChipTone; children: ReactNode }) {
  const cls = tone === 'plain' ? 'sy-chip' : `sy-chip sy-chip--${tone}`;
  return <span className={cls}>{children}</span>;
}

/** Visible provenance banner: RECORDED (committed replay bundle) or LIVE. */
export function SourceBanner({ source, note }: { source: 'RECORDED' | 'LIVE'; note?: ReactNode }) {
  if (source === 'LIVE') return null;
  return (
    <div className="sy-banner" role="note">
      <strong>RECORDED.</strong> This page is rendered from the committed replay bundle, not from a live service.{' '}
      {note}
    </div>
  );
}

export function Simulated({ children }: { children: ReactNode }) {
  return <Chip tone="warn">{children ?? 'SIMULATED'}</Chip>;
}
